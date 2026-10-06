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
 * 预览图规格（与 web/uploader.js 的 PRESETS 保持一致）
 * 标清 1200 / 高清 1600 / 高清 Pro 2880 / 原画质 4096（standard 为旧档位名 = 高清，仅兼容历史数据）
 */
export const PREVIEW_PRESET = {
  low: { longEdge: 1200, quality: 55 },
  hd: { longEdge: 1600, quality: 75 },
  hdpro: { longEdge: 2880, quality: 90 },
  raw: { longEdge: 4096, quality: 92 },
  standard: { longEdge: 1600, quality: 75 },
}

/** 每档的单张预览图体积（MB），仅用于界面上给摄影师一个直观提示 */
export const PRESET_SIZE_MB: Record<string, number> = {
  low: 0.14,
  hd: 0.25,
  hdpro: 1.2,
  raw: 2.2,
  standard: 0.25,
}

/**
 * 电脑端上传页地址（CloudBase 静态托管默认域名 + /index.html）。
 * 开通静态托管后，把这里换成控制台给出的默认域名即可，
 * 例如 https://cloud1-xxxx-1304825656.tcloudbaseapp.com/index.html
 */
export const UPLOAD_PAGE_URL = 'https://cloud1-d2guu7uw1a306815a-1499127316.tcloudbaseapp.com/index.html'

/**
 * 订阅消息模板 ID（「用户加入任务提醒」，一次性订阅）
 * 字段对应：thing1=用户(模特名) thing2=任务名称(项目名) time3=时间
 * 云函数侧的同名配置在云开发控制台环境变量里，改模板时两处都要改
 */
export const SUBSCRIBE_TPL_ID = 'Ftb4YWeLOPWm69U0p7ucsKOVXOOGdd_lU9cU0fNRXoY'

