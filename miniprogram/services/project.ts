import { callSafe } from './request'
import { Project } from '../types'

/**
 * 项目相关 service
 * 页面 → service → 云函数 project → 数据库
 */

export interface CreateProjectInput {
  name: string
  clientName?: string
  expireDays?: number
}

export async function createProject(input: CreateProjectInput) {
  return callSafe<{ _id: string }>('project', { action: 'create', ...input })
}

export async function listProjects() {
  return callSafe<{ projects: Project[] }>('project', { action: 'list' })
}

export async function getProject(_id: string) {
  return callSafe<{ project: Project }>('project', { action: 'get', _id })
}

export async function removeProject(_id: string) {
  return callSafe<{ removed: boolean }>('project', { action: 'remove', _id })
}

/** 签发 6 位一次性上传码，5 分钟有效 */
export async function issueUploadCode(_id: string) {
  return callSafe<{ uploadCode: string; uploadCodeExpireAt: number }>('project', {
    action: 'issueUploadCode',
    _id,
  })
}

/** 生成模特选片小程序码（scene=accessToken），返回云存储 fileID */
export async function getQrCode(_id: string) {
  return callSafe<{ fileID: string }>('project', { action: 'getQrCode', _id })
}

/* ---------- 管理员绑定（云函数 admin） ---------- */

export async function adminStatus() {
  return callSafe<{ openid: string; isAdmin: boolean }>('admin', { action: 'status' })
}

export async function bindAdmin(key: string) {
  return callSafe<{ bound: boolean; already: boolean }>('admin', { action: 'bind', key })
}
