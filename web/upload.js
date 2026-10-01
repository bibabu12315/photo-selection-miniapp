/**
 * 电脑端上传页 · Phase 2
 *
 * 流程：连接环境（匿名登录）→ 验证 6 位上传码 → 拖入/选择文件夹
 *       → canvas 压缩出 preview + thumbnail → 并发 3 上传 → 云函数登记照片
 *
 * 原则：
 * - 只上传 preview / thumbnail，原始 JPG 不上云（精修源永远是本地 RAW）
 * - 一张失败不影响整体，可单独重试
 * - 同名照片重传 = 覆盖更新，不重复计数
 */

const CFG_KEY = 'photo_selection_env_id'
const WX_APPID = 'wxe950960fdf45e0b5' // 小程序 AppID，微信 Web SDK 必传
const THUMB_LONG_EDGE = 480
const THUMB_QUALITY = 0.75
const CONCURRENCY = 3

const PRESETS = {
  standard: { longEdge: 2048, quality: 0.82 },
  hd: { longEdge: 2880, quality: 0.9 },
}

let app = null
let signedIn = false
let session = null // { projectId, projectName, uploadToken }
let items = [] // { file, relPath, stem, status, error }
let uploading = false

const $ = (id) => document.getElementById(id)

/* ---------- 日志 ---------- */

function log(msg) {
  const el = $('log')
  el.textContent += msg + '\n'
  el.scrollTop = el.scrollHeight
  console.log(msg)
}

function describe(err) {
  if (!err) return '未知错误'
  let m = err.message || err.errMsg || String(err)
  try {
    const keys = Object.keys(err)
    if (keys.length) {
      const o = {}
      keys.forEach((k) => {
        o[k] = err[k]
      })
      m += ' | ' + JSON.stringify(o).slice(0, 400)
    }
  } catch (e) {
    /* 忽略序列化失败 */
  }
  return m
}

/* ---------- 第 1 步：环境连接（微信 Web SDK，未登录模式，无需登录态） ---------- */

async function init() {
  const env = $('envId').value.trim()
  if (!env || env === 'your-env-id') {
    setEnvStatus('请先填写云环境 ID（小程序 miniprogram/env.ts 里的那一串）', 'err')
    return
  }
  localStorage.setItem(CFG_KEY, env)

  if (typeof cloud === 'undefined') {
    setEnvStatus('微信 Web SDK 未加载，请检查网络', 'err')
    return
  }

  $('btnInit').disabled = true
  try {
    // 微信 Web SDK 正确初始化方式：new cloud.Cloud（未登录模式）
    // cloud.init({appid,env}) 传 appid 不生效，会报 missing appid
    app = new cloud.Cloud({
      identityless: true,
      resourceAppid: WX_APPID,
      resourceEnv: env,
    })
    await app.init()
    signedIn = true
    setEnvStatus('已连接，进入下一步', 'ok')
    unlock('secCode')
    $('btnVerify').disabled = false
  } catch (err) {
    signedIn = false
    $('btnInit').disabled = false
    setEnvStatus('连接失败：' + describe(err), 'err')
    log('常见原因：1) 环境 ID 抄错 2) 设置-权限设置 未开「未登录用户访问云资源」')
  }
}

function setEnvStatus(msg, cls) {
  const el = $('envStatus')
  el.textContent = msg
  el.className = 'hint' + (cls ? ' ' + cls : '')
}

/* ---------- 微信 Web SDK 调用封装 ---------- */

function callFn(name, data) {
  // Cloud 实例的 callFunction 直接返回 Promise
  return app.callFunction({ name, data })
}

/* ---------- 第 2 步：验证上传码 ---------- */

