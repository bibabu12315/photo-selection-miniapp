const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

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
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { ok: false, error: '取不到 OPENID，请通过小程序端调用' }
  }

  try {
    switch (event.action) {
      case 'whoami':
        return await whoami(OPENID)
      case 'entry':
        return await entry(event, OPENID)
      case 'myList':
        return await myList(OPENID)
      case 'getPhotos':
        return await getPhotos(event, OPENID)
      case 'getPreview':
        return await getPreview(event, OPENID)
      case 'saveSelection':
        return await saveSelection(event, OPENID, false)
      case 'submitSelection':
        return await saveSelection(event, OPENID, true)
      case 'getResult':
        return await getResult(event, OPENID)
      case 'resetLock':
        return await resetLock(event, OPENID)
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
async function getPhotos({ projectId, modelId, skip = 0, limit = 18 }, openid) {
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
  const urlMap = await tempUrls(photos.map((p) => p.thumbFileID))

  return {
    ok: true,
    data: {
      photos: photos.map((p) => ({
        _id: p._id,
        filename: p.filename,
        width: p.width || 0,
        height: p.height || 0,
        thumbUrl: urlMap[p.thumbFileID] || '',
      })),
      hasMore: photos.length === l,
      locked: !!(selection && selection.locked),
      packageCount: project.packageCount || 0,
    },
  }
}

/** 单张大图临时链接 */
async function getPreview({ projectId, modelId, photoId }, openid) {
  const { project } = await guardModel(projectId, modelId, openid)

  const res = await db.collection('photo').doc(String(photoId || '')).get()
  const photo = res.data
  if (!photo || photo.projectId !== project._id) {
    return { ok: false, error: '照片不存在' }
  }

  const urlMap = await tempUrls([photo.previewFileID])
  return {
    ok: true,
    data: {
      photoId: photo._id,
      filename: photo.filename,
      previewUrl: urlMap[photo.previewFileID] || '',
    },
  }
}

/** 保存 / 提交选片（提交后仍可回来调整，重新提交覆盖上一版） */
async function saveSelection({ projectId, modelId, photoIds }, openid, submit) {
  const { project } = await guardModel(projectId, modelId, openid)

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

  return {
    ok: true,
    data: { saved: true, locked: !!submit, selectedCount: ids.length },
  }
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
  else if (p.status !== 'SELECTION_SUBMITTED') update.status = 'SELECTING'

  await db.collection('project').doc(projectId).update({ data: update })
  return models
}

/** 批量取临时链接（getTempFileURL 单次最多 50 个） */
async function tempUrls(fileIDs) {
  const out = {}
  const list = Array.from(new Set((fileIDs || []).filter(Boolean)))
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
