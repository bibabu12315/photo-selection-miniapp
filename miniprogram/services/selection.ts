import { callSafe } from './request'

/**
 * 选片相关 service（V2.0）
 * 页面 → service → 云函数 selection → 数据库
 */

export interface WhoamiResult {
  openid: string
  isAdmin: boolean
  isModel: boolean
  displayName: string
}

export interface EntryResult {
  projectId: string
  modelId: string
  displayName: string
  projectName: string
  photoCount: number
  packageCount: number
  locked: boolean
  selectedIds: string[]
}

export interface MyProjectItem {
  key: string
  projectId: string
  modelId: string
  name: string
  shootDate: number
  photoCount: number
  packageCount: number
  expireAt: number
  selectedCount: number
  locked: boolean
  expired: boolean
  coverUrls: string[]
}

export interface ClientPhoto {
  _id: string
  filename: string
  width: number
  height: number
  thumbUrl: string
}

/** 我是谁：摄影师 / 模特 / 路人 */
export async function whoami() {
  return callSafe<WhoamiResult>('selection', { action: 'whoami' })
}

/**
 * 进入选片页
 * @param token 邀请 token（首次从链接进入）
 * @param projectId + modelId 老模特从「我的拍摄」直接进
 */
export async function enterSelection(token: string, projectId = '', modelId = '') {
  return callSafe<EntryResult>('selection', { action: 'entry', token, projectId, modelId })
}

/** 我的拍摄：该模特名下全部项目 */
export async function myProjects() {
  return callSafe<{ items: MyProjectItem[]; displayName: string }>('selection', {
    action: 'myList',
  })
}

export interface PhotoItem extends ClientPhoto {
  /** true = 端上已有有效缓存，服务端没生成链接 */
  cached?: boolean
}

/** 分页拉取照片。have = 端上已缓存的 photoId，服务端跳过这些不再取临时链接 */
export async function getPhotos(
  projectId: string,
  modelId: string,
  skip: number,
  limit = 18,
  have: string[] = []
) {
  return callSafe<{
    photos: PhotoItem[]
    hasMore: boolean
    locked: boolean
    packageCount: number
    archived: boolean
  }>('selection', { action: 'getPhotos', projectId, modelId, skip, limit, have })
}

/**
 * 大图临时链接
 * range = 2 时一次返回当前张 + 前后各 2 张，滑动连看不再每张一次调用
 */
export async function getPreviewUrl(
  projectId: string,
  modelId: string,
  photoId: string,
  range = 2
) {
  return callSafe<{
    photoId: string
    filename: string
    previewUrl: string
    list: { photoId: string; filename: string; previewUrl: string }[]
  }>('selection', {
    action: 'getPreview',
    projectId,
    modelId,
    photoId,
    range,
  })
}

/** 保存选择（防抖批量同步） */
export async function saveSelection(projectId: string, modelId: string, photoIds: string[]) {
  return callSafe<{ saved: boolean; selectedCount: number }>('selection', {
    action: 'saveSelection',
    projectId,
    modelId,
    photoIds,
  })
}

/** 提交并锁定 */
export async function submitSelection(projectId: string, modelId: string, photoIds: string[]) {
  return callSafe<{ locked: boolean; selectedCount: number }>('selection', {
    action: 'submitSelection',
    projectId,
    modelId,
    photoIds,
  })
}

/* ---------- 摄影师端 ---------- */

export interface ResultPhoto {
  _id: string
  filename: string
  thumbUrl: string
}

/** 某位模特的选片结果 */
export async function getResult(projectId: string, modelId: string) {
  return callSafe<{
    locked: boolean
    submittedAt: number
    selectedCount: number
    photos: ResultPhoto[]
  }>('selection', { action: 'getResult', projectId, modelId })
}

/** 重新开放某位模特的选片 */
export async function resetLock(projectId: string, modelId: string) {
  return callSafe<{ reset: boolean }>('selection', { action: 'resetLock', projectId, modelId })
}
