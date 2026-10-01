const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * 管理员绑定云函数
 *
 * action = status  返回 openid 与绑定状态
 * action = bind    校验口令后把当前 openid 写入 admin 集合
 *
 * 前置条件：
 * 1. 数据库存在 admin 集合（权限：仅管理端可读写）
 * 2. 本函数环境变量 ADMIN_BIND_KEY 已设置（云开发控制台 → 云函数 → admin → 配置）
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'status'

  if (!OPENID) {
    return { ok: false, error: '取不到 OPENID，请通过小程序端调用' }
  }

  try {
    const isAdmin = await checkAdmin(OPENID)

    if (action === 'status') {
      return { ok: true, data: { openid: OPENID, isAdmin } }
    }

    if (action === 'bind') {
      if (isAdmin) {
        return { ok: true, data: { bound: true, already: true } }
      }

      const KEY = process.env.ADMIN_BIND_KEY || ''
      if (!KEY) {
        return {
          ok: false,
          error: '云函数环境变量 ADMIN_BIND_KEY 未设置。请到云开发控制台 → 云函数 → admin → 配置，添加环境变量 ADMIN_BIND_KEY',
        }
      }
      if (!event.key || event.key !== KEY) {
        return { ok: false, error: '口令不正确' }
      }

      await db.collection('admin').add({
        data: { openid: OPENID, boundAt: Date.now() },
      })
      return { ok: true, data: { bound: true, already: false } }
    }

    return { ok: false, error: '未知 action: ' + action }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

async function checkAdmin(openid) {
  try {
    const res = await db.collection('admin').where({ openid }).limit(1).get()
    return res.data.length > 0
  } catch (e) {
    return false
  }
}
