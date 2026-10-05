const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const crypto = require('crypto')

/** 登录票据有效期：印在二维码里可被拍照传播，必须短命（30_BUSINESS_RULES 第一章） */
const SESSION_TICKET_TTL = 5 * 60 * 1000
/** 网页会话有效期 */
const SESSION_TOKEN_TTL = 30 * 24 * 3600 * 1000
/** ticket 22 位 ≤ 小程序码 scene 的 32 字符限制；token 32 位（23_PERMISSION 四） */
const TICKET_LEN = 22
const TOKEN_LEN = 32
/** 顺手清理的历史票据：30 天前、单次最多 20 条（C-S3，不用定时触发器） */
const CLEANUP_BEFORE_DAYS = 30
const CLEANUP_LIMIT = 20

/** 票据三态，见 31_STATE_MACHINE 五（SSM） */
const STATUS_PENDING = 'PENDING'
const STATUS_ACTIVE = 'ACTIVE'
const STATUS_REVOKED = 'REVOKED'

/**
 * 网页端登录票据云函数（V2.0）
 *
 * 本函数**不使用 resolveCaller**（22_API 二）：
 * claim 用真实 OPENID 鉴权，其余 action 靠 ticket / token 自身鉴权。
 *
 * action = createTicket   {}                       生成登录票据 + 小程序码（公开）
 * action = claim          { ticket }               小程序扫码后绑定身份并签发 token
 * action = poll           { ticket }               网页轮询票据状态
 * action = verify         { sessionToken }         校验会话，返回摄影师身份
 * action = logout         { sessionToken }         登出
 * action = cleanup        {}                       清理过期票据
 *
 * 数据：session { ticket, token, openid, status, createdAt, claimedAt,
 *                ticketExpireAt, tokenExpireAt, ua }
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()

  try {
    switch (event.action) {
      case 'createTicket':
        return await createTicket(event)
      case 'claim':
        return await claim(event, OPENID)
      case 'poll':
        return await poll(event)
      case 'verify':
        return await verify(event)
      case 'logout':
        return await logout(event)
      case 'cleanup':
        return await cleanup()
      default:
        return { ok: false, error: '未知 action: ' + (event.action || ''), code: 'ERR_PARAM' }
    }
  } catch (err) {
    console.error('[session] 未处理异常 action=' + (event.action || ''), err && err.message)
    return { ok: false, error: '操作失败，请重试', code: 'ERR_UNKNOWN' }
  }
}

/* ---------- 六个 action ---------- */

/**
 * 生成登录票据与小程序码。
 * 码图不落云存储：5 分钟就过期，落存储还要清理，直接 base64 返回给前端显示。
 */
async function createTicket(event) {
  const now = Date.now()
  const ticket = randomBase62(TICKET_LEN)

  await db.collection('session').add({
    data: {
      ticket,
      token: '',
      openid: '',
      status: STATUS_PENDING,
      createdAt: now,
      claimedAt: 0,
      ticketExpireAt: now + SESSION_TICKET_TTL,
      tokenExpireAt: 0,
      ua: String((event && event.ua) || '').slice(0, 120),
    },
  })

  // 顺手清掉历史票据；失败不影响本次登录
  try {
    await cleanup()
  } catch (e) {
    console.error('[session.createTicket] 旧票据清理失败', e && e.message)
  }

  let qr = null
  try {
    qr = await cloud.openapi.wxacode.getUnlimited({
      scene: ticket,
      page: 'pages/guide/index',
      checkPath: false,
      // 正式版（BR-407）：与 project.getInviteQrCode 保持一致，两处必须同时为 release。
      // 灰度期如需回退体验版测试：把 release 改回 trial 并重新部署本云函数
      envVersion: 'release',
      width: 430,
    })
  } catch (e) {
    console.error('[session.createTicket] 小程序码生成失败', e && e.message)
  }
  if (!qr || !qr.buffer) {
    // 票据留着无害，5 分钟后自行作废
    return { ok: false, error: '登录二维码生成失败，请重试', code: 'ERR_UNKNOWN' }
  }

  return {
    ok: true,
    data: {
      ticket,
      qrUrl: 'data:image/png;base64,' + qr.buffer.toString('base64'),
      expireAt: now + SESSION_TICKET_TTL,
    },
  }
}

/**
 * 小程序扫码后认领票据。
 * 必须有真实 OPENID（不接受 sessionToken），否则任何人拿着票都能冒领。
 */
