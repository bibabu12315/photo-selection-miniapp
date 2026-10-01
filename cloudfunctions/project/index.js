const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const crypto = require('crypto')

/**
 * 项目管理云函数（仅管理员可调用）
 *
 * action = create            创建项目 { name, clientName?, expireDays? }
 * action = list              项目列表（按创建时间倒序）
 * action = get               项目详情 { _id }
 * action = remove            删除项目 { _id }
 * action = issueUploadCode   签发 6 位一次性上传码，5 分钟有效 { _id }
 * action = getQrCode         生成模特选片小程序码（scene=accessToken）{ _id }
 *
 * 前置条件：数据库存在 project 集合（权限：仅管理端可读写），
 *           admin 集合中已有绑定记录（先用 admin 云函数绑定）
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()

  if (!OPENID) {
    return { ok: false, error: '取不到 OPENID，请通过小程序端调用' }
  }

  try {
    if (!(await isAdmin(OPENID))) {
      return { ok: false, error: '无权限：请先绑定管理员' }
    }

    switch (event.action) {
      case 'create':
        return await createProject(event)
      case 'list':
        return await listProjects()
      case 'get':
        return await getProject(event._id)
      case 'remove':
        return await removeProject(event._id)
      case 'issueUploadCode':
        return await issueUploadCode(event._id)
      case 'getQrCode':
        return await getQrCode(event._id)
      default:
        return { ok: false, error: '未知 action: ' + (event.action || '') }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

/* ---------- actions ---------- */

async function createProject(event) {
  const name = String(event.name || '').trim()
  if (!name) {
    return { ok: false, error: '项目名称不能为空' }
  }
  if (name.length > 30) {
    return { ok: false, error: '项目名称不能超过 30 个字' }
  }

  const clientName = String(event.clientName || '').trim().slice(0, 30)
  let expireDays = parseInt(event.expireDays, 10)
  if (!expireDays || expireDays < 1) expireDays = 30
  if (expireDays > 365) expireDays = 365

  const now = Date.now()
  const doc = {
    name,
    clientName,
    status: 'DRAFT',
    previewSpec: { preset: 'standard', longEdge: 2048, quality: 82, watermarkText: '' },
    expireAt: now + expireDays * 86400000,
    accessToken: randomBase62(22),
    uploadCode: '',
    uploadCodeExpireAt: 0,
    photoCount: 0,
    selectedCount: 0,
    createdAt: now,
    updatedAt: now,
  }

  const add = await db.collection('project').add({ data: doc })
  return { ok: true, data: { _id: add._id } }
}

async function listProjects() {
  const res = await db
    .collection('project')
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get()
  return { ok: true, data: { projects: res.data } }
}

async function getProject(id) {
  if (!id) return { ok: false, error: '缺少项目 _id' }
  const res = await db.collection('project').doc(id).get()
  if (!res.data) return { ok: false, error: '项目不存在' }
  return { ok: true, data: { project: res.data } }
}

async function removeProject(id) {
  if (!id) return { ok: false, error: '缺少项目 _id' }
  await db.collection('project').doc(id).remove()
  // 注：照片记录与存储文件暂不级联删除，V1.0 项目数少，可在控制台手动清理
  return { ok: true, data: { removed: true } }
}

async function issueUploadCode(id) {
  if (!id) return { ok: false, error: '缺少项目 _id' }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
  const expireAt = Date.now() + 5 * 60 * 1000

  await db.collection('project').doc(id).update({
    data: { uploadCode: code, uploadCodeExpireAt: expireAt, updatedAt: Date.now() },
  })

  return { ok: true, data: { uploadCode: code, uploadCodeExpireAt: expireAt } }
}

/** 生成模特选片小程序码，存入云存储，返回 fileID（image 组件可直接显示） */
async function getQrCode(id) {
  if (!id) return { ok: false, error: '缺少项目 _id' }

  const res = await db.collection('project').doc(id).get()
  const p = res.data
  if (!p) return { ok: false, error: '项目不存在' }

  // scene 上只放 accessToken（22 位 base62 ≤ 32 字符限制），
  // 模特端从 pages/client-select/index 的 options.scene 取出并查项目
  const qr = await cloud.openapi.wxacode.getUnlimited({
    scene: p.accessToken,
    page: 'pages/client-select/index',
    checkPath: false,
    envVersion: 'trial', // 小程序未发布时扫体验版；正式发布后可改 'release'
    width: 430,
  })
  if (!qr || !qr.buffer) {
    return { ok: false, error: '小程序码生成失败' }
  }

  const cloudPath = `p/${id}/qrcode.png`
  await cloud.uploadFile({ cloudPath, fileContent: qr.buffer })

  const env = (cloud.getWXContext() || {}).ENV || cloud.DYNAMIC_CURRENT_ENV
  return { ok: true, data: { fileID: `cloud://${env}.${bucket()}/${cloudPath}` } }
}

function bucket() {
  // 存储桶名：取自 photo 云函数同一约定，更换环境时同步修改
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

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 高熵随机 token，22 位 base62 ≈ 131 bit */
function randomBase62(len) {
  const bytes = crypto.randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += BASE62[bytes[i] % 62]
  return s
}
