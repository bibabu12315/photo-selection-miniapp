import { getProject } from '../../services/project'
import { getResult, resetLock, ResultPhoto } from '../../services/selection'
import { packageText, formatDate } from '../../utils/format'
import { Project } from '../../types'

/**
 * 摄影师端 · 选片结果（按模特分组）
 * 顶部切换模特 → 看她选了哪些 → 复制文件名回 Lightroom 找 RAW
 */

interface ModelTab {
  modelId: string
  name: string
  label: string
  active: boolean
}

Page({
  data: {
    id: '',
    loading: true,
    pkg: '',
    tabs: [] as ModelTab[],
    currentModelId: '',
    currentName: '',
    locked: false,
    selectedCount: 0,
    submittedText: '',
    photos: [] as ResultPhoto[],
    view: 'list' as 'list' | 'grid',
    resetting: false,
  },

  onLoad(this: any, query: Record<string, string>) {
    this.setData({ id: query.id || '' })
  },

  onShow(this: any) {
    if (this.data.id) this.loadProject()
  },

  async loadProject(this: any) {
    this.setData({ loading: true })
    const res = await getProject(this.data.id)
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      ;(wx as any).showModal({ title: '加载失败', content: res.error || '', showCancel: false })
      return
    }
    const p: Project = res.data.project
    const models = p.models || []
    const first = models[0]

    this.setData({
      pkg: packageText(p.packageCount),
      tabs: models.map((m, i) => ({
        modelId: m.modelId,
        name: m.name,
        label: `${m.name} ${m.selectedCount} 张`,
        active: i === 0,
      })),
      currentModelId: first ? first.modelId : '',
    })

    if (first) await this.loadResult(first.modelId)
  },

  async loadResult(this: any, modelId: string) {
    this.setData({ loading: true })
    const res = await getResult(this.data.id, modelId)
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      ;(wx as any).showModal({ title: '加载失败', content: res.error || '', showCancel: false })
      return
    }
    const name = (this.data.tabs.find((t: ModelTab) => t.modelId === modelId) || {} as ModelTab).name
    this.setData({
      locked: res.data.locked,
      selectedCount: res.data.selectedCount,
      submittedText: res.data.submittedAt ? formatDate(res.data.submittedAt) + ' 提交' : '',
      photos: res.data.photos,
      currentName: name || '',
      currentModelId: modelId,
    })
  },

  async switchModel(this: any, e: any) {
    const modelId = e.currentTarget.dataset.id as string
    if (!modelId || modelId === this.data.currentModelId) return
    const tabs = this.data.tabs.map((t: ModelTab) =>
      Object.assign({}, t, { active: t.modelId === modelId })
    )
    this.setData({ tabs })
    await this.loadResult(modelId)
  },

  switchView(this: any) {
    this.setData({ view: this.data.view === 'list' ? 'grid' : 'list' })
  },

  copyAll(this: any) {
    const names = this.data.photos.map((p) => p.filename).join('\n')
    if (!names) {
      ;(wx as any).showToast({ title: '这位模特还没有选片', icon: 'none' })
      return
    }
    ;(wx as any).setClipboardData({
      data: names,
      success: () => {
        ;(wx as any).showToast({ title: `已复制 ${this.data.photos.length} 个文件名`, icon: 'none' })
      },
    })
  },

  /** 重新开放某位模特的选片 */
  reopen(this: any) {
    if (!this.data.currentModelId) return
    ;(wx as any).showModal({
      title: `重新开放「${this.data.currentName}」的选片？`,
      content: '会清空她当前的选择，她可以重新选一次（微信身份保留，不需要重新发链接）。',
      confirmText: '确认开放',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ resetting: true })
        const res = await resetLock(this.data.id, this.data.currentModelId)
        this.setData({ resetting: false })
        if (!res.ok) {
          ;(wx as any).showModal({ title: '操作失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: '已重新开放', icon: 'success' })
        await this.loadResult(this.data.currentModelId)
      },
    })
  },
})
