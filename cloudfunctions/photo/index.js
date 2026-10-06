const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

/** 当前环境存储桶名（fileID 前缀用）。更换环境时同步修改，或在云函数配置环境变量 STORAGE_BUCKET 覆盖 */
const BUCKET = '636c-cloud1-d2guu7uw1a306815a-1499127316'

/**
 * 画质四档（30_BUSINESS_RULES 第一章 / 24_FILE_STORAGE 3.1，与 web/uploader.js 的 PRESETS 保持一致）
 * 只用于把「这次上传实际用的档位」回写到 project.previewSpec（BR-302），改档位需两处同步。
 */
const PREVIEW_PRESETS = {
  low: { longEdge: 1200, quality: 55 },
  hd: { longEdge: 1600, quality: 75 },
  hdpro: { longEdge: 2880, quality: 90 },
  raw: { longEdge: 4096, quality: 92 },
  standard: { longEdge: 1600, quality: 75 }, // 旧档位名（= 高清），仅兼容历史数据
}

/**
 * 照片登记云函数（电脑端上传页调用，无 OPENID，靠上传码/会话 token 鉴权）
 *
 * action = issueUploadSession { projectId, sessionToken }  V2 主路径：登录后直接换上传会话
 * action = verifyCode    { code }                         校验 6 位上传码，换 24h 上传会话 token（兜底保留）
 * action = registerPhoto { projectId, uploadToken, ... }  登记一张照片（同名 stem 覆盖更新）
 * action = list          { projectId, skip, limit, filter, modelId, have }
 *                        摄影师视角读取全部底片（UI 阶段 D-2，规格见 docs/55_PHOTO_LIST_API_SPEC.md）
 * action = previewUrl    { projectId, photoId }           单张大图临时链接（照片墙点开看大图）
 *
 * 前置：project 集合存在（仅管理端可读写）、photo 集合存在（仅管理端可读写）
 */
exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'issueUploadSession':
        return await issueUploadSession(event)
      case 'verifyCode':
        return await verifyCode(event)
      case 'registerPhoto':
        return await registerPhoto(event)
      case 'list':
        return await listPhotos(event)
      case 'previewUrl':
        return await previewUrl(event)
      case 'thumbUrls':
        return await thumbUrls(event)
      default:
        return { ok: false, error: '未知 action: ' + (event.action || '') }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

/* ---------- actions ---------- */

/**
 * 网页端已登录后换取上传会话（22_API 4.1）
 * 与 verifyCode 的唯一差别：身份来源从 6 位上传码换成 sessionToken + 项目归属校验。
 * 本云函数只有两个 action 走身份解析（issueUploadSession / list）——
 * verifyCode 靠 6 位上传码、registerPhoto 靠 uploadToken，都不含 openid 逻辑。
 */
async function issueUploadSession(ev) {
  const sessionToken = String((ev && ev.sessionToken) || '').trim()
  if (!sessionToken) {
    return { ok: false, error: '未登录，请先扫码登录', code: 'ERR_NO_AUTH' }
  }

  const openid = await openidBySessionToken(sessionToken)
  if (!openid) {
    return { ok: false, error: '登录已失效，请重新扫码登录', code: 'ERR_NO_AUTH' }
  }

  const projectId = String((ev && ev.projectId) || '').trim()
  if (!projectId) return { ok: false, error: '缺少 projectId', code: 'ERR_PARAM' }

  let p = null
  try {
    const res = await db.collection('project').doc(projectId).get()
    p = res.data
  } catch (e) {
    p = null
  }
  // 归属校验与「不存在」同码返回，避免用报错探测他人项目是否存在
  if (!p || (p.ownerOpenid && p.ownerOpenid !== openid)) {
    return { ok: false, error: '项目不存在或无权访问', code: 'ERR_NOT_FOUND' }
  }
  // 归档项目的大图已清理且模特端只读，传上去也选不了（详见 43 文档 C-10）
  if (p.status === 'ARCHIVED') {
    return { ok: false, error: '项目已归档，请先续期再上传', code: 'ERR_ARCHIVED' }
  }

  const now = Date.now()
  const uploadToken = randomBase62(22)
  const tokenExpireAt = now + 24 * 3600 * 1000 // 24 小时，与 verifyCode 口径一致
  await db
    .collection('project')
    .doc(p._id)
    .update({ data: { uploadToken, uploadTokenExpireAt: tokenExpireAt } })

  return {
    ok: true,
    data: {
      projectId: p._id,
      projectName: p.name,
      uploadToken,
      tokenExpireAt,
    },
  }
}

