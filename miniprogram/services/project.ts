import { callSafe } from './request'
import { Project } from '../types'

/**
 * 项目相关 service（V2.0）
 * 页面 → service → 云函数 project → 数据库
 */

export interface CreateProjectInput {
  name: string
  note?: string
  shootDate?: string
  expireDays?: number
  packageCount?: number
}

export interface InviteItem {
  _id: string
  modelId: string
  token: string
  /** true = 还有一次数推送额度（模特提交时消耗） */
  notifyAuth?: boolean
}

export async function createProject(input: CreateProjectInput) {
  // 展开运算符会被 IDE 降级编译成 @babel/runtime helper（项目无 node_modules → 引用方页面白屏），这里用 Object.assign
  return callSafe<{ _id: string }>('project', Object.assign({ action: 'create' }, input))
}

export async function listProjects() {
  return callSafe<{ projects: Project[] }>('project', { action: 'list' })
}

export async function getProject(_id: string) {
  return callSafe<{ project: Project; invites: InviteItem[] }>('project', { action: 'get', _id })
}

export async function removeProject(_id: string) {
  return callSafe<{ removed: boolean; deletedFiles: number }>('project', { action: 'remove', _id })
}

/** 延期 30 天；已归档的项目续期后回到可上传状态（大图已删，需重新上传） */
export async function extendProject(_id: string) {
  return callSafe<{ expireAt: number; restored: boolean; needReupload: boolean }>('project', {
    action: 'extend',
    _id,
  })
}

/** 归档：删掉大图只留缩略图，占用降到原来的 4% */
export async function archiveProject(_id: string) {
  return callSafe<{ archived: boolean; deletedFiles: number; usedBytes: number }>('project', {
    action: 'archive',
    _id,
  })
}

/** 签发 6 位上传码，5 分钟有效 */
export async function issueUploadCode(_id: string) {
  return callSafe<{ uploadCode: string; uploadCodeExpireAt: number }>('project', {
    action: 'issueUploadCode',
    _id,
  })
}

/* ---------- 模特邀请 ---------- */

export async function createInvite(projectId: string, displayName: string) {
  return callSafe<{ inviteId: string; modelId: string }>('project', {
    action: 'createInvite',
    projectId,
    displayName,
  })
}

export async function removeInvite(inviteId: string) {
  return callSafe<{ removed: boolean }>('project', { action: 'removeInvite', inviteId })
}

/**
 * 登记「选片完成通知我」的一次授权（T-P2-3）
 * 前置：本函数被用户点击事件里 wx.requestSubscribeMessage 的「允许」回调调用
 */
export async function setInviteNotify(inviteId: string) {
  return callSafe<{ notifyAuth: boolean }>('project', { action: 'setInviteNotify', inviteId })
}

export async function listInvites(projectId: string) {
  return callSafe<{ invites: InviteItem[] }>('project', { action: 'listInvites', projectId })
}

/** 生成某位模特的小程序码（scene = 邀请 token） */
export async function getInviteQrCode(inviteId: string) {
  return callSafe<{ fileID: string }>('project', { action: 'getInviteQrCode', inviteId })
}

/* ---------- 摄影师身份（云函数 admin） ---------- */

export async function adminStatus() {
  return callSafe<{ openid: string; isAdmin: boolean }>('admin', { action: 'status' })
}

/** 零门槛开通摄影师：不需要口令，openid 即身份 */
export async function bindAdmin() {
  return callSafe<{ bound: boolean; already: boolean }>('admin', { action: 'bind' })
}

/** 一次性迁移：把没有归属的老项目归到自己名下（需要迁移密钥） */
export async function claimLegacy(key: string) {
  return callSafe<{ updated: number; owner: string }>('admin', { action: 'claimLegacy', key })
}
