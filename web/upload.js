/**
 * 电脑端上传页（V2.0 三步向导）
 *
 * 第 1 步：输入 6 位上传码（环境信息内置，摄影师不用管）
 * 第 2 步：拖入 / 选择照片文件夹，选预览规格
 * 第 3 步：上传进度 + 缩略图墙 + 失败重试 → 完成态
 *
 * 原则：
 * - 只上传 preview / thumbnail，原始 JPG 不上云（精修源永远是本地 RAW）
 * - 一张失败不影响整体，可单独重试
 * - 同名照片重传 = 覆盖更新，不重复计数
 */

const CFG_KEY = 'photo_selection_env_id'
const DEFAULT_ENV = 'cloud1-d2guu7uw1a306815a' // 云开发环境 ID（与 miniprogram/env.ts 一致）
const WX_APPID = 'wxe950960fdf45e0b5' // 小程序 AppID，微信 Web SDK 必传
// 缩略图只用于网格列表（手机上单格不到 120px 物理宽），320 长边足够，体积比 480 小 40%
const THUMB_LONG_EDGE = 320
const THUMB_QUALITY = 0.7
const CONCURRENCY = 3

/**
 * 画质四档。默认 standard = 1600 / 0.75 —— 单条最大的成本杠杆
 * 单位体积比约为 标准 1 : 高清 2.2 : 高清Pro 4.8 : 原画质 8.8
 * 原画质不要开到 q95：2.8MB/张时 500 张的项目模特端要下 560MB，模特的手机先崩
 */
const PRESETS = {
  standard: { longEdge: 1600, quality: 0.75 },
  hd: { longEdge: 2048, quality: 0.82 },
  hdpro: { longEdge: 2880, quality: 0.9 },
  raw: { longEdge: 4096, quality: 0.92 },
}

let app = null
let session = null // { projectId, projectName, uploadToken }
let items = [] // { file, relPath, stem, status, error, url }
let uploading = false
let corsHintShown = false

const $ = (id) => document.getElementById(id)

/* ---------- 步骤 ---------- */

function goStep(n) {
  ;[1, 2, 3].forEach((i) => {
    $('step' + i).classList.toggle('hidden', i !== n)
  })
  $('stepDone').classList.add('hidden')
  document.querySelectorAll('#steps .s').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.step) <= n)
  })
  document.querySelectorAll('#steps .t').forEach((el) => {
    el.classList.toggle('on', Number(el.previousElementSibling.dataset.step) <= n)
  })
}

function showDone(done, failed, total) {
  ;[1, 2, 3].forEach((i) => $('step' + i).classList.add('hidden'))
  $('stepDone').classList.remove('hidden')
  $('doneText').textContent =
    `共 ${total} 张，成功 ${done} 张` + (failed ? `，失败 ${failed} 张（可点「继续上传」重来）` : '')
}

/* ---------- 微信 Web SDK ---------- */

function currentEnv() {
  const q = new URLSearchParams(location.search).get('env')
  return q || localStorage.getItem(CFG_KEY) || DEFAULT_ENV
}

async function ensureApp() {
  if (app) return app
  if (typeof cloud === 'undefined') throw new Error('微信 Web SDK 未加载，请检查网络')
  const env = currentEnv()
  localStorage.setItem(CFG_KEY, env)
  app = new cloud.Cloud({
    identityless: true,
    resourceAppid: WX_APPID,
    resourceEnv: env,
  })
  await app.init()
  return app
}

function callFn(name, data) {
  return app.callFunction({ name, data })
}

/* ---------- 第 1 步：上传码 ---------- */

function codeValue() {
  return Array.from(document.querySelectorAll('#digits .digit'))
    .map((i) => i.value)
    .join('')
}

function setupDigits() {
  const inputs = Array.from(document.querySelectorAll('#digits .digit'))
  inputs.forEach((el, idx) => {
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(0, 1)
      if (el.value && idx < inputs.length - 1) inputs[idx + 1].focus()
      if (codeValue().length === 6) verifyCode()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !el.value && idx > 0) inputs[idx - 1].focus()
      if (e.key === 'Enter') verifyCode()
    })
    el.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '')
      if (!text) return
      e.preventDefault()
      for (let i = 0; i < inputs.length; i++) inputs[i].value = text[i] || ''
      inputs[Math.min(text.length, inputs.length - 1)].focus()
      if (text.length >= 6) verifyCode()
    })
  })
}

