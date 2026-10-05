/**
 * 画质预览对比（V2.0 T-P1-5 / F-06）
 *
 * 实现唯一依据：docs/12_QUALITY_PREVIEW_SPEC.md（2026-10-05 定稿，返工版）。
 * 形态：左右双视口同步对比（同一构图、同一倍率，仅档位不同），滚轮缩放 + 拖动平移。
 * 已废弃第一版的单视口 + 滑块分割（附录 A 三个根因）。
 * 纯本地计算：不上传、不联网、不消耗云资源。四档参数取自 PhotoUploader.presets。
 * 用法：PhotoQuality.open({ files, count, preset, onPick })
 */

window.PhotoQuality = (function () {
  'use strict'

  /** 缩略图参考体积（24_FILE_STORAGE 3.1：长边 320 / q0.70，约 0.025 MB） */
  const THUMB_MB = 0.025

  let mask = null
  let sampleIdx = 0
  let files = []
  let count = 0
  let cur = 'standard'
  let sideA = 'standard'
  let sideB = 'raw'
  let onPick = null

  /**
   * 视图状态（12 文档 3.1：两视口共用一组，单源渲染）
   * z = 显示宽度 / A 档生成像素宽。fit 模式下每次渲染重算。
   */
  let fitZ = 1 // 适应窗口的 z（随视口宽度变化）
  let z = 1
  let isFit = true
  let panX = 0
  let panY = 0

  let blobs = {} // key -> { blob, url, w, h, srcW, srcH }
  let busy = false

  function presets() {
    return (window.PhotoUploader && window.PhotoUploader.presets) || {}
  }
  function presetKeys() {
    return Object.keys(presets())
  }
  function fmtMb(v) {
    return v >= 1024 ? (v / 1024).toFixed(2) + ' GB' : v.toFixed(1) + ' MB'
  }

  /* ---------- 本地生成四档 ---------- */

  async function makeOne(file, spec) {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, spec.longEdge / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d').drawImage(bmp, 0, 0, w, h)
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', spec.quality))
    if (bmp.close) bmp.close()
    return { blob: blob, url: URL.createObjectURL(blob), w: w, h: h, srcW: bmp.width, srcH: bmp.height }
  }

  async function buildBlobs() {
    const file = files[sampleIdx]
    if (!file) return
    setTip('正在本地生成四档预览…')
    Object.keys(blobs).forEach((k) => URL.revokeObjectURL(blobs[k].url))
    blobs = {}
    const keys = presetKeys()
    for (let i = 0; i < keys.length; i++) {
      try {
        blobs[keys[i]] = await makeOne(file, presets()[keys[i]])
      } catch (e) {
        setTip('第 ' + (i + 1) + ' 档生成失败：' + (e && e.message))
        return
      }
    }
    resetView()
    setTip('')
    paintStage()
    paintCards()
  }

  /* ---------- 弹窗 ---------- */

  function open(opts) {
    files = opts.files || []
    count = opts.count || files.length
    cur = opts.preset || 'standard'
    onPick = opts.onPick || function () {}
    if (!files.length) return

    sampleIdx = 0
    sideA = 'standard'
    const keys = presetKeys()
    sideB = keys.indexOf('raw') >= 0 ? 'raw' : keys[keys.length - 1] // 默认差异最大的两档（12 文档 二）

    build()
    document.body.appendChild(mask)
    buildBlobs()
  }

  function close() {
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask)
    Object.keys(blobs).forEach((k) => URL.revokeObjectURL(blobs[k].url))
    blobs = {}
    mask = null
  }

  function build() {
    const keys = presetKeys()
    const optsHtml = keys
      .map((k) => '<option value="' + k + '">' + esc(presets()[k].label) + '</option>')
      .join('')

    mask = document.createElement('div')
    mask.className = 'qt-mask'
    mask.innerHTML =
      '<div class="qt-modal">' +
      '<div class="qt-head">' +
      '<h3 class="cs-sub">画质预览对比</h3>' +
      '<div class="qt-head-ops">' +
      '<button class="cs-btn primary" id="qtUse">用这个档位</button>' +
      '<button class="cs-btn" id="qtSample">换一张样张</button>' +
      '<button class="cs-btn" id="qtClose">关闭</button>' +
      '</div>' +
      '</div>' +
      '<div class="qt-bar">' +
      '<label class="up-opt"><span>左侧 A</span><select id="qtA">' + optsHtml + '</select></label>' +
      '<label class="up-opt"><span>右侧 B</span><select id="qtB">' + optsHtml + '</select></label>' +
      '<span class="qt-zoom-ops">' +
      '<button class="cs-btn" data-z="fit">适应窗口</button>' +
      '<button class="cs-btn" data-z="1">100%</button>' +
      '<button class="cs-btn" data-z="2">200%</button>' +
      '<span class="qt-zoom-now" id="qtZoomNow"></span>' +
      '</span>' +
      '</div>' +
      '<div class="qt-duo" id="qtDuo">' +
      '<div class="qv" data-side="A"><img class="qv-img" id="qtImgA" alt="A 档" draggable="false"><span class="qv-tag" id="qtTagA"></span></div>' +
      '<div class="qv" data-side="B"><img class="qv-img" id="qtImgB" alt="B 档" draggable="false"><span class="qv-tag" id="qtTagB"></span></div>' +
      '</div>' +
      '<p class="qt-tip" id="qtTip"></p>' +
      '<div class="qt-cards" id="qtCards"></div>' +
      '<p class="qt-sum" id="qtSum"></p>' +
      '</div>'

    mask.addEventListener('click', function (e) {
      if (e.target === mask) return close()
    })
    mask.querySelector('#qtClose').addEventListener('click', close)
    mask.querySelector('#qtUse').addEventListener('click', confirmPick)
    mask.querySelector('#qtSample').addEventListener('click', function () {
      if (files.length < 2) return setTip('只有一张照片，无法换样张')
      sampleIdx = (sampleIdx + 1) % files.length
      buildBlobs()
    })

    const selA = mask.querySelector('#qtA')
    const selB = mask.querySelector('#qtB')
    selA.value = sideA
    selB.value = sideB
    selA.addEventListener('change', function () {
      sideA = selA.value
      applySrc() // 12 文档 四.3：只换 src，不动视图状态
      paintCards()
    })
    selB.addEventListener('change', function () {
      sideB = selB.value
      applySrc()
      paintCards()
    })

    // 缩放按钮
    mask.querySelector('.qt-zoom-ops').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-z]')
      if (!btn) return
      setZoomMode(btn.dataset.z)
    })

    bindPanZoom()
    paintCards()
  }

  /* ---------- 视图状态与渲染（12 文档 四.1：单源状态 + 统一 render） ---------- */

  function qvBox() {
    return mask ? mask.querySelector('.qv[data-side="A"]') : null
  }

  function displayD() {
    const a = blobs[sideA]
    if (!a) return 0
    if (isFit) return qvBox() ? qvBox().clientWidth : a.w
    return a.w * z
  }

  function setZoomMode(m) {
    if (m === 'fit') {
      isFit = true
    } else {
      isFit = false
      z = Number(m)
    }
    centerView()
    paintStage()
  }

  function resetView() {
    isFit = true
    centerView()
  }

  function centerView() {
    panX = 0
    panY = 0
  }

  /** 钳制平移：图像不能被完全拖丢（12 文档 3.3） */
  function clampPan(D, imgH) {
    const qv = qvBox()
    if (!qv) return
    const w = qv.clientWidth
    const h = qv.clientHeight
    const loX = Math.min(0, w - D)
    const hiX = Math.max(0, w - D)
    const loY = Math.min(0, h - imgH)
    const hiY = Math.max(0, h - imgH)
    panX = Math.min(hiX, Math.max(loX, panX))
    panY = Math.min(hiY, Math.max(loY, panY))
  }

  function paintStage() {
    if (!mask) return
    const a = blobs[sideA]
    const b = blobs[sideB]
    const imgA = mask.querySelector('#qtImgA')
    const imgB = mask.querySelector('#qtImgB')
    if (!a || !b) return

    const D = displayD()
    const imgH = D * (a.h / a.w)
    clampPan(D, imgH)

    // 首次生成 / 换样张后在这里补设 src；切档走 applySrc（不动视图状态）
    if (imgA.getAttribute('src') !== a.url) imgA.src = a.url
    if (imgB.getAttribute('src') !== b.url) imgB.src = b.url

    // 同一显示宽度 → 构图自动对齐（12 文档 3.1 核心规则）
    imgA.style.width = D + 'px'
    imgB.style.width = D + 'px'
    imgA.style.left = panX + 'px'
    imgB.style.left = panX + 'px'
    imgA.style.top = panY + 'px'
    imgB.style.top = panY + 'px'

    // 缩放按钮高亮 + 倍率
    const nowPct = Math.round((D / a.w) * 100)
    mask.querySelectorAll('[data-z]').forEach(function (btn) {
      const on = btn.dataset.z === 'fit' ? isFit : !isFit && z === Number(btn.dataset.z)
      btn.classList.toggle('on', on)
    })
    mask.querySelector('#qtZoomNow').textContent = '当前 ' + nowPct + '%'

    // 标签（12 文档 3.4）
    mask.querySelector('#qtTagA').textContent = presets()[sideA].label + ' ' + a.w + '×' + a.h
    mask.querySelector('#qtTagB').textContent = presets()[sideB].label + ' ' + b.w + '×' + b.h

    const kb = Math.round((a.blob.size + b.blob.size) / 2 / 1024)
    setTip(
      '样张 ' + (sampleIdx + 1) + '/' + files.length +
      ' · 原图 ' + a.srcW + '×' + a.srcH +
      ' · 单张均约 ' + kb + ' KB' +
      (isFit ? ' · 整体看不出差异是正常的，请切 100% 或 200% 看细节' : ' · 滚轮缩放，按住拖动')
    )
  }

  function applySrc() {
    if (!mask) return
    const a = blobs[sideA]
    const b = blobs[sideB]
    if (!a || !b) return
    const imgA = mask.querySelector('#qtImgA')
    const imgB = mask.querySelector('#qtImgB')
    imgA.src = a.url
    imgB.src = b.url
    paintStage()
  }

  /* ---------- 滚轮缩放 + 拖动平移（两视口同步） ---------- */

  function bindPanZoom() {
    const duo = mask.querySelector('#qtDuo')

    // 滚轮：以光标为锚点（12 文档 四.2 公式）
    duo.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault()
        const a = blobs[sideA]
        if (!a) return
        const qv = qvBox()
        const rect = qv.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top

        const oldD = displayD()
        const oldZ = isFit ? oldD / a.w : z
        let newZ = oldZ * (e.deltaY < 0 ? 1.2 : 1 / 1.2)
        const minZ = Math.max(fitZOf(a), 0.05)
        newZ = Math.min(8, Math.max(minZ, newZ))

        isFit = false
        z = newZ
        const newD = a.w * newZ
        panX = cx - ((cx - panX) / oldD) * newD
        panY = cy - ((cy - panY) / oldD) * newD
        paintStage()
      },
      { passive: false }
    )

    // 按住拖动平移
    let dragging = false
    let sx = 0
    let sy = 0
    let startX = 0
    let startY = 0
    duo.addEventListener('mousedown', function (e) {
      dragging = true
      sx = e.clientX
      sy = e.clientY
      startX = panX
      startY = panY
      duo.classList.add('grabbing')
      e.preventDefault()
    })
    window.addEventListener('mousemove', function (e) {
      if (!dragging || !mask) return
      panX = startX + (e.clientX - sx)
      panY = startY + (e.clientY - sy)
      const a = blobs[sideA]
      if (a) clampPan(displayD(), displayD() * (a.h / a.w))
      paintStage()
    })
    window.addEventListener('mouseup', function () {
      dragging = false
      if (duo) duo.classList.remove('grabbing')
    })
  }

  function fitZOf(a) {
    const qv = qvBox()
    return qv && qv.clientWidth ? qv.clientWidth / a.w : 1
  }

  /* ---------- 档位卡片与体积估算（12 文档 3.5） ---------- */

  function paintCards() {
    const box = mask && mask.querySelector('#qtCards')
    if (!box) return
    const keys = presetKeys()
    box.innerHTML = keys
      .map(function (k) {
        const p = presets()[k]
        const b = blobs[k]
        const on = k === cur
        const total = count * ((p.perMb || 0) + THUMB_MB)
        return (
          '<div class="qt-card' + (on ? ' on' : '') + '" data-q="' + k + '">' +
          '<div class="qt-card-t">' + esc(p.label) + '</div>' +
          '<div class="qt-card-d">长边 ' + p.longEdge + ' · q' + Math.round(p.quality * 100) +
          (p.perMb ? ' · ≈' + p.perMb + ' MB/张' : '') + '</div>' +
          '<div class="qt-card-d">' + (b ? '样张实测 ' + Math.round(b.blob.size / 1024) + ' KB' : '生成中…') + '</div>' +
          '<div class="qt-card-d">这批 ' + count + ' 张 ≈ ' + fmtMb(total) + '</div>' +
          '</div>'
        )
      })
      .join('')
    box.onclick = function (e) {
      const card = e.target.closest('[data-q]')
      if (!card) return
      cur = card.dataset.q
      paintCards()
    }
    paintSum()
  }

  function paintSum() {
    const el = mask && mask.querySelector('#qtSum')
    if (!el) return
    const p = presets()[cur] || {}
    const total = count * ((p.perMb || 0) + THUMB_MB)
    el.innerHTML =
      '已选档位：<b>' + esc(p.label || cur) + '</b> · 这批 ' + count + ' 张 ≈ <b>' + fmtMb(total) + '</b>' +
      ' <span class="rs-note">（含缩略图，预估，实际以云端为准）</span>'
  }

  function setTip(text) {
    const el = mask && mask.querySelector('#qtTip')
    if (el) el.textContent = text
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function confirmPick() {
    if (busy) return
    busy = true
    onPick(cur)
    busy = false
    close()
  }

  return { open: open, close: close }
})()
