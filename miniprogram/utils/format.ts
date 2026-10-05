/** 项目状态 → 中文展示文案 */
export const STATUS_TEXT: Record<string, string> = {
  DRAFT: '草稿 · 等待上传照片',
  UPLOADING: '照片上传中',
  SELECTING: '等待模特选片',
  SELECTION_SUBMITTED: '已提交选片',
  ARCHIVED: '已归档',
}

export function statusText(status: string): string {
  return STATUS_TEXT[status] || status
}

/** 时间戳 → 2026-10-01 形式 */
export function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 时间戳 → 11:05 形式 */
export function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => (n < 10 ? '0' + n : '' + n)
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 有效期剩余天数：已过期返回 -1 */
export function daysLeft(expireAt: number): number {
  if (!expireAt) return -1
  const diff = expireAt - Date.now()
  if (diff <= 0) return -1
  return Math.ceil(diff / 86400000)
}

/** 剩余天数文案，如「剩 22 天」/「已过期」 */
export function expireText(expireAt: number): string {
  const d = daysLeft(expireAt)
  return d < 0 ? '已过期' : `剩 ${d} 天`
}

/** 拍摄日期文案，如「2026-09-21 拍摄」 */
export function shootText(ts: number): string {
  return ts ? formatDate(ts) + ' 拍摄' : '未填拍摄日期'
}

/** 套餐张数文案：0 = 不限 */
export function packageText(packageCount: number): string {
  return packageCount && packageCount > 0 ? `${packageCount} 张` : '不限'
}
