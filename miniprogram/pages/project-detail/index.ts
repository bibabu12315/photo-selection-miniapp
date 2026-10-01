import {
  getProject,
  issueUploadCode,
  extendProject,
  removeProject,
  createInvite,
  removeInvite,
  getInviteQrCode,
  InviteItem,
} from '../../services/project'
import { shootText, expireText, packageText, formatTime } from '../../utils/format'
import { UPLOAD_PAGE_URL } from '../../env'
import { Project } from '../../types'

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
    invites.forEach((i) => {
      tokenMap[i.modelId] = i.token
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
    }))

    const hasCode = !!p.uploadCode && p.uploadCodeExpireAt > Date.now()
    this.setData({
      project: p,
      shoot: shootText(p.shootDate),
      expire: expireText(p.expireAt),
      pkg: packageText(p.packageCount),
      note: p.note || '',
      models,
      modelCountText: `${models.length} / ${MAX_MODELS}`,
      submittedCount: (p.models || []).filter((m) => m.status === '已提交').length,
      hasCode,
      code: hasCode ? p.uploadCode : '——',
      codeExpireText: hasCode ? formatTime(p.uploadCodeExpireAt) : '',
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
    ;(wx as any).navigateTo({ url: '/pages/selection-result/index?id=' + this.data.id })
  },

  /* ---------- 其他 ---------- */

  extend(this: any) {
    ;(wx as any).showModal({
      title: '延期 30 天？',
      content: '项目已过期或快到期时，给模特多留一点选片时间。',
      confirmText: '延期',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await extendProject(this.data.id)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '操作失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: '已延期 30 天', icon: 'success' })
        await this.load()
      },
    })
  },

  tapRemoveProject(this: any) {
    ;(wx as any).showModal({
      title: '删除项目？',
      content: '会同时删除该项目的邀请、选片和照片记录，云存储里的图片需到控制台手动清理。',
      confirmText: '删除',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await removeProject(this.data.id)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '删除失败', content: res.error || '', showCancel: false })
          return
        }
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

function inviteIdOf(invites: InviteItem[], modelId: string): string {
  const hit = invites.find((i) => i.modelId === modelId)
  return hit ? hit._id : ''
}
