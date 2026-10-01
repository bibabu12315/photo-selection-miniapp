import { getPreviewUrl } from '../../services/selection'

/**
 * 模特端 · 大图浏览
 * 数据来自上一页（client-select）通过 eventChannel 传入
 * 大图按需加载：只加载当前张及相邻一张的 preview
 * 交互：
 *   - 左右滑动切换照片
 *   - 双指捏合缩放（1~4 倍），放大后可拖动查看细节
 *   - 双击：放大 2 倍 / 还原
 *   - 未放大时轻点：选中 / 取消（与底部按钮一致）
 */

interface ViewerPhoto {
  _id: string
  filename: string
  thumbUrl: string
  selected: boolean
}

const DOUBLE_TAP_MS = 300

Page({
  data: {
    ready: false,
    photos: [] as ViewerPhoto[],
    current: 0,
    previewUrl: '',
    loadingPreview: false,
    locked: false,
    /** 双击缩放目标值：1 = 原始大小，2 = 放大一倍 */
    zoomValue: 1,
    /** 当前实际缩放 > 1（捏合过），用于控制拖动方向开关 */
    zoomed: false,
    showGestureHint: false,
  },

  projectId: '',
  modelId: '',
  cache: {} as Record<string, string>,
  channel: null as any,
  lastTapTime: 0,
  tapTimer: 0 as any,

  onLoad(this: any) {
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel()
    if (!ch || !ch.on) return
    this.channel = ch
    ch.on('init', (payload: any) => {
      this.projectId = payload.projectId
      this.modelId = payload.modelId
      const photos: ViewerPhoto[] = payload.photos || []
      this.setData({
        ready: true,
        photos,
        current: Math.min(payload.index || 0, Math.max(0, photos.length - 1)),
        locked: !!payload.locked,
      })
      this.loadPreview(photos[this.data.current])
      this.preloadNeighbor()
      // 首次进入展示手势提示，几秒后自动消失
      this.setData({ showGestureHint: true })
      if (this.hintTimer) clearTimeout(this.hintTimer)
      this.hintTimer = setTimeout(() => {
        this.setData({ showGestureHint: false })
      }, 3000)
    })
  },

  hintTimer: 0 as any,

  onUnload(this: any) {
    if (this.hintTimer) clearTimeout(this.hintTimer)
    if (this.tapTimer) clearTimeout(this.tapTimer)
    if (this.scaleTimer) clearTimeout(this.scaleTimer)
  },

  onSwiper(this: any, e: any) {
    const current = e.detail.current
    this.setData({ current, zoomValue: 1, zoomed: false })
    this.loadPreview(this.data.photos[current])
    this.preloadNeighbor()
  },

  /**
   * 放大状态下，movable-view 的拖动手势会被外层的 swiper 抢走（表现为放大后拖不动图片）。
   * 这里用 catch:htouchmove / catch:vtouchmove 在放大时把事件拦下来，
   * 缩回 1 倍后自动解除，左右滑动切图恢复。
   * 这两个方法只是占位，被拦截后不做事，重点是阻止事件冒泡到 swiper。
   */
  blockSwiper(this: any) {},

  /** 捏合缩放回调：记录当前倍率；>1 视为放大，开启拖动并屏蔽 swiper */
  onScale(this: any, e: any) {
    const scale = (e.detail && e.detail.scale) || 1
    const zoomed = scale > 1.05
    if (zoomed !== this.data.zoomed) this.setData({ zoomed })
    // 缩放结束后把 scale-value 同步成真实倍率，避免重渲染把图片弹回 1 倍
    if (this.scaleTimer) clearTimeout(this.scaleTimer)
    this.scaleTimer = setTimeout(() => {
      if (Math.abs(scale - this.data.zoomValue) > 0.01) {
        this.setData({ zoomValue: scale, zoomed: scale > 1.05 })
      }
    }, 150)
  },

  scaleTimer: 0 as any,

  /** 缩回原始大小，恢复左右滑动切图 */
  resetZoom(this: any) {
    this.setData({ zoomValue: 1, zoomed: false })
  },

  /**
   * 轻点图片：
   *   双击（300ms 内两次）→ 放大 2 倍 / 还原
   *   单击（未放大时）→ 选中 / 取消；放大状态下单击不动作，避免拖动时误选
   */
  onTapPhoto(this: any) {
    const now = Date.now()
    if (now - this.lastTapTime < DOUBLE_TAP_MS) {
      this.lastTapTime = 0
      if (this.tapTimer) {
        clearTimeout(this.tapTimer)
        this.tapTimer = 0
      }
      const restore = this.data.zoomValue > 1
      this.setData({ zoomValue: restore ? 1 : 2, zoomed: !restore })
      return
    }
    this.lastTapTime = now
    if (this.tapTimer) clearTimeout(this.tapTimer)
    this.tapTimer = setTimeout(() => {
      this.tapTimer = 0
      if (this.data.zoomed) return
      this.toggleLike()
    }, DOUBLE_TAP_MS)
  },

  /** 喜欢 / 取消喜欢：通知上一页，本地状态同步翻转 */
  toggleLike(this: any) {
    if (this.data.locked) return
    const p = this.data.photos[this.data.current]
    if (!p) return
    const selected = !p.selected
    this.setData({ [`photos[${this.data.current}].selected`]: selected })
    if (this.channel) {
      this.channel.emit('selectionChanged', { id: p._id, selected })
    }
  },

  async loadPreview(this: any, photo?: ViewerPhoto) {
    if (!photo) return
    if (this.cache[photo._id]) {
      this.setData({ previewUrl: this.cache[photo._id] })
      return
    }
    this.setData({ loadingPreview: true })
    const res = await getPreviewUrl(this.projectId, this.modelId, photo._id)
    if (res.ok && res.data && res.data.previewUrl) {
      this.cache[photo._id] = res.data.previewUrl
      if (this.data.photos[this.data.current] && this.data.photos[this.data.current]._id === photo._id) {
        this.setData({ previewUrl: res.data.previewUrl, loadingPreview: false })
      }
    } else {
      this.setData({ loadingPreview: false })
      // 大图加载失败时退回缩略图，保证能看
      if (photo.thumbUrl) this.setData({ previewUrl: photo.thumbUrl })
    }
  },

  /** 预加载相邻一张，左右滑动更顺 */
  preloadNeighbor(this: any) {
    const next = this.data.photos[this.data.current + 1]
    if (next && !this.cache[next._id]) {
      getPreviewUrl(this.projectId, this.modelId, next._id).then((res) => {
        if (res.ok && res.data && res.data.previewUrl) this.cache[next._id] = res.data.previewUrl
      })
    }
  },
})
