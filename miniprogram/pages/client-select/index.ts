import { clientEntry, getPhotos, saveSelection, submitSelection, ClientPhoto } from '../../services/selection'

/**
 * 模特端 · 照片列表与选片
 * 入口：小程序码 scene / 分享卡片参数 t，均携带项目 accessToken
 */
const PAGE_SIZE = 18
const SYNC_DELAY = 2000

Page({
  data: {
    phase: 'loading' as 'loading' | 'ready' | 'locked' | 'error',
    errorMsg: '',
    projectName: '',
    clientName: '',
    photoCount: 0,
    selectedCount: 0,
    submitting: false,
    /** 照片列表（thumbUrl 直接给 image 组件） */
    photos: [] as (ClientPhoto & { selected: boolean })[],
    hasMore: false,
    loadingMore: false,
    /** 分页加载失败，底部显示重试入口 */
    loadError: false,
  },

  token: '',
  syncTimer: 0 as any,
  dirty: false,

  onLoad(this: any, options: Record<string, string>) {
    // 小程序码 scene / 分享卡片 t，两种入口都兼容
    let token = options.t || ''
    if (!token && options.scene) {
      token = decodeURIComponent(options.scene)
    }
    if (!token) {
      this.setData({ phase: 'error', errorMsg: '请通过摄影师分享的二维码或卡片进入' })
      return
    }
    this.token = token
    this.init()
  },

  onUnload(this: any) {
    // 退出页面前把未同步的选择推上去
    if (this.dirty) this.syncNow()
    if (this.syncTimer) clearTimeout(this.syncTimer)
  },

  onHide(this: any) {
    if (this.dirty) this.syncNow()
  },

  async init(this: any) {
    const res = await clientEntry(this.token)
    if (!res.ok || !res.data) {
      this.setData({ phase: 'error', errorMsg: res.error || '进入项目失败' })
      return
    }
    const d = res.data
    this.setData({
      phase: d.locked ? 'locked' : 'ready',
      projectName: d.name,
      clientName: d.clientName,
      photoCount: d.photoCount,
      selectedCount: d.locked ? d.selectedCount : 0,
    })

    // 已提交过的项目也预取一页照片（锁定态只读浏览）
    if (!d.locked) {
      const selected = new Set<string>(d.selectedIds || [])
      await this.loadMore(selected)
      this.setData({
        selectedCount: this.data.photos.filter((p: any) => p.selected).length,
      })
    }
  },

  /** 分页加载（onReachBottom 触发；presetSelected 用于首页载入时恢复已选状态） */
  async loadMore(this: any, presetSelected?: Set<string>) {
    if (this.data.loadingMore) return
    this.setData({ loadingMore: true, loadError: false })
    const skip = this.data.photos.length
    const res = await getPhotos(this.token, skip, PAGE_SIZE)
    if (!res.ok || !res.data) {
      // 弱网时不静默失败，保留一个可点击的重试入口
      this.setData({ loadingMore: false, loadError: true })
      return
    }
    const incoming = res.data.photos.map((p) => ({
      ...p,
      selected: presetSelected ? presetSelected.has(p._id) : false,
    }))
    this.setData({
      loadingMore: false,
      loadError: false,
      hasMore: res.data.hasMore,
      photos: [...this.data.photos, ...incoming],
    })
  },

  /** 首屏进入失败后重试 */
  retryInit(this: any) {
    this.setData({ phase: 'loading', errorMsg: '' })
    this.init()
  },

  /** 分页加载失败后重试（bindtap 会传 event，不能直接绑 loadMore） */
  retryLoad(this: any) {
    this.loadMore()
  },

  onReachBottom(this: any) {
    if (this.data.phase !== 'ready') return
    // 加载失败后不再随滚动自动重试，避免反复发失败请求，改由用户点按钮
    if (this.data.loadError) return
    this.loadMore()
  },

  /** 点选 / 取消选择（本地即时反馈 + 防抖批量同步） */
  toggle(this: any, e: any) {
    if (this.data.phase !== 'ready') return
    const id = e.currentTarget.dataset.id as string
    const photos = this.data.photos.map((p) =>
      p._id === id ? { ...p, selected: !p.selected } : p
    )
    const selectedCount = photos.filter((p) => p.selected).length
    this.dirty = true
    this.setData({ photos, selectedCount })
    this.scheduleSync()
  },

  scheduleSync(this: any) {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => this.syncNow(), SYNC_DELAY)
  },

  async syncNow(this: any) {
    this.dirty = false
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = 0
    }
    const ids = this.data.photos.filter((p) => p.selected).map((p) => p._id)
    const res = await saveSelection(this.token, ids)
    if (!res.ok) {
      this.dirty = true
      ;(wx as any).showToast({ title: '同步失败，稍后自动重试', icon: 'none' })
    }
  },

  /** 查看大图 */
  openViewer(this: any, e: any) {
    const index = e.currentTarget.dataset.index as number
    wx.navigateTo({
      url: '/pages/photo-viewer/index?index=' + index,
      events: {
        // 大图页改选择后回传
        selectionChanged: (payload: any) => {
          const photos = this.data.photos.map((p) =>
            p._id === payload.id ? { ...p, selected: payload.selected } : p
          )
          this.dirty = true
          this.setData({ photos, selectedCount: photos.filter((p) => p.selected).length })
          this.scheduleSync()
        },
      },
      success: (res) => {
        res.eventChannel.emit('init', {
          token: this.token,
          index,
          photos: this.data.photos,
          locked: this.data.phase !== 'ready',
        })
      },
    })
  },

  /** 提交选片 */
  async submit(this: any) {
    if (this.data.submitting) return
    const n = this.data.selectedCount
    if (n <= 0) {
      ;(wx as any).showToast({ title: '还没有选择照片', icon: 'none' })
      return
    }
    ;(wx as any).showModal({
      title: '确定提交？',
      content: `您选择了 ${n} 张照片。提交后摄影师将按当前选择精修，如需修改请联系摄影师。`,
      cancelText: '再看看',
      confirmText: '确认提交',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ submitting: true })
        if (this.dirty) await this.syncNow()
        const ids = this.data.photos.filter((p) => p.selected).map((p) => p._id)
        const res = await submitSelection(this.token, ids)
        if (!res.ok) {
          this.setData({ submitting: false })
          ;(wx as any).showModal({ title: '提交失败', content: res.error || '', showCancel: false })
          return
        }
        this.setData({ submitting: false, phase: 'locked', selectedCount: res.data!.selectedCount })
      },
    })
  },
})
