const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/**
 * 模特选片云函数
 *
 * 模特端（凭项目 accessToken 调用，openid 一码一人绑定）：
 *   action = entry            { token }                        进入项目：校验有效期 + 绑定 openid + 返回项目信息与已选列表
 *   action = getPhotos        { token, skip, limit }           分页拉取照片（含缩略图临时链接）
 *   action = getPreview       { token, photoId }               单张预览图临时链接（大图按需加载）
 *   action = saveSelection    { token, photoIds }              保存选择（未锁定时，整体覆盖）
 *   action = submitSelection  { token, photoIds }              提交并锁定
 *
 * 摄影师端（需管理员身份）：
 *   action = getResult        { projectId }                    选片结果：选中照片 + 缩略图临时链接
 *   action = resetLock        { projectId }                    重新开放选片（解锁 + 清空绑定 + 计数归零）
 *
 * 前置：project / photo 集合已存在；selection 集合需手动创建（权限：仅管理端可读写）
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { ok: false, error: '取不到 OPENID，请通过小程序端调用' }
  }

  try {
    switch (event.action) {
      case 'entry':
        return await entry(event, OPENID)
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

/* ---------- 模特端 ---------- */

/** 进入项目：校验 token + 有效期 + 一码一人绑定，返回项目概况和已选 photoIds */
async function entry({ token }, openid) {
  const { project } = await projectByToken(token)

  const sel = await ensureSelection(project, openid)
  if (!sel.ok) return { ok: false, error: sel.error }

  const doc = sel.doc || { locked: false, photoIds: [] }
  const locked = !!doc.locked
  return {
    ok: true,
    data: {
      projectId: project._id,
      name: project.name,
      clientName: project.clientName || '',
      photoCount: project.photoCount || 0,
      locked,
      selectedCount: locked ? (doc.photoIds || []).length : 0,
      selectedIds: doc.photoIds || [],
    },
  }
}

/** 分页拉取照片 + 缩略图临时链接 */
async function getPhotos({ token, skip = 0, limit = 18 }, openid) {
  const { project, selection } = await guardClient(token, openid)

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
    },
  }
}

/** 单张预览图临时链接（模特大图按需加载） */
async function getPreview({ token, photoId }, openid) {
  const { project } = await guardClient(token, openid)

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
      selected: false, // 由页面根据本地状态覆盖
    },
  }
}

/** 保存 / 提交选片 */
async function saveSelection({ token, photoIds }, openid, submit) {
  const { project, selection } = await guardClient(token, openid)

  if (selection && selection.locked) {
    return { ok: false, error: '选片已提交锁定，如需修改请联系摄影师重新开放' }
  }

  // photoIds 校验：数组、元素为合法 id、数量不超过项目照片总数
  const ids = Array.isArray(photoIds)
    ? photoIds.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{5,64}$/.test(x))
    : []
  const unique = Array.from(new Set(ids))
  const cnt = await db.collection('photo').where({ projectId: project._id }).count()
  if (unique.length > cnt.total) {
    return { ok: false, error: '选择数量超出项目照片总数，请重试' }
  }

  const now = Date.now()

  // 管理员自测时可能还没有 selection 文档，先补建
  let selId = selection && selection._id
  if (!selId) {
    const add = await db.collection('selection').add({
      data: {
        projectId: project._id,
        photoIds: [],
        locked: false,
        submittedAt: 0,
        boundOpenid: '',
        createdAt: now,
        updatedAt: now,
      },
    })
    selId = add._id
  }

  const update = { photoIds: unique, updatedAt: now }
  if (submit) {
    update.locked = true
    update.submittedAt = now
  }
  await db.collection('selection').doc(selId).update({ data: update })

  if (submit) {
    await db.collection('project').doc(project._id).update({
      data: { selectedCount: unique.length, status: 'SELECTION_SUBMITTED', updatedAt: now },
    })
  }

  return {
    ok: true,
    data: {
      saved: true,
      locked: !!submit,
      selectedCount: unique.length,
    },
  }
}

/* ---------- 摄影师端 ---------- */

