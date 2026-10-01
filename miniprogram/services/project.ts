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
}

export async function createProject(input: CreateProjectInput) {
  return callSafe<{ _id: string }>('project', { action: 'create', ...input })
}

export async function listProjects() {
  return callSafe<{ projects: Project[] }>('project', { action: 'list' })
}

export async function getProject(_id: string) {
  return callSafe<{ project: Project; invites: InviteItem[] }>('project', { action: 'get', _id })
}

export async function removeProject(_id: string) {
  return callSafe<{ removed: boolean }>('project', { action: 'remove', _id })
}

/** 延期 30 天 */
export async function extendProject(_id: string) {
  return callSafe<{ expireAt: number }>('project', { action: 'extend', _id })
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

export async function bindAdmin(key: string) {
  return callSafe<{ bound: boolean; already: boolean }>('admin', { action: 'bind', key })
}
