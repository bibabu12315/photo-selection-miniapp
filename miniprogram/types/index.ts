/** 项目状态机 */
export type ProjectStatus =
  | 'DRAFT'
  | 'UPLOADING'
  | 'SELECTING'
  | 'SELECTION_SUBMITTED'
  /** 已归档：大图已清理，只留缩略图和选片记录 */
  | 'ARCHIVED'

/** 预览规格档位 */
export type PreviewPreset = 'standard' | 'hd' | 'hdpro' | 'raw' | 'custom'

export interface PreviewSpec {
  preset: PreviewPreset
  longEdge: number
  quality: number
  watermarkText: string
}

/** 项目里某位模特的进度摘要（冗余在 project 上，列表页不用额外查） */
export interface ProjectModel {
  modelId: string
  name: string
  selectedCount: number
  status: '待选片' | '选片中' | '已提交'
  submittedAt: number
}

export interface Project {
  _id?: string
  name: string
  /** 备注，仅摄影师自己可见 */
  note: string
  /** 拍摄日期时间戳 */
  shootDate: number
  status: ProjectStatus
  previewSpec: PreviewSpec
  expireAt: number
  /** 套餐张数上限，0 = 不限 */
  packageCount: number
  /** 在线额度计量：当前占用字节数（preview + thumb），归档后只剩 thumb */
  usedBytes?: number
  /** 归档时间，0 = 未归档 */
  archivedAt?: number
  uploadCode: string
  uploadCodeExpireAt: number
  uploadToken: string
  uploadTokenExpireAt: number
  photoCount: number
  /** 封面缩略图 fileID，最多 3 张 */
  coverThumbs: string[]
  modelCount: number
  models: ProjectModel[]
  createdAt: number
  updatedAt: number
}

export interface Photo {
  _id?: string
  projectId: string
  /** 原始文件名，选片结果的核心输出，如 DSC00123.JPG */
  filename: string
  /** 去扩展名，如 DSC00123，与本地 ARW 同名对应 */
  stem: string
  /** 按文件名升序，与 Lightroom 默认顺序对齐 */
  sortOrder: number
  previewFileID: string
  thumbFileID: string
  width: number
  height: number
  previewBytes: number
  thumbBytes: number
  createdAt: number
  updatedAt: number
}

/** 模特档案：openid 为空表示还没被任何微信认领 */
export interface Model {
  _id?: string
  openid: string
  displayName: string
  createdAt: number
  updatedAt: number
}

/** 邀请：一个项目 × 一位模特一条，每项目最多 5 条 */
export interface Invite {
  _id?: string
  projectId: string
  modelId: string
  token: string
  createdAt: number
}

/** 选片记录：双人键（projectId + modelId） */
export interface Selection {
  _id?: string
  projectId: string
  modelId: string
  photoIds: string[]
  locked: boolean
  submittedAt: number
  createdAt: number
  updatedAt: number
}
