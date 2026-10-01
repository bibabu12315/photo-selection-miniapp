import { bindAdmin } from '../../services/project'
import { whoami } from '../../services/selection'

/**
 * 身份引导页
 * 只有「既不是摄影师、也不是模特」的人才会看到这里。
 * 摄影师：输一次口令永久绑定；模特：必须由摄影师发链接进入。
 */
Page({
  data: {
    key: '',
    binding: false,
    bindError: '',
    checking: true,
  },

  onLoad(this: any) {
    this.checkIdentity()
  },

  /** 进页面先确认身份：已绑定的直接放行，防止冷启动误跳到这页后又要求输口令 */
  async checkIdentity(this: any) {
    const res = await whoami()
    if (res.ok && res.data) {
      if (res.data.isAdmin) {
        ;(wx as any).reLaunch({ url: '/pages/home/index' })
        return
      }
      if (res.data.isModel) {
        ;(wx as any).reLaunch({ url: '/pages/model-home/index' })
        return
      }
    }
    this.setData({ checking: false })
  },

  retryCheck(this: any) {
    this.setData({ checking: true })
    this.checkIdentity()
  },

  onKeyInput(this: any, e: any) {
    this.setData({ key: e.detail.value, bindError: '' })
  },

  async bindAdminAction(this: any) {
    if (!this.data.key) {
      this.setData({ bindError: '请输入摄影师口令' })
      return
    }
    this.setData({ binding: true, bindError: '' })
    const res = await bindAdmin(this.data.key)
    if (!res.ok) {
      this.setData({ binding: false, bindError: res.error || '绑定失败' })
      return
    }
    const app: any = getApp()
    app.globalData.isAdmin = true
    app.globalData.loginReady = true
    ;(wx as any).showToast({ title: '绑定成功', icon: 'success' })
    setTimeout(() => {
      ;(wx as any).reLaunch({ url: '/pages/home/index' })
    }, 600)
  },
})
