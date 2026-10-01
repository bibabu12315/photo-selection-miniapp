/**
 * 身份工具（V2.0）
 *
 * 摄影师 = openid 白名单（口令绑定一次）
 * 模特   = 有 model 档案（首次由邀请链接认领，之后靠 openid 自动识别）
 * 都不做登录 UI，用户全程无感知。
 */

export interface Session {
  openid: string
  isAdmin: boolean
  isModel: boolean
  displayName: string
  ready: boolean
}

/** 读取全局登录态 */
export function getSession(): Session {
  const app: any = getApp()
  const g = (app && app.globalData) || {}
  return {
    openid: g.openid || '',
    isAdmin: !!g.isAdmin,
    isModel: !!g.isModel,
    displayName: g.displayName || '',
    ready: !!g.loginReady,
  }
}

/**
 * 等待登录态就绪，最多等 3 秒
 * 云函数冷启动可能比页面 onLoad 慢，页面渲染前调一次
 */
export function waitForSession(timeout = 3000): Promise<Session> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const s = getSession()
      if (s.ready || Date.now() - started > timeout) {
        resolve(s)
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}
