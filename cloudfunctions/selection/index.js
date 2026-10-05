const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 网页会话的有效状态：登出后置 REVOKED，这里只认 ACTIVE */
const SESSION_ACTIVE = 'ACTIVE'

/* ---------- 身份解析 ---------- */

/**
 * 解析调用者 openid。
 * 小程序路径优先于网页路径（BR-105）：即便网页的 event 里混入 sessionToken，
 * 只要请求真的来自小程序就以微信签发的 OPENID 为准，防止网页伪造提权。
 * 返回 '' 表示无法识别身份，调用方必须拒绝。
 */
async function resolveCaller(event) {
  const { OPENID } = cloud.getWXContext()
  if (OPENID) return OPENID

  const token = String((event && event.sessionToken) || '').trim()
  if (!token) return ''
  return await openidBySessionToken(token)
}

/** 网页会话换 openid：token 不存在 / 已登出 / 已过期，一律视为无身份 */
async function openidBySessionToken(token) {
  try {
    const res = await db
      .collection('session')
      .where({ token, status: SESSION_ACTIVE })
      .limit(1)
      .get()
    const s = res.data && res.data[0]
    if (!s || !s.openid) return ''
    if (!s.tokenExpireAt || s.tokenExpireAt < Date.now()) return ''
    return s.openid
  } catch (e) {
    // session 集合尚未建立（T-P0-2 之前）时，小程序路径必须照常可用
    console.warn('[selection] 会话校验失败', e && e.message)
    return ''
  }
}

/**
 * 选片云函数（V2.0 双端版）
 *
 * 身份：
 *   action = whoami           {}                                  我是谁：摄影师 / 模特 / 路人
 *
 * 模特端：
 *   action = entry            { token }                            首次凭邀请链接进入，绑定微信身份
 *   action = myList           {}                                   我的拍摄：我名下所有项目
 *   action = getPhotos        { projectId, modelId, skip, limit }  分页拉取照片
 *   action = getPreview       { projectId, modelId, photoId }      大图临时链接
 *   action = saveSelection    { projectId, modelId, photoIds }     保存选择
 *   action = submitSelection  { projectId, modelId, photoIds }     提交并锁定
 *
 * 摄影师端（管理员）：
 *   action = getResult        { projectId, modelId }               某位模特的选片结果
 *   action = resetLock        { projectId, modelId }               重新开放某位模特的选片
 *
 * 数据：
 *   model     { openid, displayName }                     模特档案（openid 为空表示还没被认领）
 *   invite    { projectId, modelId, token }               每位模特每个项目一条邀请，最多 5 条
 *   selection { projectId, modelId, photoIds[], locked }  双人键，一项目×一模特一份
 */
