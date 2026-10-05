import { getPreviewUrl } from '../../services/selection'
import { getCached, putBatch } from '../../services/urlcache'

/**
 * 模特端 · 大图浏览（WXS 手势驱动版）
 * 数据来自上一页（client-select）通过 eventChannel 传入
 *
 * 手势（缩放/拖动/翻页）全部在 gest.wxs 渲染层处理，本文件只负责：
 *   - 数据装载与 preview 大图按需加载（当前张 ± 1 张）
 *   - WXS 回调：翻页 onSwitched / 缩放状态 onZoomChanged / 单击选片 onSingleTap
 *   - 底部「喜欢」按钮
 */

interface ViewerPhoto {
  _id: string
  filename: string
  thumbUrl: string
  selected: boolean
}

const TAP_DELAY = 300

Page({
  data: {
    ready: false,
    photos: [] as ViewerPhoto[],
    current: 0,
    /** 下标 → previewUrl，当前张和相邻张才有值 */
    previewUrls: {} as Record<number, string>,
    locked: false,
    showGestureHint: false,
    windowW: 0,
    windowH: 0,
    zoomed: false,
    /** 下标 → 加载完成样式：anim=淡入 / fast=缓存命中直接显示（F-22） */
    loaded: {} as Record<number, string>,
    /** 下标 → 是否加载失败，失败才显示重试块 */
    failed: {} as Record<number, boolean>,
    /** 上级没把照片传过来（或迟迟不来），整页落错误态 */
    loadError: false,
  },

  projectId: '',
  modelId: '',
  /** 已发出但未返回的请求，避免同一张重复请求 */
  pending: {} as Record<string, boolean>,
  channel: null as any,
  tapTimer: 0 as any,
  hintTimer: 0 as any,
  /** 本批 <image> 开始渲染的时刻，用于判断 bindload 是不是缓存命中 */
  loadT0: 0,
  /** 等待上级页面 init 的超时兜底 */
  initTimer: 0 as any,

  onLoad(this: any) {
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel()
    if (!ch || !ch.on) {
      // 拿不到 eventChannel（异常路径），别让用户永远停在「加载中…」
      this.setData({ loadError: true })
      return
    }
    // 上级 5 秒内没 push 数据就直接落错误态，不给无限加载中
    if (this.initTimer) clearTimeout(this.initTimer)
    this.initTimer = setTimeout(() => {
      if (!this.data.ready) this.setData({ loadError: true })
    }, 5000)

    this.channel = ch
    ch.on('init', (payload: any) => {
      if (this.initTimer) {
        clearTimeout(this.initTimer)
        this.initTimer = 0
      }
      const info = (wx as any).getSystemInfoSync()
      this.projectId = payload.projectId
      this.modelId = payload.modelId
      const photos: ViewerPhoto[] = payload.photos || []
      this.setData({
        ready: photos.length > 0,
        loadError: photos.length === 0,
        photos,
        current: Math.min(payload.index || 0, Math.max(0, photos.length - 1)),
        locked: !!payload.locked,
        windowW: info.windowWidth,
        windowH: info.windowHeight,
      })
      if (!photos.length) return
      this.loadT0 = Date.now()
      this.loadAround(this.data.current)
      this.setData({ showGestureHint: true })
      if (this.hintTimer) clearTimeout(this.hintTimer)
      this.hintTimer = setTimeout(() => {
        this.setData({ showGestureHint: false })
      }, 3000)
    })
  },

  onUnload(this: any) {
    if (this.hintTimer) clearTimeout(this.hintTimer)
    if (this.tapTimer) clearTimeout(this.tapTimer)
    if (this.initTimer) clearTimeout(this.initTimer)
  },

  /** 单张加载完成：100ms 内回来的当作缓存命中直接显示，其余淡入 */
  onImgLoad(this: any, e: any) {
    const index = Number(e.currentTarget.dataset.index)
    if (this.data.loaded[index]) return
    const cls = Date.now() - this.loadT0 < 100 ? 'fast' : 'anim'
    // 动态 key 一律先建空对象再下标赋值：对象计算属性 { [k]: v } 会被降级编译成
    // @babel/runtime/helpers/toPropertyKey，本项目无 node_modules → 页面加载即白屏
    const patch: any = {}
    patch['loaded[' + index + ']'] = cls
    patch['failed[' + index + ']'] = false
    this.setData(patch)
  },

  /** 单张加载失败：显示就地重试块 */
  onImgError(this: any, e: any) {
    const index = Number(e.currentTarget.dataset.index)
    const patch: any = {}
    patch['failed[' + index + ']'] = true
    this.setData(patch)
  },

  /** WXS 手势与业务逻辑互不干扰：失败块的触摸在此处吞掉 */
  noop() {},

  goBack(this: any) {
    ;(wx as any).navigateBack({ fail: () => {} })
  },

  /** 重试单张：重新取一次大图链接（原链接可能已过期） */
  async retryImg(this: any, e: any) {
    const index = Number(e.currentTarget.dataset.index)
    const p = this.data.photos[index]
    if (!p) return
    const reset: any = {}
    reset['failed[' + index + ']'] = false
    reset['loaded[' + index + ']'] = ''
    this.setData(reset)
    const res = await getPreviewUrl(this.projectId, this.modelId, p._id, 0)
    const url = res.ok && res.data ? res.data.previewUrl : ''
    if (!url) {
      const archived = !!(res.error && /归档/.test(res.error))
      ;(wx as any).showToast({
        title: archived ? res.error : '重试失败，请稍后再试',
        icon: 'none',
        duration: 2500,
      })
      const fail: any = {}
      fail['failed[' + index + ']'] = true
      this.setData(fail)
      return
    }
    putBatch(this.projectId, 'preview', [{ photoId: p._id, url }])
    this.loadT0 = Date.now()
    // <image> 只有 src 变了才会重新加载：先把 src 清掉，渲染落地后再填新链接
    const clear: any = {}
    clear['previewUrls[' + index + ']'] = ''
    this.setData(clear, () => {
      const fill: any = {}
      fill['previewUrls[' + index + ']'] = url
      this.setData(fill)
    })
    this.pending[p._id] = false
  },

  /** WXS 回调：翻页完成，加载新页及相邻页的大图 */
  onSwitched(this: any, payload: { index: number }) {
    if (payload.index === this.data.current) return
    this.setData({ current: payload.index })
    this.loadAround(payload.index)
  },

  /** WXS 回调：缩放状态变化（含双击缩放）。缩放开始/进行中要取消未生效的单击选片 */
  onZoomChanged(this: any, payload: { zoomed: boolean }) {
    if (this.tapTimer) {
      clearTimeout(this.tapTimer)
      this.tapTimer = 0
    }
    this.setData({ zoomed: payload.zoomed })
  },

  /** WXS 回调：单击（未放大时）→ 选中/取消，延迟 300ms 等双击判定 */
  onSingleTap(this: any) {
    if (this.tapTimer) clearTimeout(this.tapTimer)
    this.tapTimer = setTimeout(() => {
      this.tapTimer = 0
      this.toggleLike()
    }, TAP_DELAY)
  },

  /** 喜欢 / 取消喜欢：通知上一页，本地状态同步翻转 */
  toggleLike(this: any) {
    if (this.data.locked) return
    const i = this.data.current
    const p = this.data.photos[i]
    if (!p) return
    const selected = !p.selected
    const patch: any = {}
    patch['photos[' + i + '].selected'] = selected
    this.setData(patch)
    try {
      ;(wx as any).vibrateShort({ type: 'light' })
    } catch (e) {
      // 部分机型不支持，忽略
    }
    if (this.channel) {
      this.channel.emit('selectionChanged', { id: p._id, selected })
    }
  },

  /**
   * 加载 index 前后共 5 张的 preview 大图，滑动切换时不闪缩略图
   * 一次请求拿 5 张（range=2）：连滑 20 张只产生约 4~5 次调用，而不是 20 次
   * 端上缓存命中则完全不请求（云端链接 24h 有效，本地缓存 20h）
   */
  loadAround(this: any, index: number) {
    const span = [index - 2, index - 1, index, index + 1, index + 2]
    const missing: number[] = []
    const patch: Record<string, string> = {}

    span.forEach((i) => {
      const p = this.data.photos[i]
      if (!p) return
      const cached = getCached(this.projectId, 'preview', p._id)
      if (cached) {
        if (this.data.previewUrls[i] !== cached) patch[`previewUrls[${i}]`] = cached
        return
      }
      if (!this.data.previewUrls[i]) missing.push(i)
    })
    if (Object.keys(patch).length) this.setData(patch)
    if (!missing.length) return

    // 以离当前张最近的缺失项为中心请求一次
    const center = missing.reduce(
      (a, b) => (Math.abs(b - index) < Math.abs(a - index) ? b : a),
      missing[0]
    )
    const target = this.data.photos[center]
    if (!target || this.pending[target._id]) return
    this.pending[target._id] = true

    getPreviewUrl(this.projectId, this.modelId, target._id, 2).then((res) => {
      this.pending[target._id] = false
      if (!res.ok || !res.data) {
        // 已归档 / 失败：静默回退显示缩略图，只在明确归档时提示一次
        if (res.error && /归档/.test(res.error)) {
          ;(wx as any).showToast({ title: res.error, icon: 'none', duration: 2500 })
        }
        return
      }
      const list = res.data.list || []
      putBatch(
        this.projectId,
        'preview',
        list.filter((x) => x.previewUrl).map((x) => ({ photoId: x.photoId, url: x.previewUrl }))
      )
      const next: Record<string, string> = {}
      list.forEach((item) => {
        if (!item.previewUrl) return
        const i = this.data.photos.findIndex((q: any) => q._id === item.photoId)
        if (i >= 0) next[`previewUrls[${i}]`] = item.previewUrl
      })
      if (Object.keys(next).length) this.setData(next)
    })
  },
})
