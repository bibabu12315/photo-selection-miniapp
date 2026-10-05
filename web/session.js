/**
 * 网页会话封装（V2.0 T-P1-1）
 *
 * - sessionToken 只存 localStorage，不存 cookie、不放 URL（BR-104 / 41_CODING_RULES 4.3）
 * - callCloud 自动把 token 塞进 payload，云函数侧由 resolveCaller 解析
 * - 这里另持一个 Cloud 实例，不碰 upload.js 的 ensureApp / callFn（C-1：传输层不可动）
 */

const SESSION_TOKEN_KEY = 'photo_selection_session_token'

function getToken() {
  return localStorage.getItem(SESSION_TOKEN_KEY) || ''
}

function setToken(token) {
  localStorage.setItem(SESSION_TOKEN_KEY, token)
}

function clearToken() {
  localStorage.removeItem(SESSION_TOKEN_KEY)
}

let cloudApp = null

/** 与 upload.js 的 currentEnv 同源：URL ?env= 优先，其次 localStorage，最后内置默认值 */
function currentEnv() {
  const q = new URLSearchParams(location.search).get('env')
  return q || localStorage.getItem('photo_selection_env_id') || 'cloud1-d2guu7uw1a306815a'
}

async function ensureCloudApp() {
  if (cloudApp) return cloudApp
  if (typeof cloud === 'undefined') throw new Error('微信 Web SDK 未加载，请检查网络')
  cloudApp = new cloud.Cloud({
    identityless: true,
    resourceAppid: 'wxe950960fdf45e0b5',
    resourceEnv: currentEnv(),
  })
  await cloudApp.init()
  return cloudApp
}

/**
 * 调云函数并自动附带 sessionToken。
 * 返回值统一为 { ok, data?, error?, code? }（云函数侧已按此约定返回）。
 */
async function callCloud(name, data = {}) {
  const app = await ensureCloudApp()
  const res = await app.callFunction({
    name,
    data: Object.assign({}, data, { sessionToken: getToken() }),
  })
  const result = res && res.result
  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, error: '云函数无有效返回', code: 'ERR_UNKNOWN' }
  }
  return result
}
