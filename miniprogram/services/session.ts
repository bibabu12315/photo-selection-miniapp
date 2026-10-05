import { callSafe } from './request'

/**
 * 网页扫码登录相关 service（V2.0 T-P1-2）
 * 页面 → service → 云函数 session
 */

/** 小程序扫码后认领登录票据：成功后网页端轮询到 ACTIVE 即自动进入 */
export function claimLoginTicket(ticket: string) {
  return callSafe<{ ok: boolean; displayName: string }>('session', { action: 'claim', ticket })
}