async function verifyCode() {
  const code = $('codeInput').value.trim()
  if (!/^\d{6}$/.test(code)) {
    setProjectInfo('请输入 6 位数字上传码', 'err')
    return
  }

  $('btnVerify').disabled = true
  try {
    const res = await callFn('photo', { action: 'verifyCode', code })
    const body = res && res.result
    if (!body || !body.ok) {
      setProjectInfo(body && body.error ? body.error : '验证失败', 'err')
      $('btnVerify').disabled = false
      return
    }
    session = body.data
    setProjectInfo(
      `项目「${session.projectName}」验证成功，24 小时内可直接上传。开始选照片 ↓`,
      'ok'
    )
    unlock('secFiles')
    log('已绑定项目: ' + session.projectId + '（' + session.projectName + '）')
  } catch (err) {
    setProjectInfo('调用云函数失败：' + describe(err), 'err')
    log('若提示函数不存在，请先在小程序开发者工具里部署 photo 云函数')
    $('btnVerify').disabled = false
  }
}

function setProjectInfo(msg, cls) {
  const el = $('projectInfo')
  el.textContent = msg
  el.className = 'hint' + (cls ? ' ' + cls : '')
}

/* ---------- 第 3 步：收集照片文件 ---------- */

const JPG_RE = /\.(jpe?g)$/i

function stemOf(name) {
  return name.replace(/\.[^.]+$/, '')
}

function collectFiles(fileList) {
  const list = Array.from(fileList)
  const skipped = { count: 0 }
  for (const f of list) {
    if (!JPG_RE.test(f.name)) {
      skipped.count++
      continue
    }
    const relPath = f.webkitRelativePath || f.name
    items.push({
      file: f,
      relPath,
      stem: stemOf(f.name),
      status: 'waiting', // waiting | working | done | failed
      error: '',
    })
  }
  if (skipped.count > 0) log('已跳过 ' + skipped.count + ' 个非 JPG 文件（ARW 等留在本地即可）')
  dedupeItems()
  sortItems()
  renderFiles()
}

/** 同名同路径去重（重复拖拽时以后来的为准） */
function dedupeItems() {
  const seen = new Map()
  for (const it of items) seen.set(it.relPath, it)
  items = Array.from(seen.values())
}

/** 按文件名自然排序（DSC00002 排在 DSC00010 前面），保证 sortOrder 与相机序号一致 */
function sortItems() {
  const collator = new Intl.Collator('en', { numeric: true })
  items.sort((a, b) => collator.compare(a.stem, b.stem))
}

/* ---------- 拖拽与选择 ---------- */

function setupPickers() {
  const dz = $('dropZone')

  dz.addEventListener('click', () => $('dirPicker').click())

  $('dirPicker').addEventListener('change', (e) => {
    collectFiles(e.target.files)
    e.target.value = ''
  })
  $('filePicker').addEventListener('change', (e) => {
    collectFiles(e.target.files)
    e.target.value = ''
  })

  ;['dragover', 'dragenter'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault()
      dz.classList.add('drag')
    })
  )
  ;['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault()
      dz.classList.remove('drag')
    })
  )

  dz.addEventListener('drop', async (e) => {
    const dropped = []
    // webkitGetAsEntry 必须在事件同步阶段全部取出
    const entries = []
    for (const item of e.dataTransfer.items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
    if (entries.length === 0) {
      collectFiles(e.dataTransfer.files)
      return
    }
    for (const entry of entries) await traverseEntry(entry, dropped, '')
    collectFiles(dropped)
  })
}

async function traverseEntry(entry, out, path) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej))
    out.push(file)
    // File 对象的 webkitRelativePath 为空，用路径补上
    if (!file.webkitRelativePath) {
      try {
        Object.defineProperty(file, 'webkitRelativePath', { value: path + entry.name })
      } catch (e) {
        /* 某些浏览器不可写则忽略，退化为纯文件名 */
      }
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader()
    const batch = await readAllEntries(reader)
    for (const child of batch) {
      await traverseEntry(child, out, path + entry.name + '/')
    }
  }
}

function readAllEntries(reader) {
  return new Promise((res, rej) => {
    const all = []
    const read = () =>
      reader.readEntries(
        (batch) => {
          if (!batch.length) return res(all)
          all.push(...batch)
          read()
        },
        (err) => rej(err)
      )
    read()
  })
}

/* ---------- 列表渲染 ---------- */

