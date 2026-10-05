import {
  getProject,
  issueUploadCode,
  extendProject,
  archiveProject,
  removeProject,
  createInvite,
  removeInvite,
  setInviteNotify,
  getInviteQrCode,
  InviteItem,
} from '../../services/project'
import { shootText, expireText, packageText, formatTime } from '../../utils/format'
import { UPLOAD_PAGE_URL, SUBSCRIBE_TPL_ID } from '../../env'
import { Project } from '../../types'
import { clearProject } from '../../services/urlcache'

/**
 * 摄影师端 · 项目工作台
 * 三区块按拍照流程排：① 照片（上传引导） ② 模特（最多 5 位） ③ 结果
 */

const MAX_MODELS = 5

/** 复制邀请链接后弹窗里的补充说明 */
const INVITE_LINK_HINT =
  '\n\n小程序未认证时「分享」和「小程序码」会被微信禁用，把这串路径填到开发者工具的自定义编译参数里即可自测；认证通过后可直接分享给模特。'

interface ModelVM {
  inviteId: string
  modelId: string
  token: string
  name: string
  status: string
  statusClass: string
  progress: string
  /** true = 还没授权通知，显示「通知我」按钮 */
  needNotify: boolean
}

Page({
  data: {
    id: '',
    loading: true,
    project: null as Project | null,
    shoot: '',
    expire: '',
    pkg: '',
    note: '',
    /** 状态进度条：上传 → 选片 → 提交 → 导出（派生，不落库，BR-204） */
    steps: [] as { text: string; done: boolean }[],

    /** ① 照片 */
    hasCode: false,
    code: '——',
    codeExpireText: '',
    issuing: false,
    uploadUrl: UPLOAD_PAGE_URL,
    showUpload: false,

    /** ② 模特 */
    models: [] as ModelVM[],
    modelCountText: '0 / ' + MAX_MODELS,
    showInvite: false,
    inviteName: '',
    inviting: false,
    qrFileID: '',
    qrModelId: '',
    qrMaking: false,

    /** 结果 */
    submittedCount: 0,

    /** 归档与占用 */
    isArchived: false,
    usedText: '',
  },

  onLoad(this: any, query: Record<string, string>) {
    this.setData({ id: query.id || '' })
  },

  onShow(this: any) {
    if (this.data.id) this.load()
  },

  async onPullDownRefresh(this: any) {
    await this.load()
    ;(wx as any).stopPullDownRefresh()
  },

  async load(this: any) {
    this.setData({ loading: true })
    const res = await getProject(this.data.id)
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      ;(wx as any).showModal({ title: '加载失败', content: res.error || '', showCancel: false })
      return
    }
    const p: Project = res.data.project
    const invites: InviteItem[] = res.data.invites || []
    const tokenMap: Record<string, string> = {}
    const notifyMap: Record<string, boolean> = {}
    invites.forEach((i) => {
      tokenMap[i.modelId] = i.token
      notifyMap[i.modelId] = !!i.notifyAuth
    })

    const models: ModelVM[] = (p.models || []).map((m) => ({
      inviteId: inviteIdOf(invites, m.modelId),
      modelId: m.modelId,
      token: tokenMap[m.modelId] || '',
      name: m.name,
      status: m.status,
      statusClass:
        m.status === '已提交' ? 'green' : m.status === '选片中' ? 'amber' : '',
      progress:
        m.status === '已提交'
          ? `已提交 ${m.selectedCount} 张`
          : `已选 ${m.selectedCount} / ${packageText(p.packageCount)}`,
      needNotify: !notifyMap[m.modelId],
    }))

    const submittedCount = (p.models || []).filter((m) => m.status === '已提交').length
    // 状态进度条：四步全部由现有字段派生，不新增存储状态（BR-204 / B-3）
    const steps = [
      { text: '上传', done: (p.photoCount || 0) > 0 },
      { text: '选片', done: (p.models || []).some((m) => m.selectedCount > 0) },
      { text: '提交', done: submittedCount > 0 },
      { text: '导出', done: models.length > 0 && submittedCount === models.length },
    ]

    const hasCode = !!p.uploadCode && p.uploadCodeExpireAt > Date.now()
    this.setData({
      project: p,
      steps,
      shoot: shootText(p.shootDate),
      expire: expireText(p.expireAt),
      pkg: packageText(p.packageCount),
      note: p.note || '',
      models,
      modelCountText: `${models.length} / ${MAX_MODELS}`,
      submittedCount,
      hasCode,
      code: hasCode ? p.uploadCode : '——',
      codeExpireText: hasCode ? formatTime(p.uploadCodeExpireAt) : '',
      isArchived: p.status === 'ARCHIVED',
      usedText: bytesText(p.usedBytes),
    })
  },

  /* ---------- ① 照片：上传引导 ---------- */

  openUpload(this: any) {
    this.setData({ showUpload: true })
    if (!this.data.hasCode) this.generateCode()
  },

  closeUpload(this: any) {
    this.setData({ showUpload: false })
  },

  async generateCode(this: any) {
    if (this.data.issuing) return
    this.setData({ issuing: true })
    const res = await issueUploadCode(this.data.id)
    this.setData({ issuing: false })
    if (!res.ok || !res.data) {
      ;(wx as any).showToast({ title: res.error || '生成失败', icon: 'none' })
      return
    }
    this.setData({
      hasCode: true,
      code: res.data.uploadCode,
      codeExpireText: formatTime(res.data.uploadCodeExpireAt),
    })
  },

  copyUploadInfo(this: any) {
    const hasCode = !!this.data.code && this.data.code !== '——'
    // 码直接拼进网址：浏览器粘贴一次 = 打开页面 + 自动填好上传码
    const text = hasCode ? `${this.data.uploadUrl}?code=${this.data.code}` : this.data.uploadUrl
    ;(wx as any).setClipboardData({
      data: text,
      success: () => {
        ;(wx as any).showToast({
          title: hasCode ? '已复制，浏览器粘贴直接打开' : '已复制网址',
          icon: 'none',
        })
      },
    })
  },

  /** 点网址框：只复制网址（电脑微信里复制即进电脑剪贴板，粘贴即可打开） */
  copyUploadUrl(this: any) {
    ;(wx as any).setClipboardData({
      data: this.data.uploadUrl,
      success: () => {
        ;(wx as any).showToast({ title: '网址已复制，去浏览器粘贴打开', icon: 'none' })
      },
    })
  },

  /** 点上传码框：只复制上传码 */
  copyUploadCode(this: any) {
    ;(wx as any).setClipboardData({
      data: this.data.code,
      success: () => {
        ;(wx as any).showToast({ title: '上传码已复制', icon: 'none' })
      },
    })
  },

  /* ---------- ② 模特 ---------- */

  openInviteModal(this: any) {
    if ((this.data.project as Project).models.length >= MAX_MODELS) {
      ;(wx as any).showToast({ title: `最多 ${MAX_MODELS} 位模特`, icon: 'none' })
      return
    }
    this.setData({ showInvite: true, inviteName: '' })
  },

  closeInviteModal(this: any) {
    this.setData({ showInvite: false })
  },

  onInviteName(this: any, e: any) {
    this.setData({ inviteName: e.detail.value })
  },

  async confirmInvite(this: any) {
    const name = this.data.inviteName.trim()
    if (!name) {
      ;(wx as any).showToast({ title: '请填写模特名字', icon: 'none' })
      return
    }
    this.setData({ inviting: true })
    const res = await createInvite(this.data.id, name)
    this.setData({ inviting: false })
    if (!res.ok) {
      ;(wx as any).showModal({ title: '邀请失败', content: res.error || '', showCancel: false })
      return
    }
    this.setData({ showInvite: false })
    ;(wx as any).showToast({ title: '已生成邀请链接', icon: 'success' })
    await this.load()
  },

  copyInviteLink(this: any, e: any) {
    const idx = Number(e.currentTarget.dataset.index)
    const m = this.data.models[idx]
    if (!m) return
    const path = `/pages/client-select/index?t=${m.token}`
    ;(wx as any).setClipboardData({
      data: path,
      success: () => {
        ;(wx as any).showModal({
          title: `${m.name} 的邀请链接`,
          content: path + INVITE_LINK_HINT,
          showCancel: false,
        })
      },
    })
  },

  /**
   * 「通知我」：为她开启一次提交通知（T-P2-3）
   * 微信规则：一次授权 = 一次推送；她提交时消耗这一次，之后想再收要点第二次
   */
  tapNotify(this: any, e: any) {
    const idx = Number(e.currentTarget.dataset.index)
    const m = this.data.models[idx]
    if (!m || !m.inviteId) return
    ;(wx as any).requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TPL_ID],
      success: async (r: any) => {
        if (r[SUBSCRIBE_TPL_ID] !== 'accept') {
          ;(wx as any).showToast({ title: '已取消，她提交时不会提醒你', icon: 'none' })
          return
        }
        const res = await setInviteNotify(m.inviteId)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '登记失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: `已开启，${m.name} 提交时会提醒你`, icon: 'none' })
        await this.load()
      },
    })
  },

  async makeQrCode(this: any, e: any) {
    const idx = Number(e.currentTarget.dataset.index)
    const m = this.data.models[idx]
    if (!m || this.data.qrMaking) return
    this.setData({ qrMaking: true })
    const res = await getInviteQrCode(m.inviteId)
    this.setData({ qrMaking: false })
    if (!res.ok || !res.data) {
      ;(wx as any).showModal({ title: '生成失败', content: res.error || '', showCancel: false })
      return
    }
    this.setData({ qrFileID: res.data.fileID, qrModelId: m.modelId })
  },

  closeQr(this: any) {
    this.setData({ qrFileID: '', qrModelId: '' })
  },

  tapRemoveInvite(this: any, e: any) {
    const idx = Number(e.currentTarget.dataset.index)
    const m = this.data.models[idx]
    if (!m) return
    ;(wx as any).showModal({
      title: `移除「${m.name}」？`,
      content: '会同时清空她的选片结果，之后需要重新邀请。',
      confirmText: '移除',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await removeInvite(m.inviteId)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '操作失败', content: res.error || '', showCancel: false })
          return
        }
        await this.load()
      },
    })
  },

  /* ---------- ③ 结果 ---------- */

  /** 弹层内部空点击，防止冒泡到遮罩导致误关闭 */
  noop() {},

  openResult(this: any) {
    ;(wx as any).navigateTo({ url: '/pages/selection-result/index?id=' + this.data.id + '&view=list' })
  },

  /** 照片墙（B-4 的页面：默认进照片墙视图，与网页端一致） */
  openWall(this: any) {
    ;(wx as any).navigateTo({ url: '/pages/selection-result/index?id=' + this.data.id + '&view=wall' })
  },

  /* ---------- 其他 ---------- */

  /** 归档：删掉大图只留缩略图，占用降到原来的 4% */
  tapArchiveProject(this: any) {
    ;(wx as any).showModal({
      title: '归档这个项目？',
      content:
        '会删掉云端的大图（缩略图保留），占用降到原来的 4%。项目名、模特和已选的文件名都还在，随时可回顾；如需重新选片，续期后再传一次照片。',
      confirmText: '归档',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await archiveProject(this.data.id)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '归档失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: '已归档，占用已释放', icon: 'success' })
        await this.load()
      },
    })
  },

  extend(this: any) {
    const archived = this.data.isArchived
    ;(wx as any).showModal({
      title: '延期 30 天？',
      content: archived
        ? '这个项目已归档，延期后回到可上传状态。大图之前已清理，需要重新上传照片才能再选片。'
        : '项目已过期或快到期时，给模特多留一点选片时间。',
      confirmText: '延期',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await extendProject(this.data.id)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '操作失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({
          title: archived ? '已延期，请重新上传照片' : '已延期 30 天',
          icon: 'success',
        })
        await this.load()
      },
    })
  },

  tapRemoveProject(this: any) {
    ;(wx as any).showModal({
      title: '删除项目？',
      content: '会同时删除该项目的邀请、选片、照片记录，以及云存储上的图片（不可恢复）。',
      confirmText: '删除',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await removeProject(this.data.id)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '删除失败', content: res.error || '', showCancel: false })
          return
        }
        clearProject(this.data.id)
        ;(wx as any).navigateBack()
      },
    })
  },

  /** 分享：默认分享第一位模特的邀请链接 */
  onShareAppMessage(this: any) {
    const p: Project = this.data.project
    const first = this.data.models[0]
    return {
      title: p ? `「${p.name}」照片选片` : '照片选片',
      path: first ? `/pages/client-select/index?t=${first.token}` : '/pages/home/index',
      imageUrl: this.data.qrFileID || undefined,
    }
  },
})

/** 字节数 → 人话 */
function bytesText(n: number): string {
  const v = Number(n) || 0
  if (v <= 0) return ''
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

function inviteIdOf(invites: InviteItem[], modelId: string): string {
  const hit = invites.find((i) => i.modelId === modelId)
  return hit ? hit._id : ''
}