async function verifyCode({ code }) {
  const c = String(code || '').trim()
  if (!/^\d{6}$/.test(c)) {
    return { ok: false, error: '上传码格式不对（应为 6 位数字）' }
  }

  const res = await db.collection('project').where({ uploadCode: c }).limit(2).get()
  const now = Date.now()
  const p = (res.data || []).find((x) => x.uploadCodeExpireAt > now)
  if (!p) {
    return { ok: false, error: '上传码无效或已过期（5 分钟有效，请回小程序重新生成）' }
  }

  const token = randomBase62(22)
  const tokenExpireAt = now + 24 * 3600 * 1000
  await db
    .collection('project')
    .doc(p._id)
    .update({ data: { uploadToken: token, uploadTokenExpireAt: tokenExpireAt } })

  return {
    ok: true,
    data: {
      projectId: p._id,
      projectName: p.name,
      clientName: p.clientName || '',
      uploadToken: token,
      tokenExpireAt,
    },
  }
}

async function registerPhoto(ev) {
  const {
    projectId,
    uploadToken,
    stem,
    filename,
    previewPath,
    thumbPath,
    width,
    height,
    sortOrder,
    previewBytes,
    thumbBytes,
  } = ev

  if (!projectId || !uploadToken) return { ok: false, error: '参数缺失' }

  let p = null
  try {
    const res = await db.collection('project').doc(projectId).get()
    p = res.data
  } catch (e) {
    p = null
  }
  if (!p) return { ok: false, error: '项目不存在' }
  if (!p.uploadToken || p.uploadToken !== uploadToken) {
    return { ok: false, error: '上传会话无效，请重新验证上传码' }
  }
  if (!p.uploadTokenExpireAt || p.uploadTokenExpireAt < Date.now()) {
    return { ok: false, error: '上传会话已过期（24 小时），请重新验证上传码' }
  }

  const safeStem = sanitize(stem)
  if (!safeStem) return { ok: false, error: '文件名无效: ' + String(stem).slice(0, 40) }
  const safePreviewPath = safeCloudPath(previewPath)
  const safeThumbPath = safeCloudPath(thumbPath)
  if (!safePreviewPath || !safeThumbPath) {
    return { ok: false, error: '文件路径无效' }
  }

  // 云端核验：文件真实存在于存储后才登记
  // （web 端跨域被拦时浏览器读不到上传响应，但文件可能已实际到达服务器，以此兜底）
  const env = (cloud.getWXContext() || {}).ENV || 'cloud1-d2guu7uw1a306815a'
  const bucket = process.env.STORAGE_BUCKET || BUCKET
  const previewFileID = `cloud://${env}.${bucket}/${safePreviewPath}`
  const thumbFileID = `cloud://${env}.${bucket}/${safeThumbPath}`
  let fileList = []
  try {
    const check = await cloud.getTempFileURL({ fileList: [previewFileID, thumbFileID] })
    fileList = (check && check.fileList) || []
  } catch (e) {
    fileList = []
  }
  const exists = fileList.length === 2 && fileList.every((f) => f && f.tempFileURL)
  if (!exists) {
    return { ok: false, error: '云端核验失败：文件未上传成功，请重试' }
  }

  const now = Date.now()
  const base = {
    stem: safeStem,
    filename: sanitize(filename) || safeStem + '.jpg',
    previewFileID,
    thumbFileID,
    width: parseInt(width, 10) || 0,
    height: parseInt(height, 10) || 0,
    previewBytes: parseInt(previewBytes, 10) || 0,
    thumbBytes: parseInt(thumbBytes, 10) || 0,
    updatedAt: now,
  }

  // 画质是「上传时的选择」（BR-302 / R-4）：把本次实际档位回写到项目，仅用于展示与统计
  const spec = previewSpecOf(ev)

  // 同名照片（重传）→ 覆盖更新，不重复计数
  const exist = await db
    .collection('photo')
    .where({ projectId, stem: safeStem })
    .limit(1)
    .get()

  if (exist.data && exist.data.length > 0) {
    const id = exist.data[0]._id
    await db.collection('photo').doc(id).update({ data: base })
    // 重传可能换过画质档，按差值调整项目在线额度
    const old = exist.data[0]
    const delta =
      (parseInt(previewBytes, 10) || 0) +
      (parseInt(thumbBytes, 10) || 0) -
      ((parseInt(old.previewBytes, 10) || 0) + (parseInt(old.thumbBytes, 10) || 0))
    const projData = { updatedAt: now }
    if (delta) projData.usedBytes = _.inc(delta)
    if (spec) projData.previewSpec = spec
    await db.collection('project').doc(projectId).update({ data: projData })
    return { ok: true, data: { photoId: id, updated: true } }
  }

  const add = await db.collection('photo').add({
    data: {
      projectId,
      sortOrder: parseInt(sortOrder, 10) || 0,
      createdAt: now,
      ...base,
    },
  })

  // 项目封面：取前 3 张缩略图，供模特端「我的拍摄」列表显示
  // usedBytes = 在线额度计量（preview + thumb），归档时会扣掉 preview 部分
  const bytes = (parseInt(previewBytes, 10) || 0) + (parseInt(thumbBytes, 10) || 0)
  const updateData = { photoCount: _.inc(1), usedBytes: _.inc(bytes), updatedAt: now }
  if (p.status === 'DRAFT') updateData.status = 'UPLOADING'
  if ((p.coverThumbs || []).length < 3) updateData.coverThumbs = _.push([thumbFileID])
  if (spec) updateData.previewSpec = spec
  await db.collection('project').doc(projectId).update({ data: updateData })

  return { ok: true, data: { photoId: add._id } }
}

