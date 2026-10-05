/**
 * 项目详情页上传模块（V2.0 T-P1-4）
 *
 * 取代「复制 6 位上传码」：进项目详情 → photo.issueUploadSession 换会话 → 直接拖文件夹上传。
 * 遍历 / 解码 / 压缩 / 上传逻辑移植自已验证的 upload.js（C-1：不改动 upload.js 的传输层），
 * 常量与 upload.js 保持一致（并发 3、thumb 320/0.70、画质四档见 PRESETS）。
 *
 * 依赖：session.js 的 ensureCloudApp() / callCloud()（同一 Cloud 实例，自动带 sessionToken）
 * 用法：PhotoUploader.mount({ projectId, hasPhotos, onFinish })
 */

window.PhotoUploader = (function () {
  'use strict'

  const CONCURRENCY = 3
  const THUMB_LONG_EDGE = 320
  const THUMB_QUALITY = 0.7

  /**
   * 画质四档（30_BUSINESS_RULES 常量表 / 24_FILE_STORAGE 3.1），默认 standard
   * perMb = 单张 preview 参考体积，供画质预览估算「这批 N 张 ≈ XXX MB」（不含缩略图）
   */
  const PRESETS = {
    standard: { longEdge: 1600, quality: 0.75, perMb: 0.25, label: '标准（推荐 · 省流量）' },
    hd: { longEdge: 2048, quality: 0.82, perMb: 0.55, label: '高清' },
    hdpro: { longEdge: 2880, quality: 0.9, perMb: 1.2, label: '高清 Pro' },
    raw: { longEdge: 4096, quality: 0.92, perMb: 2.2, label: '原画质（占用大）' },
    custom: { longEdge: 1600, quality: 0.75, perMb: 0.25, label: '自定义' },
  }

  const JPG_RE = /\.(jpe?g)$/i

  let ctx = null // { projectId, onFinish }
  let session = null // { projectId, uploadToken, tokenExpireAt }
  let items = [] // { file, relPath, stem, status, error, url, el }
  let uploading = false
  let corsHintShown = false

  const $ = (id) => document.getElementById(id)

  /* ---------- 挂载 ---------- */

  function mount(opts) {
    ctx = { projectId: opts.projectId, onFinish: opts.onFinish || function () {} }
    items = []
    uploading = false
    corsHintShown = false

    bindPickers()
    $('upPreset').addEventListener('change', renderSummary)
    $('upQuality').addEventListener('click', openQuality)
    $('upStart').addEventListener('click', startUpload)
    $('upClear').addEventListener('click', clearItems)
    $('upRetry').addEventListener('click', retryFailed)
    renderSummary()
  }

  /** 页面离开时调用，避免旧项目会话串到新页面 */
  function unmount() {
    if (window.PhotoQuality) PhotoQuality.close() // 离开页面要带走弹窗，否则它挂在 body 上
    items.forEach((i) => URL.revokeObjectURL(i.url))
    items = []
    session = null
    ctx = null
    uploading = false
  }

  /* ---------- 上传会话 ---------- */

  async function ensureSession() {
    if (session && session.tokenExpireAt > Date.now() + 60000) return session

    const res = await callCloud('photo', {
      action: 'issueUploadSession',
      projectId: ctx.projectId,
    })
    if (!res.ok) throw new Error(res.error || '获取上传会话失败')
    session = res.data
    return session
  }

  /* ---------- 选文件 ---------- */

  function bindPickers() {
    const dz = $('upDrop')
    dz.addEventListener('click', () => $('upDir').click())

    $('upDir').addEventListener('change', (e) => {
      collectFiles(e.target.files)
      e.target.value = ''
    })
    $('upFile').addEventListener('change', (e) => {
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
      if (uploading) return
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

  function collectFiles(fileList) {
    if (uploading) return
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
    renderSummary(skipped)
  }

  function stemOf(name) {
    return name.replace(/\.[^.]+$/, '')
  }

  /** 按文件名自然排序，保证 sortOrder 与相机序号一致 */
  function sortItems() {
    const collator = new Intl.Collator('en', { numeric: true })
    items.sort((a, b) => collator.compare(a.stem, b.stem))
  }

  function renderSummary(skipped) {
    if (!ctx) return
    if (Number(skipped) > 0) lastSkipped = Number(skipped)
    const skippedHint =
      lastSkipped > 0 ? ' · 已跳过 ' + lastSkipped + ' 个非 JPG（ARW 留在本地）' : ''

    const total = items.length
    const folders = new Set(items.map((i) => i.relPath.split('/')[0]))
    $('upSummary').textContent =
      (total ? `已选 ${total} 张` : '还没选照片') +
      (folders.size > 1 ? `，来自 ${folders.size} 个文件夹` : '') +
      skippedHint
    $('upStart').disabled = uploading || total === 0
    $('upStart').textContent = '开始上传' + (total ? `（${total} 张）` : '')
    $('upClear').classList.toggle('hidden', total === 0)
    $('upQuality').disabled = uploading || total === 0
    // 拖入 / 选择文件后立即铺缩略图（不用等点「开始上传」）；上传中不能重建（会丢 it.el 的实时状态）
    if (!uploading) buildWall()
  }

  let lastSkipped = 0

  /** 画质预览对比（T-P1-5）：本地生成四档，选完回写下拉框 */
  function openQuality() {
    if (!ctx || uploading || !items.length || !window.PhotoQuality) return
    PhotoQuality.open({
      files: items.map((i) => i.file),
      count: items.length,
      preset: $('upPreset').value,
      onPick: function (key) {
        $('upPreset').value = key
        renderSummary()
      },
    })
  }

  function clearItems() {
    if (uploading) return
    items.forEach((i) => URL.revokeObjectURL(i.url))
    items = []
    lastSkipped = 0
    $('upWall').innerHTML = ''
    $('upStats').textContent = ''
    $('upFail').textContent = ''
    $('upDone').classList.add('hidden')
    $('upBar').style.width = '0'
    renderSummary(0)
  }

  /* ---------- 上传 ---------- */

  function currentSpec() {
    return Object.assign({}, PRESETS[$('upPreset').value] || PRESETS.standard)
  }

  /** 自定义档：把滑条的值写进 PRESETS.custom（console.js 的滑条调用），返回当前值 */
  function setCustomSpec(v) {
    if (v && Number(v.longEdge)) {
      PRESETS.custom.longEdge = Math.max(1200, Math.min(4096, Math.round(Number(v.longEdge))))
    }
    if (v && Number(v.quality)) {
      PRESETS.custom.quality = Math.max(0.4, Math.min(0.95, Number(v.quality)))
    }
    // 体积估算随参数走（以标准档 0.25MB/张 为基准）
    PRESETS.custom.perMb =
      0.25 * (PRESETS.custom.longEdge / 1600) * (PRESETS.custom.quality / 0.75)
    return Object.assign({}, PRESETS.custom)
  }

  async function startUpload() {
    if (!ctx || uploading || items.length === 0) return

    let s
    try {
      s = await ensureSession()
    } catch (e) {
      $('upFail').textContent = e.message || '获取上传会话失败'
      return
    }

    uploading = true
    const t0 = Date.now()
    $('upStart').disabled = true
    $('upDone').classList.add('hidden')
    $('upFail').textContent = ''
    buildWall()

    const spec = currentSpec()
    const presetKey = $('upPreset').value || 'standard'
    const watermark = ($('upWatermark').value || '').trim()
    let cursor = 0
    const worker = async () => {
      while (true) {
        const idx = cursor++
        if (idx >= items.length) return
        await processOne(items[idx], spec, presetKey, watermark, s)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    uploading = false
    renderStats()

    const failed = items.filter((i) => i.status === 'failed')
    const done = items.filter((i) => i.status === 'done')
    // F-25：结束必须给「成功/失败张数 + 耗时」，有失败才另起一行列文件名
    showDone(done.length, failed.length, Math.round((Date.now() - t0) / 100) / 10)
    if (failed.length > 0) {
      $('upFail').textContent =
        `${failed.length} 张失败：` + failed.slice(0, 5).map((i) => i.stem).join('、')
    }
    $('upStart').disabled = items.length === 0
    ctx.onFinish(done.length, failed.length)
  }

  async function retryFailed() {
    if (uploading) return
    for (const it of items) if (it.status === 'failed') it.status = 'waiting'
    $('upFail').textContent = ''
    await startUpload()
  }

  async function processOne(item, spec, presetKey, watermark, s) {
    item.status = 'working'
    renderStats()
    try {
      const bmp = await decode(item.file)
      const preview = await render(bmp, spec.longEdge, spec.quality, watermark)
      const thumb = await render(bmp, THUMB_LONG_EDGE, THUMB_QUALITY, watermark)
      if (bmp.close) bmp.close()

      const safe = sanitizeStem(item.stem)
      await uploadBlob(preview.blob, `p/${s.projectId}/preview/${safe}.jpg`)
      await uploadBlob(thumb.blob, `p/${s.projectId}/thumb/${safe}.jpg`)

      const res = await callCloud('photo', {
        action: 'registerPhoto',
        projectId: s.projectId,
        uploadToken: s.uploadToken,
        stem: safe,
        filename: safe + '.jpg',
        previewPath: `p/${s.projectId}/preview/${safe}.jpg`,
        thumbPath: `p/${s.projectId}/thumb/${safe}.jpg`,
        width: preview.width,
        height: preview.height,
        sortOrder: items.indexOf(item),
        previewBytes: preview.blob.size,
        thumbBytes: thumb.blob.size,
        // 画质是「上传时的选择」：回写 project.previewSpec（BR-302 / T-P2-5）
        preset: presetKey,
        watermarkText: watermark,
      })
      if (!res.ok) throw new Error(res.error || '登记失败')

      item.status = 'done'
    } catch (err) {
      item.status = 'failed'
      item.error = err && err.message ? err.message : String(err)
    }
    renderStats()
  }

  async function uploadBlob(blob, cloudPath) {
    const app = await ensureCloudApp()
    const name = cloudPath.split('/').pop() || 'photo.jpg'
    const file = new File([blob], name, { type: 'image/jpeg' })
    try {
      await app.uploadFile({ cloudPath, file })
    } catch (e) {
      // 已知坑：存储桶不给 localhost 返回 CORS 头，浏览器读不到响应，
      // 但文件可能已实际到达服务器。是否真传成功由 registerPhoto 云端核验。
      if (!corsHintShown) {
        corsHintShown = true
        $('upFail').textContent = '提示：上传结果由云端核验，跨域提示不影响实际上传。'
      }
    }
  }

  /* ---------- 渲染 ---------- */

  function buildWall() {
    const wall = $('upWall')
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
    if (!ctx) return
    const total = items.length
    const done = items.filter((i) => i.status === 'done').length
    const failed = items.filter((i) => i.status === 'failed').length
    const working = items.filter((i) => i.status === 'working').length

    $('upBar').style.width = total ? ((done + failed) / total) * 100 + '%' : '0'
    $('upStats').textContent =
      `${done + failed} / ${total}` +
      (failed ? ` · 失败 ${failed}` : '') +
      (working ? ` · 上传中 ${working}` : '')

    items.forEach((it) => {
      if (!it.el) return
      it.el.className = it.status === 'done' ? 'done' : it.status === 'failed' ? 'failed' : ''
    })
    $('upRetry').disabled = uploading || failed === 0
  }

  function showDone(done, failed, sec) {
    const total = done + failed
    const pct = total ? Math.round((done / total) * 100) : 0
    const box = $('upDone')
    box.classList.remove('hidden')
    box.innerHTML =
      '<div class="up-done-t">✓ 成功上传 ' +
      done +
      ' / ' +
      total +
      ' 张（' +
      pct +
      '%）</div>' +
      '<div class="up-done-d">用时 ' +
      sec +
      ' 秒' +
      (failed
        ? '；失败的 ' + failed + ' 张可点「重试失败项」再传一次'
        : '；下一步：去下方「邀请模特」，把链接发给模特') +
      '</div>'
  }

  /* ---------- 图片处理 ---------- */

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

  async function render(source, longEdge, quality, watermark) {
    const sw = source.width
    const sh = source.height
    const scale = Math.min(1, longEdge / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx2d = canvas.getContext('2d')
    ctx2d.drawImage(source, 0, 0, w, h)
    if (watermark) drawWatermark(ctx2d, w, h, watermark)

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
    if (!blob) throw new Error('canvas 导出失败')
    return { blob, width: w, height: h }
  }

  function drawWatermark(ctx2d, w, h, text) {
    const size = Math.max(14, Math.round(Math.min(w, h) * 0.03))
    ctx2d.font = `${size}px -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif`
    ctx2d.textAlign = 'right'
    ctx2d.textBaseline = 'bottom'
    ctx2d.globalAlpha = 0.45
    ctx2d.fillStyle = '#ffffff'
    ctx2d.shadowColor = 'rgba(0,0,0,0.5)'
    ctx2d.shadowBlur = size / 4
    ctx2d.fillText(text, w - size, h - size)
    ctx2d.globalAlpha = 1
    ctx2d.shadowBlur = 0
  }

  function sanitizeStem(stem) {
    return (
      String(stem || '')
        .replace(/^.*[\\/]/, '')
        .replace(/[^A-Za-z0-9._-]/g, '')
        .slice(0, 80) || 'unnamed'
    )
  }

  return {
    mount: mount,
    unmount: unmount,
    presets: PRESETS,
    setCustomSpec: setCustomSpec,
    busy: () => uploading,
  }
})()