/** 选片结果：选中照片（缩略图 + 文件名，按 sortOrder 升序与 Lightroom 对齐） */
async function getResult({ projectId }, openid) {
  if (!(await isAdmin(openid))) {
    return { ok: false, error: '无权限：仅摄影师可查看选片结果' }
  }
  if (!projectId) return { ok: false, error: '缺少项目 _id' }

  let sel = null
  try {
    const res = await db.collection('selection').where({ projectId }).limit(1).get()
    sel = res.data[0] || null
  } catch (e) {
    sel = null
  }

  const selectedSet = new Set((sel && sel.photoIds) || [])

  const res = await db
    .collection('photo')
    .where({ projectId })
    .orderBy('sortOrder', 'asc')
    .limit(1000)
    .get()
  const photos = res.data || []

  // 只为选中的照片取临时链接，节省调用
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

/** 重新开放选片：解锁 + 清空提交状态 + 解绑微信账号（模特换人时用） */
async function resetLock({ projectId }, openid) {
  if (!(await isAdmin(openid))) {
    return { ok: false, error: '无权限：仅摄影师可重新开放选片' }
  }
  if (!projectId) return { ok: false, error: '缺少项目 _id' }

  const now = Date.now()
  const selRes = await db.collection('selection').where({ projectId }).limit(1).get()
  const sel = selRes.data[0]
  if (sel) {
    await db.collection('selection').doc(sel._id).update({
      data: { locked: false, submittedAt: 0, photoIds: [], boundOpenid: '', updatedAt: now },
    })
  }
  await db.collection('project').doc(projectId).update({
    data: { selectedCount: 0, status: 'SELECTING', updatedAt: now },
  })

  return { ok: true, data: { reset: true } }
}

/* ---------- guards & helpers ---------- */

/** token → 项目，并校验有效期 */
async function projectByToken(token) {
  const t = String(token || '').trim()
  if (t.length < 16) {
    throw new Error('访问链接无效，请通过摄影师分享的入口进入')
  }
  const res = await db.collection('project').where({ accessToken: t }).limit(1).get()
  const project = res.data[0]
  if (!project) {
    throw new Error('项目不存在或链接已失效，请联系摄影师重新分享')
  }
  if (project.expireAt && project.expireAt < Date.now()) {
    throw new Error('项目已过期，请联系摄影师')
  }
  return { project }
}

/**
 * 模特端统一守卫：token 有效 + openid 绑定校验。
 * 管理员（摄影师本人）直接放行且不写入绑定，方便自测。
 */
async function guardClient(token, openid) {
  const { project } = await projectByToken(token)

  const selRes = await db.collection('selection').where({ projectId: project._id }).limit(1).get()
  const selection = selRes.data[0] || null

  if (await isAdmin(openid)) {
    return { project, selection: selection || { _id: '', photoIds: [], locked: false } }
  }

  if (!selection) {
    throw new Error('请先重新进入项目（入口链接无效）')
  }
  if (selection.boundOpenid && selection.boundOpenid !== openid) {
    throw new Error('此链接已被其他微信账号使用，请联系摄影师重新分享')
  }
  return { project, selection }
}

/** 进入时补建/补绑 selection 文档；管理员不绑定 */
async function ensureSelection(project, openid) {
  const now = Date.now()
  const selRes = await db.collection('selection').where({ projectId: project._id }).limit(1).get()
  let doc = selRes.data[0] || null

  if (!(await isAdmin(openid))) {
    if (!doc) {
      const add = await db.collection('selection').add({
        data: {
          projectId: project._id,
          photoIds: [],
          locked: false,
          submittedAt: 0,
          boundOpenid: openid,
          createdAt: now,
          updatedAt: now,
        },
      })
      doc = { _id: add._id, photoIds: [], locked: false }
    } else if (!doc.boundOpenid) {
      await db.collection('selection').doc(doc._id).update({
        data: { boundOpenid: openid, updatedAt: now },
      })
    } else if (doc.boundOpenid !== openid) {
      return { ok: false, error: '此链接已被其他微信账号使用，请联系摄影师重新分享' }
    }
  }

  // 首次进入时把状态推到 SELECTING（保持 SELECTING 以后的状态不变）
  if (project.status === 'DRAFT' || project.status === 'UPLOADING') {
    await db.collection('project').doc(project._id).update({
      data: { status: 'SELECTING', updatedAt: now },
    })
  }

  return { ok: true, doc }
}

/** 批量取临时链接（getTempFileURL 单次最多 50 个，分块调用） */
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
