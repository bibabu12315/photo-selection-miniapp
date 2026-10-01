/** 项目状态机（终版，见 docs/技术方案V1.2-最小闭环.md） */
export type ProjectStatus =
  | 'DRAFT'
  | 'UPLOADING'
  | 'SELECTING'
  | 'SELECTION_SUBMITTED'
  | 'COMPLETED'
  | 'EXPIRED'

/** 预览规格档位 */
export type PreviewPreset = 'standard' | 'high' | 'custom'

export interface PreviewSpec {
  preset: PreviewPreset
  longEdge: number
  quality: number
  watermarkText: string
}

export interface Project {
  _id?: string
  name: string
  clientName: string
  status: ProjectStatus
  previewSpec: PreviewSpec
  expireAt: number
  accessToken: string
  uploadCode: string
  uploadCodeExpireAt: number
  photoCount: number
  selectedCount: number
  createdAt: number
  updatedAt: number
}

export interface Photo {
  _id?: string
  projectId: string
  /** 原始文件名，选片结果的核心输出，如 DSC00123.JPG */
  filename: string
  /** 去扩展名，如 DSC00123，预留用于将来匹配 ARW */
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

export interface Selection {
  _id?: string
  projectId: string
  /** 项目级单文档：已选照片 id 列表（按选片顺序） */
  photoIds: string[]
  /** 提交后锁定，模特不可再改 */
  locked: boolean
  submittedAt: number
  /** 首次进入后写入，之后不同 openid 拒绝访问（一码一人） */
  boundOpenid: string
  createdAt: number
  updatedAt: number
}
