/**
 * 身份工具
 *
 * 摄影师身份 = openid 白名单，不做登录 UI。
 * 见 docs/安全与访问控制.md
 */

/** 读取全局登录态 */
export function getSession(): { openid: string; isAdmin: boolean; ready: boolean } {
  const app: any = getApp()
  const g = (app && app.globalData) || {}
  return {
    openid: g.openid || '',
    isAdmin: !!g.isAdmin,
    ready: !!g.loginReady,
  }
}

/**
 * 等待登录态就绪，最多等 3 秒
 * 云函数冷启动可能比页面 onLoad 慢，页面渲染前调一次
 */
export function waitForSession(timeout = 3000): Promise<{ openid: string; isAdmin: boolean }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const s = getSession()
      if (s.ready || Date.now() - started > timeout) {
        resolve({ openid: s.openid, isAdmin: s.isAdmin })
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}