exports.main = async (event = {}) => {
  // 同一套 action 同时服务两端：模特走小程序 OPENID，摄影师网页走 sessionToken
  const openid = await resolveCaller(event)
  if (!openid) {
    return { ok: false, error: '登录已过期，请重新扫码登录', code: 'ERR_NO_AUTH' }
  }

  try {
    switch (event.action) {
      case 'whoami':
        return await whoami(openid)
      case 'entry':
        return await entry(event, openid)
      case 'myList':
        return await myList(openid)
      case 'getPhotos':
        return await getPhotos(event, openid)
      case 'getPreview':
        return await getPreview(event, openid)
      case 'thumbUrls':
        return await thumbUrls(event, openid)
      case 'saveSelection':
        return await saveSelection(event, openid, false)
      case 'submitSelection':
        return await saveSelection(event, openid, true)
      case 'getResult':
        return await getResult(event, openid)
      case 'getProjectResults':
        return await getProjectResults(event, openid)
      case 'resetLock':
        return await resetLock(event, openid)
      default:
        return { ok: false, error: '未知 action: ' + (event.action || '') }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

/* ---------- 身份 ---------- */

async function whoami(openid) {
  // 注意：局部变量不能叫 isAdmin，否则会遮蔽下面的 isAdmin() 函数（报 "Cannot access 'isAdmin' before initialization"）
  const admin = await isAdmin(openid)
  const m = await db.collection('model').where({ openid }).limit(1).get()
  const model = m.data[0] || null
  return {
    ok: true,
    data: {
      openid,
      isAdmin: admin,
      isModel: !!model,
      displayName: model ? model.displayName : '',
    },
  }
}

/* ---------- 模特端 ---------- */

/**
 * 进入选片页：
 * - 带 token：首次凭邀请链接进入，认领模特身份
 * - 带 projectId + modelId：老模特从「我的拍摄」直接进
 */
async function entry({ token, projectId, modelId }, openid) {
  if (!token) {
    const { project, selection } = await guardModel(projectId, modelId, openid)
    const mRes = await db.collection('model').doc(modelId).get()
    return {
      ok: true,
      data: {
        projectId: project._id,
        modelId,
        displayName: (mRes.data && mRes.data.displayName) || '',
        projectName: project.name,
        photoCount: project.photoCount || 0,
        packageCount: project.packageCount || 0,
        locked: !!(selection && selection.locked),
        selectedIds: (selection && selection.photoIds) || [],
      },
    }
  }

  const inv = await inviteByToken(token)
  const project = await projectById(inv.projectId)
  assertNotExpired(project)

  const mRes = await db.collection('model').doc(inv.modelId).get()
  const model = mRes.data
  if (!model) throw new Error('邀请已失效，请联系摄影师重新发送')

  if (!model.openid) {
    // 首次认领：这个微信号以后就是这个模特
    await db.collection('model').doc(inv.modelId).update({
      data: { openid, updatedAt: Date.now() },
    })
  } else if (model.openid !== openid) {
    throw new Error('该链接已被其他微信账号使用，请联系摄影师重新发送')
  }

  const sel = await ensureSelection(project._id, inv.modelId)

  return {
    ok: true,
    data: {
      projectId: project._id,
      modelId: inv.modelId,
      displayName: model.displayName,
      projectName: project.name,
      photoCount: project.photoCount || 0,
      packageCount: project.packageCount || 0,
      locked: !!sel.locked,
      selectedIds: sel.photoIds || [],
    },
  }
}

/** 我的拍摄：该模特名下全部项目（拍几次就有几个） */
async function myList(openid) {
  const mRes = await db.collection('model').where({ openid }).limit(1).get()
  const model = mRes.data[0]
  if (!model) return { ok: true, data: { items: [], displayName: '' } }

  const invRes = await db.collection('invite').where({ modelId: model._id }).limit(100).get()
  const invites = invRes.data || []
  if (!invites.length) return { ok: true, data: { items: [], displayName: model.displayName } }

  const projectIds = Array.from(new Set(invites.map((i) => i.projectId)))
  const pRes = await db
    .collection('project')
    .where({ _id: _.in(projectIds) })
    .limit(100)
    .get()
  const projects = {}
  for (const p of pRes.data || []) projects[p._id] = p

  const sRes = await db
    .collection('selection')
    .where({ projectId: _.in(projectIds), modelId: model._id })
    .limit(100)
    .get()
  const sels = {}
  for (const s of sRes.data || []) sels[s.projectId] = s

  const now = Date.now()
  const items = invites
    .map((inv) => {
      const p = projects[inv.projectId]
      if (!p) return null
      const sel = sels[inv.projectId] || { photoIds: [], locked: false }
      const expired = !!p.expireAt && p.expireAt < now
      return {
        projectId: p._id,
        modelId: model._id,
        name: p.name,
        shootDate: p.shootDate || p.createdAt || 0,
        photoCount: p.photoCount || 0,
        packageCount: p.packageCount || 0,
        expireAt: p.expireAt || 0,
        selectedCount: (sel.photoIds || []).length,
        locked: !!sel.locked,
        expired,
        coverThumbs: p.coverThumbs || [],
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.shootDate - a.shootDate)

  // 封面缩略图换临时链接
  const coverKeys = []
  items.forEach((it, idx) => {
    it.key = 'k' + idx
    ;(it.coverThumbs || []).forEach((f) => coverKeys.push(f))
  })
  const urlMap = await tempUrls(coverKeys)
  items.forEach((it) => {
    it.coverUrls = (it.coverThumbs || []).map((f) => urlMap[f] || '')
    delete it.coverThumbs
  })

  return { ok: true, data: { items, displayName: model.displayName } }
}

/** 分页拉取照片 + 缩略图临时链接 */
/** have：端上已有有效缓存的 photoId，服务端跳过这些，不再重复取临时链接 */
async function getPhotos({ projectId, modelId, skip = 0, limit = 18, have }, openid) {
  const { project, selection } = await guardModel(projectId, modelId, openid)

  const s = Math.max(0, parseInt(skip, 10) || 0)
  const l = Math.min(50, Math.max(1, parseInt(limit, 10) || 18))

  const res = await db
    .collection('photo')
    .where({ projectId: project._id })
    .orderBy('sortOrder', 'asc')
    .skip(s)
    .limit(l)
    .get()

  const photos = res.data || []
  const haveSet = new Set(
    (Array.isArray(have) ? have : []).filter((x) => typeof x === 'string').slice(0, 3000)
  )
  const need = photos.filter((p) => !haveSet.has(p._id))
  const urlMap = await tempUrls(need.map((p) => p.thumbFileID))

  return {
    ok: true,
    data: {
      photos: photos.map((p) => ({
        _id: p._id,
        filename: p.filename,
        width: p.width || 0,
        height: p.height || 0,
        thumbUrl: urlMap[p.thumbFileID] || '',
        /** true = 端上已有缓存，服务端没生成链接，由端上从缓存补 */
        cached: haveSet.has(p._id),
      })),
      hasMore: photos.length === l,
      locked: !!(selection && selection.locked),
      packageCount: project.packageCount || 0,
      archived: project.status === 'ARCHIVED',
    },
  }
}

/**
 * 批量重取缩略图临时链接（模特端瀑布流图片加载失败时自愈用）。
 *
 * 云端私有读的临时链接实际只有约 10 分钟有效期，模特慢慢往下滚时后面的链接
 * 已经过期。加载失败就丢缓存、用这里换一条新链接，不必整页重拉。
 * 鉴权复用 guardModel（模特本人 + 项目未过期），不额外引入新规则。
 */
async function thumbUrls({ projectId, modelId, photoIds }, openid) {
  const { project } = await guardModel(projectId, modelId, openid)

  const ids = (Array.isArray(photoIds) ? photoIds : [])
    .filter((x) => typeof x === 'string' && x)
    .slice(0, 50)
  if (!ids.length) return { ok: false, error: '缺少参数', code: 'ERR_PARAM' }

  const res = await db
    .collection('photo')
    .where({ projectId: project._id, _id: _.in(ids) })
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
 * 大图临时链接
 * range > 0 时一次返回当前张 + 前后各 range 张（默认 0，模特端传 2）
 * 一次调用顶 5 次：连续滑 20 张只产生约 4~5 次调用，而不是 20 次
 */
async function getPreview({ projectId, modelId, photoId, range }, openid) {
  const { project } = await guardModel(projectId, modelId, openid)
  if (project.status === 'ARCHIVED') {
    return {
      ok: false,
      error: '项目已归档，大图已清理；如需查看大图请联系摄影师续期',
      code: 'ERR_ARCHIVED',
    }
  }

  const res = await db.collection('photo').doc(String(photoId || '')).get()
  const photo = res.data
  if (!photo || photo.projectId !== project._id) {
    return { ok: false, error: '照片不存在' }
  }

  const r = Math.min(5, Math.max(0, parseInt(range, 10) || 0))
  let list = [photo]

  if (r > 0) {
    const so = photo.sortOrder || 0
    const proj = { previewFileID: 1, sortOrder: 1, filename: 1 }
    const [nextRes, prevRes] = await Promise.all([
      db
        .collection('photo')
        .where({ projectId: project._id, sortOrder: _.gt(so) })
        .orderBy('sortOrder', 'asc')
        .limit(r)
        .field(proj)
        .get(),
      db
        .collection('photo')
        .where({ projectId: project._id, sortOrder: _.lt(so) })
        .orderBy('sortOrder', 'desc')
        .limit(r)
        .field(proj)
        .get(),
    ])
    list = (prevRes.data || []).slice().reverse().concat([photo], nextRes.data || [])
  }

  const urlMap = await tempUrls(list.map((p) => p.previewFileID))
  return {
    ok: true,
    data: {
      photoId: photo._id,
      filename: photo.filename,
      previewUrl: urlMap[photo.previewFileID] || '',
      list: list.map((p) => ({
        photoId: p._id,
        filename: p.filename,
        previewUrl: urlMap[p.previewFileID] || '',
      })),
    },
  }
}

/** 自动保存 / 提交选片（提交后锁定，改选择必须由摄影师解锁） */
async function saveSelection({ projectId, modelId, photoIds }, openid, submit) {
  const { project, selection } = await guardModel(projectId, modelId, openid)

  // 重复提交幂等：已锁定时直接返回成功，不改数据、不重复推送（31_STATE_MACHINE 八 C-3）
  if (submit && selection && selection.locked) {
    return {
      ok: true,
      data: { saved: true, locked: true, selectedCount: (selection.photoIds || []).length },
    }
  }
  // 已提交后禁止模特自行改动（R-1）；摄影师 resetLock 后 locked 为 false，这里自然放行
  if (selection && selection.locked) {
    return { ok: false, error: '已提交，如需修改请联系摄影师', code: 'ERR_LOCKED' }
  }

  const ids = Array.isArray(photoIds)
    ? Array.from(
        new Set(
          photoIds.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{5,64}$/.test(x))
        )
      )
    : []

  const limit = project.packageCount || 0
  if (limit > 0 && ids.length > limit) {
    return { ok: false, error: `最多只能选 ${limit} 张，当前选了 ${ids.length} 张` }
  }

  const cnt = await db.collection('photo').where({ projectId: project._id }).count()
  if (ids.length > cnt.total) {
    return { ok: false, error: '选择数量超出项目照片总数，请重试' }
  }

  const now = Date.now()
  const selId = await ensureSelectionId(project._id, modelId)

  const update = { photoIds: ids, updatedAt: now }
  if (submit) {
    update.locked = true
    update.submittedAt = now
  }
  await db.collection('selection').doc(selId).update({ data: update })

  // 项目卡片上的进度摘要
  await updateModelSummary(project._id, modelId, {
    selectedCount: ids.length,
    status: submit ? '已提交' : ids.length > 0 ? '选片中' : '待选片',
    submittedAt: submit ? now : 0,
  })

  // 订阅通知（T-P2-3）：只在「首次提交」走到这里（重复提交在上面幂等分支已返回）。
  // 推送失败只记日志，不影响提交结果（42 文档 T-P2-3 完成标准）
  if (submit) {
    await notifyOwnerSubmit(project, modelId, now)
  }

  return {
    ok: true,
    data: { saved: true, locked: !!submit, selectedCount: ids.length },
  }
}

/* ---------- 订阅消息（T-P2-3） ---------- */

/** 模板 ID 走环境变量（云开发控制台 → 云函数 selection → 配置 → 环境变量），不硬编码 */
const SUBSCRIBE_TPL_ID = process.env.SUBSCRIBE_TPL_ID || ''
/** 开发期用体验版，正式发布前在环境变量里改成 formal（与 B-3 同批） */
const SUBSCRIBE_MSG_STATE = process.env.SUBSCRIBE_MSG_STATE || 'trial'

/**
 * 模特提交时给项目主人推一条「选片完成通知」
 * 授权模型：一次 notifyAuth 推一次，推完即消耗（置 false）。
 * 模板「用户加入任务提醒」：thing1=用户（模特名） thing2=任务名称（项目名） time3=时间
 */
async function notifyOwnerSubmit(project, modelId, now) {
  try {
    if (!project.ownerOpenid) return
    if (!SUBSCRIBE_TPL_ID) {
      console.log('[notify] 跳过：未配置环境变量 SUBSCRIBE_TPL_ID')
      return
    }

    const invRes = await db
      .collection('invite')
      .where({ projectId: project._id, modelId: modelId })
      .limit(1)
      .get()
    const inv = invRes.data && invRes.data[0]
    if (!inv || !inv.notifyAuth) return // 未授权：静默不推（03_USER_FLOW 通知流程）

    const name = modelDisplayName(project, modelId)
    // thing 类型限 20 字符
    const res = await cloud.openapi.subscribeMessage.send({
      touser: project.ownerOpenid,
      templateId: SUBSCRIBE_TPL_ID,
      page: 'pages/project-detail/index?id=' + project._id,
      miniprogramState: SUBSCRIBE_MSG_STATE,
      data: {
        thing1: { value: String(name).slice(0, 20) },
        thing2: { value: String(project.name || '').slice(0, 20) },
        time3: { value: fmtCnTime(now) },
      },
    })
    console.log('[notify] 已推送', JSON.stringify(res))

    // 消耗这次授权
    await db.collection('invite').doc(inv._id).update({
      data: { notifyAuth: false, notifyUsedAt: now },
    })
  } catch (e) {
    // 43101 = 用户未订阅/已拒收；其余错误同样只记日志，不回滚提交
    console.log('[notify] 推送失败（不影响提交）', e.errCode || '', e.errMsg || e.message)
  }
}

/** 从 project.models 里取模特备注名；找不到就用「模特」兜底 */
function modelDisplayName(project, modelId) {
  const hit = (project.models || []).find((m) => m.modelId === modelId)
  return (hit && hit.name) || '模特'
}

/** 订阅消息 time 类型要求的格式：2026年10月5日 14:56 */
function fmtCnTime(ts) {
  const d = new Date(ts)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return (
    d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
  )
}

/* ---------- 摄影师端 ---------- */

/** 某位模特的选片结果 */
async function getResult({ projectId, modelId }, openid) {
  if (!(await isAdmin(openid))) {
    return { ok: false, error: '无权限：仅摄影师可查看选片结果' }
  }
  if (!projectId || !modelId) return { ok: false, error: '缺少参数' }

  const selRes = await db
    .collection('selection')
    .where({ projectId, modelId })
    .limit(1)
    .get()
  const sel = selRes.data[0] || null
  const selectedSet = new Set((sel && sel.photoIds) || [])

  const res = await db
    .collection('photo')
    .where({ projectId })
    .orderBy('sortOrder', 'asc')
    .limit(1000)
    .get()
  const photos = res.data || []

  const selectedPhotos = photos.filter((p) => selectedSet.has(p._id))
  const urlMap = await tempUrls(selectedPhotos.map((p) => p.thumbFileID))

  return {
    ok: true,
    data: {
      locked: !!(sel && sel.locked),
      submittedAt: (sel && sel.submittedAt) || 0,
      selectedCount: selectedPhotos.length,
      photos: selectedPhotos.map((p) => ({
        _id: p._id,
        filename: p.filename,
        thumbUrl: urlMap[p.thumbFileID] || '',
      })),
    },
  }
}

/**
 * 一次取回项目下全部模特的已选文件名（网页导出用，22_API 5.10）
 * 只返回文件名，**不生成任何临时链接**（BR-805：导出不需要图，零额外云调用）
 */
async function getProjectResults({ projectId }, openid) {
  if (!(await isAdmin(openid))) {
    return { ok: false, error: '无权限：仅摄影师可查看选片结果' }
  }
  if (!projectId) return { ok: false, error: '缺少参数' }

  const p = await projectById(projectId)
  // 非本人项目与「不存在」返回同一句，避免用报错差异探测别人的项目 ID
  if (!p || p.ownerOpenid !== openid) {
    return { ok: false, error: '项目不存在或无权访问' }
  }

  // 一次查 photo 建 _id → filename 映射
  const photoRes = await db
    .collection('photo')
    .where({ projectId })
    .limit(1000)
    .get()
  const nameOf = {}
  ;(photoRes.data || []).forEach((ph) => {
    nameOf[ph._id] = ph.filename
  })

  // 一次查全体模特的选片记录
  const selRes = await db
    .collection('selection')
    .where({ projectId })
    .limit(100)
    .get()
  const selMap = {}
  ;(selRes.data || []).forEach((s) => {
    selMap[s.modelId] = s
  })

  const models = (p.models || []).map((m) => {
    const s = selMap[m.modelId] || null
    const ids = (s && s.photoIds) || []
    const filenames = ids
      .map((id) => nameOf[id])
      .filter((n) => !!n)
      .sort() // 服务端按文件名升序排好，前端不再排
    return {
      modelId: m.modelId,
      displayName: m.name || '',
      locked: !!(s && s.locked),
      submittedAt: (s && s.submittedAt) || 0,
      selectedCount: filenames.length,
      filenames,
    }
  })

  return {
    ok: true,
    data: {
      projectId,
      projectName: p.name,
      photoCount: p.photoCount || 0,
      packageCount: typeof p.packageCount === 'number' ? p.packageCount : 0,
      status: p.status,
      expireAt: p.expireAt || 0,
      models,
    },
  }
}

/** 重新开放某位模特的选片：解锁但保留她已选的照片，在其基础上继续挑 */
async function resetLock({ projectId, modelId }, openid) {
  if (!(await isAdmin(openid))) {
    return { ok: false, error: '无权限：仅摄影师可重新开放选片' }
  }
  if (!projectId || !modelId) return { ok: false, error: '缺少参数' }

  const now = Date.now()
  const selRes = await db
    .collection('selection')
    .where({ projectId, modelId })
    .limit(1)
    .get()
  const sel = selRes.data[0]
  const keep = (sel && sel.photoIds) || []
  if (sel) {
    await db.collection('selection').doc(sel._id).update({
      data: { locked: false, submittedAt: 0, photoIds: keep, updatedAt: now },
    })
  }

  await updateModelSummary(projectId, modelId, {
    selectedCount: keep.length,
    status: keep.length > 0 ? '选片中' : '待选片',
    submittedAt: 0,
  })
  await db.collection('project').doc(projectId).update({
    data: { status: 'SELECTING', updatedAt: now },
  })

  return { ok: true, data: { reset: true } }
}

/* ---------- guards & helpers ---------- */

async function inviteByToken(token) {
  const t = String(token || '').trim()
  if (t.length < 16) throw new Error('邀请链接无效，请通过摄影师分享的入口进入')
  const res = await db.collection('invite').where({ token: t }).limit(1).get()
  const inv = res.data[0]
  if (!inv) throw new Error('邀请链接已失效，请联系摄影师重新发送')
  return inv
}

async function projectById(id) {
  const res = await db.collection('project').doc(String(id || '')).get()
  const p = res.data
  if (!p) throw new Error('项目不存在')
  return p
}

function assertNotExpired(p) {
  if (p.expireAt && p.expireAt < Date.now()) {
    throw new Error('项目已过期，请联系摄影师')
  }
}

/**
 * 模特端统一守卫：项目有效 + 该模特确实被邀请 + openid 与模特档案一致。
 * 摄影师（管理员）放行，方便自测。
 */
async function guardModel(projectId, modelId, openid) {
  if (!projectId || !modelId) throw new Error('缺少参数')

  const project = await projectById(projectId)
  assertNotExpired(project)

  const invRes = await db
    .collection('invite')
    .where({ projectId, modelId })
    .limit(1)
    .get()
  if (!invRes.data.length) throw new Error('你没有被邀请进这个项目')

  if (await isAdmin(openid)) {
    const selRes = await db
      .collection('selection')
      .where({ projectId, modelId })
      .limit(1)
      .get()
    return { project, selection: selRes.data[0] || null }
  }

  const mRes = await db.collection('model').doc(modelId).get()
  const model = mRes.data
  if (!model || model.openid !== openid) {
    throw new Error('请用你自己的微信打开，或联系摄影师重新发送链接')
  }

  const selRes = await db
    .collection('selection')
    .where({ projectId, modelId })
    .limit(1)
    .get()
  const selection = selRes.data[0] || null

  if (project.status === 'DRAFT' || project.status === 'UPLOADING') {
    await db.collection('project').doc(projectId).update({
      data: { status: 'SELECTING', updatedAt: Date.now() },
    })
  }

  return { project, selection }
}

async function ensureSelection(projectId, modelId) {
  const selRes = await db
    .collection('selection')
    .where({ projectId, modelId })
    .limit(1)
    .get()
  if (selRes.data[0]) return selRes.data[0]

  const now = Date.now()
  const add = await db.collection('selection').add({
    data: {
      projectId,
      modelId,
      photoIds: [],
      locked: false,
      submittedAt: 0,
      createdAt: now,
      updatedAt: now,
    },
  })
  return { _id: add._id, photoIds: [], locked: false }
}

async function ensureSelectionId(projectId, modelId) {
  const sel = await ensureSelection(projectId, modelId)
  return sel._id
}

/** 更新 project.models 里某位模特的摘要，并顺带推进项目状态 */
async function updateModelSummary(projectId, modelId, patch) {
  const p = await projectById(projectId)
  const models = (p.models || []).map((m) =>
    m.modelId === modelId ? Object.assign({}, m, patch) : m
  )
  const update = { models, updatedAt: Date.now() }

  const all = models.length > 0 && models.every((m) => m.status === '已提交')
  if (all) update.status = 'SELECTION_SUBMITTED'
  // 归档项目不能被模特的保存动作拉回 SELECTING（31_STATE_MACHINE 2.5）
  else if (p.status !== 'SELECTION_SUBMITTED' && p.status !== 'ARCHIVED') {
    update.status = 'SELECTING'
  }

  await db.collection('project').doc(projectId).update({ data: update })
  return models
}

/** 临时链接有效期：24 小时（maxAge 单位是「秒」，官方默认 86400）。
 *  注意：wx-server-sdk 的 getTempFileURL 签名是 fileList: string[]，传
 *  {fileID, maxAge} 时 maxAge 不保证生效；私有读文件的临时链接实测只有约
 *  10 分钟有效期（链接里的 t 参数就是到期时刻）。端上按链接自带 t 判断新鲜度
 *  （见 services/urlcache.ts），不要写死长 TTL（与 photo 同一套口径） */
const TEMP_URL_MAX_AGE = 86400

/** 批量取临时链接（getTempFileURL 单次最多 50 个） */
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

async function isAdmin(openid) {
  try {
    const res = await db.collection('admin').where({ openid }).limit(1).get()
    return res.data.length > 0
  } catch (e) {
    return false
  }
}
