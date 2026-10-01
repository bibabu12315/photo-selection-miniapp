const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * 摄影师身份云函数
 *
 * action = status      返回 openid 与绑定状态
 * action = bind        零门槛开通：点「我是摄影师」即把当前 openid 写入 admin 集合
 * action = claimLegacy 一次性迁移（需 ADMIN_BIND_KEY）：把没有 ownerOpenid 的老项目
 *                      归到指定 openid（不传则用调用者 openid，云端测试时回落到最早的摄影师）
 *
 * 说明：口令不再作为开通门槛（对外推广时人人可开通摄影师）。
 * 数据安全改由 project.ownerOpenid 保证：摄影师只能看见自己的项目。
 * ADMIN_BIND_KEY 仅保留给 claimLegacy 这类一次性高危操作使用。
 *
 * 前置条件：数据库存在 admin 集合（权限：仅管理端可读写）
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
      await db.collection('admin').add({
        data: { openid: OPENID, boundAt: Date.now() },
      })
      return { ok: true, data: { bound: true, already: false } }
    }

    if (action === 'claimLegacy') {
      const KEY = process.env.ADMIN_BIND_KEY || ''
      if (!KEY) {
        return {
          ok: false,
          error: '未设置环境变量 ADMIN_BIND_KEY，无法执行迁移（云开发控制台 → 云函数 admin → 配置）',
        }
      }
      if (!event.key || event.key !== KEY) {
        return { ok: false, error: '迁移密钥不正确' }
      }
      const owner = event.openid || OPENID || (await firstAdminOpenid())
      if (!owner) {
        return { ok: false, error: '找不到归属人：请先在小程序的引导页点「我是摄影师」完成开通' }
      }
      const updated = await claimLegacy(owner)
      return { ok: true, data: { updated, owner } }
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

/** 最早的摄影师（迁移时作为默认归属人） */
async function firstAdminOpenid() {
  try {
    const res = await db
      .collection('admin')
      .orderBy('boundAt', 'asc')
      .limit(1)
      .get()
    const a = (res.data || [])[0]
    return a && a.openid ? a.openid : ''
  } catch (e) {
    return ''
  }
}

/** 把没有 ownerOpenid 的老项目批量归到 owner 名下 */
async function claimLegacy(owner) {
  let updated = 0
  let skip = 0
  for (let i = 0; i < 20; i++) {
    const res = await db
      .collection('project')
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(100)
      .get()
    const list = res.data || []
    if (!list.length) break
    for (const p of list) {
      if (!p.ownerOpenid) {
        await db.collection('project').doc(p._id).update({
          data: { ownerOpenid: owner, updatedAt: Date.now() },
        })
        updated += 1
      }
    }
    if (list.length < 100) break
    skip += 100
  }
  return updated
}
