import { ENV_ID } from './env'

App({
  globalData: {
    /** 当前用户 openid，登录后填充 */
    openid: '',
    /** 是否为摄影师（管理员），登录后填充 */
    isAdmin: false,
    /** 登录态是否已就绪 */
    loginReady: false,
  },

  onLaunch() {
    // 用 any 断言，避免不同版本基础库类型声明缺失 wx.cloud 时编译报错
    const cloud: any = (wx as any).cloud
    if (!cloud) {
      console.error('[app] 当前基础库不支持云开发，请在开发者工具详情中调高基础库版本')
      return
    }
    cloud.init({
      env: ENV_ID,
      traceUser: true,
    })
    console.log('[app] cloudbase 初始化完成，env =', ENV_ID)
    this.fetchOpenid()
  },

  /**
   * 静默获取 openid，不弹窗、不需要授权。
   * openid 在同一小程序内对该微信账号永久固定。
   */
  async fetchOpenid() {
    try {
      const res: any = await (wx as any).cloud.callFunction({
        name: 'ping',
        data: { action: 'whoami' },
      })
      const result = res && res.result
      const d = result && result.data
      if (result && result.ok && d) {
        this.globalData.openid = d.openid || ''
        this.globalData.isAdmin = !!d.isAdmin
        this.globalData.loginReady = true
        console.log('[app] openid =', this.globalData.openid, 'isAdmin =', this.globalData.isAdmin)
      } else {
        console.error('[app] 获取 openid 失败', result)
      }
    } catch (err) {
      console.error('[app] 调用 ping 云函数失败，请确认已上传并部署', err)
    }
  },
})
