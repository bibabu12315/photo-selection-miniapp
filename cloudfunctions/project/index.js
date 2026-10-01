const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

/** 每个项目最多邀请的模特数 */
const MAX_MODELS = 5

/**
 * 项目管理云函数（仅摄影师可调用，V2.0）
 *
 * action = create            创建项目 { name, shootDate?, note?, expireDays?, packageCount? }
 * action = list              项目列表（按创建时间倒序）
 * action = get               项目详情 { _id }
 * action = remove            删除项目（连带清理邀请/选片/照片记录）{ _id }
 * action = extend            项目延期 30 天 { _id }
 * action = issueUploadCode   签发 6 位上传码，5 分钟有效 { _id }
 *
 * 模特邀请（每项目最多 5 位）：
 * action = createInvite      邀请模特 { projectId, displayName }
 * action = removeInvite      移除模特 { inviteId }
 * action = listInvites       邀请列表 { projectId }
 * action = getInviteQrCode   生成该模特的小程序码（scene = 邀请 token）{ inviteId }
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    return { ok: false, error: '取不到 OPENID，请通过小程序端调用' }
  }

  try {
    if (!(await isAdmin(OPENID))) {
      return { ok: false, error: '无权限：请先绑定摄影师' }
    }

    // 所有 action 都带 OPENID：项目归属到人，摄影师之间互不可见
    switch (event.action) {
      case 'create':
        return await createProject(event, OPENID)
      case 'list':
        return await listProjects(OPENID)
      case 'get':
        return await getProject(event._id, OPENID)
      case 'remove':
        return await removeProject(event._id, OPENID)
      case 'extend':
        return await extendProject(event._id, OPENID)
      case 'issueUploadCode':
        return await issueUploadCode(event._id, OPENID)
      case 'createInvite':
        return await createInvite(event, OPENID)
      case 'removeInvite':
        return await removeInvite(event.inviteId, OPENID)
      case 'listInvites':
        return await listInvites(event.projectId, OPENID)
      case 'getInviteQrCode':
        return await getInviteQrCode(event.inviteId, OPENID)
      default:
        return { ok: false, error: '未知 action: ' + (event.action || '') }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

/* ---------- 项目 ---------- */

async function createProject(event, openid) {
  const name = String(event.name || '').trim()
  if (!name) return { ok: false, error: '项目名称不能为空' }
  if (name.length > 30) return { ok: false, error: '项目名称不能超过 30 个字' }

  let expireDays = parseInt(event.expireDays, 10)
  if (!expireDays || expireDays < 1) expireDays = 30
  if (expireDays > 365) expireDays = 365

  // packageCount：0 = 不限
  let packageCount = parseInt(event.packageCount, 10)
  if (!packageCount || packageCount < 0) packageCount = 0
  if (packageCount > 999) packageCount = 999

  const shootAt = parseDate(event.shootDate)
  const now = Date.now()

  const doc = {
    ownerOpenid: openid,
    name,
    note: String(event.note || '').trim().slice(0, 200),
    shootDate: shootAt || now,
    status: 'DRAFT',
    previewSpec: { preset: 'standard', longEdge: 2048, quality: 82, watermarkText: '' },
    expireAt: now + expireDays * 86400000,
    packageCount,
    uploadCode: '',
    uploadCodeExpireAt: 0,
    uploadToken: '',
    uploadTokenExpireAt: 0,
    photoCount: 0,
    coverThumbs: [],
    modelCount: 0,
    models: [],
    createdAt: now,
    updatedAt: now,
  }

  const add = await db.collection('project').add({ data: doc })
  return { ok: true, data: { _id: add._id } }
}

/** 只返回自己的项目 */
async function listProjects(openid) {
  const res = await db
    .collection('project')
    .where({ ownerOpenid: openid })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get()
  return { ok: true, data: { projects: res.data || [] } }
}

