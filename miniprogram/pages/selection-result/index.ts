import { getResult, resetLock, ResultPhoto } from '../../services/selection'

/**
 * 摄影师端 · 选片结果
 * 列表展示选中照片（缩略图 + 文件名，按文件名升序与 Lightroom 对齐），
 * 支持复制全部文件名、重新开放选片。
 */
Page({
  data: {
    id: '',
    loading: true,
    locked: false,
    selectedCount: 0,
    photos: [] as ResultPhoto[],
    /** 视图模式：list（80px 缩略图 + 文件名）/ grid */
    view: 'list' as 'list' | 'grid',
    resetting: false,
  },

  onLoad(this: any, query: Record<string, string>) {
    this.setData({ id: query.id || '' })
  },

  onShow(this: any) {
    if (this.data.id) this.load()
  },

  async load(this: any) {
    this.setData({ loading: true })
    const res = await getResult(this.data.id)
    if (!res.ok || !res.data) {
      this.setData({ loading: false })
      ;(wx as any).showModal({ title: '加载失败', content: res.error || '', showCancel: false })
      return
    }
    this.setData({
      loading: false,
      locked: res.data.locked,
      selectedCount: res.data.selectedCount,
      photos: res.data.photos,
    })
  },

  switchView(this: any) {
    this.setData({ view: this.data.view === 'list' ? 'grid' : 'list' })
  },

  copyAll(this: any) {
    const names = this.data.photos.map((p) => p.filename).join('\n')
    if (!names) {
      ;(wx as any).showToast({ title: '暂无选片结果', icon: 'none' })
      return
    }
    ;(wx as any).setClipboardData({
      data: names,
      success: () => {
        ;(wx as any).showToast({ title: `已复制 ${this.data.photos.length} 个文件名`, icon: 'none' })
      },
    })
  },

  /** 重新开放选片：解锁 + 解绑模特微信 + 清空结果 */
  reopen(this: any) {
    ;(wx as any).showModal({
      title: '重新开放选片？',
      content: '将清空当前选片结果并解绑模特的微信账号，模特需要重新进入项目选片。',
      confirmText: '确认开放',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ resetting: true })
        const res = await resetLock(this.data.id)
        this.setData({ resetting: false })
        if (!res.ok) {
          ;(wx as any).showModal({ title: '操作失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: '已重新开放', icon: 'success' })
        this.load()
      },
    })
  },
})
