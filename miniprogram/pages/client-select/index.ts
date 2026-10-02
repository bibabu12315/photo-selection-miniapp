import {
  enterSelection,
  getPhotos,
  saveSelection,
  submitSelection,
  ClientPhoto,
  PhotoItem,
} from '../../services/selection'
import { getCached, putBatch, cachedIds } from '../../services/urlcache'

/**
 * 模特端 · 选片
 * 两种入口：
 *   1) 邀请链接 / 小程序码：options.t 或 scene（首次认领身份）
 *   2) 从「我的拍摄」进入：options.pid + options.mid
 */
const PAGE_SIZE = 18
const SYNC_DELAY = 2000

Page({
  data: {
    phase: 'loading' as 'loading' | 'ready' | 'locked' | 'error',
    errorMsg: '',
    projectName: '',
    displayName: '',
    photoCount: 0,
    /** 套餐上限，0 = 不限 */
    packageCount: 0,
    limitText: '',
    selectedCount: 0,
    submitting: false,
    /** 之前提交过一版，展示「可继续调整」提示 */
    resubmitHint: false,
    photos: [] as (ClientPhoto & { selected: boolean })[],
    hasMore: false,
    loadingMore: false,
    loadError: false,
    /** 项目已归档：缩略图还在，大图已清理 */
    archived: false,
  },

  projectId: '',
  modelId: '',
  syncTimer: 0 as any,
  dirty: false,

  onLoad(this: any, options: Record<string, string>) {
    // 入口一：邀请链接 / 小程序码
    let token = options.t || ''
    if (!token && options.scene) token = decodeURIComponent(options.scene)

    // 入口二：我的拍摄
    const pid = options.pid || ''
    const mid = options.mid || ''

    if (!token && !(pid && mid)) {
      this.setData({ phase: 'error', errorMsg: '请通过摄影师分享的链接或二维码进入' })
      return
    }
    this.projectId = pid
    this.modelId = mid
    this.token = token
    this.init()
  },

  token: '',

  onUnload(this: any) {
    if (this.dirty) this.syncNow()
    if (this.syncTimer) clearTimeout(this.syncTimer)
  },

  onHide(this: any) {
    if (this.dirty) this.syncNow()
  },

  async init(this: any) {
    const res = await enterSelection(this.token, this.projectId, this.modelId)
    if (!res.ok || !res.data) {
      this.setData({ phase: 'error', errorMsg: res.error || '进入项目失败' })
      return
    }
    const d = res.data
    this.projectId = d.projectId
    this.modelId = d.modelId
    this.token = ''

    // 提交过也照常进入：已选的保留勾选，模特在原基础上继续精挑
    this.setData({
      phase: 'ready',
      projectName: d.projectName,
      displayName: d.displayName,
      photoCount: d.photoCount,
      packageCount: d.packageCount,
      limitText: d.packageCount > 0 ? `${d.packageCount} 张` : '不限',
      resubmitHint: !!d.locked,
      selectedCount: (d.selectedIds || []).length,
    })

    const selected = new Set<string>(d.selectedIds || [])
    await this.loadMore(selected)
    this.setData({
      selectedCount: this.data.photos.filter((p: any) => p.selected).length,
    })
  },

  async loadMore(this: any, presetSelected?: Set<string>) {
    if (this.data.loadingMore) return
    this.setData({ loadingMore: true, loadError: false })
    const skip = this.data.photos.length

    // 端上已有有效缓存的，告诉服务端别再生成链接
    const have = cachedIds(this.projectId, 'thumb')
    const res = await getPhotos(this.projectId, this.modelId, skip, PAGE_SIZE, have)
    if (!res.ok || !res.data) {
      this.setData({ loadingMore: false, loadError: true })
      return
    }

    const photos: PhotoItem[] = res.data.photos
    const incoming = photos.map((p) => ({
      ...p,
      thumbUrl: p.thumbUrl || getCached(this.projectId, 'thumb', p._id),
      selected: presetSelected ? presetSelected.has(p._id) : false,
    }))
    putBatch(
      this.projectId,
      'thumb',
      photos.filter((p) => !p.cached && p.thumbUrl).map((p) => ({ photoId: p._id, url: p.thumbUrl }))
    )

    if (res.data.archived && !this.data.archived) {
      this.setData({ archived: true })
      ;(wx as any).showToast({
        title: '项目已归档，大图已清理；缩略图和已选记录仍可查看',
        icon: 'none',
        duration: 3000,
      })
    }

    this.setData({
      loadingMore: false,
      loadError: false,
      hasMore: res.data.hasMore,
      packageCount: res.data.packageCount || this.data.packageCount,
      photos: [...this.data.photos, ...incoming],
    })
  },

  retryInit(this: any) {
    this.setData({ phase: 'loading', errorMsg: '' })
    this.init()
  },

  retryLoad(this: any) {
    this.loadMore()
  },

  onReachBottom(this: any) {
    if (this.data.phase !== 'ready') return
    if (this.data.loadError) return
    this.loadMore()
  },

  /** 全选本页（受套餐上限约束） */
  selectAllPage(this: any) {
    if (this.data.phase !== 'ready') return
    const limit = this.data.packageCount
    let room = limit > 0 ? limit - this.data.selectedCount : this.data.photos.length
    if (limit > 0 && room <= 0) {
      ;(wx as any).showToast({ title: `已达 ${limit} 张上限`, icon: 'none' })
      return
    }
    const photos = this.data.photos.map((p) => {
      if (p.selected || room <= 0) return p
      room -= 1
      return { ...p, selected: true }
    })
    this.dirty = true
    this.setData({ photos, selectedCount: photos.filter((p) => p.selected).length })
    this.scheduleSync()
  },

  /** 点选 / 取消 */
  toggle(this: any, e: any) {
    if (this.data.phase !== 'ready') return
    const id = e.currentTarget.dataset.id as string
    const target = this.data.photos.find((p) => p._id === id)
    const limit = this.data.packageCount

    if (target && !target.selected && limit > 0 && this.data.selectedCount >= limit) {
      ;(wx as any).showToast({ title: `最多选 ${limit} 张，先取消一张`, icon: 'none' })
      return
    }

    const photos = this.data.photos.map((p) =>
      p._id === id ? { ...p, selected: !p.selected } : p
    )
    this.dirty = true
    this.setData({ photos, selectedCount: photos.filter((p) => p.selected).length })
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
    const res = await saveSelection(this.projectId, this.modelId, ids)
    if (!res.ok) {
      this.dirty = true
      ;(wx as any).showToast({ title: '同步失败，稍后自动重试', icon: 'none' })
    }
  },

  openViewer(this: any, e: any) {
    const index = e.currentTarget.dataset.index as number
    wx.navigateTo({
      url: '/pages/photo-viewer/index?index=' + index,
      events: {
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
          projectId: this.projectId,
          modelId: this.modelId,
          index,
          photos: this.data.photos,
          locked: this.data.phase !== 'ready',
        })
      },
    })
  },

  async submit(this: any) {
    if (this.data.submitting) return
    const n = this.data.selectedCount
    const limit = this.data.packageCount
    if (n <= 0) {
      ;(wx as any).showToast({ title: '还没有选择照片', icon: 'none' })
      return
    }
    if (limit > 0 && n > limit) {
      ;(wx as any).showToast({ title: `最多只能选 ${limit} 张`, icon: 'none' })
      return
    }
    ;(wx as any).showModal({
      title: `确认提交这 ${n} 张？`,
      content: '提交后摄影师会收到通知；之后你仍可回来调整，重新提交即覆盖上一版。',
      cancelText: '再看看',
      confirmText: '确认提交',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ submitting: true })
        if (this.dirty) await this.syncNow()
        const ids = this.data.photos.filter((p) => p.selected).map((p) => p._id)
        const res = await submitSelection(this.projectId, this.modelId, ids)
        if (!res.ok) {
          this.setData({ submitting: false })
          ;(wx as any).showModal({ title: '提交失败', content: res.error || '', showCancel: false })
          return
        }
        this.setData({
          submitting: false,
          phase: 'locked',
          resubmitHint: true,
          selectedCount: res.data!.selectedCount,
        })
      },
    })
  },

  /** 提交成功页 → 继续调整 */
  reopen(this: any) {
    this.setData({ phase: 'ready' })
  },
})