async function getProject(id, openid) {
  const own = await ownedProject(id, openid)
  if (!own.ok) return { ok: false, error: own.error }
  const p = own.project

  const invRes = await db.collection('invite').where({ projectId: id }).limit(20).get()
  const invites = (invRes.data || []).map((i) => ({
    _id: i._id,
    modelId: i.modelId,
    token: i.token,
  }))

  return { ok: true, data: { project: res.data, invites } }
}

async function removeProject(id, openid) {
  const own = await ownedProject(id, openid)
  if (!own.ok) return { ok: false, error: own.error }

  // 连带清理：邀请 / 选片记录 / 照片记录（云存储文件在控制台手动清理）
  try {
    const invRes = await db.collection('invite').where({ projectId: id }).limit(50).get()
    for (const inv of invRes.data || []) {
      await db.collection('invite').doc(inv._id).remove()
    }
  } catch (e) {
    /* 集合不存在时忽略 */
  }
  try {
    const selRes = await db.collection('selection').where({ projectId: id }).limit(50).get()
    for (const s of selRes.data || []) {
      await db.collection('selection').doc(s._id).remove()
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    const pRes = await db.collection('photo').where({ projectId: id }).limit(1000).get()
    for (const p of pRes.data || []) {
      await db.collection('photo').doc(p._id).remove()
    }
  } catch (e) {
    /* 忽略 */
  }

  await db.collection('project').doc(id).remove()
  return { ok: true, data: { removed: true } }
}

async function extendProject(id, openid) {
  const own = await ownedProject(id, openid)
  if (!own.ok) return { ok: false, error: own.error }
  const p = own.project

  const base = p.expireAt && p.expireAt > Date.now() ? p.expireAt : Date.now()
  const expireAt = base + 30 * 86400000
  await db.collection('project').doc(id).update({
    data: { expireAt, status: p.status === 'EXPIRED' ? 'SELECTING' : p.status, updatedAt: Date.now() },
  })
  return { ok: true, data: { expireAt } }
}

async function issueUploadCode(id, openid) {
  const own = await ownedProject(id, openid)
  if (!own.ok) return { ok: false, error: own.error }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const expireAt = Date.now() + 5 * 60 * 1000

  await db.collection('project').doc(id).update({
    data: { uploadCode: code, uploadCodeExpireAt: expireAt, updatedAt: Date.now() },
  })

  return { ok: true, data: { uploadCode: code, uploadCodeExpireAt: expireAt } }
}

/* ---------- 模特邀请 ---------- */

async function createInvite({ projectId, displayName }, openid) {
  const own = await ownedProject(projectId, openid)
  if (!own.ok) return { ok: false, error: own.error }
  const p = own.project

  const name = String(displayName || '').trim().slice(0, 20)
  if (!name) return { ok: false, error: '请填写模特名字（备注用，如「小王」）' }
  if ((p.models || []).length >= MAX_MODELS) {
    return { ok: false, error: `每个项目最多邀请 ${MAX_MODELS} 位模特` }
  }

  const now = Date.now()
  const mAdd = await db.collection('model').add({
    data: { openid: '', displayName: name, createdAt: now, updatedAt: now },
  })
  const modelId = mAdd._id

  const iAdd = await db.collection('invite').add({
    data: { projectId, modelId, token: randomBase62(22), createdAt: now },
  })

  const models = (p.models || []).concat([
    { modelId, name, selectedCount: 0, status: '待选片', submittedAt: 0 },
  ])
  await db.collection('project').doc(projectId).update({
    data: { models, modelCount: models.length, updatedAt: now },
  })

  return {
    ok: true,
    data: { inviteId: iAdd._id, modelId, token: '', models },
  }
}

async function removeInvite(inviteId, openid) {
  if (!inviteId) return { ok: false, error: '缺少邀请 _id' }
  const res = await db.collection('invite').doc(inviteId).get()
  const inv = res.data
  if (!inv) return { ok: false, error: '邀请不存在' }

  const own = await ownedProject(inv.projectId, openid)
  if (!own.ok) return { ok: false, error: own.error }

  try {
    await db.collection('model').doc(inv.modelId).remove()
  } catch (e) {
    /* 忽略 */
  }
  try {
    const selRes = await db
      .collection('selection')
      .where({ projectId: inv.projectId, modelId: inv.modelId })
      .limit(1)
      .get()
    for (const s of selRes.data || []) await db.collection('selection').doc(s._id).remove()
  } catch (e) {
    /* 忽略 */
  }
  await db.collection('invite').doc(inviteId).remove()

  const pRes = await db.collection('project').doc(inv.projectId).get()
  const p = pRes.data
  if (p) {
    const models = (p.models || []).filter((m) => m.modelId !== inv.modelId)
    await db.collection('project').doc(inv.projectId).update({
      data: { models, modelCount: models.length, updatedAt: Date.now() },
    })
  }
  return { ok: true, data: { removed: true } }
}

async function listInvites(projectId, openid) {
  const own = await ownedProject(projectId, openid)
  if (!own.ok) return { ok: false, error: own.error }

  const res = await db.collection('invite').where({ projectId }).limit(20).get()
  const invites = (res.data || []).map((i) => ({
    _id: i._id,
    modelId: i.modelId,
    token: i.token,
  }))
  return { ok: true, data: { invites } }
}

/** 生成模特专属小程序码，scene = 邀请 token（22 位 ≤ 32 字符限制） */
async function getInviteQrCode(inviteId, openid) {
  if (!inviteId) return { ok: false, error: '缺少邀请 _id' }
  const res = await db.collection('invite').doc(inviteId).get()
  const inv = res.data
  if (!inv) return { ok: false, error: '邀请不存在' }

  const own = await ownedProject(inv.projectId, openid)
  if (!own.ok) return { ok: false, error: own.error }

  const qr = await cloud.openapi.wxacode.getUnlimited({
    scene: inv.token,
    page: 'pages/client-select/index',
    checkPath: false,
    envVersion: 'trial',
    width: 430,
  })
  if (!qr || !qr.buffer) return { ok: false, error: '小程序码生成失败' }

  const cloudPath = `p/${inv.projectId}/qrcode-${inv.modelId}.png`
  await cloud.uploadFile({ cloudPath, fileContent: qr.buffer })

  const env = (cloud.getWXContext() || {}).ENV || cloud.DYNAMIC_CURRENT_ENV
  return { ok: true, data: { fileID: `cloud://${env}.${bucket()}/${cloudPath}` } }
}

function bucket() {
  return process.env.STORAGE_BUCKET || '636c-cloud1-d2guu7uw1a306815a-1499127316'
}

/* ---------- helpers ---------- */

async function isAdmin(openid) {
  try {
    const res = await db.collection('admin').where({ openid }).limit(1).get()
    return res.data.length > 0
  } catch (e) {
    return false
  }
}

/**
 * 取项目并校验归属：不是自己的项目一律拒绝，摄影师之间互不可见、互不可删。
 * 兼容期：老项目没有 ownerOpenid 字段时放行（迁移脚本跑完后所有项目都有归属）。
 */
async function ownedProject(id, openid) {
  if (!id) return { ok: false, error: '缺少项目 _id' }
  let p = null
  try {
    const res = await db.collection('project').doc(id).get()
    p = res.data
  } catch (e) {
    p = null
  }
  if (!p) return { ok: false, error: '项目不存在' }
  if (p.ownerOpenid && p.ownerOpenid !== openid) {
    return { ok: false, error: '无权限：这不是你的项目' }
  }
  return { ok: true, project: p }
}

/** 日期字符串 → 时间戳，失败返回 0 */
function parseDate(s) {
  const v = String(s || '').trim()
  if (!v) return 0
  const t = Date.parse(v.length <= 10 ? v + 'T00:00:00' : v)
  return isNaN(t) ? 0 : t
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomBase62(len) {
  const bytes = crypto.randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += BASE62[bytes[i] % 62]
  return s
}
