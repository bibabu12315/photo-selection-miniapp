import { callSafe } from './request'

/**
 * 照片墙 service（U-0 / B-4）
 * 摄影师视角列出项目全部照片，规格见 docs/55_PHOTO_LIST_API_SPEC.md
 */

export interface WallPhoto {
  _id: string
  filename: string
  /** 预览图尺寸，瀑布流算格子高度用 */
  width: number
  height: number
  thumbUrl: string
  /** 大图 fileID，点开大图时按需换临时链接（不批量取，省调用） */
  previewFileID: string
  /** true = 端上已有缓存，服务端没生成链接 */
  cached: boolean
  /** 选中这张的模特 ID 数组；无人选 = [] */
  selectedBy: string[]
}

export interface WallModel {
  modelId: string
  displayName: string
  selectedCount: number
  locked: boolean
}

export interface WallResult {
  photos: WallPhoto[]
  hasMore: boolean
  total: number
  models: WallModel[]
  archived: boolean
  packageCount: number
}

/**
 * 分页拉取照片墙
 * @param filter 'all' / 'selected' / 'unselected'（modelId 仅在 selected 时生效）
 * @param have   端上已缓存的 photoId，服务端跳过不再取临时链接
 */
export async function listPhotos(params: {
  projectId: string
  skip?: number
  limit?: number
  filter?: 'all' | 'selected' | 'unselected'
  modelId?: string
  have?: string[]
}) {
  return callSafe<WallResult>('photo', {
    action: 'list',
    projectId: params.projectId,
    skip: params.skip || 0,
    limit: params.limit || 18,
    filter: params.filter || 'all',
    modelId: params.modelId || '',
    have: params.have || [],
  })
}

/**
 * 重取缩略图临时链接（瀑布流图片加载失败时自愈）
 * 云端临时链接只有约 10 分钟有效期，慢慢滚必然有链接过期，失败就换一条新的。
 */
export async function refreshThumbUrls(projectId: string, photoIds: string[]) {
  return callSafe<{ list: { photoId: string; thumbUrl: string }[] }>('photo', {
    action: 'thumbUrls',
    projectId,
    photoIds,
  })
}

/**
 * 单张大图临时链接（照片墙点开看大图）。
 * 走云函数服务端取链，与缩略图同一条已验证路径，不依赖客户端直连存储。
 */
export async function getPreviewUrl(projectId: string, photoId: string) {
  return callSafe<{ previewUrl: string; filename: string }>('photo', {
    action: 'previewUrl',
    projectId,
    photoId,
  })
}
