/**
 * 摄影师控制台（V2.0 T-P1-1：脚手架 + 扫码登录）
 *
 * hash 路由：#/login  #/projects  #/project/:id  #/result/:id（#/upload = 旧三步向导兜底入口）
 * 登录：session.createTicket 出码 → 2 秒轮询 poll → 扫码 claim 后拿 token 存 localStorage
 *
 * 零框架原生 JS（41_CODING_RULES 4.1）。渲染用简单字符串模板 + 事件委托。
 */

(function () {
  'use strict'

  /** 每个项目最多邀请的模特数（30_BUSINESS_RULES 常量表） */
  const MAX_MODELS = 5

  /** 轮询间隔（42 文档 T-P1-1：不许低于 2 秒，浪费云调用） */
  const POLL_INTERVAL = 2000
  /** 网络异常重试上限（11_INTERACTION_SPEC 七：指数退避最多 3 次） */
  const NET_RETRY_MAX = 3

  let pollTimer = null // 轮询定时器句柄（路由离开必须清除）
  let pollNetFails = 0
  let ticketInfo = null // { ticket, expireAt }

  const $ = (id) => document.getElementById(id)

  /* ---------- 路由 ---------- */

  function parseHash() {
    const h = (location.hash || '#/login').replace(/^#/, '')
    const parts = h.split('/').filter(Boolean)
    return { name: parts[0] || 'login', param: parts[1] || '' }
  }

  function go(hash) {
    if (location.hash === hash) {
      render() // 同 hash 重复跳转也要触发渲染
    } else {
      location.hash = hash
    }
  }

  /** UI 2.0 骨架：登录态切换 + 侧边栏高亮 + 最近项目列表（SECTION 2~8 通用） */
  function syncChrome(route) {
    const isLogin = route.name === 'login'
    document.body.classList.toggle('solo', isLogin)
    const side = document.querySelector('.side')
    if (side) side.classList.toggle('hidden', isLogin) // 登录页是独立一屏，不带侧边栏
    $('loginView').classList.toggle('hidden', !isLogin)
    $('consoleMain').classList.toggle('hidden', isLogin)

    $('navDash').classList.toggle('on', route.name === 'dash')
    $('navProjects').classList.toggle(
      'on',
      route.name === 'projects' || route.name === 'project' || route.name === 'result'
    )
    renderRecent(route.param)
  }

  /* ---------- 侧边栏「最近项目」 ---------- */

  /** 最近打开的项目（最多 4 个，localStorage 记忆） */
  function recentProjects(patch) {
    let list = []
    try {
      list = JSON.parse(localStorage.getItem('ps_recent_projects') || '[]')
    } catch (e) {
      list = []
    }
    if (!patch) return list
    list = list.filter(function (x) {
      return x.id !== patch.id
    })
    list.unshift(patch)
    list = list.slice(0, 4)
    try {
      localStorage.setItem('ps_recent_projects', JSON.stringify(list))
    } catch (e) {
      // 隐身模式存不下只影响侧边栏记忆
    }
    return list
  }

  function recentProjectsSync(patch) {
    recentProjects(patch)
    renderRecent()
  }

  function renderRecent(activeId) {
    const box = $('recentList')
    if (!box) return
    const list = recentProjects()
    if (!list.length) {
      box.innerHTML = '<div class="recent-empty">打开过的项目会出现在这里</div>'
      return
    }
    box.innerHTML = list
      .map(function (it) {
        const tone = it.tone === 'ok' ? '#2F7D4F' : it.tone === 'warn' ? '#9A6B00' : it.tone === 'info' ? '#3A5FA8' : '#8A897F'
        return (
          '<button class="recent-item" data-go="#/project/' + escapeHtml(it.id) + '"' +
          (activeId && activeId === it.id ? ' style="color:var(--fg);font-weight:500"' : '') + '>' +
          '<span class="dot" style="background:' + tone + '"></span>' +
          escapeHtml(it.name) + '</button>'
        )
      })
      .join('')
  }

  /** 侧边栏导航 / 最近项目的点击统一走 history（赋值式，不累积监听） */
  function bindSideNav() {
    const side = document.querySelector('.side')
    if (!side) return
    side.onclick = function (e) {
      const btn = e.target.closest('[data-go]')
      if (!btn) return
      go(btn.getAttribute('data-go'))
    }
  }

  async function render() {
    const route = parseHash()

    // 旧上传向导：独立入口，不走登录（T-P1-4 会把它并进项目详情，此处保留兜底）
    // 旧三步向导是独立入口，不需要登录；显示时就收起整个控制台骨架
    $('legacyApp').classList.toggle('hidden', route.name !== 'upload')
    $('consoleShell').classList.toggle('hidden', route.name === 'upload')
    if (route.name === 'upload') {
      stopPolling()
      return
    }

    // 其余路由都需要登录；无 token 一律回登录页
    if (route.name !== 'login' && !getToken()) {
      go('#/login')
      return
    }

    const isLogin = route.name === 'login'

    if (isLogin) {
      $('legacyApp').classList.add('hidden')
      startLogin()
      return
    }

    stopPolling()
    syncChrome(route)
    if (route.name !== 'project' && window.PhotoUploader) PhotoUploader.unmount()
    if (route.name === 'dash') renderDash()
    else if (route.name === 'projects') renderProjects()
    else if (route.name === 'project') renderProject(route.param)
    else if (route.name === 'result') renderResult(route.param)
    else go('#/dash')
  }

  /* ---------- 项目详情页（P-W3 / T-P1-4） ---------- */

  /**
   * 上传区内容（UI 2.0 SECTION 6：拖放区 + 规格卡 + 队列）。
   * 元素 id 全部保留（up* 前缀），uploader.js 仍按 id 绑定 —— 只换视觉，不动传输层。
   * 规格卡是新增的等价控件：选中即回写隐藏的 select#upPreset 并派发 change。
   */
  const SPEC_LABEL = { standard: '标准', hd: '高清', hdpro: '高清 Pro', raw: '原画质' }

  function uploadZoneHtml() {
    const presets = (window.PhotoUploader && PhotoUploader.presets) || {}
    const keys = Object.keys(presets)
    const cards = keys
      .map(function (k) {
        const it = presets[k]
        return (
          '<button class="spec' + (k === 'standard' ? ' on' : '') + '" data-spec="' + k + '">' +
          '<div class="n">' + escapeHtml(SPEC_LABEL[k] || it.label || k) +
          (k === 'standard' ? '<span class="rec">推荐</span>' : '') + '</div>' +
          '<div class="v">' + (k === 'custom' ? '自己调长边与画质' : it.longEdge + ' px / ' + it.quality) + '</div>' +
          '</button>'
        )
      })
      .join('')
    const opts = keys
      .map(function (k) {
        return (
          '<option value="' + k + '"' + (k === 'standard' ? ' selected' : '') + '>' +
          escapeHtml(presets[k].label || k) + '</option>'
        )
      })
      .join('')

    return (
      '<div class="v2drop" id="upDrop">' +
      '<div class="ic">↑</div>' +
      '<div class="t1">把照片文件夹拖到这里</div>' +
      '<div class="t2">或者</div>' +
      '<span class="btn btn-sec btn-sm" style="margin-top:12px">选择文件夹</span>' +
      '<div class="drop-note"><span>只读取 JPG</span><span>·</span><span>RAW（ARW / CR2 / NEF）自动跳过</span></div>' +
      '</div>' +
      '<input id="upDir" type="file" webkitdirectory multiple hidden>' +
      '<input id="upFile" type="file" accept=".jpg,.jpeg" multiple hidden>' +

      '<div class="dr-sec">' +
      '<div class="dr-sec-t">上传规格</div>' +
      '<div class="spec-grid" id="specGrid">' + cards + '</div>' +
      '<select id="upPreset" hidden>' + opts + '</select>' +
      // 自定义档滑条（选中「自定义」卡时出现，实时写回 PhotoUploader.presets.custom）
      '<div class="custom-spec hidden" id="customSpec">' +
      '<div class="cs-row"><span class="lbl">长边</span>' +
      '<input id="upLongEdge" type="range" min="1200" max="4096" step="100" value="1600">' +
      '<b id="upLongEdgeV">1600 px</b></div>' +
      '<div class="cs-row"><span class="lbl">画质</span>' +
      '<input id="upQualityRange" type="range" min="40" max="95" step="1" value="75">' +
      '<b id="upQualityV">75%</b></div>' +
      '<div class="cs-note">拖动即改，立即对这批照片生效</div>' +
      '</div>' +
      '<p class="drop-note" style="margin-top:10px;justify-content:flex-start;line-height:1.6;text-align:left">' +
      '画质是上传时的选择，决定模特看到的预览清晰度。原图（RAW）始终保留在你本地，不会上传。' +
      '</p>' +
      '</div>' +

      '<div class="dr-sec">' +
      '<div class="dr-sec-t">水印（可选）</div>' +
      '<div class="field" style="width:100%">' +
      '<input id="upWatermark" type="text" maxlength="20" placeholder="留空则不加">' +
      '</div>' +
      '</div>' +

      '<div class="dr-sec">' +
      '<p id="upSummary" class="up-summary"></p>' +
      '<div class="up-acts">' +
      '<button class="btn btn-pri btn-sm" id="upStart" disabled>开始上传</button>' +
      '<button class="btn btn-sec btn-sm hidden" id="upClear">清空</button>' +
      '<button class="btn btn-sec btn-sm" id="upRetry" disabled>重试失败项</button>' +
      '<button class="btn btn-ghost btn-sm" id="upQuality" disabled>画质对比</button>' +
      '</div>' +
      '<p id="upStats" class="up-stats"></p>' +
      '<div class="up-grid" id="upWall"></div>' +
      '<p class="err-inline" id="upFail"></p>' +
      '<div class="up-done hidden" id="upDone"></div>' +
      '</div>'
    )
  }

  /* ---------- A-4 照片墙（数据源 photo.list，规格见 docs/55） ---------- */

  /**
   * 缩略图链接端上缓存。
   * 云端私有读的临时链接实际只有约 10 分钟有效期，到期时刻就写在链接的 t 参数里
   * （?sign=xxx&t=1791205892，Unix 秒）。所以缓存过期时间直接从链接里算，
   * 不再写死一个长 TTL —— 写死长 TTL 会把早就过期的链接当成新鲜货，瀑布流一片 403。
   */
  const thumbCache = {}

  /** 从临时链接算出「可以用到什么时候」；解析不到就保守给 5 分钟 */
  function thumbExpireAt(url) {
    const m = /[?&]t=(\d+)/.exec(String(url || ''))
    let t = m ? parseInt(m[1], 10) : 0
    if (t && t < 1e12) t = t * 1000
    if (!t) return Date.now() + 5 * 60 * 1000
    return Math.max(Date.now(), t - 60 * 1000)
  }

  /** 缓存仍新鲜的 photoId（过期条目不进 have，服务端会重新下发链接） */
  function freshThumbIds() {
    const now = Date.now()
    return wall.photos
      .filter(function (x) {
        const c = thumbCache[x._id]
        return c && c.exp > now
      })
      .map(function (x) {
        return x._id
      })
  }

  /** 每页张数（30 常量表 PHOTO_PAGE_SIZE = 18） */
  const WALL_PAGE = 18

  /** 照片墙运行时状态 */
  const wall = {
    projectId: '',
    filter: 'all',
    modelId: '',
    kw: '',
    skip: 0,
    photos: [],
    total: 0,
    hasMore: false,
    loading: false,
    loadErr: false,
    models: [],
    archived: false,
    density: 'm', // 小 / 中 / 大 → 由 CSS 容器查询换算成列数
    totalAll: 0, // 项目照片总数（Tab 计数用）
    selectedTotal: 0, // 模特已选合计（Tab 计数用）
    view: [], // 当前画出来的照片列表，大图 ← → 在这份列表里切换
  }

  function wallReset() {
    wall.skip = 0
    wall.photos = []
    wall.hasMore = false
    wall.loadErr = false
  }

  /** E-8：视图偏好记忆——照片墙 Tab 写 localStorage，下次进来不用重选 */
  const WALL_TAB_KEY = 'ps_wall_filter'

  function readWallTab() {
    try {
      const v = localStorage.getItem(WALL_TAB_KEY)
      return v === 'all' || v === 'selected' || v === 'unselected' ? v : 'all'
    } catch (e) {
      return 'all'
    }
  }

  function writeWallTab(v) {
    try {
      localStorage.setItem(WALL_TAB_KEY, v)
    } catch (e) {
      // 隐身模式等写不进去也不影响使用
    }
  }

  /** E-8 + UI 2.0：密度偏好也记忆下来（小 / 中 / 大 → 照片墙列数） */
  const WALL_DENS_KEY = 'ps_wall_density'

  function readWallDensity() {
    try {
      const v = localStorage.getItem(WALL_DENS_KEY)
      return v === 's' || v === 'm' || v === 'l' ? v : 'm'
    } catch (e) {
      return 'm'
    }
  }

  function writeWallDensity(v) {
    try {
      localStorage.setItem(WALL_DENS_KEY, v)
    } catch (e) {
      // 隐身模式写不进去也能用，只是不记忆
    }
  }

  /**
   * 三个 Tab 的计数：全部与已选都来自项目自身字段（photoCount / 模特已选），
   * 未选是两者的差值 —— 不编造服务端没给的统计。
   */
  function wallCounts() {
    const sel = wall.selectedTotal || 0
    return { all: wall.totalAll || 0, selected: sel, unselected: Math.max(0, (wall.totalAll || 0) - sel) }
  }

  /** UI 2.0 SECTION 5：照片墙工具条（Tab 带计数 + 搜索 + 密度 + 信息栏收起） */
  function wallBarHtml() {
    const c = wallCounts()
    const tabs = [
      ['all', '全部', c.all],
      ['selected', '已选', c.selected],
      ['unselected', '未选', c.unselected],
    ]
    const tabHtml = tabs
      .map(function (t) {
        return (
          '<button class="' + (wall.filter === t[0] ? 'on' : '') +
          '" data-pw="tab" data-f="' + t[0] + '">' + t[1] +
          ' <span class="n">' + t[2] + '</span></button>'
        )
      })
      .join('')

    const densHtml = [['s', '小'], ['m', '中'], ['l', '大']]
      .map(function (d) {
        return (
          '<button data-d="' + d[0] + '" title="' + d[1] +
          '" class="' + (wall.density === d[0] ? 'on' : '') + '"><span class="' + d[0] + '"></span></button>'
        )
      })
      .join('')

    return (
      '<div class="tabs" id="wallTabs">' + tabHtml + '</div>' +
      '<div class="right">' +
      '<div class="field" style="height:28px;width:190px">' +
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#8A897F" stroke-width="1.5"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5L14 14"/></svg>' +
      '<input id="pwSearch" placeholder="搜索 DSC01023" value="' + escapeHtml(wall.kw) + '">' +
      '</div>' +
      '<div class="dens" id="dens">' + densHtml + '</div>' +
      '<button class="btn btn-sec btn-sm" id="btnPanel" data-pw="panel">' +
      '<span id="panelLabel">收起信息栏</span></button>' +
      '</div>'
    )
  }

  /** 画布右上角的模特 chips（仅「已选」Tab 下出现，数据来自 photo.list 的 models） */
  function wallChipsHtml() {
    if (wall.filter !== 'selected' || !wall.models.length) return ''
    return (
      '<button class="chip-d' + (wall.modelId ? '' : ' on') + '" data-pw="model" data-m="">全部</button>' +
      wall.models
        .map(function (m) {
          return (
            '<button class="chip-d' + (wall.modelId === m.modelId ? ' on' : '') +
            '" data-pw="model" data-m="' + escapeHtml(m.modelId) + '">' +
            escapeHtml(m.displayName || '模特') + ' <span class="n">' + (m.selectedCount || 0) + '</span></button>'
          )
        })
        .join('')
    )
  }

  /** UI 2.0 SECTION 5：单张照片卡（悬停显示文件名与选择人，已选打绿勾） */
  function wallItemHtml(x, names) {
    const w = Number(x.width) || 0
    const h = Number(x.height) || 0
    // width/height 缺失（老数据）按 3:2 兜底（55 第 5 节）
    const ar = w > 0 && h > 0 ? w + ' / ' + h : '3 / 2'
    const c = thumbCache[x._id]
    const url = x.cached ? ((c && c.exp > Date.now() && c.url) || '') : x.thumbUrl
    const hit = (x.selectedBy || []).length
    return (
      '<button class="shot" data-pw="open" data-id="' + escapeHtml(x._id) + '">' +
      (url
        ? '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" style="aspect-ratio:' + ar + '">'
        : '<div class="shot-ph" style="aspect-ratio:' + ar + '"></div>') +
      '<span class="mask"><span class="fn">' + escapeHtml(x.filename || '') + '</span>' +
      '<span class="who' + (names ? '' : ' no') + '">' +
      (names ? '✓ ' + escapeHtml(names) : '未选择') + '</span></span>' +
      (hit ? '<span class="tick">✓</span>' : '') +
      '</button>'
    )
  }

  /** 首屏加载骨架屏（SECTION 9）：占位高度参考横竖构图，避免加载完抖动 */
  function wallSkeletonHtml() {
    const ar = ['3 / 4', '3 / 2', '3 / 4', '1 / 1', '3 / 2', '3 / 4', '3 / 2', '1 / 1']
    return ar
      .map(function (r) {
        return '<div class="shot"><div class="shot-ph" style="aspect-ratio:' + r + '"></div></div>'
      })
      .join('')
  }

  function paintWall() {
    const box = $('pwCanvas')
    if (!box) return

    box.dataset.d = wall.density
    const count = $('wallCount')
    const chipsBox = $('wallChips')
    if (chipsBox) chipsBox.innerHTML = wallChipsHtml()

    const nameOf = {}
    ;(wall.models || []).forEach(function (m) {
      nameOf[m.modelId] = m.displayName || '模特'
    })
    const kw = wall.kw.trim().toLowerCase()
    const list = kw
      ? wall.photos.filter(function (x) {
          return String(x.filename || '').toLowerCase().indexOf(kw) >= 0
        })
      : wall.photos

    // 大图 ← → 就在这份「当前看到的顺序」里切换
    wall.view = list

    if (wall.loading && !wall.photos.length) {
      box.innerHTML = wallSkeletonHtml()
      if (count) count.textContent = '加载中…'
      paintWallFoot()
      return
    }

    box.innerHTML =
      list
        .map(function (x) {
          const names = (x.selectedBy || [])
            .map(function (id) {
              return nameOf[id] || '模特'
            })
            .join('、')
          return wallItemHtml(x, names)
        })
        .join('') ||
      // E-3 / SECTION 9：空态给一个能点的下一步（column-span 让它占满整行，不缩在多列里）
      '<div class="pw-empty" style="column-span:all">' +
      '<div class="ic">▤</div>' +
      '<div class="t">' +
      (kw ? '没有匹配「' + escapeHtml(wall.kw) + '」的照片' : '还没有照片') +
      '</div>' +
      '<div class="d">' +
      (kw
        ? '换一个关键词试试，文件名支持部分匹配'
        : '在电脑上批量上传后，这里会按上传顺序铺满整面墙') +
      '</div>' +
      (kw || wall.archived
        ? ''
        : '<button class="btn btn-pri btn-sm" data-pw="upload">↑ 上传照片</button>') +
      '</div>'

    // 缩略图加载失败（临时链接约 10 分钟就过期）→ 换一条新链接重加载，每张只补一次
    Array.prototype.forEach.call(box.querySelectorAll('.shot img'), function (img) {
      img.addEventListener('error', function () {
        retryThumbImg(img)
      })
    })

    const c = wallCounts()
    if (count) {
      count.textContent =
        (kw ? '筛出 ' + list.length + ' 张（已加载 ' + wall.photos.length + '）' :
        c.all + ' 张 · 已选 ' + c.selected) +
        (wall.modelId ? ' · ' + escapeHtml(modelNameOf(wall.modelId, wall.models)) : '')
    }
    paintWallFoot()
  }

  function modelNameOf(id, models) {
    const hit = (models || []).filter(function (m) {
      return m.modelId === id
    })[0]
    return hit ? hit.displayName || '模特' : ''
  }

  /** 缩略图 403：丢掉缓存、向服务端重取一条链接（数据源仍是 photo.list 的服务端取链） */
  async function retryThumbImg(img) {
    if (img.dataset.fixed) return
    img.dataset.fixed = '1'
    const item = img.closest('.shot')
    const pid = item && item.dataset.id
    if (!pid) return
    delete thumbCache[pid]
    try {
      const r = await callCloud('photo', {
        action: 'thumbUrls',
        projectId: wall.projectId,
        photoIds: [pid],
      })
      const hit = ((r.ok && r.data && r.data.list) || []).filter(function (x) {
        return x.photoId === pid
      })[0]
      if (!hit || !hit.thumbUrl) return
      thumbCache[pid] = { url: hit.thumbUrl, exp: thumbExpireAt(hit.thumbUrl) }
      img.src = hit.thumbUrl
    } catch (e) {
      // 重取失败就保留占位，点开大图仍可看（大图是现取的链接）
    }
  }

  /** 照片墙脚（SECTION 9：加载失败 / 加载更多 / 到底了） */
  function paintWallFoot() {
    const foot = $('pwFoot')
    if (!foot) return

    if (wall.archived) {
      foot.innerHTML =
        '<p class="pw-tip" style="text-align:center">项目已归档，大图已清理。缩略图仍可查看，续期后可重新上传。</p>'
      return
    }
    if (wall.loading) {
      foot.innerHTML = '<p class="pw-tip" style="text-align:center">加载中…</p>'
      return
    }
    if (wall.loadErr) {
      foot.innerHTML =
        '<div class="err-inline" style="justify-content:center">' +
        '<span>照片加载失败</span>' +
        '<button class="btn btn-sec btn-sm" id="pwRetry">重试</button></div>'
      $('pwRetry').addEventListener('click', function () {
        loadWall(true)
      })
      return
    }
    if (wall.hasMore) {
      foot.innerHTML =
        '<div style="display:flex;justify-content:center">' +
        '<button class="btn btn-sec btn-sm" id="pwMore">加载更多</button></div>'
      $('pwMore').addEventListener('click', function () {
        loadWall(true)
      })
      return
    }
    foot.innerHTML = wall.photos.length
      ? '<p class="pw-tip" style="text-align:center">已全部加载</p>'
      : ''
  }

  async function loadWall(append, auto) {
    if (wall.loading) return
    if (!append) wallReset()
    wall.loading = true
    wall.loadErr = false
    paintWall() // 首屏先铺骨架屏（含 Tab 下的空白态）

    let res
    try {
      res = await callCloud('photo', {
        action: 'list',
        projectId: wall.projectId,
        filter: wall.filter,
        modelId: wall.modelId || '',
        skip: wall.skip,
        limit: WALL_PAGE,
        have: freshThumbIds(),
      })
    } catch (e) {
      wall.loading = false
      wall.loadErr = true
      paintWallFoot()
      return
    }
    wall.loading = false

    if (!res.ok) {
      if (res.code === 'ERR_NO_AUTH') {
        clearToken()
        go('#/login')
        return
      }
      wall.loadErr = true
      paintWallFoot()
      return
    }

    const d = res.data || {}
    const got = (d.photos || []).length
    ;(d.photos || []).forEach(function (x) {
      if (x.thumbUrl) thumbCache[x._id] = { url: x.thumbUrl, exp: thumbExpireAt(x.thumbUrl) }
    })
    wall.photos = wall.photos.concat(d.photos || [])
    wall.skip = wall.photos.length
    wall.hasMore = !!d.hasMore
    wall.total = Number(d.total) || 0
    wall.models = d.models || []
    wall.archived = !!d.archived

    // 「未选」在服务端是取页后过滤，可能整页都被过滤掉；还有余量就自动再拉一页（最多 5 次防死循环）
    if (wall.hasMore && got === 0 && wall.photos.length < wall.total && (auto || 0) < 5) {
      return loadWall(true, (auto || 0) + 1)
    }

    paintWall()
  }

  /* ---------- 大图查看器（照片墙 / 选片结果页共用；滚轮缩放 + 拖动平移） ---------- */

  /** 查看器运行时状态：缩放倍率 + 平移偏移（屏幕像素）+ 当前列表与序号 */
  const lb = {
    scale: 1,
    tx: 0,
    ty: 0,
    drag: false,
    sx: 0,
    sy: 0,
    holder: null,
    list: [], // [{ id, filename, who }] —— ← → 在这份列表里切换
    idx: 0,
    projectId: '',
    archived: false,
  }

  function lbApply() {
    if (lb.holder) {
      lb.holder.style.transform = 'translate(' + lb.tx + 'px, ' + lb.ty + 'px) scale(' + lb.scale + ')'
    }
    const v = $('zoomV')
    if (v) v.textContent = Math.round(lb.scale * 100) + '%'
  }

  function lbReset() {
    lb.scale = 1
    lb.tx = 0
    lb.ty = 0
    lb.drag = false
    if (lb.holder) lb.holder.classList.remove('dragging')
    lbApply()
  }

  /** UI 2.0 SECTION 7：顶栏文件名 / 序号 / 已选，中间画布，底栏快捷键与缩放 */
  function lbShellHtml() {
    return (
      '<div class="lb-top">' +
      // 中间一组（文件名 / 序号 / 已选）居中悬在照片正上方；关闭按钮单独钉在右上角
      '<div class="lb-top-c">' +
      '<span class="fn" id="lbFn"></span>' +
      '<span class="idx" id="lbIdx"></span>' +
      '<span class="badge badge-ok hidden" id="lbSel"><span class="d"></span>已选</span>' +
      '</div>' +
      '<div class="ops"><button class="lb-btn" id="lbClose">✕ 关闭 ESC</button></div>' +
      '</div>' +
      '<div class="lb-stage" id="lbStage">' +
      '<button class="lb-nav prev" id="lbPrev">‹</button>' +
      '<div class="holder" id="lbHolder"></div>' +
      '<button class="lb-nav next" id="lbNext">›</button>' +
      '</div>' +
      '<div class="lb-foot">' +
      '<span><span class="kbd">←</span><span class="kbd">→</span> 切换</span>' +
      '<span><span class="kbd">ESC</span> 关闭</span>' +
      '<span>滚轮缩放 · 按住拖动</span>' +
      '<div class="r">' +
      '<div class="zoom-ctl">' +
      '<button id="zoomOut">−</button><span class="v" id="zoomV">100%</span><button id="zoomIn">＋</button>' +
      '</div>' +
      '<button class="lb-btn" id="zoomReset">适应窗口</button>' +
      '</div>' +
      '</div>'
    )
  }

  /**
   * 开大图：按需现取 preview 临时链接（不批量取，省调用）。
   * list 为「当前看到的那组照片」，没传就只此一张 —— 决定 ← → 能不能切。
   */
  async function openLightbox(projectId, photoId, filename, archived, list) {
    const box = $('pwLightbox')
    if (!box || !projectId || !photoId) return

    lb.projectId = projectId
    lb.archived = !!archived
    lb.holder = null
    lbReset()

    const src = list && list.length ? list : [{ _id: photoId, filename: filename || '' }]
    lb.list = src.map(function (x) {
      return {
        id: x._id || x.photoId || '',
        filename: x.filename || '',
        who: x.who || (x.selectedBy && x.selectedBy.length ? '已选' : ''),
      }
    })
    let hit = 0
    lb.list.forEach(function (x, i) {
      if (x.id === photoId) hit = i
    })
    lb.idx = hit

    const shell0 = $('consoleShell')
    if (shell0) shell0.dataset.lb = 'on'
    box.innerHTML = lbShellHtml()
    bindLightbox(box)
    loadLightboxImage()
  }

  /** 按当前序号取链接并渲染（← → 切换也走这里） */
  async function loadLightboxImage() {
    const it = lb.list[lb.idx]
    const holder = $('lbHolder')
    if (!it || !holder) return

    lb.holder = holder
    lbReset()

    const fn = $('lbFn')
    const idx = $('lbIdx')
    const sel = $('lbSel')
    if (fn) fn.textContent = it.filename || '—'
    if (idx) idx.textContent = lb.idx + 1 + ' / ' + lb.list.length
    if (sel) sel.classList.toggle('hidden', !it.who)
    const prev = $('lbPrev')
    const next = $('lbNext')
    if (prev) prev.classList.toggle('hidden', lb.list.length < 2)
    if (next) next.classList.toggle('hidden', lb.list.length < 2)

    holder.innerHTML =
      '<div class="sk sk-dark" style="width:min(52vw,520px);height:min(38vw,360px);border-radius:2px"></div>'

    // 大图链接走云函数（photo.previewUrl）：与缩略图同一条已验证的服务端取链路径
    let url = ''
    let errMsg = ''
    try {
      const r = await callCloud('photo', {
        action: 'previewUrl',
        projectId: lb.projectId,
        photoId: it.id,
      })
      if (r.ok && r.data) url = r.data.previewUrl || ''
      else errMsg = r.error || ''
    } catch (e) {
      errMsg = e.message || ''
    }

    if (lb.list[lb.idx] !== it) return // 期间已经切到别的图，丢掉这次迟到的结果
    if (!url) {
      holder.innerHTML =
        '<div class="err-box" style="color:#EDEDE8">' +
        '<div class="ic">!</div><div class="t">大图加载失败</div>' +
        '<div class="d">' +
        escapeHtml(errMsg || (lb.archived ? '大图已清理（项目已归档），续期后可重新上传' : '请重试')) +
        '</div></div>'
      return
    }
    holder.innerHTML = '<img src="' + escapeHtml(url) + '" alt="" draggable="false">'
  }

  function lbGo(delta) {
    if (lb.list.length < 2) return
    lb.idx = (lb.idx + delta + lb.list.length) % lb.list.length
    loadLightboxImage()
  }

  function lbZoom(mul) {
    // 100% = 适应窗口；允许缩到 25%（看整图概览），最大 8 倍看局部
    lb.scale = Math.min(8, Math.max(0.25, lb.scale * mul))
    if (lb.scale <= 1.001) {
      lb.tx = 0
      lb.ty = 0
    } else {
      // 平移别把图拖出视野
      const maxX = lb.scale * window.innerWidth
      const maxY = lb.scale * window.innerHeight
      lb.tx = Math.max(-maxX / 2, Math.min(maxX / 2, lb.tx))
      lb.ty = Math.max(-maxY / 2, Math.min(maxY / 2, lb.ty))
    }
    lbApply()
  }

  /** 大图自身事件（结构化 DOM 每次重建一次，用 onclick 赋值：不累积） */
  function bindLightbox(box) {
    const stage = $('lbStage')
    const holder = $('lbHolder')

    $('lbClose').onclick = closeLightbox
    $('lbPrev').onclick = function () {
      lbGo(-1)
    }
    $('lbNext').onclick = function () {
      lbGo(1)
    }
    $('zoomIn').onclick = function () {
      lbZoom(1.25)
    }
    $('zoomOut').onclick = function () {
      lbZoom(1 / 1.25)
    }
    $('zoomReset').onclick = lbReset

    // 点空白关闭（点在图上不算）
    if (stage) {
      stage.onclick = function (e) {
        if (e.target === stage || e.target === holder) closeLightbox()
      }
    }

    // 滚轮缩放
    box.onwheel = function (e) {
      e.preventDefault()
      lbZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)
    }

    // 按住拖动：看放大后的局部
    if (holder) {
      holder.onmousedown = function (e) {
        e.preventDefault()
        lb.drag = true
        lb.sx = e.clientX - lb.tx
        lb.sy = e.clientY - lb.ty
        holder.classList.add('dragging')
      }
      holder.ondblclick = lbReset
    }
    box.onmousemove = function (e) {
      if (!lb.drag) return
      lb.tx = e.clientX - lb.sx
      lb.ty = e.clientY - lb.sy
      lbApply()
    }
    document.onmouseup = function () {
      if (!lb.drag) return
      lb.drag = false
      if (lb.holder) lb.holder.classList.remove('dragging')
    }
    document.onkeydown = function (e) {
      if (e.key === 'Escape') closeLightbox()
      else if (e.key === 'ArrowLeft') lbGo(-1)
      else if (e.key === 'ArrowRight') lbGo(1)
    }
  }

  function closeLightbox() {
    const box = $('pwLightbox')
    if (box) box.innerHTML = ''
    const shell = $('consoleShell')
    if (shell) shell.dataset.lb = 'off'
    lb.holder = null
    lb.list = []
    lb.drag = false
    document.onkeydown = null
    document.onmouseup = null
  }

  /**
   * 照片墙事件委托（Tab / 模特 chip / 搜索 / 开大图）。
   * 用 onclick 赋值而不是 addEventListener —— consoleMain 是常驻元素，
   * 每次进详情页都 add 一次会累积监听，点一下触发 N 次。
   */
  function bindWall() {
    $('consoleMain').onclick = function (e) {
      const tab = e.target.closest('[data-pw="tab"]')
      if (tab) {
        if (wall.filter === tab.dataset.f) return
        wall.filter = tab.dataset.f
        writeWallTab(wall.filter)
        wall.modelId = ''
        repaintWallBar()
        loadWall(false)
        return
      }
      const chip = e.target.closest('[data-pw="model"]')
      if (chip) {
        wall.modelId = chip.dataset.m || ''
        repaintWallBar()
        loadWall(false)
        return
      }
      const dens = e.target.closest('#dens [data-d]')
      if (dens) {
        wall.density = dens.dataset.d
        writeWallDensity(wall.density)
        repaintWallBar()
        paintWall()
        return
      }
      const panelBtn = e.target.closest('[data-pw="panel"]')
      if (panelBtn) {
        applyPanelState(readPanelState() === 'on' ? 'off' : 'on')
        return
      }
      const up = e.target.closest('[data-pw="upload"]')
      if (up) {
        openUploadDrawer()
        return
      }
      const item = e.target.closest('[data-pw="open"]')
      if (item) {
        const x = wall.view.filter(function (p) {
          return p._id === item.dataset.id
        })[0]
        // ← → 就在当前这张列表里切换（含搜索过滤后的结果）
        openLightbox(wall.projectId, item.dataset.id, (x && x.filename) || '', wall.archived, wall.view)
        return
      }
      const closer = e.target.closest('[data-pw="close"]')
      if (closer) closeLightbox()
    }

    // 滚动到底自动加载下一页（「加载更多」按钮保留兜底）
    const canvas = document.querySelector('.canvas')
    if (canvas) {
      canvas.onscroll = function () {
        if (!wall.hasMore || wall.loading || wall.loadErr) return
        if (canvas.scrollTop + canvas.clientHeight >= canvas.scrollHeight - 640) loadWall(true)
      }
    }
  }

  /** 工具条整段重画 + 重绑搜索（Tab / 密度状态变了都走这里） */
  function repaintWallBar() {
    const bar = $('wallBar')
    if (!bar) return
    bar.innerHTML = wallBarHtml()
    bindSearch()
  }

  /** 搜索框每次重画后要重新绑（防抖 300ms） */
  let searchTimer = null
  function bindSearch() {
    const el = $('pwSearch')
    if (!el) return
    el.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(function () {
        wall.kw = el.value || ''
        paintWall()
      }, 300)
    })
  }

  /* ---------- UI 2.0 SECTION 5：右侧信息栏 ---------- */

  /** 项目状态块（状态徽标 + 剩余天数 + 三格统计 + 关键参数 + 续期） */
  function infoStatusHtml(p, id) {
    const st = statusMeta(p)
    const total = Number(p.photoCount) || 0
    const picked = (p.models || []).reduce(function (s, m) {
      return s + (Number(m.selectedCount) || 0)
    }, 0)
    const days = p.expireAt ? Math.ceil((p.expireAt - Date.now()) / DAY) : 0
    const pkg = p.packageCount > 0 ? '限 ' + p.packageCount + ' 张' : '不限'
    // previewSpec 是上传时才回写的字段（BR-302），没有就说明还没传过 —— 不猜一个值显示
    const spec = p.previewSpec ? (p.previewSpec.longEdge || '—') + ' px / ' + (p.previewSpec.quality || '—') : ''

    return (
      '<div class="info-block">' +
      '<h4>项目状态</h4>' +
      '<div class="status-big">' +
      '<span class="badge ' + badgeTone(st.tone) + '"><span class="d"></span>' + st.text + '</span>' +
      '<span class="nm">' + escapeHtml(days > 0 ? '剩余 ' + days + ' 天' : fmtRemain(p)) + '</span>' +
      '</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-cell"><div class="v">' + total + '</div><div class="l">照片</div></div>' +
      '<div class="stat-cell"><div class="v">' + picked + '</div><div class="l">已选</div></div>' +
      '<div class="stat-cell"><div class="v">' + (p.models || []).length + '</div><div class="l">模特</div></div>' +
      '</div>' +
      '<div style="margin-top:12px">' +
      '<div class="kv"><span class="k">套餐上限</span><span class="v">' + escapeHtml(pkg) + '</span></div>' +
      (spec ? '<div class="kv"><span class="k">画质规格</span><span class="v">' + escapeHtml(spec) + '</span></div>' : '') +
      '<div class="kv"><span class="k">已用空间</span><span class="v">' + escapeHtml(fmtBytes(p.usedBytes)) + '</span></div>' +
      '<div class="kv"><span class="k">创建于</span><span class="v">' + escapeHtml(fmtDay(p.createdAt)) + '</span></div>' +
      '</div>' +
      (p.status === 'ARCHIVED'
        ? ''
        : '<button class="btn btn-sec btn-sm" style="width:100%;justify-content:center;margin-top:12px" data-hd="extend">续期 30 天</button>') +
      '</div>'
    )
  }

  /** 四步进度：全部由真实状态推导（有没有照片 / 模特状态 / 是否提交 / 是否导出） */
  function infoProgressHtml(p) {
    const total = Number(p.photoCount) || 0
    const models = p.models || []
    const submitted = models.filter(function (m) {
      return m.status === '已提交'
    }).length
    const step = function (done, doing, nm, st) {
      return (
        '<div class="step' + (done ? ' done' : doing ? ' doing' : ' wait') + '">' +
        '<span class="ic">' + (done ? '✓' : doing ? '●' : '○') + '</span>' +
        '<span class="nm">' + nm + '</span><span class="st">' + st + '</span></div>'
      )
    }
    return (
      '<div class="info-block">' +
      '<h4>项目进度</h4>' +
      '<div class="vsteps">' +
      step(total > 0, total === 0, '上传照片', total > 0 ? '完成' : '待处理') +
      step(
        submitted > 0 && submitted >= models.length && models.length > 0,
        models.length > 0 && submitted < models.length,
        '模特选片',
        !models.length ? '待邀请' : submitted >= models.length ? '完成' : '进行中 ' + submitted + '/' + models.length
      ) +
      step(false, p.status === 'SELECTION_SUBMITTED', '确认结果', p.status === 'SELECTION_SUBMITTED' ? '待处理' : '待选择完成') +
      step(false, false, '导出清单', '去结果页导出') +
      '</div>' +
      '</div>'
    )
  }

  /** 模特行（保留二维码 / 复制链接 / 允许重选 / 查看结果 / 移除五个动作） */
  function infoModelsHtml(p, invites) {
    const models = p.models || []
    const inviteMap = {}
    invites.forEach(function (i) {
      inviteMap[i.modelId] = i
    })
    const rows = models
      .map(function (m) {
        const inv = inviteMap[m.modelId] || {}
        const pkg = Number(p.packageCount) || 0
        const pct = pkg > 0 ? Math.min(100, Math.round(((m.selectedCount || 0) / pkg) * 100)) : (m.selectedCount || 0) > 0 ? 100 : 0
        const linkText = m.status === '已提交' ? '复制链接' : '催一下'
        return (
          '<div class="model-row" data-model="' + escapeHtml(m.modelId) + '"' +
          ' data-invite="' + escapeHtml(inv._id || '') + '"' +
          ' data-token="' + escapeHtml(inv.token || '') + '"' +
          ' data-name="' + escapeHtml(m.name || '模特') + '"' +
          ' data-count="' + (m.selectedCount || 0) + '">' +
          '<div class="top">' +
          '<span class="nm">' + escapeHtml(m.name || '模特') + '</span>' +
          '<span class="r ' + modelTone(m.status) + '">' + escapeHtml(m.status || '待选片') + '</span>' +
          '</div>' +
          '<div class="bar"><i class="' + (m.status === '已提交' ? 'ok' : 'warn') + '" style="width:' + pct + '%"></i></div>' +
          '<div class="bot"><span>已选 ' + (m.selectedCount || 0) + ' 张' + (pkg > 0 ? ' / 上限 ' + pkg : '') + '</span>' +
          '<span>' + (m.submittedAt ? escapeHtml(fmtDay(m.submittedAt)) : escapeHtml(fmtDay(p.updatedAt))) + '</span></div>' +
          '<div class="md-ops-v2">' +
          '<button class="btn btn-ghost btn-sm" data-md="qr">二维码</button>' +
          '<button class="btn btn-ghost btn-sm" data-md="link">' + linkText + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-md="result">结果</button>' +
          '<button class="btn btn-ghost btn-sm" data-md="unlock">重选</button>' +
          '<button class="btn btn-ghost btn-sm" data-md="remove" style="color:var(--err)">移除</button>' +
          '</div>' +
          '<div class="md-qr hidden"></div>' +
          '</div>'
        )
      })
      .join('')

    const full = models.length >= MAX_MODELS
    return (
      '<div class="info-block">' +
      '<h4>模特（' + models.length + '/' + MAX_MODELS + '）</h4>' +
      (rows || '<p class="page-sub">还没有邀请模特。上传照片后邀请她，她就能在小程序里选片。</p>') +
      (full
        ? ''
        : '<button class="btn btn-sec btn-sm" id="btnAddModel" style="width:100%;justify-content:center;margin-top:12px">＋ 邀请模特</button>') +
      '</div>'
    )
  }

  /** 动态只用项目与模特身上真实存在的时间戳（创建 / 更新 / 提交 / 归档 / 到期） */
  function infoFeedHtml(p) {
    const items = []
    if (p.createdAt) items.push([p.createdAt, '项目创建'])
    if (p.updatedAt && p.updatedAt !== p.createdAt) items.push([p.updatedAt, '项目更新'])
    ;(p.models || []).forEach(function (m) {
      if (m.submittedAt) items.push([m.submittedAt, '<b>' + escapeHtml(m.name || '模特') + '</b> 提交了选片 · ' + (m.selectedCount || 0) + ' 张'])
    })
    if (p.archivedAt) items.push([p.archivedAt, '已归档 · 大图已清理'])
    if (p.expireAt && p.expireAt < Date.now()) items.push([p.expireAt, '已到期'])
    if (!items.length) return ''
    items.sort(function (a, b) {
      return b[0] - a[0]
    })

    return (
      '<div class="info-block">' +
      '<h4>最近动态</h4>' +
      '<div class="feed">' +
      items
        .slice(0, 6)
        .map(function (it) {
          return (
            '<div class="feed-item"><div class="feed-t">' + relTime(it[0]) + '</div>' +
            '<div class="feed-c">' + it[1] + '</div></div>'
          )
        })
        .join('') +
      '</div>' +
      '</div>'
    )
  }

  /** MM-DD HH:mm（信息栏里的时间一律不写秒） */
  function fmtDay(ts) {
    if (!ts) return '—'
    const d = new Date(ts)
    const p2 = function (n) {
      return n < 10 ? '0' + n : '' + n
    }
    return (
      p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
    )
  }

  function fmtTime(ts) {
    if (!ts) return '—'
    const d = new Date(ts)
    const p2 = function (n) {
      return n < 10 ? '0' + n : '' + n
    }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  // 旧的时间线模块已并入 UI 2.0 的 infoFeedHtml（同口径：只用真实时间戳）

  /** 详情页装载态骨架（SECTION 9） */
  function detailLoadingHtml() {
    return (
      '<div class="page" style="padding:40px 32px">' +
      '<div class="sk" style="width:180px;height:22px;margin-bottom:16px"></div>' +
      '<div class="sk" style="width:320px;height:14px;margin-bottom:24px"></div>' +
      '<div class="sk" style="height:320px;border-radius:14px;background:#E2E1DC"></div>' +
      '</div>'
    )
  }

  function detailFailHtml(text, projectId) {
    return (
      '<div class="page"><div class="err-box">' +
      '<div class="ic">!</div><div class="t">项目加载失败</div>' +
      '<div class="d">' + escapeHtml(text) + '</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;margin-top:16px">' +
      '<button class="btn btn-sec btn-sm" id="pdRetry">重试</button>' +
      '<button class="btn btn-ghost btn-sm" id="pdBack">返回项目列表</button>' +
      '</div></div></div>'
    )
  }

  async function renderProject(id) {
    const main = $('consoleMain')
    main.innerHTML = detailLoadingHtml()

    let res
    try {
      res = await callCloud('project', { action: 'get', _id: id })
    } catch (e) {
      main.innerHTML = detailFailHtml(e.message || '网络异常', id)
      bindDetailFail(id)
      return
    }
    if (!res.ok) {
      if (res.code === 'ERR_NO_AUTH') {
        clearToken()
        go('#/login')
        return
      }
      main.innerHTML = detailFailHtml(res.error || '加载失败', id)
      bindDetailFail(id)
      return
    }

    const p = res.data.project
    const st = statusMeta(p)
    const models = p.models || []
    const picked = models.reduce(function (s, m) {
      return s + (Number(m.selectedCount) || 0)
    }, 0)
    const days = p.expireAt ? Math.ceil((p.expireAt - Date.now()) / DAY) : 0

    main.innerHTML =
      '<div class="detail">' +
      '<div class="wall-wrap">' +

      // 头：返回 + 标题 + 状态 + 三个操作
      '<div class="dhead">' +
      '<button class="back" data-nav="#/projects">‹</button>' +
      '<div>' +
      '<h1>' + escapeHtml(p.name) + '</h1>' +
      '<div class="meta">' + (Number(p.photoCount) || 0) + ' 张照片 · ' + models.length + ' 位模特 · 创建于 ' +
      escapeHtml(fmtDay(p.createdAt)) +
      (p.expireAt ? ' · 存续至 ' + escapeHtml(fmtDay(p.expireAt)) : '') + '</div>' +
      '</div>' +
      '<div class="ops">' +
      '<span class="badge ' + badgeTone(st.tone) + '"><span class="d"></span>' + st.text + '</span>' +
      (p.status === 'ARCHIVED'
        ? ''
        : '<button class="btn btn-pri" id="btnUpload">↑ <span class="lbl">上传照片</span></button>') +
      '<button class="btn btn-sec" id="btnInvite">邀请模特</button>' +
      // 延期 / 归档 / 删除直接并排在头部（不再收进 ⋯ 菜单）
      (p.status === 'ARCHIVED'
        ? ''
        : '<button class="btn btn-ghost btn-sm" data-hd="extend">延期 30 天</button>' +
          '<button class="btn btn-ghost btn-sm" data-hd="archive">归档</button>') +
      '<button class="btn btn-ghost btn-sm hd-danger" data-hd="remove">删除项目</button>' +
      '</div>' +
      '</div>' +

      // 工具条：Tab + 搜索 + 密度 + 信息栏开关
      '<div class="wall-bar" id="wallBar">' + wallBarHtml() + '</div>' +

      // 画布
      '<div class="canvas">' +
      '<div class="canvas-head">' +
      '<span class="t" id="wallCount"></span>' +
      '<div class="r" id="wallChips"></div>' +
      '</div>' +
      '<div class="masonry" id="pwCanvas"></div>' +
      '<div id="pwFoot"></div>' +
      '<button class="info-collapsed-btn btn btn-sec btn-sm" id="btnPanel2" data-pw="panel">展开信息栏 ›</button>' +
      '</div>' +

      '</div>' +

      // 右侧信息栏（前面留 6px 拖拽条，可拖动调宽）
      '<div class="rz" id="rzInfo"></div>' +
      '<aside class="info">' +
      '<div class="info-head">' +
      '<span class="t">项目信息</span>' +
      '<button class="collapse" id="btnPanelCollapse" data-pw="panel">›</button>' +
      '</div>' +
      '<div class="info-body" id="infoBody">' +
      inviteHintHtml(p) +
      infoStatusHtml(p, id) +
      infoProgressHtml(p) +
      infoModelsHtml(p, res.data.invites || []) +
      infoFeedHtml(p) +
      '</div>' +
      '<div class="info-foot">' +
      '<button class="btn btn-sec btn-sm" id="btnResultTotal" style="flex:1">查看选片结果</button>' +
      '</div>' +
      '</aside>' +
      '</div>'

    // 侧边栏「最近项目」记住这次打开的项目
    recentProjectsSync({ id: id, name: p.name, tone: toneOfStatus(p) })

    // 照片墙初始化（E-8：Tab 与密度用上次的偏好）
    wall.projectId = id
    wall.filter = readWallTab()
    wall.density = readWallDensity()
    wall.modelId = ''
    wall.kw = ''
    wall.totalAll = Number(p.photoCount) || 0
    wall.selectedTotal = picked
    applyPanelState(readPanelState())
    bindWall()
    bindSearch()
    bindDetailChrome(id)
    loadWall(false)

    bindProjectActions(id, p, res.data.invites || [])

    const gInvite = $('btnGuideInvite')
    if (gInvite) {
      gInvite.onclick = function () {
        openInviteModal(id)
      }
    }

    // 上传抽屉：只装容器，不动 uploader.js 的任何逻辑
    mountUploadDrawer(id, p.name)

    if (window.PhotoUploader) {
      PhotoUploader.mount({
        projectId: id,
        onFinish: function () {
          // 不重渲染整页（否则上传结果会被清掉）：只刷照片墙 + 信息栏
          loadWall(false)
          callCloud('project', { action: 'get', _id: id }).then(function (r) {
            if (!r.ok) return
            refreshDetailAside(r.data.project, id, r.data.invites || [])
          })
        },
      })
    }
  }

  /** 上传完成后只换信息栏，不碰照片墙与抽屉 */
  function refreshDetailAside(p, id, invites) {
    const pPicked = (p.models || []).reduce(function (s, m) {
      return s + (Number(m.selectedCount) || 0)
    }, 0)
    wall.totalAll = Number(p.photoCount) || 0
    wall.selectedTotal = pPicked

    const body = $('infoBody')
    if (body) {
      body.innerHTML =
        inviteHintHtml(p) +
        infoStatusHtml(p, id) +
        infoProgressHtml(p) +
        infoModelsHtml(p, invites) +
        infoFeedHtml(p)
    }
    const totalBtn = $('btnResultTotal')
    if (totalBtn) totalBtn.textContent = '查看选片结果' + (pPicked ? '（' + pPicked + ' 张）' : '')

    const bar = $('wallBar')
    if (bar) {
      bar.innerHTML = wallBarHtml()
      bindSearch()
    }
    const head = document.querySelector('.dhead .ops .badge')
    if (head) {
      const st = statusMeta(p)
      head.className = 'badge ' + badgeTone(st.tone)
      head.innerHTML = '<span class="d"></span>' + st.text
    }
    const meta = document.querySelector('.dhead .meta')
    if (meta) {
      meta.textContent =
        (Number(p.photoCount) || 0) + ' 张照片 · ' + (p.models || []).length + ' 位模特 · 创建于 ' +
        fmtDay(p.createdAt) + (p.expireAt ? ' · 存续至 ' + fmtDay(p.expireAt) : '')
    }
  }

  function bindDetailFail(id) {
    const retry = $('pdRetry')
    if (retry) retry.onclick = function () {
      renderProject(id)
    }
    const back = $('pdBack')
    if (back) back.onclick = function () {
      go('#/projects')
    }
  }

  /* ---------- 详情页外壳交互：信息栏收起 / 密度 / 头部菜单 ---------- */

  const PANEL_KEY = 'ps_wall_panel'

  function readPanelState() {
    try {
      return localStorage.getItem(PANEL_KEY) === 'off' ? 'off' : 'on'
    } catch (e) {
      return 'on'
    }
  }

  function applyPanelState(v) {
    const shell = appShellEl()
    if (shell) shell.dataset.panel = v
    const label = $('panelLabel')
    if (label) label.textContent = v === 'off' ? '展开信息栏' : '收起信息栏'
    try {
      localStorage.setItem(PANEL_KEY, v)
    } catch (e) {
      // 记不住也不影响这次使用
    }
  }

  function bindDetailChrome(projectId) {
    // 信息栏的收起 / 展开统一由 bindWall 里的事件委托处理（[data-pw="panel"] / [data-panel] 三处按钮），
    // 这里不再逐个 onclick —— 否则工具条重画后会同时触发两次切换，等于没反应。

    const up = $('btnUpload')
    if (up) up.onclick = openUploadDrawer
    const iv = $('btnInvite')
    if (iv) iv.onclick = function () {
      openInviteModal(projectId)
    }

    // 头部操作：延期 / 归档 / 删除（直接并排在头部，逐个绑定）
    document.querySelectorAll('.dhead [data-hd]').forEach(function (b) {
      b.onclick = async function () {
        if (uploadBusy()) return
        const act = b.dataset.hd
        if (act === 'extend') await doExtend(projectId, b)
        else if (act === 'archive') await doArchive(projectId, b)
        else if (act === 'remove') await doRemove(projectId, b)
      }
    })

    // 信息栏宽度：挂拖拽 + 恢复上次宽度
    const info = document.querySelector('.detail > .info')
    if (info) {
      rzMount($('rzInfo'), info, 'pw_info_w', -1)
      const savedW = Number(safeGet('pw_info_w') || 0)
      if (savedW) {
        const w = rzClamp(savedW)
        info.style.width = w + 'px'
        info.style.flexBasis = w + 'px'
      }
    }

    const total = $('btnResultTotal')
    if (total) total.onclick = function () {
      go('#/result/' + projectId)
    }
  }

  /**
   * E-6：上传完成 → 邀请模特引导卡。
   * 照片已就位但一个模特都没邀请，是现在最大的流程断点——这里直接把下一步摆出来。
   */
  function inviteHintHtml(p) {
    const total = Number(p.photoCount) || 0
    if (total <= 0 || (p.models || []).length > 0 || p.status === 'ARCHIVED') return ''
    return (
      '<div class="info-block">' +
      '<div class="hint-box">' +
      '<div class="ht">照片已就位（' + total + ' 张）</div>' +
      '<div class="hd">现在邀请模特选片：生成二维码或链接发给她，她选完就能导出文件名清单。</div>' +
      '<button class="btn btn-pri btn-sm" id="btnGuideInvite" style="margin-top:10px">＋ 邀请模特</button>' +
      '</div>' +
      '</div>'
    )
  }

  /* ---------- 上传抽屉（UI 2.0 SECTION 6：装进骨架里的静态容器，逻辑全在 uploader.js） ---------- */

  function appShellEl() {
    return $('consoleShell')
  }

  /** 抽屉内容按当前项目重建（进入详情页时调用一次，避免串项目） */
  function mountUploadDrawer(projectId, projectName) {
    const dr = $('upDrawer')
    if (!dr) return
    dr.innerHTML =
      '<div class="dr-head">' +
      '<span class="t">上传照片</span>' +
      '<span class="badge badge-gray">' + escapeHtml(projectName || '') + '</span>' +
      '<div class="ops">' +
      '<button id="upDrawerMin" title="最小化">—</button>' +
      '<button id="upDrawerClose" title="关闭">✕</button>' +
      '</div>' +
      '</div>' +
      '<div class="dr-body">' +
      uploadZoneHtml() +
      '</div>' +
      // 进度条放抽屉底部（设计稿 dr-foot）：#upBar 由 uploader.js 按 id 写宽度
      '<div class="dr-foot">' +
      '<div class="top"><span id="upFootLabel">准备就绪</span><span id="upFootCount"></span></div>' +
      '<div class="bar"><i id="upBar" style="width:0"></i></div>' +
      '</div>'

    $('upMin').innerHTML =
      '<span class="t">上传中</span>' +
      '<span class="n" id="upMinCount"></span>' +
      '<div class="bar"><i id="upMinBar" style="width:0"></i></div>' +
      '<button id="upMinOpen">展开</button>'

    const dMin = $('upDrawerMin')
    if (dMin) dMin.onclick = minUploadDrawer
    const dClose = $('upDrawerClose')
    if (dClose) dClose.onclick = minUploadDrawer
    const mOpen = $('upMinOpen')
    if (mOpen) mOpen.onclick = openUploadDrawer
    bindSpecCards()
    mirrorUploadProgress()
  }

  /** 规格卡 ⇄ 隐藏 select（uploader.js 只读 select 的值） */
  function bindSpecCards() {
    const grid = $('specGrid')
    const sel = $('upPreset')
    if (!grid || !sel) return
    const customBox = $('customSpec')
    const le = $('upLongEdge')
    const q = $('upQualityRange')
    const leV = $('upLongEdgeV')
    const qV = $('upQualityV')

    const syncCustom = function () {
      if (!customBox) return
      customBox.classList.toggle('hidden', sel.value !== 'custom')
      const card = grid.querySelector('[data-spec="custom"] .v')
      if (card && le && q) card.textContent = '长边 ' + le.value + ' · 画质 ' + q.value + '%'
      if (le && leV) leV.textContent = le.value + ' px'
      if (q && qV) qV.textContent = q.value + '%'
    }

    const sync = function () {
      Array.prototype.forEach.call(grid.querySelectorAll('[data-spec]'), function (b) {
        b.classList.toggle('on', b.dataset.spec === sel.value)
      })
      syncCustom()
    }

    if (customBox && le && q) {
      const apply = function () {
        if (window.PhotoUploader && PhotoUploader.setCustomSpec) {
          PhotoUploader.setCustomSpec({ longEdge: Number(le.value), quality: Number(q.value) / 100 })
        }
        syncCustom()
      }
      le.addEventListener('input', apply)
      q.addEventListener('input', apply)
    }

    grid.onclick = function (e) {
      const b = e.target.closest('[data-spec]')
      if (!b) return
      sel.value = b.dataset.spec
      sel.dispatchEvent(new Event('change')) // uploader.js 监听的就是 change
      sync()
    }
    sel.addEventListener('change', sync) // 画质对比弹窗改值时也要同步卡片
    sync()
  }

  /**
   * 抽屉最小化后，底下那条迷你条要跟着上传进度走。
   * uploader.js 只认自己的 DOM，所以这里用一个观察者把它的输出镜像过去 —— 不改上传逻辑。
   */
  let upMirror = null
  function mirrorUploadProgress() {
    if (upMirror) upMirror.disconnect()
    const bar = $('upBar')
    const stats = $('upStats')
    if (!bar || !stats) return
    const push = function () {
      const cnt = $('upMinCount')
      const mb = $('upMinBar')
      const label = $('upFootLabel')
      const fc = $('upFootCount')
      if (mb) mb.style.width = bar.style.width || '0'
      if (cnt) cnt.textContent = stats.textContent || ''
      if (fc) fc.textContent = stats.textContent || ''
      if (label) label.textContent = bar.style.width && bar.style.width !== '0px' ? '正在上传' : '准备就绪'
    }
    upMirror = new MutationObserver(push)
    upMirror.observe(bar, { attributes: true, attributeFilter: ['style'] })
    upMirror.observe(stats, { childList: true, characterData: true, subtree: true })
    push()
  }

  function openUploadDrawer() {
    const shell = appShellEl()
    if (shell) shell.dataset.drawer = 'open'
  }

  /**
   * 收起抽屉：还在上传就留一条底部迷你条（data-drawer="min"），
   * 传完了就彻底关掉（data-drawer="closed"）——不打扰，也不占地方。
   */
  function minUploadDrawer() {
    const shell = appShellEl()
    if (!shell) return
    const busy = window.PhotoUploader && PhotoUploader.busy && PhotoUploader.busy()
    shell.dataset.drawer = busy ? 'min' : 'closed'
  }

  /* ---------- 详情页：模特与邀请（P-W3 区域 6+7 / T-P1-6） ---------- */

  // 旧的模特面板（md-row）已并入 UI 2.0 的 infoModelsHtml，动作按钮一个没删

  /** 上传进行中禁止重渲染类操作（会连上传区的 DOM 一起换掉） */
  function uploadBusy() {
    if (window.PhotoUploader && PhotoUploader.busy()) {
      showToast('照片正在上传，上传完成后再操作')
      return true
    }
    return false
  }

  /** 详情页所有按钮走事件委托：DOM 每次重渲染，只绑一次在容器上 */
  function bindProjectActions(projectId, p, invites) {
    // UI 2.0：信息栏里也有「续期」（data-hd），这里统一兜住整个信息栏
    const aside = document.querySelector('.info')
    if (aside) {
      aside.addEventListener('click', async function (e) {
        const btn = e.target.closest('[data-hd]')
        if (!btn) return
        const act = btn.dataset.hd
        if (uploadBusy()) return
        if (act === 'extend') await doExtend(projectId, btn)
        else if (act === 'archive') await doArchive(projectId, btn)
        else if (act === 'remove') await doRemove(projectId, btn)
      })
    }

    const panel = document.querySelector('.info')
    if (panel) {
      panel.addEventListener('click', function (e) {
        const add = e.target.closest('#btnAddModel')
        if (add) {
          openInviteModal(projectId)
          return
        }
        const btn = e.target.closest('[data-md]')
        if (!btn) return
        const row = btn.closest('.model-row')
        if (!row) return
        const modelId = row.dataset.model
        const act = btn.dataset.md
        // 二维码与复制链接不重渲染页面，上传期间也允许
        if (act === 'qr') showInviteQr(row, btn)
        else if (act === 'link') copyInviteLink(row)
        else if (uploadBusy()) return
        else if (act === 'unlock') doUnlock(projectId, row, btn)
        else if (act === 'result') go('#/result/' + projectId)
        else if (act === 'remove') doRemoveInvite(projectId, row, btn)
      })
    }
  }

  /* ---------- 详情页：头部三个操作 ---------- */

  function showPdError(text) {
    const el = $('pdErr')
    // UI 2.0 之后详情页没有常驻错误行，统一走 toast（不丢提示）
    if (!el) {
      if (text) showToast(text)
      return
    }
    if (!el) return
    el.textContent = text
    el.classList.toggle('hidden', !text)
  }

  /** 延期：文档未列入确认弹窗场景（11 §1 只有 5 处），不加弹窗 */
  async function doExtend(projectId, btn) {
    btn.disabled = true
    showPdError('')
    const res = await callCloud('project', { action: 'extend', _id: projectId })
    btn.disabled = false
    if (!res.ok) return showPdError(res.error || '延期失败')
    const days = res.data && res.data.needReupload ? '已延期 30 天；大图已清理，需重新上传照片' : '已延期 30 天'
    showToast(days)
    render()
  }

  async function doArchive(projectId, btn) {
    if (!window.confirm('归档后将删除大图预览、释放空间，仍保留缩略图与文件名。确定吗？')) return
    btn.disabled = true
    showPdError('')
    const res = await callCloud('project', { action: 'archive', _id: projectId })
    btn.disabled = false
    if (!res.ok) return showPdError(res.error || '归档失败')
    showToast('已归档，大图已清理')
    render()
  }

  async function doRemove(projectId, btn) {
    if (!window.confirm('删除后照片与选片结果将永久消失，无法恢复。确定删除吗？')) return
    btn.disabled = true
    showPdError('')
    const res = await callCloud('project', { action: 'remove', _id: projectId })
    btn.disabled = false
    if (!res.ok) return showPdError(res.error || '删除失败')
    if (window.PhotoUploader) PhotoUploader.unmount()
    showToast('项目已删除')
    go('#/projects')
  }

  /* ---------- 详情页：模特操作 ---------- */

  /** 二维码 fileID 页内缓存：每次生成都会在云存储留一张 PNG，重复点不该重复产图 */
  const qrCache = {}

  async function showInviteQr(row, btn) {
    const inviteId = row.dataset.invite
    if (!inviteId) return showToast('该模特缺少邀请记录，请移除后重新邀请')

    const box = row.querySelector('.md-qr')
    if (!box.classList.contains('hidden')) {
      box.classList.add('hidden')
      box.innerHTML = ''
      return
    }
    if (qrCache[inviteId]) {
      renderQrBox(box, qrCache[inviteId], row.dataset.name)
      return
    }

    btn.disabled = true
    btn.textContent = '生成中…'
    const res = await callCloud('project', { action: 'getInviteQrCode', inviteId })
    btn.disabled = false
    btn.textContent = '二维码'
    if (!res.ok || !res.data || !res.data.fileID) {
      return showToast(res.error || '二维码生成失败')
    }

    let url = ''
    try {
      const app = await ensureCloudApp()
      const r = await app.getTempFileURL({
        fileList: [{ fileID: res.data.fileID, maxAge: 86400 }],
      })
      url = ((r && r.fileList) || []).map((f) => f && f.tempFileURL)[0] || ''
    } catch (e) {
      url = ''
    }
    if (!url) return showToast('二维码生成成功，但取临时链接失败，请重试')

    qrCache[inviteId] = url
    renderQrBox(box, url, row.dataset.name)
  }

  function renderQrBox(box, url, name) {
    box.classList.remove('hidden')
    box.innerHTML =
      '<img class="md-qr-img" src="' + escapeHtml(url) + '" alt="邀请二维码">' +
      '<div class="md-qr-ops">' +
      '<a class="btn btn-sec btn-sm" href="' + escapeHtml(url) + '" download="邀请码-' + escapeHtml(name) + '.png" target="_blank" rel="noopener">下载二维码</a>' +
      '<span class="qr-cap">发给她扫码，或复制下面的链接在微信里打开</span>' +
      '</div>'
  }

  function copyInviteLink(row) {
    const token = row.dataset.token
    if (!token) return showToast('该模特缺少邀请记录，请移除后重新邀请')
    const path = '/pages/client-select/index?t=' + token
    copyText(path)
    showToast('链接已复制，发给模特即可')
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      return
    }
    fallbackCopy(text)
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch (e) {
      ok = false // 浏览器不支持：走「请手动复制」降级，页面上另有可见文本
    }
    document.body.removeChild(ta)
    return ok
  }

  /** 复制并返回是否成功：失败时调用方降级为「选中文本 + 请手动复制」（11_INTERACTION_SPEC） */
  function tryCopyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => fallbackCopy(text))
    }
    return Promise.resolve(fallbackCopy(text))
  }

  async function doUnlock(projectId, row, btn) {
    const name = row.dataset.name
    const count = row.dataset.count || '0'
    if (!window.confirm(`${name} 将可以在已选的 ${count} 张基础上继续调整（可加可减）。确定吗？`)) return
    btn.disabled = true
    const res = await callCloud('selection', {
      action: 'resetLock',
      projectId,
      modelId: row.dataset.model,
    })
    btn.disabled = false
    if (!res.ok) return showToast(res.error || '解锁失败')
    showToast('已允许她重新选择')
    render()
  }

  async function doRemoveInvite(projectId, row, btn) {
    const inviteId = row.dataset.invite
    if (!inviteId) return showToast('该模特缺少邀请记录，无法移除')
    // 不可逆（连带删 model + 她的选片结果），用户 2026-10-05 拍板：必须二次确认
    const name = row.dataset.name || '该模特'
    const cnt = row.dataset.count || '0'
    if (
      !window.confirm(
        `移除后 ${name} 将无法再进入这个项目，她已选的 ${cnt} 张也会一并清除，无法恢复。确定移除吗？`
      )
    ) {
      return
    }
    btn.disabled = true
    const res = await callCloud('project', { action: 'removeInvite', inviteId })
    btn.disabled = false
    if (!res.ok) return showToast(res.error || '移除失败')
    delete qrCache[inviteId]
    showToast('已移除该模特')
    render()
  }

  /* ---------- 邀请模特弹窗 ---------- */

  let inviteProjectId = ''

  function openInviteModal(projectId) {
    inviteProjectId = projectId
    $('ivName').value = ''
    $('ivErr').textContent = ''
    $('ivSubmit').disabled = false
    $('ivSubmit').textContent = '生成邀请'
    $('inviteModal').classList.remove('hidden')
    $('ivName').focus()
  }

  function closeInviteModal() {
    $('inviteModal').classList.add('hidden')
  }

  async function submitInvite() {
    const name = $('ivName').value.trim()
    const errEl = $('ivErr')
    if (!name) {
      errEl.textContent = '请填写模特名字'
      return
    }
    const btn = $('ivSubmit')
    btn.disabled = true
    btn.textContent = '生成中…'
    errEl.textContent = ''

    const res = await callCloud('project', {
      action: 'createInvite',
      projectId: inviteProjectId,
      displayName: name,
    })
    btn.disabled = false
    btn.textContent = '生成邀请'
    if (!res.ok) {
      errEl.textContent = res.error || '邀请失败，请重试'
      return
    }
    closeInviteModal()
    showToast('已生成邀请，点「二维码」发给她')
    render()
  }

  /* ---------- 轻提示（11_INTERACTION_SPEC：2 秒自动消失） ---------- */

  let toastTimer = null

  function showToast(text) {
    const el = $('pdToast')
    if (!el) return
    el.textContent = text
    el.classList.add('on')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('on'), 2000)
  }

  /* ---------- 选片结果页（P-W4 / T-P1-7） ---------- */

  /**
   * 结果页状态。
   * data = getProjectResults 返回（含全部模特的 filenames，服务端已按文件名升序）
   * tab = 'all'（全部合并）| modelId
   * thumbs[tab] = [{ filename, thumbUrl, modelName }]，按需加载并缓存
   */
  const resultState = { projectId: '', data: null, tab: 'all', thumbs: {}, invites: [] }

  async function renderResult(id) {
    const main = $('consoleMain')
    main.innerHTML =
      '<div class="page"><div class="sk" style="width:220px;height:22px;margin-bottom:16px"></div>' +
      '<div class="sk" style="height:280px;border-radius:14px;background:#E2E1DC"></div></div>'

    const [pr, rs] = await Promise.all([
      callCloud('project', { action: 'get', _id: id }),
      callCloud('selection', { action: 'getProjectResults', projectId: id }),
    ])

    if (!rs.ok) {
      if (rs.code === 'ERR_NO_AUTH') {
        clearToken()
        go('#/login')
        return
      }
      main.innerHTML =
        '<div class="page"><div class="err-box">' +
        '<div class="ic">!</div><div class="t">加载失败</div>' +
        '<div class="d">' + escapeHtml(rs.error || '加载失败') + '</div>' +
        '<div style="display:flex;gap:8px;justify-content:center;margin-top:16px">' +
        '<button class="btn btn-sec btn-sm" id="rsRetry">重试</button>' +
        '<button class="btn btn-ghost btn-sm" data-nav="#/project/' + escapeHtml(id) + '">返回项目详情</button>' +
        '</div></div></div>'
      const retry = $('rsRetry')
      if (retry) retry.addEventListener('click', () => renderResult(id))
      return
    }

    resultState.projectId = id
    resultState.data = rs.data
    resultState.invites = (pr.ok && pr.data && pr.data.invites) || []
    resultState.thumbs = {}
    resultState.tab = 'all'
    paintResult()
    loadResultThumbs()
  }

  /** 当前 tab 的文件名（已升序）；'all' 为合并去重 */
  function currentRows() {
    const d = resultState.data
    if (!d) return []
    if (resultState.tab === 'all') {
      const map = {}
      d.models.forEach((m) => {
        ;(m.filenames || []).forEach((f) => {
          if (!map[f]) map[f] = { filename: f, modelName: m.displayName || '模特' }
          else if (map[f].modelName.indexOf(m.displayName) < 0) {
            map[f].modelName += '、' + (m.displayName || '模特')
          }
        })
      })
      return Object.keys(map).sort().map((k) => map[k])
    }
    const m = d.models.find((x) => x.modelId === resultState.tab)
    if (!m) return []
    const nm = m.displayName || '模特'
    return (m.filenames || []).map((f) => ({ filename: f, modelName: nm }))
  }

  function currentModel() {
    if (resultState.tab === 'all') return null
    return (resultState.data.models || []).find((m) => m.modelId === resultState.tab) || null
  }

  function fmtTime(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /** UI 2.0 SECTION 8：文件名清单（表格 + 复制 / 导出 + 复制结果预览） */
  function paintResult() {
    const d = resultState.data
    const main = $('consoleMain')
    const rows = currentRows()
    const m = currentModel()
    const pkg = Number(d.packageCount) || 0
    const over = pkg > 0 && rows.length > pkg
    const models = d.models || []
    const submitted = models.filter(function (x) {
      return x.locked
    }).length
    const thumbs = resultState.thumbs[resultState.tab]
    const thumbMap = {}
    ;(thumbs || []).forEach(function (it) {
      thumbMap[it.filename] = it
    })

    const chipsHtml =
      '<button class="chip' + (resultState.tab === 'all' ? ' on' : '') + '" data-rs="tab" data-tab="all">全部 <span class="n">' + countAll() + '</span></button>' +
      models
        .map(function (x) {
          return (
            '<button class="chip' + (resultState.tab === x.modelId ? ' on' : '') +
            '" data-rs="tab" data-tab="' + escapeHtml(x.modelId) + '">' +
            escapeHtml(x.displayName || '模特') + ' <span class="n">' + (x.selectedCount || 0) + '</span>' +
            (x.locked ? '' : ' ·') + '</button>'
          )
        })
        .join('')

    const headMeta = m
      ? m.locked
        ? '提交于 ' + fmtTime(m.submittedAt)
        : (m.selectedCount || 0) > 0
        ? '她正在选，当前已选 ' + m.selectedCount + ' 张（未提交）'
        : '她还没有开始选片'
      : '已确认 ' + submitted + ' / ' + models.length + ' 位模特'

    const tableRows = function () {
      if (!models.length) return ''
      if (!rows.length) return ''
      return rows
        .map(function (r, i) {
          const th = thumbMap[r.filename]
          const who = m ? m.displayName || '模特' : r.modelName
          // 单张的选中时间没有落库，列的是「提交时间」，不编造逐张时间
          const tm = m && m.locked ? fmtTime(m.submittedAt) : m ? '未提交' : '—'
          return (
            '<tr>' +
            '<td class="idx">' + (i + 1) + '</td>' +
            '<td class="fn">' + escapeHtml(r.filename) + '</td>' +
            '<td class="who">' + escapeHtml(who) + '</td>' +
            '<td class="tm">' + escapeHtml(tm) + '</td>' +
            '<td class="op">' +
            (th && th.photoId
              ? '<button class="btn btn-ghost btn-sm" data-rs="open" data-pid="' + escapeHtml(th.photoId) +
                '" data-fn="' + escapeHtml(r.filename) + '">大图</button>'
              : '<span class="pw-tip">' + (thumbs ? '无图' : '…') + '</span>') +
            '</td>' +
            '</tr>'
          )
        })
        .join('')
    }

    const emptyHtml = !models.length
      ? '<div class="vcard"><div class="empty"><div class="ic">◍</div>' +
        '<div class="t">还没有邀请模特</div>' +
        '<div class="d">回项目详情邀请后，她选完的照片会出现在这张清单里。</div>' +
        '<button class="btn btn-pri btn-sm" data-nav="#/project/' + escapeHtml(d.projectId) + '">去邀请模特</button>' +
        '</div></div>'
      : !rows.length
      ? '<div class="vcard"><div class="empty"><div class="ic">◍</div>' +
        '<div class="t">还没有选片结果</div>' +
        '<div class="d">' +
        escapeHtml(m ? (m.locked ? '她提交了 0 张' : '她还没有开始选片') : '还没有人开始选片') +
        '</div></div></div>'
      : ''

    const previewLines = rows.slice(0, 4).map((r) => escapeHtml(r.filename)).join('\n')

    main.innerHTML =
      '<div class="page" id="rsPanel">' +
      '<div class="result-head">' +
      '<div>' +
      '<div class="t">文件名清单</div>' +
      '<p class="page-sub" style="margin-top:4px">' + escapeHtml(d.projectName) + ' · ' +
      rows.length + ' 张 · ' + escapeHtml(headMeta) + '</p>' +
      '</div>' +
      '<div class="ops">' +
      '<button class="btn btn-ghost btn-sm" data-rs="refresh">刷新</button>' +
      (m ? '<button class="btn btn-sec btn-sm" data-rs="unlock">允许她重新选择</button>' : '') +
      '<button class="btn btn-sec" data-rs="copy"' + (rows.length ? '' : ' disabled') + '>复制全部</button>' +
      '<button class="btn btn-sec" data-rs="csv"' + (rows.length ? '' : ' disabled') + '>导出 CSV</button>' +
      '<button class="btn btn-pri" data-rs="txt"' + (rows.length ? '' : ' disabled') + '>导出 TXT</button>' +
      '</div>' +
      '</div>' +
      '<div class="chips" id="resultChips" style="margin-bottom:20px">' + chipsHtml + '</div>' +
      (pkg > 0
        ? '<p class="page-sub" style="margin-bottom:16px">套餐上限 ' + pkg + ' 张 · 当前 ' + rows.length + ' 张' +
          (over ? ' · <span style="color:var(--warn)">已超出 ' + (rows.length - pkg) + ' 张，需要和她确认</span>' : '') +
          '</p>'
        : '') +
      (!models.length || !rows.length
        ? emptyHtml
        : '<div class="vcard" style="overflow:hidden">' +
          '<table class="tbl"><thead><tr><th>#</th><th>文件名</th><th>选择人</th><th>时间</th><th></th></tr></thead>' +
          '<tbody id="resultBody">' + tableRows() + '</tbody></table>' +
          '</div>' +
          '<div class="preview-box">复制结果预览：\n' + previewLines +
          '\n…共 ' + rows.length + ' 行，可直接粘进 Lightroom 筛选栏</div>' +
          '<p style="font-size:12.5px;color:#8A897F;margin-top:16px;line-height:1.7">' +
          '复制全部：每行一个文件名，按文件名升序 · 导出 TXT：UTF-8 带 BOM，Excel 打开不乱码 · 导出 CSV：额外带「选择人」一列<br>' +
          '拿到清单后回到 Lightroom，用「按文件名筛选」定位对应 RAW 即可开始精修。' +
          '</p>') +
      '</div>'

    bindResultActions()
  }

  function countAll() {
    const set = {}
    ;(resultState.data.models || []).forEach((m) => {
      ;(m.filenames || []).forEach((f) => {
        set[f] = 1
      })
    })
    return Object.keys(set).length
  }

  /**
   * 缩略图接口回来后重画整页（表格里的「大图」要靠 photoId）。
   * 结果页不再铺缩略图墙（UI 2.0 改成表格），所以这里只需要把新数据刷进表格。
   */
  function paintGrid() {
    paintResult()
  }

  /**
   * 缩略图按需加载：getProjectResults 只有文件名（BR-805 零链接），
   * 要看图时再按 tab 调 getResult（≤5 次，结果页内缓存，切 tab 不重复取）
   */
  async function loadResultThumbs() {
    const d = resultState.data
    if (!d) return
    const tab = resultState.tab
    if (resultState.thumbs[tab]) return paintGrid()

    const targets =
      tab === 'all'
        ? (d.models || []).filter((m) => (m.selectedCount || 0) > 0)
        : (d.models || []).filter((m) => m.modelId === tab)
    if (!targets.length) {
      resultState.thumbs[tab] = []
      return paintGrid()
    }

    const res = await Promise.all(
      targets.map((m) =>
        callCloud('selection', {
          action: 'getResult',
          projectId: resultState.projectId,
          modelId: m.modelId,
        })
      )
    )

    const map = {}
    res.forEach(function (r, i) {
      if (!r.ok || !r.data) return
      const nm = targets[i].displayName || '模特'
      ;(r.data.photos || []).forEach(function (ph) {
        if (!map[ph.filename]) {
          map[ph.filename] = {
            filename: ph.filename,
            photoId: ph._id || '',
            thumbUrl: ph.thumbUrl,
            modelName: nm,
          }
        } else if (map[ph.filename].modelName.indexOf(nm) < 0) {
          map[ph.filename].modelName += '、' + nm
        }
      })
    })
    resultState.thumbs[tab] = Object.keys(map).sort().map((k) => map[k])
    paintGrid()
  }

  function bindResultActions() {
    const panel = $('rsPanel')
    if (!panel) return
    panel.addEventListener('click', async function (e) {
      const btn = e.target.closest('[data-rs]')
      if (!btn || btn.disabled) return
      const act = btn.dataset.rs
      if (act === 'tab') {
        resultState.tab = btn.dataset.tab
        paintResult()
        loadResultThumbs()
        return
      }
      // 「大图」：与照片墙共用查看器，← → 可在这一 tab 的照片里切换
      if (act === 'open') {
        if (btn.dataset.pid) {
          const list = (resultState.thumbs[resultState.tab] || []).map(function (it) {
            return { photoId: it.photoId, filename: it.filename }
          })
          openLightbox(resultState.projectId, btn.dataset.pid, btn.dataset.fn || '', false, list)
        }
        return
      }
      const rows = currentRows()
      if (act === 'copy') {
        const ok = await tryCopyText(rows.map((r) => r.filename).join('\n'))
        if (ok) return showToast('已复制 ' + rows.length + ' 个文件名')
        selectListText(rows.map((r) => r.filename).join('\n'))
        return showToast('复制失败，已帮你选中，请按 Ctrl+C 手动复制')
      }
      if (act === 'csv') return downloadCsv(rows)
      if (act === 'txt') return downloadTxt(rows)
      if (act === 'refresh') {
        resultState.thumbs = {}
        paintResult()
        return loadResultThumbs()
      }
      if (act === 'unlock') {
        const m = currentModel()
        if (!m) return
        if (
          !window.confirm(
            `${m.displayName || '她'} 将可以在已选的 ${m.selectedCount || 0} 张基础上继续调整（可加可减）。确定吗？`
          )
        ) {
          return
        }
        btn.disabled = true
        const r = await callCloud('selection', {
          action: 'resetLock',
          projectId: resultState.projectId,
          modelId: m.modelId,
        })
        btn.disabled = false
        if (!r.ok) return showToast(r.error || '解锁失败')
        showToast('已允许她重新选择')
        resultState.thumbs = {}
        await reloadResultData()
        return
      }
    })
  }

  async function reloadResultData() {
    const rs = await callCloud('selection', {
      action: 'getProjectResults',
      projectId: resultState.projectId,
    })
    if (!rs.ok) return showToast(rs.error || '刷新失败')
    resultState.data = rs.data
    paintResult()
    loadResultThumbs()
  }

  /**
   * 复制失败降级：临时塞一个 textarea 并把内容选中，提示手动复制
   * （不报错，11_INTERACTION_SPEC；表格版没有常驻的 <pre> 可依赖）
   */
  function selectListText(text) {
    const ta = document.createElement('textarea')
    ta.value = text || ''
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    const active = document.activeElement
    try {
      ta.setSelectionRange(0, ta.value.length)
    } catch (e) {
      // 少数浏览器不支持也没关系，已经 select() 过了
    }
    if (active && active.blur) active.blur()
    ta.focus()
    setTimeout(function () {
      document.body.removeChild(ta)
    }, 60000)
  }

  /** 导出 TXT：每行一个文件名，UTF-8 带 BOM（Excel 打开不乱码） */
  function downloadTxt(rows) {
    downloadBlob(
      '\ufeff' + rows.map((r) => r.filename).join('\r\n') + '\r\n',
      'text/plain;charset=utf-8',
      safeFileName(resultState.data.projectName + '-' + (currentModel() ? currentModel().displayName || '模特' : '全部') + '-选片清单.txt')
    )
    showToast('已导出 TXT（' + rows.length + ' 张）')
  }

  /** CSV：列 = 序号 / 文件名 / 模特备注名；**必须带 BOM**，否则 Excel 中文乱码 */
  function downloadCsv(rows) {
    const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"'
    const lines = ['序号,文件名,模特备注名']
    rows.forEach(function (r, i) {
      lines.push([i + 1, esc(r.filename), esc(r.modelName)].join(','))
    })
    downloadBlob(
      '\ufeff' + lines.join('\r\n'),
      'text/csv;charset=utf-8',
      safeFileName(
        resultState.data.projectName + '-' + (currentModel() ? currentModel().displayName || '模特' : '全部') + '-选片清单.csv'
      )
    )
    showToast('已导出 CSV（' + rows.length + ' 张）')
  }

  /** Windows / macOS 文件名非法字符 */
  function safeFileName(s) {
    return String(s || '选片清单').replace(/[\\/:*?"<>|\r\n]/g, '_')
  }

  /** 导出落盘的公共出口（BOM + Blob + 临时 <a>） */
  function downloadBlob(text, mime, filename) {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /* ---------- 工作台（UI 2.0 SECTION 3） ---------- */

  function greetText() {
    const h = new Date().getHours()
    return h < 6 ? '夜深了' : h < 12 ? '上午好' : h < 18 ? '下午好' : '晚上好'
  }

  /** 相对时间：今天给时分，昨天/更早给日期（不编造任何没有记录的操作） */
  function relTime(ts) {
    if (!ts) return ''
    const d = new Date(ts)
    const now = new Date()
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    const hm = p(d.getHours()) + ':' + p(d.getMinutes())
    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    if (sameDay(d, now)) return hm
    const y = new Date(now.getTime() - DAY)
    if (sameDay(d, y)) return '昨天'
    return p(d.getMonth() + 1) + '-' + p(d.getDate())
  }

  /** 动态只取项目真实存在的时间戳（创建 / 最近更新），按时间倒序取前 6 条 */
  function buildFeed(projects) {
    const items = []
    projects.forEach(function (p) {
      if (p.createdAt) {
        items.push({ t: p.createdAt, html: '项目「<b>' + escapeHtml(p.name) + '</b>」创建' })
      }
      if (p.updatedAt && p.updatedAt !== p.createdAt) {
        items.push({ t: p.updatedAt, html: '「<b>' + escapeHtml(p.name) + '</b>」有更新' })
      }
    })
    items.sort(function (a, b) {
      return b.t - a.t
    })
    return items.slice(0, 6)
  }

  /** 下一步建议：全部来自项目真实状态（待确认 / 没照片 / 快到期） */
  function buildTodos(projects) {
    const todos = []
    projects.forEach(function (p) {
      const days = p.expireAt ? (p.expireAt - Date.now()) / DAY : Infinity
      if (p.status === 'SELECTION_SUBMITTED') {
        todos.push({
          tone: 'badge-warn',
          tag: '待处理',
          text: '「' + escapeHtml(p.name) + '」已提交选片，去确认并导出文件名清单',
          href: '#/result/' + p._id,
        })
      } else if (!Number(p.photoCount)) {
        todos.push({
          tone: 'badge-info',
          tag: '可操作',
          text: '「' + escapeHtml(p.name) + '」还没有照片，先去上传',
          href: '#/project/' + p._id,
        })
      }
      if (days < 7 && p.status !== 'ARCHIVED') {
        const left = days === Infinity ? '' : (days > 0 ? '剩 ' + Math.ceil(days) + ' 天' : '已过期')
        todos.push({
          tone: 'badge-gray',
          tag: '提醒',
          text: '「' + escapeHtml(p.name) + '」' + (left || '临近到期') + '，记得续期',
          href: '#/project/' + p._id,
        })
      }
    })
    return todos.slice(0, 3)
  }

  async function renderDash() {
    const main = $('consoleMain')
    main.innerHTML = '<div class="page"><p class="greet-sub">加载中…</p></div>'

    let projects = []
    try {
      const res = await callCloud('project', { action: 'list' })
      if (res.ok && res.data && res.data.projects) projects = res.data.projects
      else if (res.code === 'ERR_NO_AUTH') {
        clearToken()
        go('#/login')
        return
      }
    } catch (e) {
      main.innerHTML =
        '<div class="page">' +
        errBoxHtml('加载失败', '网络异常，项目数据没能取回来', '重试', '') +
        '</div>'
      const btn = document.getElementById('dashRetry')
      if (btn) btn.onclick = renderDash
      return
    }

    if (!projects.length) {
      main.innerHTML =
        '<div class="page">' +
        '<div class="greet">' + greetText() + '，摄影师</div>' +
        '<p class="greet-sub">还没有项目。新建第一个项目后，就能在电脑上批量上传照片、邀请模特选片。</p>' +
        '<div style="margin-top:24px"><button class="btn btn-pri" id="dashCreate">＋ 新建项目</button></div>' +
        '</div>'
      const c = document.getElementById('dashCreate')
      if (c) c.onclick = openCreateModal
      return
    }

    const going = projects.filter(function (p) {
      return p.status !== 'ARCHIVED'
    }).length
    const pending = projects.filter(function (p) {
      return p.status === 'SELECTION_SUBMITTED'
    })
    const soon = projects.filter(function (p) {
      return p.expireAt && p.status !== 'ARCHIVED' && p.expireAt - Date.now() < 7 * DAY
    })
    const soonName = soon.length ? soon[0].name : ''
    const soonDays = soon.length
      ? soon[0].expireAt > Date.now()
        ? Math.ceil((soon[0].expireAt - Date.now()) / DAY)
        : 0
      : 0

    const feed = buildFeed(projects)
    const todos = buildTodos(projects)
    const recent = projects
      .slice()
      .sort(function (a, b) {
        return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
      })
      .slice(0, 4)

    main.innerHTML =
      '<div class="page">' +
      '<div class="greet">' + greetText() + '，摄影师</div>' +
      '<p class="greet-sub">共 ' + projects.length + ' 个项目 · ' +
      (pending.length ? pending.length + ' 个已提交选片等你确认' : going + ' 个进行中') +
      (soon.length ? ' · ' + soon.length + ' 个即将到期' : '') +
      '</p>' +
      '<div class="stats">' +
      '<div class="stat"><div><div class="stat-n">' + going + '</div>' +
      '<div class="stat-t">进行中的项目</div><div class="stat-hint">共 ' + projects.length + ' 个项目</div></div></div>' +
      '<div class="stat"><div><div class="stat-n">' + pending.length + '</div>' +
      '<div class="stat-t">待处理选片</div><div class="stat-hint">' +
      (pending.length ? escapeHtml(pending[0].name) + ' 已提交' : '暂时没有待确认的选片') +
      '</div></div></div>' +
      '<div class="stat"><div><div class="stat-n"' + (soon.length ? ' style="color:var(--warn)"' : '') + '>' +
      soon.length + '</div><div class="stat-t">即将到期</div><div class="stat-hint">' +
      (soon.length ? escapeHtml(soonName) + ' 剩 ' + soonDays + ' 天' : '没有即将到期的项目') +
      '</div></div></div>' +
      '</div>' +
      '<div class="sec-title"><h3>最近项目</h3>' +
      '<button class="more" data-nav="#/projects">查看全部 ' + projects.length + ' 个项目 →</button></div>' +
      '<div class="proj-row">' + recent.map(projectCardHtml).join('') + '</div>' +
      '<div class="sec-title" style="margin-top:40px"><h3>最近动态</h3></div>' +
      '<div class="two-col">' +
      '<div class="vcard panel-pad"><div class="feed">' +
      (feed.length
        ? feed
            .map(function (it) {
              return (
                '<div class="feed-item"><div class="feed-t">' + relTime(it.t) + '</div>' +
                '<div class="feed-c">' + it.html + '</div></div>'
              )
            })
            .join('')
        : '<p class="page-sub">还没有动态记录</p>') +
      '</div></div>' +
      '<div class="vcard panel-pad">' +
      '<h4 style="margin:0 0 12px;font-size:13px;font-weight:600">下一步建议</h4>' +
      (todos.length
        ? todos
            .map(function (t) {
              return (
                '<button data-nav="' + escapeHtml(t.href) + '" style="display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;padding:6px 0">' +
                '<span class="badge ' + t.tone + '" style="flex:0 0 auto"><span class="d"></span>' + t.tag + '</span>' +
                '<div style="font-size:13px;line-height:1.6">' + t.text + '</div></button>'
              )
            })
            .join('')
        : '<p class="page-sub">暂时没有待办，项目都在正常推进</p>') +
      '</div>' +
      '</div>' +
      '</div>'

    // 页面内的跳转按钮统一走 boot 里的 [data-nav] 全局委托
    fillProjCovers(recent)
  }

  /** 页面内的 [data-nav] 跳转按钮 */
  function bindNavButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-nav]'), function (el) {
      el.addEventListener('click', function () {
        go(el.getAttribute('data-nav'))
      })
    })
  }

  function errBoxHtml(title, desc, btnText) {
    return (
      '<div class="err-box"><div class="ic">!</div><div class="t">' + escapeHtml(title) + '</div>' +
      '<div class="d">' + escapeHtml(desc) + '</div>' +
      (btnText ? '<button class="btn btn-sec btn-sm" id="dashRetry">' + escapeHtml(btnText) + '</button>' : '') +
      '</div>'
    )
  }

  /* ---------- 项目列表页（P-W2 / T-P1-3） ---------- */

  const DAY = 86400000

  /** 状态标签唯一映射（42 文档：不许散落多处）。5 存储值 + 已过期/宽限中 派生态 */
  function statusMeta(p) {
    const now = Date.now()
    if (p.status === 'ARCHIVED') return { text: '已归档', tone: 'muted' }
    if (p.expireAt && p.expireAt < now) {
      return now < p.expireAt + 7 * DAY
        ? { text: '宽限中', tone: 'err' }
        : { text: '已过期', tone: 'err' }
    }
    const map = {
      DRAFT: { text: '待上传', tone: 'muted' },
      UPLOADING: { text: '上传中', tone: 'amber' },
      SELECTING: { text: '选片中', tone: 'amber' },
      SELECTION_SUBMITTED: { text: '已提交选片', tone: 'ok' },
    }
    return map[p.status] || { text: p.status || '未知', tone: 'muted' }
  }

  function fmtBytes(n) {
    const v = Number(n) || 0
    if (v < 1024) return v + ' B'
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB'
    return (v / 1073741824).toFixed(2) + ' GB'
  }

  function fmtRemain(p) {
    if (!p.expireAt) return '—'
    const diff = p.expireAt - Date.now()
    if (diff > 0) return '剩 ' + Math.ceil(diff / DAY) + ' 天'
    return '已过期 ' + Math.floor(-diff / DAY) + ' 天'
  }

  /** 模特进度摘要：模特名 + 各自进度（BR：模特名字由摄影师备注） */
  function fmtModels(p) {
    const list = p.models || []
    if (!list.length) return '还没邀请模特'
    return list
      .map((m) => {
        const name = m.name || '模特'
        const done = m.status === '已提交'
        return name + (done ? ' ✓' + (m.selectedCount || 0) + '张' : ' ' + (m.selectedCount || 0) + '张')
      })
      .join('，')
  }

  /** 项目 id → 稳定色相（封面色带用：同一个项目每次刷新颜色一致） */
  function hueOf(id) {
    let h = 0
    const s = String(id || '')
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
    return h
  }

  /** statusMeta 的 tone → UI 2.0 的 badge 类名（唯一映射，别再散落多处） */
  function badgeTone(t) {
    if (t === 'ok') return 'badge-ok'
    if (t === 'amber') return 'badge-warn'
    if (t === 'err') return 'badge-err'
    if (t === 'info') return 'badge-info'
    return 'badge-gray'
  }

  /** 模特行的小色点 CLI 用色 → UI 2.0 语义色 */
  function modelTone(status) {
    if (status === '已提交') return 'st-ok'
    if (status === '选片中') return 'st-ing'
    return 'st-wait'
  }

  /** 侧边栏「最近项目」的状态点颜色 */
  function toneOfStatus(p) {
    if (p.status === 'SELECTION_SUBMITTED') return 'ok'
    if (p.status === 'SELECTING' || p.status === 'UPLOADING') return 'warn'
    if (p.status === 'DRAFT') return 'info'
    return ''
  }

  /** A-3 → UI 2.0 SECTION 4：项目卡（真实照片封面 + 状态 + 剩余天数 + 模特进度 + 选片进度） */
  function projectCardHtml(p) {
    const st = statusMeta(p)
    const total = Number(p.photoCount) || 0
    const picked = (p.models || []).reduce(function (s, m) {
      return s + (Number(m.selectedCount) || 0)
    }, 0)
    const pct = total > 0 ? Math.min(100, Math.round((picked / total) * 100)) : 0
    const remain = fmtRemain(p)
    // E-4：剩 7 天内（含已过期）都算要止损的，卡片上直接给续期入口
    const daysToEnd = p.expireAt ? (p.expireAt - Date.now()) / DAY : Infinity
    const urgent = daysToEnd < 7 && p.status !== 'ARCHIVED'
    const models = (p.models || []).slice(0, 3)

    return (
      '<button class="pcard" data-proj="' + escapeHtml(p._id) + '">' +
      '<div class="pcover">' +
      // 三列错落封面：有 coverThumbs 时由 fillProjCovers 填真实缩略图，没有就留深色
      '<div class="grid3"><div class="col wide"></div><div class="col"></div><div class="col"></div></div>' +
      (total ? '<span class="cnt">' + total + ' 张</span>' : '') +
      (urgent
        ? '<span class="act"><span class="btn btn-sec btn-sm" data-extend="' + escapeHtml(p._id) + '">续期 30 天</span></span>'
        : '') +
      '</div>' +
      '<div class="pbody">' +
      '<div class="pname">' + escapeHtml(p.name) + '</div>' +
      '<div class="pmeta">' + escapeHtml(remain) + ' · ' + (p.packageCount > 0 ? '限 ' + p.packageCount + ' 张' : '不限张数') + '</div>' +
      '<div class="prow">' +
      '<span class="badge ' + badgeTone(st.tone) + '"><span class="d"></span>' + st.text + '</span>' +
      (urgent ? '<span class="badge badge-err"><span class="d"></span>即将到期</span>' : '') +
      '</div>' +
      (models.length
        ? '<div class="pmodels">' +
          models
            .map(function (m) {
              return (
                '<div class="pmline"><span class="nm">' + escapeHtml(m.name || '模特') + '</span>' +
                '<span class="st ' + modelTone(m.status) + '"><i></i>' + escapeHtml(m.status || '待选片') +
                ' ' + (m.selectedCount || 0) + '</span></div>'
              )
            })
            .join('') +
          '</div>'
        : '') +
      '<div class="pprog">' +
      '<div class="lbl"><span>选片进度</span><b>' + picked + ' / ' + total + '</b></div>' +
      '<div class="bar"><i' + (pct >= 100 ? ' class="ok"' : '') + ' style="width:' + pct + '%"></i></div>' +
      '</div>' +
      '</div>' +
      '</button>'
    )
  }

  /** E-4：卡片上的续期（doExtend 的错误提示挂在详情页元素上，列表页单走一支，用 toast 反馈） */
  async function extendFromCard(btn) {
    if (listState.busy) return
    listState.busy = true
    btn.style.opacity = '0.5'
    const res = await callCloud('project', { action: 'extend', _id: btn.dataset.extend })
    listState.busy = false
    btn.style.opacity = ''
    if (!res.ok) return showToast(res.error || '延期失败')
    showToast(
      res.data && res.data.needReupload
        ? '已延期 30 天；大图已清理，需重新上传照片'
        : '已延期 30 天'
    )
    renderProjects()
  }

  /** 卡片封面：有 coverThumbs 就换成真实缩略图，没有就留色带；取图失败不影响列表 */
  async function fillProjCovers(projects) {
    const want = {}
    let ids = []
    projects.forEach(function (p) {
      const t = (p.coverThumbs || []).slice(0, 3)
      if (t.length) {
        want[p._id] = t
        ids = ids.concat(t)
      }
    })
    if (!ids.length) return
    ids = Array.from(new Set(ids))

    const urlMap = {}
    try {
      const app = await ensureCloudApp()
      const r = await app.getTempFileURL({
        fileList: ids.map(function (id) {
          return { fileID: id, maxAge: 3600 }
        }),
      })
      ;((r && r.fileList) || []).forEach(function (f) {
        if (f && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
      })
    } catch (e) {
      return
    }

    projects.forEach(function (p) {
      const grid = document.querySelector('.pcard[data-proj="' + p._id + '"] .pcover .grid3')
      if (!grid) return
      const urls = (want[p._id] || [])
        .map(function (id) {
          return urlMap[id]
        })
        .filter(Boolean)
      if (!urls.length) return
      const cols = grid.children
      urls.forEach(function (u, i) {
        const img = document.createElement('img')
        img.src = u
        img.alt = ''
        cols[i % cols.length].appendChild(img)
      })
    })
  }

  /** 项目列表页的筛选 / 排序状态（UI 2.0 SECTION 4 工具栏） */
  const listState = { kw: '', filter: 'all', sort: 'updated', projects: [], busy: false }

  const FILTERS = [
    ['all', '全部', function (p) {
      return true
    }],
    ['going', '进行中', function (p) {
      return p.status === 'DRAFT' || p.status === 'UPLOADING' || p.status === 'SELECTING'
    }],
    ['pending', '待确认', function (p) {
      return p.status === 'SELECTION_SUBMITTED'
    }],
    ['archived', '已归档', function (p) {
      return p.status === 'ARCHIVED'
    }],
  ]

  function filterLabel(key) {
    return (FILTERS.filter(function (f) {
      return f[0] === key
    })[0] || FILTERS[0])[1]
  }

  function visibleProjects() {
    const kw = listState.kw.trim().toLowerCase()
    const fn = (FILTERS.filter(function (f) {
      return f[0] === listState.filter
    })[0] || FILTERS[0])[2]
    let list = listState.projects.filter(fn)
    if (kw) {
      list = list.filter(function (p) {
        return String(p.name || '').toLowerCase().indexOf(kw) >= 0
      })
    }
    const keyOf = function (p) {
      if (listState.sort === 'created') return p.createdAt || 0
      if (listState.sort === 'name') return String(p.name || '')
      return p.updatedAt || p.createdAt || 0
    }
    return list.sort(function (a, b) {
      const x = keyOf(a)
      const y = keyOf(b)
      if (typeof x === 'string') return x.localeCompare(y, 'zh-Hans-CN')
      return y - x
    })
  }

  function paintProjGrid() {
    const box = $('projGrid')
    if (!box) return
    const list = visibleProjects()
    if (!list.length) {
      box.innerHTML =
        '<div class="vcard" style="grid-column:1/-1"><div class="empty">' +
        '<div class="ic">⌕</div><div class="t">没有符合条件的项目</div>' +
        '<div class="d">' +
        (listState.kw ? '换个关键词，或把筛选切回「全部」' : '这个筛选下还没有项目') +
        '</div></div></div>'
      return
    }
    box.innerHTML =
      list.map(projectCardHtml).join('') +
      '<button class="pcard-new" id="btnNewProjectCard">' +
      '<span class="plus">＋</span><span>新建项目</span></button>'

    Array.prototype.forEach.call(box.querySelectorAll('.pcard[data-proj]'), function (el) {
      el.addEventListener('click', function () {
        go('#/project/' + el.dataset.proj)
      })
    })
    Array.prototype.forEach.call(box.querySelectorAll('[data-extend]'), function (el) {
      el.addEventListener('click', function (e) {
        // 卡片整体是「进详情」，续期要单独生效，别冒泡上去
        e.stopPropagation()
        extendFromCard(el)
      })
    })
    const nc = $('btnNewProjectCard')
    if (nc) nc.addEventListener('click', openCreateModal)
    fillProjCovers(list)
  }

  function listChipsHtml() {
    return FILTERS.map(function (f) {
      const n = listState.projects.filter(f[2]).length
      return (
        '<button class="chip' + (listState.filter === f[0] ? ' on' : '') + '" data-flt="' + f[0] + '">' +
        f[1] + ' <span class="n">' + n + '</span></button>'
      )
    }).join('')
  }

  function failProjectsHtml(text) {
    return (
      '<div class="page">' +
      '<div class="vcard" style="padding:40px"><div class="err-box">' +
      '<div class="ic">!</div><div class="t">加载失败</div>' +
      '<div class="d">' + escapeHtml(text) + '</div>' +
      '<button class="btn btn-sec btn-sm" id="btnReloadList">重试</button>' +
      '</div></div></div>'
    )
  }

  async function renderProjects() {
    const main = $('consoleMain')
    main.innerHTML = '<div class="page"><p class="page-sub">加载中…</p></div>'

    let res
    try {
      res = await callCloud('project', { action: 'list' })
    } catch (e) {
      main.innerHTML = failProjectsHtml(e.message || '网络异常')
      $('btnReloadList').addEventListener('click', renderProjects)
      return
    }
    if (!res.ok) {
      // 鉴权失效统一踢回登录页（41_CODING_RULES 4.3）
      if (res.code === 'ERR_NO_AUTH') {
        clearToken()
        go('#/login')
        return
      }
      main.innerHTML = failProjectsHtml(res.error || '加载失败')
      $('btnReloadList').addEventListener('click', renderProjects)
      return
    }

    listState.projects = (res.data && res.data.projects) || []
    listState.busy = false
    const cnt = $('navProjCnt')
    if (cnt) cnt.textContent = listState.projects.length // 侧边栏「项目」后面的数量
    renderProjectsShell()
  }

  /** 骨架 + 工具栏（数据已在 listState.projects 里，切换筛选只重画网格，不重拉数据） */
  function renderProjectsShell() {
    const main = $('consoleMain')
    const projects = listState.projects

    if (!projects.length) {
      main.innerHTML =
        '<div class="page">' +
        '<div class="page-head"><div><h1 class="page-title">项目</h1>' +
        '<p class="page-sub">还没有项目</p></div></div>' +
        '<button class="pcard-new" id="btnEmptyCreate" style="width:100%">' +
        '<span class="plus">＋</span><span>新建项目</span>' +
        '<span class="d" style="font-size:12.5px;color:var(--muted)">创建第一个项目后就能在电脑上批量上传照片了</span>' +
        '</button>' +
        '</div>'
      $('btnEmptyCreate').addEventListener('click', openCreateModal)
      return
    }

    main.innerHTML =
      '<div class="page">' +
      '<div class="page-head">' +
      '<div><h1 class="page-title">项目</h1>' +
      '<p class="page-sub">共 ' + projects.length + ' 个项目 · ' +
      projects.filter(function (p) {
        return p.status === 'SELECTING'
      }).length +
      ' 个正在选片</p></div>' +
      '<div class="right"><button class="btn btn-pri" id="btnNewProject">＋ 新建项目</button></div>' +
      '</div>' +
      '<div class="toolbar">' +
      '<div class="field" style="width:260px">' +
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#8A897F" stroke-width="1.5"><circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5L14 14"/></svg>' +
      '<input placeholder="搜索项目名称" id="projSearch" value="' + escapeHtml(listState.kw) + '">' +
      '</div>' +
      '<div class="chips" id="statusChips">' + listChipsHtml() + '</div>' +
      '<div class="grow"></div>' +
      '<select class="select" id="projSort">' +
      '<option value="updated"' + (listState.sort === 'updated' ? ' selected' : '') + '>最近更新</option>' +
      '<option value="created"' + (listState.sort === 'created' ? ' selected' : '') + '>创建时间</option>' +
      '<option value="name"' + (listState.sort === 'name' ? ' selected' : '') + '>名称</option>' +
      '</select>' +
      '</div>' +
      '<div class="grid-proj" id="projGrid"></div>' +
      '</div>'

    $('btnNewProject').addEventListener('click', openCreateModal)

    const search = $('projSearch')
    let timer = null
    search.addEventListener('input', function () {
      if (timer) clearTimeout(timer)
      timer = setTimeout(function () {
        listState.kw = search.value || ''
        paintProjGrid()
      }, 200)
    })

    $('statusChips').addEventListener('click', function (e) {
      const chip = e.target.closest('[data-flt]')
      if (!chip) return
      listState.filter = chip.dataset.flt
      $('statusChips').innerHTML = listChipsHtml()
      paintProjGrid()
    })

    $('projSort').addEventListener('change', function (e) {
      listState.sort = e.target.value
      paintProjGrid()
    })

    paintProjGrid()
  }

  /* ---------- 新建项目弹窗 ---------- */

  function openCreateModal() {
    $('npName').value = ''
    $('npCount').value = '0'
    $('npDays').value = '30'
    $('npErr').textContent = ''
    $('npSubmit').disabled = false
    $('npSubmit').textContent = '创建'
    $('createModal').classList.remove('hidden')
    $('npName').focus()
  }

  function closeCreateModal() {
    $('createModal').classList.add('hidden')
  }

  async function submitCreate() {
    const name = $('npName').value.trim()
    const errEl = $('npErr')
    if (!name) {
      errEl.textContent = '项目名称不能为空'
      return
    }
    if (name.length > 30) {
      errEl.textContent = '项目名称不能超过 30 个字'
      return
    }
    // 输入框范围已限制，这里再做一次数值收敛，与云函数口径一致（30 常量表）
    let packageCount = parseInt($('npCount').value, 10)
    if (isNaN(packageCount) || packageCount < 0) packageCount = 0
    if (packageCount > 999) packageCount = 999
    let expireDays = parseInt($('npDays').value, 10)
    if (isNaN(expireDays) || expireDays < 1) expireDays = 30
    if (expireDays > 365) expireDays = 365

    // project.create 非幂等（32 文档硬规则）：提交按钮置灰防连点，失败不自动重试
    const btn = $('npSubmit')
    btn.disabled = true
    btn.textContent = '创建中…'
    errEl.textContent = ''

    let res
    try {
      res = await callCloud('project', {
        action: 'create',
        name: name,
        packageCount: packageCount,
        expireDays: expireDays,
      })
    } catch (e) {
      btn.disabled = false
      btn.textContent = '创建'
      errEl.textContent = '网络异常：' + (e.message || '请重试')
      return
    }
    if (!res.ok) {
      btn.disabled = false
      btn.textContent = '创建'
      errEl.textContent = res.error || '创建失败，请重试'
      return
    }
    closeCreateModal()
    go('#/project/' + res.data._id)
  }

  function renderStub(title, desc) {
    $('consoleMain').innerHTML =
      '<div class="page"><h1 class="page-title">' + escapeHtml(title) + '</h1>' +
      '<p class="page-sub">' + escapeHtml(desc) + '</p>' +
      '<button class="btn btn-pri" style="margin-top:16px" data-nav="#/dash">回工作台</button></div>'
  }

  /* ---------- 登录页 ---------- */

  async function startLogin() {
    // 已有 token 先验：有效直接进控制台（42 文档：进入先调 verify）
    if (getToken()) {
      try {
        const v = await callCloud('session', { action: 'verify' })
        if (v.ok && v.data && v.data.isAdmin) {
          go('#/dash')
          return
        }
      } catch (e) {
        /* 网络异常时留在登录页，不误清 token */
        renderLoginError('网络异常，无法校验登录状态，请重试')
        return
      }
      // token 失效 → 清掉回到扫码
      clearToken()
    }
    await refreshQr()
  }

  async function refreshQr() {
    stopPolling()
    ticketInfo = null
    renderLoginState('loading', '正在生成二维码…')

    let res
    try {
      res = await callCloud('session', { action: 'createTicket', ua: navigator.userAgent })
    } catch (e) {
      renderLoginState('error', '二维码生成失败，请检查网络后重试')
      return
    }
    if (!res.ok || !res.data || !res.data.qrUrl) {
      renderLoginState('error', res.error || '二维码生成失败，请重试')
      return
    }

    ticketInfo = { ticket: res.data.ticket, expireAt: res.data.expireAt }
    renderLoginState('ready', '请用微信扫描二维码登录')
    $('qrImg').src = res.data.qrUrl

    pollTimer = setInterval(pollOnce, POLL_INTERVAL)
    pollOnce() // 立即先问一次，别白等 2 秒
  }

  async function pollOnce() {
    if (!ticketInfo) return

    // 本地 5 分钟兜底：即使 poll 没给 ERR_EXPIRED 也自动转过期
    if (Date.now() > ticketInfo.expireAt) {
      markExpired()
      return
    }

    let res
    try {
      res = await callCloud('session', { action: 'poll', ticket: ticketInfo.ticket })
      pollNetFails = 0
    } catch (e) {
      pollNetFails++
      renderLoginState('ready', '网络异常，正在重试（第 ' + pollNetFails + ' 次）…')
      if (pollNetFails >= NET_RETRY_MAX) markExpired()
      return
    }

    if (!res.ok) {
      // 票据失效 / 过期 / 被冒用：统一按过期处理（22_API 2.3）
      markExpired()
      return
    }

    if (res.data && res.data.status === 'ACTIVE' && res.data.token) {
      stopPolling()
      setToken(res.data.token)
      renderLoginState('ready', '登录成功，正在进入…', 'ok')
      setTimeout(() => go('#/dash'), 400)
    }
    // PENDING：继续等（扫码即确认，无中间态 —— 见 43 文档 C-9）
  }

  function markExpired() {
    stopPolling()
    ticketInfo = null
    renderLoginState('expired', '二维码已过期，请点击刷新')
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    pollNetFails = 0
  }

  /** 登录页四态渲染：loading / ready / expired / error（10_PAGE_SPEC P-W1） */
  function renderLoginState(state, text, tone) {
    const stateEl = $('loginState')

    stateEl.textContent = text
    stateEl.className = 'lg-state' + (tone === 'ok' ? ' ok' : state === 'expired' ? ' err' : '')

    $('qrLoading').classList.toggle('hidden', state !== 'loading')
    $('qrError').classList.toggle('hidden', state !== 'error')
    $('qrExpired').classList.toggle('hidden', state !== 'expired')
    $('qrImg').classList.toggle('hidden', state !== 'ready')
    $('qrHint').classList.toggle('hidden', state !== 'ready')
    if (state === 'error') $('qrErrorText').textContent = text
  }

  function renderLoginError(text) {
    renderLoginState('error', text)
  }

  /* ---------- 登出 ---------- */

  async function logoutAction() {
    // 11_INTERACTION_SPEC：退出登录是唯一要确认的操作
    if (!window.confirm('退出后需要重新扫码登录。确定吗？')) return
    try {
      await callCloud('session', { action: 'logout' })
    } catch (e) {
      /* 云端登出失败也照常清本地，本地 token 已无法使用 */
    }
    clearToken()
    go('#/login')
  }

  /* ---------- 工具 ---------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c])
  }

  /* ---------- 左右栏宽度拖拽（1/10 ~ 1/3 视口宽，localStorage 记忆） ---------- */

  const RZ_KEY_MIN = 0.1
  const RZ_KEY_MAX = 1 / 3
  const rz = { active: null, sx: 0, sw: 0 }

  function safeGet(k) {
    try {
      return localStorage.getItem(k)
    } catch (e) {
      return ''
    }
  }

  function safeSet(k, v) {
    try {
      localStorage.setItem(k, v)
    } catch (e) {}
  }

  function rzClamp(w) {
    const lo = Math.round(window.innerWidth * RZ_KEY_MIN)
    const hi = Math.round(window.innerWidth * RZ_KEY_MAX)
    return Math.max(lo, Math.min(hi, w))
  }

  /**
   * dir：拖拽方向系数。侧栏把手在栏右侧（往右拖变宽）= +1；
   * 信息栏把手在栏左侧（往左拖变宽）= -1。
   */
  function rzMount(handle, target, key, dir) {
    if (!handle || !target) return
    handle.onmousedown = function (e) {
      e.preventDefault()
      rz.active = { target: target, key: key, dir: dir }
      rz.sx = e.clientX
      rz.sw = target.getBoundingClientRect().width
      handle.classList.add('dragging')
      document.body.classList.add('rz-dragging')
    }
  }

  if (document.addEventListener) {
    document.addEventListener('mousemove', function (e) {
      if (!rz.active) return
      const w = rzClamp(rz.sw + rz.active.dir * (e.clientX - rz.sx))
      rz.active.target.style.width = w + 'px'
      rz.active.target.style.flexBasis = w + 'px'
    })
    document.addEventListener('mouseup', function () {
      if (!rz.active) return
      const a = rz.active
      rz.active = null
      document.body.classList.remove('rz-dragging')
      const h = document.querySelector('.rz.dragging')
      if (h) h.classList.remove('dragging')
      safeSet(a.key, String(Math.round(a.target.getBoundingClientRect().width)))
    })
  }

  function applySideW() {
    const side = document.querySelector('.app > .side')
    if (!side) return
    // 窄屏折叠（≤900px 侧栏变 68px 图标栏）交给 CSS，清掉内联宽度
    if (window.innerWidth < 902) {
      side.style.width = ''
      side.style.flexBasis = ''
      return
    }
    const savedW = Number(safeGet('pw_side_w') || 0)
    if (savedW) {
      const w = rzClamp(savedW)
      side.style.width = w + 'px'
      side.style.flexBasis = w + 'px'
    }
  }

  /** 窗口缩放时把两栏宽度重新夹回 1/10 ~ 1/3 */
  function rzReclamp() {
    applySideW()
    const info = document.querySelector('.detail > .info')
    if (info && info.style.width) {
      const w = rzClamp(parseFloat(info.style.width) || 0)
      info.style.width = w + 'px'
      info.style.flexBasis = w + 'px'
    }
  }

  function initResizers() {
    const side = document.querySelector('.app > .side')
    if (side && !$('rzSide')) {
      const h = document.createElement('div')
      h.className = 'rz'
      h.id = 'rzSide'
      side.parentNode.insertBefore(h, side.nextSibling)
      rzMount(h, side, 'pw_side_w', 1)
    }
    applySideW()
    window.addEventListener('resize', rzReclamp)
  }

  /* ---------- 启动 ---------- */

  function boot() {
    $('btnRefreshQr').addEventListener('click', refreshQr)
    $('btnQrRetry').addEventListener('click', refreshQr)
    $('btnLogout').addEventListener('click', logoutAction)
    $('npCancel').addEventListener('click', closeCreateModal)
    $('npSubmit').addEventListener('click', submitCreate)
    $('createModal').addEventListener('click', function (e) {
      if (e.target === this) closeCreateModal() // 点遮罩关闭；创建中不响应（按钮已置灰）
    })
    $('ivCancel').addEventListener('click', closeInviteModal)
    $('ivSubmit').addEventListener('click', submitInvite)
    $('ivName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitInvite()
    })
    $('inviteModal').addEventListener('click', function (e) {
      if (e.target === this) closeInviteModal()
    })
    bindSideNav()
    initResizers()
    // [data-nav] 是页面内的跳转按钮（返回列表 / 去结果页 / 下一步建议等）：全局委托一次
    document.addEventListener('click', function (e) {
      const el = e.target.closest('[data-nav]')
      if (el) go(el.getAttribute('data-nav'))
    })
    const scrim = $('upScrim')
    if (scrim) scrim.addEventListener('click', minUploadDrawer)
    window.addEventListener('hashchange', render)
    render()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
