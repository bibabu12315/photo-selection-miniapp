import { getPreviewUrl } from '../../services/selection'

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
  },

  projectId: '',
  modelId: '',
  cache: {} as Record<string, string>,
  channel: null as any,
  tapTimer: 0 as any,
  hintTimer: 0 as any,

  onLoad(this: any) {
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel()
    if (!ch || !ch.on) return
    this.channel = ch
    ch.on('init', (payload: any) => {
      const info = (wx as any).getSystemInfoSync()
      this.projectId = payload.projectId
      this.modelId = payload.modelId
      const photos: ViewerPhoto[] = payload.photos || []
      this.setData({
        ready: true,
        photos,
        current: Math.min(payload.index || 0, Math.max(0, photos.length - 1)),
        locked: !!payload.locked,
        windowW: info.windowWidth,
        windowH: info.windowHeight,
      })
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
    this.setData({ [`photos[${i}].selected`]: selected })
    try {
      ;(wx as any).vibrateShort({ type: 'light' })
    } catch (e) {
      // 部分机型不支持，忽略
    }
    if (this.channel) {
      this.channel.emit('selectionChanged', { id: p._id, selected })
    }
  },

  /** 加载 index 及前后各一张的 preview 大图，滑动切换时不闪缩略图 */
  loadAround(this: any, index: number) {
    ;[index - 1, index, index + 1].forEach((i) => {
      const p = this.data.photos[i]
      if (!p) return
      if (this.cache[p._id]) {
        this.setData({ [`previewUrls[${i}]`]: this.cache[p._id] })
        return
      }
      getPreviewUrl(this.projectId, this.modelId, p._id).then((res) => {
        if (res.ok && res.data && res.data.previewUrl) {
          this.cache[p._id] = res.data.previewUrl
          this.setData({ [`previewUrls[${i}]`]: res.data.previewUrl })
        }
        // 失败时静默：WXML 回退显示缩略图
      })
    })
  },
})
