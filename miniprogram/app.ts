import { ENV_ID } from './env'
import { whoami } from './services/selection'

/**
 * 是否输出调试日志。正式版（envType = release）静默。
 * 目的：① 发布前「无调试残留」检查；② 不要把 openid 打到正式版真机日志里。
 */
const IS_DEV = (() => {
  try {
    const info: any = (wx as any).getAccountInfoSync()
    return (info && info.miniProgram && info.miniProgram.envType) !== 'release'
  } catch (e) {
    return false
  }
})()

App({
  globalData: {
    /** 当前用户 openid */
    openid: '',
    /** 是否为摄影师（管理员） */
    isAdmin: false,
    /** 是否为模特（有模特档案） */
    isModel: false,
    /** 模特备注名 */
    displayName: '',
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
    if (IS_DEV) console.log('[app] cloudbase 初始化完成，env =', ENV_ID)
    this.fetchIdentity()
  },

  /**
   * 静默识别身份：摄影师 / 模特 / 路人。
   * 不弹窗、不需要授权，openid 在同一小程序内对该微信账号永久固定。
   */
  async fetchIdentity() {
    try {
      const res = await whoami()
      if (!res.ok || !res.data) {
        console.error('[app] 身份识别失败', res.error)
        return
      }
      const d = res.data
      this.globalData.openid = d.openid || ''
      this.globalData.isAdmin = !!d.isAdmin
      this.globalData.isModel = !!d.isModel
      this.globalData.displayName = d.displayName || ''
      this.globalData.loginReady = true
      if (IS_DEV)
        console.log(
          '[app] openid =',
          d.openid,
          'isAdmin =',
          d.isAdmin,
          'isModel =',
          d.isModel
        )
    } catch (err) {
      console.error('[app] 调用 selection 云函数失败，请确认已上传并部署', err)
    }
  },
})