/**
 * 摄影师视角：按项目分页列出全部照片（UI 阶段 D-2 / 55 文档）
 *
 * 只做读取，不触碰上传链路的三个 action，也不写任何字段。
 * 排序一律 sortOrder 升序（21_DATABASE 三节）；导出时才按 filename 升序，那是结果页的事。
 */
async function listPhotos(ev) {
  // 1) 身份：小程序取 OPENID，网页用 sessionToken 换；都没有 → 未登录
  const openid = await resolveCaller(ev)
  if (!openid) {
    return { ok: false, error: '未登录，请先扫码登录', code: 'ERR_NO_AUTH' }
  }

  // 2) 参数
  const projectId = String((ev && ev.projectId) || '').trim()
  if (!projectId) return { ok: false, error: '缺少 projectId', code: 'ERR_PARAM' }

  const s = Math.max(0, parseInt(ev.skip, 10) || 0)
  const l = Math.min(50, Math.max(1, parseInt(ev.limit, 10) || 18))
  const rawFilter = String((ev && ev.filter) || 'all')
  const filter = ['all', 'selected', 'unselected'].indexOf(rawFilter) >= 0 ? rawFilter : 'all'
  const modelId = String((ev && ev.modelId) || '').trim()
  const haveSet = new Set(
    (Array.isArray(ev.have) ? ev.have : []).filter((x) => typeof x === 'string').slice(0, 3000)
  )

  // 3) 归属校验：非本人与「不存在」同码同文案，避免用报错差异探测他人项目
  let p = null
  try {
    const res = await db.collection('project').doc(projectId).get()
    p = res.data
  } catch (e) {
    p = null
  }
  if (!p || (p.ownerOpenid && p.ownerOpenid !== openid)) {
    return { ok: false, error: '项目不存在或无权访问', code: 'ERR_NOT_FOUND' }
  }

  // 4) 一次查全体模特的选片记录：photoId → [modelId]，顺带得到已选并集与模特 chips
  const selRes = await db.collection('selection').where({ projectId }).limit(100).get()
  const byPhoto = {}
  const selMap = {}
  const unionSet = new Set()
  ;(selRes.data || []).forEach((sel) => {
    selMap[sel.modelId] = sel
    ;((sel && sel.photoIds) || []).forEach((pid) => {
      ;(byPhoto[pid] = byPhoto[pid] || []).push(sel.modelId)
      if (!modelId || sel.modelId === modelId) unionSet.add(pid)
    })
  })

  let photos = []
  let hasMore = false
  let total = 0

  if (filter === 'selected') {
    // 已选是核心视图，翻页必须准确：先按 sortOrder 排好 id 数组，再在内存里切片
    const sorted = await sortIdsByOrder(projectId, Array.from(unionSet))
    total = sorted.length
    const pageIds = sorted.slice(s, s + l)
    hasMore = s + l < sorted.length
    if (pageIds.length) {
      const res = await db.collection('photo').where({ _id: _.in(pageIds) }).get()
      const map = {}
      ;(res.data || []).forEach((x) => {
        map[x._id] = x
      })
      // where in 不保证顺序，按 pageIds 还原
      photos = pageIds.map((id) => map[id]).filter(Boolean)
    }
  } else {
    const res = await db
      .collection('photo')
      .where({ projectId })
      .orderBy('sortOrder', 'asc')
      .skip(s)
      .limit(l)
      .get()
    photos = res.data || []
    hasMore = photos.length === l
    if (filter === 'unselected') {
      // 取页后再过滤，分页会有轻微不准（某页可能不足 l 张）——云开发聚合能力限制，
      // 前端按「本页不足 limit 且 hasMore 为 true 时继续拉下一页」拼接即可，不引入游标
      photos = photos.filter((x) => !(byPhoto[x._id] || []).length)
    }
    total =
      filter === 'all'
        ? p.photoCount || 0
        : Math.max(0, (p.photoCount || 0) - unionSet.size)
  }

  // 5) 缩略图临时链接：端上已缓存（have）的不重复取，getTempFileURL 按 50 分块
  const need = photos.filter((x) => !haveSet.has(x._id))
  const urlMap = await tempUrls(need.map((x) => x.thumbFileID))

  // 6) 模特 chips：给「已选」Tab 下的筛选用，前端不用再发一次请求
  const models = (p.models || []).map((m) => {
    const sel = selMap[m.modelId] || null
    return {
      modelId: m.modelId,
      displayName: m.name || '',
      selectedCount: ((sel && sel.photoIds) || []).length,
      locked: !!(sel && sel.locked),
      submittedAt: (sel && sel.submittedAt) || 0,
    }
  })

  return {
    ok: true,
    data: {
      photos: photos.map((x) => ({
        _id: x._id,
        filename: x.filename,
        width: x.width || 0,
        height: x.height || 0,
        thumbUrl: urlMap[x.thumbFileID] || '',
        // 点开大图用：前端按需换临时链接，不在这里批量取（省 getTempFileURL 调用）。
        // 归档项目的 preview 已被清理，取链接会失败 → 前端提示「需续期」，属预期。
        previewFileID: x.previewFileID || '',
        cached: haveSet.has(x._id),
        selectedBy: byPhoto[x._id] || [],
      })),
      hasMore,
      total,
      models,
      // 归档项目 thumb 仍在（归档只清 preview），列表照样能渲染，前端提示续期即可
      archived: p.status === 'ARCHIVED',
      packageCount: typeof p.packageCount === 'number' ? p.packageCount : 0,
    },
  }
}