async function verifyCode() {
  const code = codeValue()
  $('codeErr').textContent = ''
  if (!/^\d{6}$/.test(code)) {
    $('codeErr').textContent = '请输入 6 位数字上传码'
    return
  }
  $('btnVerify').disabled = true
  try {
    await ensureApp()
    const res = await callFn('photo', { action: 'verifyCode', code })
    const body = res && res.result
    if (!body || !body.ok) {
      $('codeErr').textContent = (body && body.error) || '验证失败'
      $('btnVerify').disabled = false
      return
    }
    session = body.data
    $('projectInfo').textContent = `项目「${session.projectName}」· 24 小时内可直接上传`
    goStep(2)
  } catch (err) {
    $('codeErr').textContent = '调用云函数失败：' + (err && err.message ? err.message : String(err))
    $('btnVerify').disabled = false
  }
}

/* ---------- 第 2 步：选照片 ---------- */

const JPG_RE = /\.(jpe?g)$/i

function stemOf(name) {
  return name.replace(/\.[^.]+$/, '')
}

function collectFiles(fileList) {
  const list = Array.from(fileList)
  let skipped = 0
  for (const f of list) {
    if (!JPG_RE.test(f.name)) {
      skipped++
      continue
    }
    const relPath = f.webkitRelativePath || f.name
    if (items.some((i) => i.relPath === relPath)) continue
    items.push({
      file: f,
      relPath,
      stem: stemOf(f.name),
      status: 'waiting', // waiting | working | done | failed
      error: '',
      url: URL.createObjectURL(f),
    })
  }
  sortItems()
  renderFiles(skipped)
}

/** 按文件名自然排序，保证 sortOrder 与相机序号一致 */
function sortItems() {
  const collator = new Intl.Collator('en', { numeric: true })
  items.sort((a, b) => collator.compare(a.stem, b.stem))
}

