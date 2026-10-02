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

/**
 * 预览图规格（与 web/upload.js 的 PRESETS 保持一致）
 * 默认 standard = 1600 / 75：存储 + CDN 直接砍一半，是最划算的一档
 */
export const PREVIEW_PRESET = {
  standard: { longEdge: 1600, quality: 75 },
  hd: { longEdge: 2048, quality: 82 },
  hdpro: { longEdge: 2880, quality: 90 },
  raw: { longEdge: 4096, quality: 92 },
}

/** 每档的单张预览图体积（MB），仅用于界面上给摄影师一个直观提示 */
export const PRESET_SIZE_MB: Record<string, number> = {
  standard: 0.25,
  hd: 0.55,
  hdpro: 1.2,
  raw: 2.2,
}

/**
 * 电脑端上传页地址（CloudBase 静态托管默认域名 + /index.html）。
 * 开通静态托管后，把这里换成控制台给出的默认域名即可，
 * 例如 https://cloud1-xxxx-1304825656.tcloudbaseapp.com/index.html
 */
export const UPLOAD_PAGE_URL = 'https://cloud1-d2guu7uw1a306815a-1499127316.tcloudbaseapp.com/index.html'