/**
 * 单张大图临时链接（照片墙点开看大图，小程序 / 网页共用）。
 *
 * 为什么放服务端：网页端 identityless SDK 在浏览器里 getTempFileURL 依赖
 * 存储安全规则与匿名身份，链路脆弱；而云函数侧取临时链接（缩略图同路径）
 * 已验证稳定，前端统一走 callCloud 即可，不再依赖客户端 SDK 直连存储。
 */
async function previewUrl(ev) {
  const openid = await resolveCaller(ev)
  if (!openid) {
    return { ok: false, error: '未登录，请先扫码登录', code: 'ERR_NO_AUTH' }
  }

  const projectId = String((ev && ev.projectId) || '').trim()
  const photoId = String((ev && ev.photoId) || '').trim()
  if (!projectId || !photoId) return { ok: false, error: '缺少参数', code: 'ERR_PARAM' }

  let p = null
  try {
    const res = await db.collection('project').doc(projectId).get()
    p = res.data
  } catch (e) {
    p = null
  }
  if (!p || (p.ownerOpenid && p.ownerOpenid !== openid)) {
    return { ok: false, error: '项目不存在或无权访问', code: 'ERR_NOT_FOUND' }
  }

  const res = await db
    .collection('photo')
    .doc(photoId)
    .get()
    .catch(() => null)
  const photo = res && res.data
  if (!photo || photo.projectId !== projectId) {
    return { ok: false, error: '照片不存在', code: 'ERR_NOT_FOUND' }
  }
  if (!photo.previewFileID) {
    return { ok: false, error: '大图已清理（项目已归档），续期后可查看' }
  }

  const urlMap = await tempUrls([photo.previewFileID])
  const url = urlMap[photo.previewFileID]
  if (!url) return { ok: false, error: '大图取链接失败，请重试' }

  return { ok: true, data: { previewUrl: url, filename: photo.filename || '' } }
}