function renderFiles(skipped) {
  const total = items.length
  const folders = new Set(items.map((i) => i.relPath.split('/')[0]))
  $('fileSummary').textContent =
    `已选 ${total} 张` +
    (folders.size > 1 ? `，来自 ${folders.size} 个文件夹` : '') +
    (skipped ? ` · 已跳过 ${skipped} 个非 JPG（ARW 留在本地）` : '')
  $('btnStart').disabled = uploading || total === 0
  $('btnClear').classList.toggle('hidden', total === 0)
}

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
    if (!file.webkitRelativePath) {
      try {
        Object.defineProperty(file, 'webkitRelativePath', { value: path + entry.name })
      } catch (e) {
        /* 某些浏览器不可写则忽略 */
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

/* ---------- 第 3 步：上传 ---------- */

async function startUpload() {
  if (!session || uploading) return
  uploading = true
  goStep(3)
  buildWall()
  renderStats()

  const spec = currentSpec()
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
  renderStats()

  const failed = items.filter((i) => i.status === 'failed')
  if (failed.length === 0) {
    showDone(items.length, 0, items.length)
  } else {
    $('failList').textContent =
      `${failed.length} 张失败：` + failed.slice(0, 5).map((i) => i.stem).join('、')
  }
}

async function processOne(item, spec) {
  item.status = 'working'
  renderStats()
  try {
    const bmp = await decode(item.file)
    const preview = await render(bmp, spec.longEdge, spec.quality)
    const thumb = await render(bmp, THUMB_LONG_EDGE, THUMB_QUALITY)
    if (bmp.close) bmp.close()

    const safe = sanitizeStem(item.stem)
    const previewUp = await uploadBlob(preview.blob, `p/${session.projectId}/preview/${safe}.jpg`)
    const thumbUp = await uploadBlob(thumb.blob, `p/${session.projectId}/thumb/${safe}.jpg`)

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
    if (!body || !body.ok) throw new Error((body && body.error) || '登记失败')

    item.status = 'done'
  } catch (err) {
    item.status = 'failed'
    item.error = err && err.message ? err.message : String(err)
  }
  renderStats()
}

async function uploadBlob(blob, cloudPath) {
  const name = cloudPath.split('/').pop() || 'photo.jpg'
  const file = new File([blob], name, { type: 'image/jpeg' })
  try {
    await app.uploadFile({ cloudPath, file })
  } catch (e) {
    // 已知坑：本环境存储桶不给 localhost 返回 CORS 头，浏览器读不到响应，
    // 但文件可能已实际到达服务器（204）。是否真传成功由 registerPhoto 云端核验。
    if (!corsHintShown) {
      corsHintShown = true
      $('failList').textContent = '提示：上传结果由云端核验，跨域提示不影响实际上传。'
    }
  }
  return { cloudPath }
}

function buildWall() {
  const wall = $('wall')
  wall.innerHTML = ''
  items.forEach((it) => {
    const img = document.createElement('img')
    img.src = it.url
    img.alt = it.stem
    it.el = img
    wall.appendChild(img)
  })
}

function renderStats() {
  const total = items.length
  const done = items.filter((i) => i.status === 'done').length
  const failed = items.filter((i) => i.status === 'failed').length
  const working = items.filter((i) => i.status === 'working').length

  $('progText').textContent = `${done + failed} / ${total}`
  $('progPct').textContent = total ? Math.round(((done + failed) / total) * 100) + '%' : '0%'
  $('progBar').style.width = total ? ((done + failed) / total) * 100 + '%' : '0'
  $('stats').textContent =
    `成功 ${done}` + (failed ? ` · 失败 ${failed}` : '') + (working ? ` · 上传中 ${working}` : '')

  items.forEach((it) => {
    if (!it.el) return
    it.el.className = it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : ''
  })

  $('btnRetry').disabled = uploading || failed === 0
  $('btnBack2').disabled = uploading
}

async function retryFailed() {
  if (uploading) return
  for (const it of items) if (it.status === 'failed') it.status = 'waiting'
  $('failList').textContent = ''
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
  return Object.assign({}, PRESETS[v])
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 解码，优先 createImageBitmap 并按 EXIF 方向摆正 */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (e) {
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

function drawWatermark(ctx, w, h, text) {
  const size = Math.max(14, Math.round(Math.min(w, h) * 0.03))
  ctx.font = `${size}px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif`
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

/* ---------- 绑定 ---------- */

window.addEventListener('DOMContentLoaded', () => {
  setupDigits()
  setupPickers()

  $('btnVerify').addEventListener('click', verifyCode)
  $('btnStart').addEventListener('click', startUpload)
  $('btnRetry').addEventListener('click', retryFailed)
  $('btnBack2').addEventListener('click', () => {
    if (uploading) return
    goStep(2)
  })
  $('btnClear').addEventListener('click', () => {
    if (uploading) return
    items.forEach((i) => URL.revokeObjectURL(i.url))
    items = []
    renderFiles(0)
  })
  $('btnMore').addEventListener('click', () => {
    items = items.filter((i) => i.status !== 'done')
    renderFiles(0)
    goStep(2)
  })
  $('btnFinish').addEventListener('click', () => {
    items = []
    session = null
    Array.from(document.querySelectorAll('#digits .digit')).forEach((i) => (i.value = ''))
    goStep(1)
  })

  $('preset').addEventListener('change', () => {
    $('customOpts').classList.toggle('hidden', $('preset').value !== 'custom')
  })
  $('quality').addEventListener('input', () => {
    $('qualityVal').textContent = $('quality').value + '%'
  })

  goStep(1)
  prefillFromUrl()
})

/** 支持 ?code=123456 直达：从小程序复制「网址+码」粘贴打开时自动填码并验证 */
function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search)
  let code = (params.get('code') || '').replace(/\D/g, '')
  if (!code && window.location.hash) {
    const m = window.location.hash.match(/code=(\d{6})/)
    if (m) code = m[1]
  }
  if (!/^\d{6}$/.test(code)) return

  // 清掉地址栏里的参数，避免刷新/复制地址栏时重复携带旧码
  history.replaceState(null, '', window.location.pathname)

  const inputs = Array.from(document.querySelectorAll('#digits .digit'))
  for (let i = 0; i < inputs.length; i++) inputs[i].value = code[i] || ''
  setTimeout(verifyCode, 300)
}
