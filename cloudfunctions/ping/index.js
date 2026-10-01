const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/**
 * Phase 0 自检云函数
 *
 * action = whoami   返回 openid 与管理员标记
 * action = selftest 向 selftest 集合写一条记录并读回，验证数据库链路
 *
 * 前置条件：数据库中已存在 selftest 与 admin 两个集合
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'whoami'

  if (!OPENID) {
    return { ok: false, error: '取不到 OPENID，请通过小程序端调用' }
  }

  try {
    const isAdmin = await checkAdmin(OPENID)

    if (action === 'selftest') {
      let add
      try {
        add = await db.collection('selftest').add({
          data: {
            openid: OPENID,
            hello: 'photo-selection',
            ts: Date.now(),
          },
        })
      } catch (e) {
        return {
          ok: false,
          error: '写入 selftest 失败，请先在云开发控制台创建 selftest 集合：' + e.message,
        }
      }

      const read = await db.collection('selftest').doc(add._id).get()

      return {
        ok: true,
        data: {
          openid: OPENID,
          isAdmin,
          env: process.env.TCB_ENV || '',
          wroteId: add._id,
          readBack: read.data,
        },
      }
    }

    // 用 admin 权限换取临时链接，验证「存储私有 + 云函数下发」是否生效
    if (action === 'tempurl') {
      const fileID = event.fileID
      if (!fileID) {
        return { ok: false, error: '缺少 fileID' }
      }
      const res = await cloud.getTempFileURL({
        fileList: [{ fileID, maxAge: 60 * 60 }],
      })
      const item = res.fileList && res.fileList[0]
      return {
        ok: true,
        data: {
          fileID,
          tempFileURL: item && item.tempFileURL ? item.tempFileURL : '',
          status: item && item.code ? item.code : 'SUCCESS',
        },
      }
    }

    return { ok: true, data: { openid: OPENID, isAdmin } }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  }
}

/**
 * 判断是否为摄影师（管理员）
 * 管理员记录存在于 admin 集合；集合不存在视为尚未绑定
 */
async function checkAdmin(openid) {
  try {
    const res = await db.collection('admin').where({ openid }).limit(1).get()
    return res.data.length > 0
  } catch (e) {
    return false
  }
}
