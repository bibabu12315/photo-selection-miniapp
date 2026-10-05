/**
 * 临时链接端上缓存
 *
 * 云端临时链接的真实有效期由链接自带的 `t` 参数给出（形如 `?sign=xxx&t=1791205892`，
 * Unix 秒，即到期时刻）。官方文档口径：私有读文件的临时链接只有约 10 分钟有效期，
 * 且 wx-server-sdk 的 getTempFileURL 签名是 fileList: string[]，传 {fileID, maxAge}
 * 里的 maxAge 不保证生效 → **不能再用固定的 90 分钟 TTL 判断链接新鲜度**，
 * 否则缓存认为「新鲜」的链接其实早就过期，瀑布流滚动到后面就是一片 403。
 *
 * 所以这里改成：从链接里解析出真实到期时刻，只缓存「到此刻为止仍有效」的链接。
 * 缓存按「项目 + 用途（缩略图 / 大图）」分桶，缩略图和大图互不覆盖。
 */

/** 提前这么久就当作已过期，避开「刚好卡在到期边缘」的 403 */
const SAFE_MARGIN = 60 * 1000
/** 缓存条目的时间上限：即使云端某天给出超长有效期，端上也不无限信任 */
const TTL_CAP = 90 * 60 * 1000
/** 解析不到 t 参数时的保守兜底（对应官方口径的约 10 分钟，再留一点余量） */
const TTL_FALLBACK = 5 * 60 * 1000
/**
 * 提前续签窗口：一条链接距离过期不足这么久，就不再告诉服务端「我已有缓存」。
 * 必须与 getCached 用同一个判定（bugfix：早前 cachedIds 只比较写入时的 TTL，
 * 而 getCached 会复核链接自带的 t，两者不一致 → 服务端跳过签发、端上又取不到可用
 * 链接 → 缩略图 src 为空 → 既不 bindload 也不 binderror，界面一片黑且无任何提示）
 */
const RENEW_WINDOW = 2 * 60 * 1000
/** 单个项目单桶最多缓存条数，防止老数据堆积 */
const MAX_ENTRIES = 3000

/**
 * 从临时链接里算出「可以用到什么时候」（毫秒时间戳）
 * 拿不到 t / 已经过期 → 返回 0，调用方直接不缓存
 */
function expireAtOf(url: string, now: number): number {
  const m = /[?&]t=(\d+)/.exec(String(url || ''))
  if (!m) return 0
  let t = parseInt(m[1], 10)
  if (!t) return 0
  // 10 位是秒，13 位是毫秒
  if (t < 1e12) t = t * 1000
  const at = t - SAFE_MARGIN
  if (!isFinite(at) || at <= now) return 0
  return Math.min(at, now + TTL_CAP)
}

/** 兜底到期时刻：解析不到 t 时按保守值缓存 */
function fallbackExpireAt(now: number): number {
  return now + TTL_FALLBACK
}

export type UrlKind = 'thumb' | 'preview'

interface Entry {
  u: string
  e: number
}

function storageKey(projectId: string, kind: UrlKind) {
  // v3：v1（20h TTL）/ v2（90 分钟 TTL）写入的条目，到期时间都是「写死的 TTL」，
  // 而云端临时链接实际只有约 10 分钟 → 老缓存里全是过期链接。换前缀整体作废
  // （旧 key 留在 storage 里无害，不主动清）
  return `psurl3_${kind}_${projectId}`
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

/** 取一条缓存，过期或不存在返回空串（再拿链接自带的 t 复核一次，双保险） */
export function getCached(projectId: string, kind: UrlKind, photoId: string): string {
  if (!projectId || !photoId) return ''
  const map = read(projectId, kind)
  const it = map[photoId]
  if (!it || !it.u || !it.e || it.e < Date.now()) return ''
  return expireAtOf(it.u, Date.now()) ? it.u : ''
}

/** 批量写入缓存（到期时刻取自链接本身，不写已经过期或寿命极短的链接） */
export function putBatch(projectId: string, kind: UrlKind, items: { photoId: string; url: string }[]) {
  if (!projectId || !items || !items.length) return
  const map = read(projectId, kind)
  const now = Date.now()
  let dirty = false
  for (const it of items) {
    if (!it || !it.photoId || !it.url) continue
    const e = expireAtOf(it.url, now) || fallbackExpireAt(now)
    map[it.photoId] = { u: it.url, e }
    dirty = true
  }
  if (!dirty) return
  write(projectId, kind, prune(map))
}

/** 丢掉一条缓存（图片加载失败时用它，下次会走服务端重新取链接） */
export function drop(projectId: string, kind: UrlKind, photoId: string) {
  if (!projectId || !photoId) return
  const map = read(projectId, kind)
  if (!map[photoId]) return
  delete map[photoId]
  write(projectId, kind, map)
}

/**
 * 仍有效的 photoId 列表（传给服务端，让它跳过这些不生成链接）
 * 判定口径与 getCached 完全一致：这条链接此刻在端上真的能用，才算「已有缓存」。
 * 另外要求它还能撑过 RENEW_WINDOW，否则让服务端重新签一条，避免刚用上就过期。
 */
export function cachedIds(projectId: string, kind: UrlKind): string[] {
  if (!projectId) return []
  const map = read(projectId, kind)
  const now = Date.now()
  const ids: string[] = []
  for (const id of Object.keys(map)) {
    const it = map[id]
    if (!it || !it.u || !it.e || it.e <= now) continue
    if (!expireAtOf(it.u, now)) continue
    if (!expireAtOf(it.u, now + RENEW_WINDOW)) continue
    ids.push(id)
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