async function claim({ ticket }, openid) {
  if (!openid) {
    return { ok: false, error: '请在微信中扫码登录', code: 'ERR_NO_AUTH' }
  }

  const s = await sessionByTicket(ticket)
  if (!s) {
    return { ok: false, error: '二维码无效，请在电脑上点击刷新', code: 'ERR_NOT_FOUND' }
  }
  if (s.status !== STATUS_PENDING) {
    // 已被领用过：同一个码不能被第二个微信兑换（C-S2）
    return { ok: false, error: '二维码已被使用，请在电脑上点击刷新', code: 'ERR_EXPIRED' }
  }
  if (!s.ticketExpireAt || s.ticketExpireAt < Date.now()) {
    await revoke(s._id)
    return { ok: false, error: '二维码已过期，请在电脑上点击刷新', code: 'ERR_EXPIRED' }
  }

  // 首次扫码自动开通摄影师（11_INTERACTION_SPEC 七）；与引导页「我是摄影师」同门槛：
  // openid 即身份、零校验，扫的是自己电脑上的码，不存在被冒开的风险
  const now = Date.now()
  if (!(await checkAdmin(openid))) {
    await db.collection('admin').add({ data: { openid, boundAt: now } })
  }

  const token = randomBase62(TOKEN_LEN)
  await db.collection('session').doc(s._id).update({
    data: {
      status: STATUS_ACTIVE,
      token,
      openid,
      claimedAt: now,
      tokenExpireAt: now + SESSION_TOKEN_TTL,
    },
  })

  // 摄影师没有名字字段，昵称能力暂不支持，前端展示「已登录」即可
  return { ok: true, data: { ok: true, displayName: '' } }
}

/** 网页轮询：票据被认领后返回长期 token */
async function poll({ ticket }) {
  const s = await sessionByTicket(ticket)
  if (!s) {
    return { ok: false, error: '二维码已失效，请点击刷新', code: 'ERR_NOT_FOUND' }
  }

  if (s.status === STATUS_ACTIVE && s.token) {
    if (!s.tokenExpireAt || s.tokenExpireAt < Date.now()) {
      await revoke(s._id)
      return { ok: false, error: '登录已过期，请重新扫码', code: 'ERR_EXPIRED' }
    }
    return {
      ok: true,
      data: { status: STATUS_ACTIVE, token: s.token, expireAt: s.tokenExpireAt },
    }
  }

  if (s.status === STATUS_REVOKED || !s.ticketExpireAt || s.ticketExpireAt < Date.now()) {
    return { ok: false, error: '二维码已过期，请点击刷新', code: 'ERR_EXPIRED' }
  }

  return { ok: true, data: { status: STATUS_PENDING } }
}

/** 校验网页会话，返回摄影师身份；token 无效 / 过期 / 已登出一律 ERR_NO_AUTH */
async function verify({ sessionToken }) {
  const s = await sessionByToken(sessionToken)
  if (!s || s.status !== STATUS_ACTIVE) {
    return { ok: false, error: '登录已过期，请重新扫码', code: 'ERR_NO_AUTH' }
  }
  if (!s.tokenExpireAt || s.tokenExpireAt < Date.now()) {
    await revoke(s._id)
    return { ok: false, error: '登录已过期，请重新扫码', code: 'ERR_NO_AUTH' }
  }

  return {
    ok: true,
    data: {
      openid: s.openid,
      isAdmin: await checkAdmin(s.openid),
      displayName: '',
      expireAt: s.tokenExpireAt,
    },
  }
}

async function logout({ sessionToken }) {
  const s = await sessionByToken(sessionToken)
  if (!s) return { ok: true, data: { ok: true } }
  await revoke(s._id)
  return { ok: true, data: { ok: true } }
}

/** 清理 30 天前的历史票据；不用定时触发器（C-S3） */
async function cleanup() {
  const deadline = Date.now() - CLEANUP_BEFORE_DAYS * 24 * 3600 * 1000
  const res = await db
    .collection('session')
    .where({ createdAt: _.lt(deadline) })
    .limit(CLEANUP_LIMIT)
    .remove()
  return { ok: true, data: { removed: (res && res.stats && res.stats.removed) || 0 } }
}

/* ---------- helpers ---------- */

async function sessionByTicket(ticket) {
  const t = String(ticket || '').trim()
  if (!t) return null
  const res = await db.collection('session').where({ ticket: t }).limit(1).get()
  return (res.data && res.data[0]) || null
}

async function sessionByToken(token) {
  const t = String(token || '').trim()
  if (!t) return null
  const res = await db.collection('session').where({ token: t }).limit(1).get()
  return (res.data && res.data[0]) || null
}

async function revoke(id) {
  try {
    await db.collection('session').doc(id).update({ data: { status: STATUS_REVOKED } })
  } catch (e) {
    console.error('[session.revoke] 置 REVOKED 失败', e && e.message)
  }
}

async function checkAdmin(openid) {
  try {
    const res = await db.collection('admin').where({ openid }).limit(1).get()
    return (res.data || []).length > 0
  } catch (e) {
    return false
  }
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 服务端随机，禁止用时间戳 / Math.random / openid 哈希等可推导值（23_PERMISSION 四） */
function randomBase62(len) {
  const bytes = crypto.randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += BASE62[bytes[i] % 62]
  return s
}