/**
 * 批量重取缩略图临时链接（照片墙图片加载失败时自愈用）。
 *
 * 为什么需要它：云端私有读的临时链接实际有效期只有约 10 分钟（官方口径），
 * 瀑布流一次取 18 张、用户慢慢滚，后面的链接必然过期。图片加载失败时端上
 * 丢掉该条缓存、用这里重新换一条新链接即可，不必整页刷新。
 *
 * 只返回链接，不写任何字段；鉴权与归属校验与 list / previewUrl 同口径。
 */
async function thumbUrls(ev) {
  const openid = await resolveCaller(ev)
  if (!openid) {
    return { ok: false, error: '未登录，请先扫码登录', code: 'ERR_NO_AUTH' }
  }

  const projectId = String((ev && ev.projectId) || '').trim()
  const ids = (Array.isArray(ev.photoIds) ? ev.photoIds : [])
    .filter((x) => typeof x === 'string' && x)
    .slice(0, 50)
  if (!projectId || !ids.length) return { ok: false, error: '缺少参数', code: 'ERR_PARAM' }

  let p = null
  try {
    const res = await db.collection('project').doc(projectId).get()
    p = res.data
  } catch (e) {
    p = null
  }
  if (!p || (p.ownerOpenid && p.ownerOpenid !== openid)) {
    return { ok: false, error: '项目不存在或无权访问', code: 'ERR_NOT_FOUND' }
  }

  const res = await db
    .collection('photo')
    .where({ projectId, _id: _.in(ids) })
    .field({ thumbFileID: 1, projectId: 1 })
    .limit(50)
    .get()
    .catch(() => null)
  const rows = (res && res.data) || []
  if (!rows.length) return { ok: false, error: '照片不存在', code: 'ERR_NOT_FOUND' }

  const urlMap = await tempUrls(rows.map((x) => x.thumbFileID))
  return {
    ok: true,
    data: {
      list: rows.map((x) => ({ photoId: x._id, thumbUrl: urlMap[x.thumbFileID] || '' })),
    },
  }
}

/**
 * 本次上传使用的画质档位 → 待回写的 project.previewSpec。
 * 档位不在四档表内（旧客户端没传 / 传了未知值）时返回 null，保持原值不动。
 */
function previewSpecOf(ev) {
  const key = String((ev && ev.preset) || '').trim()
  const preset = PREVIEW_PRESETS[key]
  if (!preset) return null
  return {
    preset: key,
    longEdge: preset.longEdge,
    quality: preset.quality,
    watermarkText: String((ev && ev.watermarkText) || '').trim().slice(0, 40),
  }
}

