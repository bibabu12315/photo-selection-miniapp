/**
 * 环境配置
 *
 * 唯一需要手改的地方：把 ENV_ID 换成你自己的云开发环境 ID。
 * 形如 photo-select-1a2b3c4d5e
 * 获取方式：微信开发者工具 → 云开发 → 环境 → 环境 ID
 */
export const ENV_ID = 'cloud1-d2guu7uw1a306815a'

/** 项目默认有效期（天） */
export const DEFAULT_EXPIRE_DAYS = 30

/** 缩略图与预览图默认规格 */
export const PREVIEW_PRESET = {
  standard: { longEdge: 2048, quality: 82 },
  high: { longEdge: 2880, quality: 90 },
}

/**
 * 电脑端上传页地址（CloudBase 静态托管默认域名 + /index.html）。
 * 开通静态托管后，把这里换成控制台给出的默认域名即可，
 * 例如 https://cloud1-xxxx-1304825656.tcloudbaseapp.com/index.html
 */
export const UPLOAD_PAGE_URL = 'https://cloud1-d2guu7uw1a306815a-1499127316.tcloudbaseapp.com/index.html'

