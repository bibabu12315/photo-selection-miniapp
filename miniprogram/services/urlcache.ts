/**
 * 临时链接端上缓存
 *
 * 云端 getTempFileURL 现在下发 24 小时有效期，这里缓存 20 小时（留 4 小时余量）。
 * 同一项目在有效期内重复打开，直接读本地缓存，不再请求临时链接。
 * 缓存按「项目 + 用途（缩略图 / 大图）」分桶，缩略图和大图互不覆盖。
 */

/** 缓存有效期：20 小时（云端 24 小时，留余量） */
const TTL = 20 * 3600 * 1000
/** 单个项目单桶最多缓存条数，防止老数据堆积 */
const MAX_ENTRIES = 3000

export type UrlKind = 'thumb' | 'preview'

interface Entry {
  u: string
  e: number
}

function storageKey(projectId: string, kind: UrlKind) {
  return `psurl_${kind}_${projectId}`
}

function read(projectId: string, kind: UrlKind): Record<string, Entry> {
  try {
    const raw = (wx as any).getStorageSync(storageKey(projectId, kind))
    if (!raw || typeof raw !== 'object') return {}
    return raw as Record<string, Entry>
  } catch (e) {
    return {}
  }
}

function write(projectId: string, kind: UrlKind, map: Record<string, Entry>) {
  try {
    ;(wx as any).setStorageSync(storageKey(projectId, kind), map)
  } catch (e) {
    // 超配额时静默放弃缓存，不影响主流程
  }
}

/** 取一条缓存，过期或不存在返回空串 */
export function getCached(projectId: string, kind: UrlKind, photoId: string): string {
  if (!projectId || !photoId) return ''
  const map = read(projectId, kind)
  const it = map[photoId]
  if (!it || !it.u || !it.e || it.e < Date.now()) return ''
  return it.u
}

/** 批量写入缓存 */
export function putBatch(projectId: string, kind: UrlKind, items: { photoId: string; url: string }[]) {
  if (!projectId || !items || !items.length) return
  const map = read(projectId, kind)
  const expireAt = Date.now() + TTL
  let dirty = false
  for (const it of items) {
    if (!it || !it.photoId || !it.url) continue
    map[it.photoId] = { u: it.url, e: expireAt }
    dirty = true
  }
  if (!dirty) return
  write(projectId, kind, prune(map))
}

/** 仍有效的 photoId 列表（传给服务端，让它跳过这些不生成链接） */
export function cachedIds(projectId: string, kind: UrlKind): string[] {
  if (!projectId) return []
  const map = read(projectId, kind)
  const now = Date.now()
  const ids: string[] = []
  for (const id of Object.keys(map)) {
    const it = map[id]
    if (it && it.u && it.e && it.e > now) ids.push(id)
  }
  return ids
}

/** 清理过期 + 超量（按过期时间从早到晚丢） */
function prune(map: Record<string, Entry>): Record<string, Entry> {
  const now = Date.now()
  const alive: { id: string; e: number }[] = []
  const out: Record<string, Entry> = {}
  for (const id of Object.keys(map)) {
    const it = map[id]
    if (!it || !it.u || !it.e || it.e <= now) continue
    out[id] = it
    alive.push({ id, e: it.e })
  }
  if (alive.length <= MAX_ENTRIES) return out
  alive.sort((a, b) => a.e - b.e)
  const drop = alive.length - MAX_ENTRIES
  for (let i = 0; i < drop; i++) delete out[alive[i].id]
  return out
}

/** 删除项目时顺手清掉它的缓存 */
export function clearProject(projectId: string) {
  try {
    ;(wx as any).removeStorageSync(storageKey(projectId, 'thumb'))
    ;(wx as any).removeStorageSync(storageKey(projectId, 'preview'))
  } catch (e) {
    // 忽略
  }
}