function renderFiles() {
  const total = items.length
  const summary = $('fileSummary')
  if (total === 0) {
    summary.classList.add('hidden')
    $('btnStart').disabled = true
    $('btnClear').classList.add('hidden')
    $('stats').classList.add('hidden')
    $('progress').classList.add('hidden')
    return
  }

  const folders = new Set(items.map((i) => i.relPath.split('/')[0]))
  summary.classList.remove('hidden')
  summary.textContent =
    `已选 ${total} 张` + (folders.size > 1 ? `，来自 ${folders.size} 个文件夹` : '')
  $('btnStart').disabled = uploading
  $('btnClear').classList.remove('hidden')
  $('btnRetry').classList.toggle('hidden', !items.some((i) => i.status === 'failed'))
  renderStats()
}

function renderStats() {
  const done = items.filter((i) => i.status === 'done').length
  const failed = items.filter((i) => i.status === 'failed').length
  const working = items.filter((i) => i.status === 'working').length
  const waiting = items.filter((i) => i.status === 'waiting').length
  const total = items.length

  const el = $('stats')
  el.classList.remove('hidden')
  el.innerHTML =
    `共 ${total} · ` +
    `<span class="ok">成功 ${done}</span> · ` +
    (failed ? `<span class="err-c">失败 ${failed}</span> · ` : '') +
    `上传中 ${working} · 等待 ${waiting}` +
    (uploading ? '（上传中请勿关闭页面）' : '')

  $('progress').classList.toggle('hidden', total === 0)
  $('progressBar').style.width = Math.round(((done + failed) / total) * 100) + '%'
  $('btnRetry').classList.toggle('hidden', uploading || failed === 0)
  $('btnStart').disabled = uploading || waiting + failed === 0
  $('btnClear').disabled = uploading
}

/* ---------- 第 4 步：上传 ---------- */

async function startUpload() {
  if (!session) {
    log('请先验证上传码')
    return
  }
  if (uploading) return
  uploading = true
  renderStats()

  const spec = currentSpec()
  log(`开始上传：${items.length} 张 · 预览长边 ${spec.longEdge}px · 质量 ${Math.round(spec.quality * 100)}%`)

  let cursor = 0
  const worker = async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) return
      await processOne(items[idx], spec)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  uploading = false
  const failed = items.filter((i) => i.status === 'failed').length
  const done = items.filter((i) => i.status === 'done').length
  log(`上传结束：成功 ${done}，失败 ${failed}` + (failed ? '（点「重试失败项」重传）' : ''))
  renderStats()
}

async function processOne(item, spec) {
  item.status = 'working'
  item.error = ''
  renderStats()
  try {
    // 1. 解码一次，压出 preview + thumbnail
    const bmp = await decode(item.file)
    const preview = await render(bmp, spec.longEdge, spec.quality)
    const thumb = await render(bmp, THUMB_LONG_EDGE, THUMB_QUALITY)
    if (bmp.close) bmp.close()

    // 2. 上传两图（私有存储，只有云函数能发链接）
    const safe = sanitizeStem(item.stem)
    const previewUp = await uploadBlob(
      preview.blob,
      `p/${session.projectId}/preview/${safe}.jpg`
    )
    const thumbUp = await uploadBlob(
      thumb.blob,
      `p/${session.projectId}/thumb/${safe}.jpg`
    )

    // 3. 云函数登记（云端核验文件真实存在后才入库；同名 stem 自动覆盖）
    const res = await callFn('photo', {
      action: 'registerPhoto',
      projectId: session.projectId,
      uploadToken: session.uploadToken,
      stem: safe,
      filename: safe + '.jpg',
      previewPath: previewUp.cloudPath,
      thumbPath: thumbUp.cloudPath,
      width: preview.width,
      height: preview.height,
      sortOrder: items.indexOf(item),
      previewBytes: preview.blob.size,
      thumbBytes: thumb.blob.size,
    })
    const body = res && res.result
    if (!body || !body.ok) throw new Error(body && body.error ? body.error : '登记失败')

    item.status = 'done'
  } catch (err) {
    item.status = 'failed'
    item.error = describe(err)
    log(`✗ ${item.stem}: ${item.error}`)
  }
  renderStats()
}