/* ---------- helpers ---------- */

/** 临时链接有效期：24 小时（maxAge 单位是「秒」，官方默认 86400）。
 *  注意：wx-server-sdk 的 getTempFileURL 签名是 fileList: string[]，传
 *  {fileID, maxAge} 时 maxAge 不保证生效；私有读文件的临时链接实测只有约
 *  10 分钟有效期（链接里的 t 参数就是到期时刻）。所以端上必须按链接自带的
 *  t 判断新鲜度（见 services/urlcache.ts），不要再写死一个长 TTL。 */
const TEMP_URL_MAX_AGE = 86400

/** 批量取临时链接（getTempFileURL 单次最多 50 个）。与 selection 同一份实现，各函数各写一份副本 */
async function tempUrls(fileIDs) {
  const out = {}
  const list = Array.from(new Set((fileIDs || []).filter(Boolean))).map((fileID) => ({
    fileID,
    maxAge: TEMP_URL_MAX_AGE,
  }))
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50)
    try {
      const res = await cloud.getTempFileURL({ fileList: chunk })
      for (const f of (res && res.fileList) || []) {
        if (f && f.fileID && f.tempFileURL) out[f.fileID] = f.tempFileURL
      }
    } catch (e) {
      // 单块失败不影响其他块
    }
  }
  return out
}

/**
 * 把一批 photoId 按 sortOrder 升序排好（已选分页要准，必须先在内存排序再切片）。
 * where in 数组按 100 分块取，避免单次 in 过大。
 */
async function sortIdsByOrder(projectId, ids) {
  if (!ids || !ids.length) return []
  const rows = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await db
      .collection('photo')
      .where({ projectId, _id: _.in(chunk) })
      .field({ sortOrder: 1 })
      .limit(1000)
      .get()
    ;(res.data || []).forEach((x) => rows.push(x))
  }
  const seen = new Set()
  const uniq = []
  rows.forEach((x) => {
    if (seen.has(x._id)) return
    seen.add(x._id)
    uniq.push(x)
  })
  uniq.sort((a, b) => (parseInt(a.sortOrder, 10) || 0) - (parseInt(b.sortOrder, 10) || 0))
  return uniq.map((x) => x._id)
}

/**
 * 身份解析（与 project / selection 同口径：各云函数各写一份副本，不跨函数 require）。
 * 小程序端：微信上下文直接给 OPENID；网页端：sessionToken 换 openid。都取不到 → 无身份。
 */
async function resolveCaller(event) {
  const wxCtx = cloud.getWXContext() || {}
  if (wxCtx.OPENID) return wxCtx.OPENID
  const token = String((event && event.sessionToken) || '').trim()
  if (!token) return ''
  return await openidBySessionToken(token)
}

/** 与 project / selection 同一份实现：网页会话换 openid，无效/过期一律视为无身份 */
async function openidBySessionToken(token) {
  try {
    const res = await db
      .collection('session')
      .where({ token, status: 'ACTIVE' })
      .limit(1)
      .get()
    const s = res.data && res.data[0]
    if (!s || !s.openid) return ''
    if (!s.tokenExpireAt || s.tokenExpireAt < Date.now()) return ''
    return s.openid
  } catch (e) {
    console.warn('[photo] 会话校验失败', e && e.message)
    return ''
  }
}

/** 仅保留字母数字与 . - _，防路径穿越 */
function sanitize(s) {
  return String(s || '')
    .replace(/^.*[\\/]/, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 80)
}

/** 校验云存储相对路径：p/<projectId>/(preview|thumb)/<stem>.jpg */
function safeCloudPath(p) {
  const s = String(p || '').trim()
  if (!/^p\/[A-Za-z0-9-]+\/(preview|thumb)\/[A-Za-z0-9._-]+\.jpg$/.test(s)) return ''
  return s
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomBase62(len) {
  const bytes = crypto.randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += BASE62[bytes[i] % 62]
  return s
}
