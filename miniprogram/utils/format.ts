/** 项目状态 → 中文展示文案 */
export const STATUS_TEXT: Record<string, string> = {
  DRAFT: '草稿 · 等待上传照片',
  UPLOADING: '照片上传中',
  SELECTING: '等待模特选片',
  SELECTION_SUBMITTED: '已提交选片',
  COMPLETED: '已完成',
  EXPIRED: '已过期',
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