let corsHintShown = false

async function uploadBlob(blob, cloudPath) {
  // 微信 Web SDK：web 端必须传 file 参数（File 对象），不是 filePath
  const name = cloudPath.split('/').pop() || 'photo.jpg'
  const file = new File([blob], name, { type: 'image/jpeg' })
  try {
    const res = await app.uploadFile({ cloudPath, file })
    if (res && res.fileID) return { cloudPath, verified: true }
  } catch (e) {
    // 已知坑：本环境存储桶不给 localhost 返回 CORS 头。文件可能已实际到达服务器（204），
    // 只是浏览器读不到响应。是否真传成功由 registerPhoto 云函数核验，这里不中断流程。
    if (!corsHintShown) {
      corsHintShown = true
      log('提示：浏览器被跨域限制挡住读不到上传响应，上传结果改由云端核验…')
    }
  }
  return { cloudPath, verified: false }
}

async function retryFailed() {
  if (uploading) return
  for (const it of items) {
    if (it.status === 'failed') it.status = 'waiting'
  }
  log('重试失败项…')
  await startUpload()
}

/* ---------- 压缩 ---------- */

function currentSpec() {
  const v = $('preset').value
  if (v === 'custom') {
    return {
      longEdge: clamp(parseInt($('longEdge').value, 10) || 2048, 1200, 4096),
      quality: clamp(parseInt($('quality').value, 10) || 82, 40, 95) / 100,
    }
  }
  return { ...PRESETS[v] }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 解码，优先 createImageBitmap 并按 EXIF 方向摆正（照片不会躺倒） */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (e) {
    // 退化路径：<img> 在现代浏览器里也会自动按 EXIF 摆正
    return new Promise((res, rej) => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        res(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        rej(new Error('图片解码失败（文件可能损坏）'))
      }
      img.src = url
    })
  }
}

async function render(source, longEdge, quality) {
  const sw = source.width
  const sh = source.height
  const scale = Math.min(1, longEdge / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * scale))
  const h = Math.max(1, Math.round(sh * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, 0, 0, w, h)

  const text = $('watermark').value.trim()
  if (text) drawWatermark(ctx, w, h, text)

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
  if (!blob) throw new Error('canvas 导出失败')
  return { blob, width: w, height: h }
}

/** 右下角半透明文字水印，随图宽自适应 */
function drawWatermark(ctx, w, h, text) {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.03))
  ctx.font = `${size}px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.globalAlpha = 0.45
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(0,0,0,0.5)'
  ctx.shadowBlur = size / 4
  ctx.fillText(text, w - size, h - size)
  ctx.globalAlpha = 1
  ctx.shadowBlur = 0
}

function sanitizeStem(stem) {
  return (
    String(stem || '')
      .replace(/^.*[\\/]/, '')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .slice(0, 80) || 'unnamed'
  )
}

/* ---------- 其他控件 ---------- */

function clearList() {
  if (uploading) return
  items = []
  renderFiles()
  log('已清空列表（云端已登记的照片不受影响）')
}

function unlock(id) {
  const el = $(id)
  el.classList.remove('locked')
  el.classList.add('unlocked')
}

/* ---------- 绑定 ---------- */

window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem(CFG_KEY)
  if (saved) $('envId').value = saved

  $('btnInit').addEventListener('click', init)
  $('btnVerify').addEventListener('click', verifyCode)
  $('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyCode()
  })
  $('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6)
  })

  setupPickers()

  $('preset').addEventListener('change', () => {
    $('customOpts').classList.toggle('hidden', $('preset').value !== 'custom')
  })
  $('quality').addEventListener('input', () => {
    $('qualityVal').textContent = $('quality').value + '%'
  })

  $('btnStart').addEventListener('click', startUpload)
  $('btnRetry').addEventListener('click', retryFailed)
  $('btnClear').addEventListener('click', clearList)
})
