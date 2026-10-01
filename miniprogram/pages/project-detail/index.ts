import { getProject, issueUploadCode, getQrCode } from '../../services/project'
import { statusText, formatDate, formatTime } from '../../utils/format'
import { Project } from '../../types'

Page({
  data: {
    id: '',
    loading: true,
    project: null as Project | null,
    statusText: '',
    expireText: '',
    /** 上传码是否仍在有效期内 */
    hasCode: false,
    codeExpireText: '',
    issuing: false,
    /** 模特选片小程序码（云存储 fileID，image 组件可直接显示） */
    qrFileID: '',
    qrMaking: false,
  },

  onLoad(this: any, query: Record<string, string>) {
    this.setData({ id: query.id || '' })
  },

  onShow(this: any) {
    if (this.data.id) this.load()
  },

  async load(this: any) {
    this.setData({ loading: true })
    const res = await getProject(this.data.id)
    if (!res.ok || !res.data) {
      this.setData({ loading: false })
      ;(wx as any).showModal({ title: '加载失败', content: res.error || '', showCancel: false })
      return
    }
    const p = res.data.project
    const hasCode = !!p.uploadCode && p.uploadCodeExpireAt > Date.now()
    this.setData({
      loading: false,
      project: p,
      statusText: statusText(p.status),
      expireText: formatDate(p.expireAt),
      hasCode,
      codeExpireText: hasCode ? formatTime(p.uploadCodeExpireAt) : '',
    })
  },

  async generateCode(this: any) {
    if (this.data.issuing) return
    this.setData({ issuing: true })
    const res = await issueUploadCode(this.data.id)
    if (!res.ok || !res.data) {
      this.setData({ issuing: false })
      ;(wx as any).showModal({ title: '签发失败', content: res.error || '', showCancel: false })
      return
    }
    const p = this.data.project as Project
    this.setData({
      issuing: false,
      hasCode: true,
      'project.uploadCode': res.data.uploadCode,
      codeExpireText: formatTime(res.data.uploadCodeExpireAt),
    })
    void p
    ;(wx as any).showToast({ title: '已生成，5 分钟内有效', icon: 'none' })
  },

  copyCode(this: any) {
    const p = this.data.project
    if (p && p.uploadCode) {
      ;(wx as any).setClipboardData({ data: p.uploadCode })
    }
  },

  /** 生成模特选片小程序码 */
  async makeQrCode(this: any) {
    if (this.data.qrMaking) return
    this.setData({ qrMaking: true })
    const res = await getQrCode(this.data.id)
    this.setData({ qrMaking: false })
    if (!res.ok || !res.data) {
      ;(wx as any).showModal({ title: '生成失败', content: res.error || '', showCancel: false })
      return
    }
    this.setData({ qrFileID: res.data.fileID })
  },

  openResult(this: any) {
    wx.navigateTo({ url: '/pages/selection-result/index?id=' + this.data.id })
  },

  /**
   * 复制选片入口链接。
   * 小程序未完成认证时，「生成小程序码」和「分享给模特」会被微信禁用，
   * 此时复制该链接手动填到开发者工具的自定义编译参数即可自测。
   * 认证通过后可删除本方法及页面上的对应按钮。
   */
  copyTestLink(this: any) {
    const p = this.data.project
    if (!p || !p.accessToken) {
      ;(wx as any).showToast({ title: '项目未加载', icon: 'none' })
      return
    }
    const path = '/pages/client-select/index?t=' + p.accessToken
    ;(wx as any).setClipboardData({
      data: path,
      success: () => {
        ;(wx as any).showModal({
          title: '已复制选片入口链接',
          content: 'token：' + p.accessToken + '\n\n把上面这串字符（注意大小写）填到开发者工具自定义编译的 query 参数里，或项目根目录 project.private.config.json 的 t= 后面。',
          showCancel: false,
        })
      },
    })
  },

  /** 分享给模特：卡片携带 accessToken，模特点开直接进项目 */
  onShareAppMessage(this: any) {
    const p = this.data.project
    return {
      title: p ? `「${p.name}」照片选片` : '照片选片',
      path: '/pages/client-select/index?t=' + (p ? p.accessToken : ''),
      imageUrl: this.data.qrFileID || undefined,
    }
  },
})
