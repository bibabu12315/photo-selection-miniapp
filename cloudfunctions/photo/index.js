const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

/** 当前环境存储桶名（fileID 前缀用）。更换环境时同步修改，或在云函数配置环境变量 STORAGE_BUCKET 覆盖 */
const BUCKET = '636c-cloud1-d2guu7uw1a306815a-1499127316'

/**
 * 照片登记云函数（电脑端上传页调用，无 OPENID，靠上传码/会话 token 鉴权）
 *
 * action = verifyCode    { code }                         校验 6 位上传码，换 24h 上传会话 token
 * action = registerPhoto { projectId, uploadToken, ... }  登记一张照片（同名 stem 覆盖更新）
 *
 * 前置：project 集合存在（仅管理端可读写）、photo 集合存在（仅管理端可读写）
 */
exports.main = async (event = {}) => {
  try {
    switch (event.action) {
      case 'verifyCode':
        return await verifyCode(event)
      case 'registerPhoto':
        return await registerPhoto(event)
      default:
        return { ok: false, error: '未知 action: ' + (event.action || '') }
    }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

/* ---------- actions ---------- */

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

  // 同名照片（重传）→ 覆盖更新，不重复计数
  const exist = await db
    .collection('photo')
    .where({ projectId, stem: safeStem })
    .limit(1)
    .get()

  if (exist.data && exist.data.length > 0) {
    const id = exist.data[0]._id
    await db.collection('photo').doc(id).update({ data: base })
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

  const updateData = { photoCount: _.inc(1), updatedAt: now }
  if (p.status === 'DRAFT') updateData.status = 'UPLOADING'
  await db.collection('project').doc(projectId).update({ data: updateData })

  return { ok: true, data: { photoId: add._id } }
}

/* ---------- helpers ---------- */

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
