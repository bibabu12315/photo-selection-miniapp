import { callSafe } from './request'

/**
 * 选片相关 service
 * 模特端页面 → service → 云函数 selection → 数据库
 */

export interface ClientProject {
  projectId: string
  name: string
  clientName: string
  photoCount: number
  locked: boolean
  selectedCount: number
  selectedIds: string[]
}

export interface ClientPhoto {
  _id: string
  filename: string
  width: number
  height: number
  thumbUrl: string
}

/** 模特进入项目（token 来自小程序码 scene 或分享卡片参数） */
export async function clientEntry(token: string) {
  return callSafe<ClientProject>('selection', { action: 'entry', token })
}

/** 分页拉取照片 */
export async function getPhotos(token: string, skip: number, limit = 18) {
  return callSafe<{ photos: ClientPhoto[]; hasMore: boolean; locked: boolean }>('selection', {
    action: 'getPhotos',
    token,
    skip,
    limit,
  })
}

/** 单张预览图临时链接 */
export async function getPreviewUrl(token: string, photoId: string) {
  return callSafe<{ photoId: string; filename: string; previewUrl: string }>('selection', {
    action: 'getPreview',
    token,
    photoId,
  })
}

/** 保存选择（批量同步） */
export async function saveSelection(token: string, photoIds: string[]) {
  return callSafe<{ saved: boolean; selectedCount: number }>('selection', {
    action: 'saveSelection',
    token,
    photoIds,
  })
}

/** 提交并锁定 */
export async function submitSelection(token: string, photoIds: string[]) {
  return callSafe<{ locked: boolean; selectedCount: number }>('selection', {
    action: 'submitSelection',
    token,
    photoIds,
  })
}

/* ---------- 摄影师端 ---------- */

export interface ResultPhoto {
  _id: string
  filename: string
  thumbUrl: string
}

export async function getResult(projectId: string) {
  return callSafe<{
    locked: boolean
    submittedAt: number
    selectedCount: number
    photos: ResultPhoto[]
  }>('selection', { action: 'getResult', projectId })
}

export async function resetLock(projectId: string) {
  return callSafe<{ reset: boolean }>('selection', { action: 'resetLock', projectId })
}
