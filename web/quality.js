/**
 * 画质预览对比（V2.0 T-P1-5 / F-06 · UI 2.0 SECTION 10）
 *
 * 形态依据：docs/ui-redesign/web-ui-v2.html SECTION 10
 * —— PS「存储为 Web」式深色全屏工作台：左右双视口同步对比（同一构图、同一倍率，仅档位不同），
 *    滚轮缩放 + 拖动平移，底部五张档位卡 + 自定义清晰度单滑条（与上传抽屉实时互通）。
 * 实现依据：docs/12_QUALITY_PREVIEW_SPEC.md（2026-10-05 定稿，返工版）。
 * 层级：scrim 40 < mini-bar 45 < drawer 50 < 本弹窗 70 < Lightbox 90 < toast 150。
 * 纯本地计算：不上传、不联网、不消耗云资源。四档 + 自定义参数取自 PhotoUploader.presets。
 * 用法：PhotoQuality.open({ files, count, preset, watermark, onPick })
 */

window.PhotoQuality = (function () {
  'use strict'

  /** 缩略图参考体积（24_FILE_STORAGE 3.1：长边 320 / q0.70，约 0.025 MB） */
  const THUMB_MB = 0.025

  let mask = null
  let sampleIdx = 0
  let files = []
  let count = 0
  let cur = 'hd'
  let sideA = 'hd'
  let sideB = 'raw'
  let onPick = null
  let wmText = ''

  /**
   * 视图状态（12 文档 3.1：两视口共用一组，单源渲染）
   * z = 显示宽度 / A 档生成像素宽。fit 模式下每次渲染重算。
   */
  let z = 1
  let isFit = true
  let panX = 0
  let panY = 0

  let blobs = {} // key -> { blob, url, w, h, srcW, srcH }
  let busy = false
  let customTimer = null

  function presets() {
    return (window.PhotoUploader && window.PhotoUploader.presets) || {}
  }
  function presetKeys() {
    return Object.keys(presets())
  }
  function fmtMb(v) {
    return v >= 1024 ? (v / 1024).toFixed(2) + ' GB' : v.toFixed(1) + ' MB'
  }
  function customT() {
    return window.PhotoUploader && PhotoUploader.customT ? PhotoUploader.customT() : 0
  }

  /* ---------- 水印：满屏斜向平铺（抽屉输入 → 弹窗两视口同步） ---------- */

  /**
   * 弹窗水印 SVG：满屏 -24° 斜向平铺（与实际上传 drawWatermark / 抽屉预览同一套）。
   * SVG 按 2 倍尺寸绘制（520×380），高分屏上缩放后依然锐利。
   */
  function wmBg(text) {
    if (!text) return null
    const w = 520
    const h = 380
    const t = esc(text)
    const txt = function (x, y, fs, rot) {
      return (
        '<text x="' + x + '" y="' + y + '" font-size="' + fs + '" fill="#ffffff" fill-opacity="0.3" ' +
        "font-family=\"'Segoe UI','Microsoft YaHei',sans-serif\" " +
        'text-anchor="middle" dominant-baseline="middle" transform="rotate(' + rot + ' ' + x + ' ' + y + ')">' + t + '</text>'
      )
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      txt(w * 0.25, h * 0.25, 40, -24) +
      txt(w * 0.75, h * 0.75, 40, -24) +
      '</svg>'
    return { image: svg, repeat: 'repeat', position: '0 0', size: 'auto' }
  }

  function paintWatermark() {
    if (!mask) return
    const bg = wmBg(wmText)
    const css = bg
      ? {
          backgroundImage: "url('data:image/svg+xml;utf8," + encodeURIComponent(bg.image) + "')",
          backgroundRepeat: bg.repeat,
          backgroundPosition: bg.position,
          backgroundSize: bg.size,
        }
      : { backgroundImage: 'none' }
    ;[mask.querySelector('#qtWmA'), mask.querySelector('#qtWmB')].forEach(function (el) {
      if (!el) return
      el.style.backgroundImage = css.backgroundImage
      el.style.backgroundRepeat = css.backgroundRepeat || 'repeat'
      el.style.backgroundPosition = css.backgroundPosition || '0 0'
      el.style.backgroundSize = css.backgroundSize || 'auto'
    })
  }

  /* ---------- 本地生成各档 ---------- */

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
    setTip('正在本地生成各档预览…')
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

  /** 自定义档改了滑条才需要重生成：只重算 custom 一档，其他档不动 */
  async function rebuildCustom() {
    const file = files[sampleIdx]
    if (!file || !presets().custom) return
    // 拖滑条只改清晰度，不改构图：记住当前显示宽度，重生成后把倍率调回去，画面纹丝不动
    const keepD = displayD()
    const wasCustomSide = sideA === 'custom'
    if (blobs.custom) {
      URL.revokeObjectURL(blobs.custom.url)
      delete blobs.custom
    }
    try {
      blobs.custom = await makeOne(file, presets().custom)
    } catch (e) {
      return
    }
    if (!mask) return
    if (wasCustomSide && !isFit && blobs.custom.w && keepD) {
      z = keepD / blobs.custom.w
    }
    applySrc()
    paintCards()
  }

  function scheduleCustomRebuild() {
    if (customTimer) clearTimeout(customTimer)
    customTimer = setTimeout(function () {
      customTimer = null
      rebuildCustom()
    }, 160)
  }

  /* ---------- 弹窗 ---------- */

  function open(opts) {
    files = opts.files || []
    count = opts.count || files.length
    cur = opts.preset || 'hd'
    onPick = opts.onPick || function () {}
    wmText = opts.watermark || ''
    if (!files.length) return

    sampleIdx = 0
    sideA = 'hd'
    const keys = presetKeys()
    sideB = keys.indexOf('raw') >= 0 ? 'raw' : keys[keys.length - 1] // 默认差异最大的两档（12 文档 二）

    build()
    document.body.appendChild(mask)
    paintWatermark()
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
    const hasCustom = keys.indexOf('custom') >= 0

    mask = document.createElement('div')
    mask.className = 'qtd-mask'
    mask.innerHTML =
      '<div class="qtd">' +
      '<div class="qtd-head">' +
      '<h3>画质预览对比</h3>' +
      '<span class="sub" id="qtSub"></span>' +
      '<div class="ops">' +
      '<button class="qbtn" id="qtSample">换一张样张</button>' +
      '<button class="qbtn pri" id="qtUse">用这个档位</button>' +
      '<button class="qbtn" id="qtClose" title="关闭（ESC）">✕</button>' +
      '</div>' +
      '</div>' +
      '<div class="qtd-bar">' +
      '<span class="qtd-sel"><span>左侧 A</span><select id="qtA">' + optsHtml + '</select></span>' +
      '<span class="qtd-sel"><span>右侧 B</span><select id="qtB">' + optsHtml + '</select></span>' +
      '<div class="qtd-zoom">' +
      '<button class="qbtn" data-z="fit">适应窗口</button>' +
      '<button class="qbtn" data-z="1">100%</button>' +
      '<button class="qbtn" data-z="2">200%</button>' +
      '<span class="znow" id="qtZoomNow"></span>' +
      '</div>' +
      '</div>' +
      '<div class="qtd-duo" id="qtDuo">' +
      '<div class="qtd-vp" id="qtVpA">' +
      '<img class="qtd-img" id="qtImgA" alt="A 档" draggable="false">' +
      '<div class="wm-cover" id="qtWmA"></div>' +
      '<span class="lo">A · <b id="qtTagA"></b></span>' +
      '<div class="qtd-stat"><span>JPG</span><span id="qtQA"></span><span id="qtSizeA"></span>' +
      '<span>实测 <b id="qtKbA"></b></span></div>' +
      '</div>' +
      '<div class="qtd-vp" id="qtVpB">' +
      '<img class="qtd-img" id="qtImgB" alt="B 档" draggable="false">' +
      '<div class="wm-cover" id="qtWmB"></div>' +
      '<span class="lo">B · <b id="qtTagB"></b></span>' +
      '<div class="qtd-stat"><span>JPG</span><span id="qtQB"></span><span id="qtSizeB"></span>' +
      '<span>实测 <b id="qtKbB"></b></span></div>' +
      '</div>' +
      '</div>' +
      '<p class="qtd-tip" id="qtTip"></p>' +
      '<div class="qtd-cards" id="qtCards"></div>' +
      (hasCustom
        ? '<div class="qtd-custom">' +
          '<span>自定义清晰度</span>' +
          '<input type="range" id="qtCustomT" min="0" max="200" step="1" value="' + customT() + '">' +
          '<b id="qtCustomVal"></b>' +
          '<span class="hint">与上传抽屉「自定义」实时互通</span>' +
          '</div>'
        : '') +
      '<div class="qtd-sum">' +
      '已选档位：<b id="qtCur"></b><span>这批 <b id="qtTotal"></b></span>' +
      '<span class="rs-note">（含缩略图，预估，实际以云端为准）</span>' +
      '<span class="qtd-foot-note">缩放与平移在 A / B 两视口完全同步 —— 任何时候看到的是同一构图区域</span>' +
      '</div>' +
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

    mask.querySelector('.qtd-zoom').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-z]')
      if (!btn) return
      setZoomMode(btn.dataset.z)
    })

    // 自定义清晰度滑条（弹窗 ↔ 抽屉 单源：都写进 PhotoUploader.presets.custom）
    const ct = mask.querySelector('#qtCustomT')
    if (ct) {
      ct.addEventListener('input', function () {
        const t = Number(ct.value)
        if (window.PhotoUploader && PhotoUploader.setCustomT) PhotoUploader.setCustomT(t)
        // 同步抽屉滑条（抽屉自己的 input 监听会顺带刷新它那边的文案与卡片）
        const dr = document.getElementById('upCustomT')
        if (dr && Number(dr.value) !== t) {
          dr.value = String(t)
          dr.dispatchEvent(new Event('input'))
        }
        paintCustomText()
        scheduleCustomRebuild()
      })
      paintCustomText()
    }

    document.addEventListener('keydown', onKey)
    bindPanZoom()
    paintCards()
  }

  function onKey(e) {
    if (e.key === 'Escape' && mask) {
      e.stopPropagation()
      close()
      document.removeEventListener('keydown', onKey)
    }
  }

  /** 滑条文案：1600 px · 75%（弹窗 + 抽屉共用一套数字） */
  function paintCustomText() {
    if (!mask) return
    const p = presets().custom
    const el = mask.querySelector('#qtCustomVal')
    if (el && p) el.textContent = p.longEdge + ' px · ' + Math.round(p.quality * 100) + '%'
  }

  /* ---------- 视图状态与渲染（12 文档 四.1：单源状态 + 统一 render） ---------- */

  function vpBox() {
    return mask ? mask.querySelector('#qtVpA') : null
  }

  function displayD() {
    const a = blobs[sideA]
    if (!a) return 0
    if (isFit) return vpBox() ? vpBox().clientWidth : a.w
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
    const vp = vpBox()
    if (!vp) return
    const w = vp.clientWidth
    const h = vp.clientHeight
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

    // 水印层跟随图像矩形（斜向平铺，所见即所得）
    const ca = mask.querySelector('#qtWmA')
    const cb = mask.querySelector('#qtWmB')
    if (ca) {
      ca.style.left = panX + 'px'
      ca.style.top = panY + 'px'
      ca.style.width = D + 'px'
      ca.style.height = imgH + 'px'
      ca.style.right = 'auto'
      ca.style.bottom = 'auto'
    }
    if (cb) {
      cb.style.left = panX + 'px'
      cb.style.top = panY + 'px'
      cb.style.width = D + 'px'
      cb.style.height = imgH + 'px'
      cb.style.right = 'auto'
      cb.style.bottom = 'auto'
    }

    // 缩放按钮高亮 + 倍率
    const nowPct = Math.round((D / a.w) * 100)
    mask.querySelectorAll('[data-z]').forEach(function (btn) {
      const on = btn.dataset.z === 'fit' ? isFit : !isFit && z === Number(btn.dataset.z)
      btn.classList.toggle('on', on)
    })
    mask.querySelector('#qtZoomNow').textContent = '当前 ' + nowPct + '%'

    // 标签与状态条（12 文档 3.4）
    const sub = mask.querySelector('#qtSub')
    if (sub) {
      sub.textContent =
        '样张 ' + (sampleIdx + 1) + ' / ' + files.length + ' · 原图 ' + a.srcW + '×' + a.srcH
    }
    setSideInfo('A', sideA, a)
    setSideInfo('B', sideB, b)

    setTip(
      isFit
        ? '整体看不出差异是正常的 —— 请切 100% 或 200% 对比细节 · 滚轮缩放，按住拖动'
        : '滚轮缩放 · 按住拖动 · 两视口始终显示同一构图区域'
    )
  }

  function setSideInfo(side, key, blob) {
    const p = presets()[key] || {}
    const tag = mask.querySelector('#qtTag' + side)
    const q = mask.querySelector('#qtQ' + side)
    const size = mask.querySelector('#qtSize' + side)
    const kb = mask.querySelector('#qtKb' + side)
    if (tag) tag.textContent = p.label + ' ' + blob.w + '×' + blob.h
    if (q) q.textContent = 'q' + Math.round(p.quality * 100)
    if (size) size.textContent = blob.w + '×' + blob.h
    if (kb) kb.textContent = Math.round(blob.blob.size / 1024) + ' KB'
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
        const vp = vpBox()
        const rect = vp.getBoundingClientRect()
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
      mask.querySelector('#qtVpA').classList.add('grabbing')
      mask.querySelector('#qtVpB').classList.add('grabbing')
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
      if (!dragging) return
      dragging = false
      if (!mask) return
      mask.querySelector('#qtVpA').classList.remove('grabbing')
      mask.querySelector('#qtVpB').classList.remove('grabbing')
    })
    window.addEventListener('resize', function () {
      if (mask) paintStage()
    })
  }

  function fitZOf(a) {
    const vp = vpBox()
    return vp && vp.clientWidth ? vp.clientWidth / a.w : 1
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
          '<div class="qtd-card' + (on ? ' on' : '') + '" data-q="' + k + '">' +
          '<div class="t"><span class="dot"></span>' + esc(p.label) + '</div>' +
          '<div class="d">长边 ' + p.longEdge + ' · q' + Math.round(p.quality * 100) + '</div>' +
          '<div class="d">样张实测 ' + (b ? '<b>' + Math.round(b.blob.size / 1024) + ' KB</b>' : '生成中…') + '</div>' +
          '<div class="d">这批 ' + count + ' 张 ≈ <b>' + fmtMb(total) + '</b></div>' +
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
    const curEl = mask.querySelector('#qtCur')
    const totEl = mask.querySelector('#qtTotal')
    if (curEl) curEl.textContent = p.label || cur
    if (totEl) totEl.textContent = count + ' 张 ≈ ' + fmtMb(total)
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
