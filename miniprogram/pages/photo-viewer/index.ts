import { getPreviewUrl } from '../../services/selection'

/**
 * 模特端 · 大图浏览
 * 数据来自上一页（client-select）通过 eventChannel 传入
 * 大图按需加载：只加载当前张及相邻一张的 preview
 */

interface ViewerPhoto {
  _id: string
  filename: string
  thumbUrl: string
  selected: boolean
}

Page({
  data: {
    ready: false,
    photos: [] as ViewerPhoto[],
    current: 0,
    previewUrl: '',
    loadingPreview: false,
    locked: false,
  },

  token: '',
  cache: {} as Record<string, string>,
  channel: null as any,

  onLoad(this: any) {
    const ch = this.getOpenerEventChannel && this.getOpenerEventChannel()
    if (!ch || !ch.on) return
    this.channel = ch
    ch.on('init', (payload: any) => {
      this.token = payload.token
      const photos: ViewerPhoto[] = payload.photos || []
      this.setData({
        ready: true,
        photos,
        current: Math.min(payload.index || 0, Math.max(0, photos.length - 1)),
        locked: !!payload.locked,
      })
      this.loadPreview(photos[this.data.current])
      this.preloadNeighbor()
    })
  },

  onSwiper(this: any, e: any) {
    const current = e.detail.current
    this.setData({ current })
    this.loadPreview(this.data.photos[current])
    this.preloadNeighbor()
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
    const res = await getPreviewUrl(this.token, photo._id)
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
      getPreviewUrl(this.token, next._id).then((res) => {
        if (res.ok && res.data && res.data.previewUrl) this.cache[next._id] = res.data.previewUrl
      })
    }
  },
})
