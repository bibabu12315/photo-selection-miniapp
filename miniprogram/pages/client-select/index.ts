import {
  enterSelection,
  getPhotos,
  saveSelection,
  submitSelection,
  refreshThumbUrls,
  ClientPhoto,
  PhotoItem,
} from '../../services/selection'
import { getCached, putBatch, cachedIds, drop } from '../../services/urlcache'

/**
 * 模特端 · 选片
 * 两种入口：
 *   1) 邀请链接 / 小程序码：options.t 或 scene（首次认领身份）
 *   2) 从「我的拍摄」进入：options.pid + options.mid
 */
const PAGE_SIZE = 18
const SYNC_DELAY = 2000

/**
 * 瀑布流（C-2）：小程序端不用 WXSS column-count（渲染器差异有风险），改为 JS 分列。
 * 页面左右各 24rpx 内边距 + 8rpx 列间距 → 单列宽 = (750 - 48 - 8) / 2 = 347rpx
 */
const COL_W = 347
const COL_GAP = 8
/** 缺宽高的老数据按 3:2 兜底；极端比例裁到这个区间，避免超长条破坏版面 */
const CELL_MIN_H = 220
const CELL_MAX_H = 700

Page({
  data: {
    phase: 'loading' as 'loading' | 'ready' | 'locked' | 'error',
    errorMsg: '',
    projectName: '',
    displayName: '',
    photoCount: 0,
    /** 套餐上限，0 = 不限 */
    packageCount: 0,
    limitText: '',
    selectedCount: 0,
    submitting: false,
    /** 之前提交过一版，展示「可继续调整」提示 */
    resubmitHint: false,
    photos: [] as (ClientPhoto & { selected: boolean })[],
    hasMore: false,
    loadingMore: false,
    loadError: false,
    /** 项目已归档：缩略图还在，大图已清理 */
    archived: false,
    /** 一张照片都没有（摄影师还没上传），用于展示空态 */
    emptyPhotos: false,
    /** 自动保存失败：顶部挂提示条，成功时必须清掉 */
    unsaved: false,
    /** 瀑布流两列（每项带 idx = 在 photos 里的真实下标、h = 格子高度 rpx） */
    colA: [] as any[],
    colB: [] as any[],
    /** E-10：只看已选 Tab（all = 全部 / selected = 只看已选），本地过滤，不发请求 */
    tab: 'all' as 'all' | 'selected',
    /** E-5：首次进入的一次性操作引导蒙层，3 秒自动消失，只弹一次 */
    guide: false,
  },

  /** 格子高度缓存：同一张照片重复布局不重算，翻页时已有格子不会抖动 */
  hMap: {} as Record<string, number>,

  projectId: '',
  modelId: '',
  syncTimer: 0 as any,
  /** E-5 引导蒙层的自动关闭定时器 */
  guideTimer: 0 as any,
  dirty: false,
  /** 连续同步失败次数，用于指数退避，成功后清零 */
  retryCount: 0,
  /** 本批照片开始渲染的时间戳，用于判断 bindload 是不是缓存命中（F-22） */
  loadT0: 0,
  /** 缩略图已自动重取过的 photoId（换过链接还失败 → 转手动重试） */
  imgTried: {} as Record<string, boolean>,
  /** 正在重取链接的 photoId，避免同一张并发请求 */
  imgPending: {} as Record<string, boolean>,

  onLoad(this: any, options: Record<string, string>) {
    // 入口一：邀请链接 / 小程序码
    let token = options.t || ''
    if (!token && options.scene) token = decodeURIComponent(options.scene)

    // 入口二：我的拍摄
    const pid = options.pid || ''
    const mid = options.mid || ''

    if (!token && !(pid && mid)) {
      this.setData({ phase: 'error', errorMsg: '请通过摄影师分享的链接或二维码进入' })
      return
    }
    this.projectId = pid
    this.modelId = mid
    this.token = token
    this.init()
  },

  token: '',

  onUnload(this: any) {
    if (this.dirty) this.syncNow()
    if (this.syncTimer) clearTimeout(this.syncTimer)
    if (this.guideTimer) clearTimeout(this.guideTimer)
  },

  onHide(this: any) {
    if (this.dirty) this.syncNow()
  },

  async init(this: any) {
    const res = await enterSelection(this.token, this.projectId, this.modelId)
    if (!res.ok || !res.data) {
      this.setData({ phase: 'error', errorMsg: res.error || '进入项目失败' })
      return
    }
    const d = res.data
    this.projectId = d.projectId
    this.modelId = d.modelId
    this.token = ''

    // 已提交的模特再进入直接落到只读终态（BR-605）：不再加载照片，也无从改动
    if (d.locked) {
      this.setData({
        phase: 'locked',
        projectName: d.projectName,
        displayName: d.displayName,
        photoCount: d.photoCount,
        packageCount: d.packageCount,
        limitText: d.packageCount > 0 ? `${d.packageCount} 张` : '不限',
        selectedCount: (d.selectedIds || []).length,
      })
      return
    }

    this.setData({
      phase: 'ready',
      projectName: d.projectName,
      displayName: d.displayName,
      photoCount: d.photoCount,
      packageCount: d.packageCount,
      limitText: d.packageCount > 0 ? `${d.packageCount} 张` : '不限',
      selectedCount: (d.selectedIds || []).length,
    })

    const selected = new Set<string>(d.selectedIds || [])
    await this.loadMore(selected)
    this.setData({
      selectedCount: this.data.photos.filter((p: any) => p.selected).length,
    })
    // E-5：照片加载完再弹引导，避免盖在空态上
    this.maybeShowGuide()
  },

  async loadMore(this: any, presetSelected?: Set<string>) {
    if (this.data.loadingMore) return
    this.setData({ loadingMore: true, loadError: false })
    const skip = this.data.photos.length

    // 端上已有有效缓存的，告诉服务端别再生成链接
    const have = cachedIds(this.projectId, 'thumb')
    const res = await getPhotos(this.projectId, this.modelId, skip, PAGE_SIZE, have)
    if (!res.ok || !res.data) {
      this.setData({ loadingMore: false, loadError: true })
      return
    }

    const photos: PhotoItem[] = res.data.photos
    // IDE 降级编译会把展开运算符转成 @babel/runtime helper，项目无 node_modules → 页面白屏，故一律 Object.assign / concat
    const incoming = photos.map((p) =>
      Object.assign({}, p, {
        thumbUrl: p.thumbUrl || getCached(this.projectId, 'thumb', p._id),
        selected: presetSelected ? presetSelected.has(p._id) : false,
      })
    )
    putBatch(
      this.projectId,
      'thumb',
      photos.filter((p) => !p.cached && p.thumbUrl).map((p) => ({ photoId: p._id, url: p.thumbUrl }))
    )

    if (res.data.archived && !this.data.archived) {
      this.setData({ archived: true })
      ;(wx as any).showToast({
        title: '项目已归档，大图已清理；缩略图和已选记录仍可查看',
        icon: 'none',
        duration: 3000,
      })
    }

    this.loadT0 = Date.now()
    const all = this.data.photos.concat(incoming)
    this.setData({
      loadingMore: false,
      loadError: false,
      hasMore: res.data.hasMore,
      packageCount: res.data.packageCount || this.data.packageCount,
      photos: all,
      emptyPhotos: all.length === 0,
    })
    this.layout()
    // 有链接的张数打日志：端上排查「图加载没有」时一眼能分锅（用户可直接贴控制台）
    console.log(
      '[client-select] 本批',
      incoming.length,
      '张，拿到缩略图链接',
      incoming.filter((p: any) => !!p.thumbUrl).length,
      '张'
    )
    this.healMissing(incoming)
    this.forceLoaded()
  },

  /**
   * 兜底自愈：服务端跳过签发（它认为端上已有缓存）而端上又拿不到可用链接时，
   * 照片的 thumbUrl 是空串 → <image> 不发请求、不触发 load/error 事件，
   * 界面就是一片黑格子且毫无提示。这里一次性向服务端补签。
   */
  async healMissing(this: any, incoming: any[]) {
    const missing = incoming.filter((p: any) => !p.thumbUrl).map((p: any) => p._id)
    if (!missing.length) return
    // 这条缓存已经不可用了，先丢掉，否则下次还是跳过签发
    missing.forEach((id: string) => drop(this.projectId, 'thumb', id))
    const ids = missing.slice(0, 50)
    const res = await refreshThumbUrls(this.projectId, this.modelId, ids)
    const list = (res.ok && res.data && res.data.list) || []
    const got: Record<string, string> = {}
    list.forEach((it: any) => {
      if (it && it.photoId && it.thumbUrl) got[it.photoId] = it.thumbUrl
    })
    const patch: any = {}
    const cache: { photoId: string; url: string }[] = []
    let n = 0
    ids.forEach((id: string) => {
      const i = this.data.photos.findIndex((p: any) => p._id === id)
      if (i < 0) return
      if (got[id]) {
        patch['photos[' + i + '].thumbUrl'] = got[id]
        patch['photos[' + i + '].failed'] = false
        cache.push({ photoId: id, url: got[id] })
      } else {
        // 服务端也拿不到 → 明说，别留一格黑让用户猜
        patch['photos[' + i + '].failed'] = true
      }
      n += 1
    })
    if (cache.length) putBatch(this.projectId, 'thumb', cache)
    if (n) {
      this.setData(patch)
      this.layout()
      this.forceLoaded()
    }
  },

  /**
   * 淡入兜底：bindload 在某些机型 / 缓存命中的情况下不回调，导致图片其实已经到位，
   * 但 class 没写上、opacity 仍是 0（格子就是黑的）。1.5s 后无条件补齐标记：
   * 少一次淡入无所谓，黑格子不行。
   */
  forceLoaded(this: any) {
    setTimeout(() => {
      const patch: any = {}
      this.data.photos.forEach((p: any, i: number) => {
        if (p.loaded || !p.thumbUrl) return
        patch['photos[' + i + '].loaded'] = 'fast'
      })
      this.data.colA.forEach((x: any, i: number) => {
        if (x.loaded || !x.thumbUrl) return
        patch['colA[' + i + '].loaded'] = 'fast'
      })
      this.data.colB.forEach((x: any, i: number) => {
        if (x.loaded || !x.thumbUrl) return
        patch['colB[' + i + '].loaded'] = 'fast'
      })
      const keys = Object.keys(patch)
      if (!keys.length) return
      this.setData(patch)
    }, 1500)
  },

  /**
   * 瀑布流分列：维护两列累计高度，每张投放到当前较矮的一列（第 6 节统一规则）。
   * 高度 = 列宽 × 原图高 / 原图宽，所以横竖构图混排不留空位。
   */
  layout(this: any) {
    const photos = this.data.photos || []
    const onlySelected = this.data.tab === 'selected'
    const a: any[] = []
    const b: any[] = []
    let ha = 0
    let hb = 0
    photos.forEach((p: any, idx: number) => {
      // E-10：只看已选中——本地过滤。idx 仍是 photos 里的真实下标（大图页按它取数据）
      if (onlySelected && !p.selected) return
      let h = this.hMap[p._id]
      if (!h) {
        const w = Number(p.width) || 0
        const ht = Number(p.height) || 0
        h = Math.round(COL_W * (w > 0 && ht > 0 ? ht / w : 1.5))
        if (h < CELL_MIN_H) h = CELL_MIN_H
        if (h > CELL_MAX_H) h = CELL_MAX_H
        this.hMap[p._id] = h
      }
      const cell = Object.assign({}, p, { idx, h })
      if (ha <= hb) {
        a.push(cell)
        ha += h + COL_GAP
      } else {
        b.push(cell)
        hb += h + COL_GAP
      }
    })
    this.setData({ colA: a, colB: b })
  },

  /**
   * 缩略图加载完成 → 加 class 淡入（BR-507 / F-22）
   * 100ms 内就回来的是本地缓存命中，直接显示，避免淡入反而造成闪动
   */
  onThumbLoad(this: any, e: any) {
    const idx = Number(e.currentTarget.dataset.idx)
    const item = this.data.photos[idx]
    if (!item || item.loaded) return
    const cls = Date.now() - this.loadT0 < 100 ? 'fast' : 'anim'
    // 数据源与所在列都要更新：列里的对象是 photos 的拷贝
    // 动态 key 先建空对象再下标赋值：对象计算属性 { [k]: v } 会被降级编译成
    // @babel/runtime/helpers/toPropertyKey，本项目无 node_modules → 页面加载即白屏
    const patch: any = {}
    patch['photos[' + idx + '].loaded'] = cls
    const ia = this.data.colA.findIndex((x: any) => x.idx === idx)
    if (ia >= 0) patch['colA[' + ia + '].loaded'] = cls
    else {
      const ib = this.data.colB.findIndex((x: any) => x.idx === idx)
      if (ib >= 0) patch['colB[' + ib + '].loaded'] = cls
    }
    this.setData(patch)
  },

  /**
   * 缩略图加载失败（云端临时链接只有约 10 分钟有效期，慢慢滚必然有链接过期）：
   * 第一次自动丢缓存换一条新链接重试；还失败才挂「点此重试」交给模特点。
   */
  async onImgError(this: any, e: any) {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) as string
    if (!id) return
    if (this.imgTried[id]) {
      this.patchThumb(id, '', true)
      return
    }
    this.imgTried[id] = true
    await this.refreshThumb(id)
  },

  /** 手动重试：清掉失败标记，再走一次换链 */
  async retryImg(this: any, e: any) {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) as string
    if (!id) return
    this.imgTried[id] = false
    await this.refreshThumb(id)
  },

  /** 丢掉本地缓存 → 服务端重取一条缩略图链接 → 回填（src 变了图片会自己重新加载） */
  async refreshThumb(this: any, id: string) {
    if (!id || this.imgPending[id]) return
    this.imgPending[id] = true
    drop(this.projectId, 'thumb', id)
    const res = await refreshThumbUrls(this.projectId, this.modelId, [id])
    delete this.imgPending[id]
    const list = (res.ok && res.data && res.data.list) || []
    const hit = list.filter((x: any) => x.photoId === id)[0]
    if (!hit || !hit.thumbUrl) {
      this.patchThumb(id, '', true)
      return
    }
    this.patchThumb(id, hit.thumbUrl, false)
  },

  /** 只改一张照片的字段再重排瀑布流，不重拉整页 */
  patchThumb(this: any, id: string, url: string, failed: boolean) {
    const i = this.data.photos.findIndex((p: any) => p._id === id)
    if (i < 0) return
    const patch: any = {}
    patch['photos[' + i + '].failed'] = failed
    if (url) patch['photos[' + i + '].thumbUrl'] = url
    this.setData(patch)
    this.layout()
  },

  /** E-10：切 Tab（全部 / 只看已选）。纯本地过滤，不重新加载 */
  switchTab(this: any, e: any) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    // 在「已选」档下取消勾选会把这张从视图里抽走，容易让人以为丢了 → 切时回「全部」更稳
    this.setData({ tab })
    this.layout()
  },

  /**
   * E-5：首次进选片页弹一次 3 秒引导（模特多为非专业用户，别指望她自己摸索）。
   * 只弹一次，看过就写 storage；3 秒自动消失，也可以点一下立刻关掉。
   */
  maybeShowGuide(this: any) {
    let seen = ''
    try {
      seen = (wx as any).getStorageSync('ps_guide_sel') || ''
    } catch (e) {
      seen = ''
    }
    if (seen) return
    this.setData({ guide: true })
    if (this.guideTimer) clearTimeout(this.guideTimer)
    this.guideTimer = setTimeout(() => this.closeGuide(), 3000)
  },

  closeGuide(this: any) {
    if (this.guideTimer) {
      clearTimeout(this.guideTimer)
      this.guideTimer = 0
    }
    if (!this.data.guide) return
    this.setData({ guide: false })
    try {
      ;(wx as any).setStorageSync('ps_guide_sel', '1')
    } catch (e) {
      // 存不下就下次再弹一次，不影响选片
    }
  },

  retryInit(this: any) {
    this.setData({ phase: 'loading', errorMsg: '' })
    this.init()
  },

  retryLoad(this: any) {
    this.loadMore()
  },

  onReachBottom(this: any) {
    if (this.data.phase !== 'ready') return
    if (this.data.loadError) return
    this.loadMore()
  },

  /** 全选本页（受套餐上限约束） */
  selectAllPage(this: any) {
    if (this.data.phase !== 'ready') return
    const limit = this.data.packageCount
    let room = limit > 0 ? limit - this.data.selectedCount : this.data.photos.length
    if (limit > 0 && room <= 0) {
      ;(wx as any).showToast({ title: `已达 ${limit} 张上限`, icon: 'none' })
      return
    }
    const photos = this.data.photos.map((p) => {
      if (p.selected || room <= 0) return p
      room -= 1
      return Object.assign({}, p, { selected: true })
    })
    this.dirty = true
    this.setData({ photos, selectedCount: photos.filter((p) => p.selected).length })
    this.layout()
    this.scheduleSync()
  },

  /** 点选 / 取消 */
  toggle(this: any, e: any) {
    if (this.data.phase !== 'ready') return
    const id = e.currentTarget.dataset.id as string
    const target = this.data.photos.find((p) => p._id === id)
    const limit = this.data.packageCount

    if (target && !target.selected && limit > 0 && this.data.selectedCount >= limit) {
      ;(wx as any).showToast({ title: `最多选 ${limit} 张，先取消一张`, icon: 'none' })
      return
    }

    const photos = this.data.photos.map((p) =>
      p._id === id ? Object.assign({}, p, { selected: !p.selected }) : p
    )
    this.dirty = true
    this.setData({ photos, selectedCount: photos.filter((p) => p.selected).length })
    this.layout()
    this.scheduleSync()
  },

  scheduleSync(this: any) {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => this.syncNow(), SYNC_DELAY)
  },

  async syncNow(this: any) {
    this.dirty = false
    if (this.syncTimer) {
      clearTimeout(this.syncTimer)
      this.syncTimer = 0
    }
    const ids = this.data.photos.filter((p) => p.selected).map((p) => p._id)
    const res = await saveSelection(this.projectId, this.modelId, ids)
    if (!res.ok) {
      this.dirty = true
      this.retryCount += 1
      // BR-503：失败才提示，且只挂提示条不打扰选片
      this.setData({ unsaved: true })
      // 指数退避 1s → 2s，最多补 2 次；还失败就保持「未保存」等你操作（32 第四节）
      if (this.retryCount <= 2) {
        this.syncTimer = setTimeout(() => this.syncNow(), 1000 * this.retryCount)
      }
      return
    }
    this.retryCount = 0
    this.setData({ unsaved: false })
  },

  openViewer(this: any, e: any) {
    const index = Number(e.currentTarget.dataset.idx)
    wx.navigateTo({
      url: '/pages/photo-viewer/index?index=' + index,
      events: {
        selectionChanged: (payload: any) => {
          const photos = this.data.photos.map((p) =>
            p._id === payload.id ? Object.assign({}, p, { selected: payload.selected }) : p
          )
          this.dirty = true
          this.setData({ photos, selectedCount: photos.filter((p) => p.selected).length })
          this.layout()
          this.scheduleSync()
        },
      },
      success: (res) => {
        res.eventChannel.emit('init', {
          projectId: this.projectId,
          modelId: this.modelId,
          index,
          photos: this.data.photos,
          locked: this.data.phase !== 'ready',
        })
      },
    })
  },

  async submit(this: any) {
    if (this.data.submitting) return
    const n = this.data.selectedCount
    const limit = this.data.packageCount
    if (n <= 0) {
      ;(wx as any).showToast({ title: '还没有选择照片', icon: 'none' })
      return
    }
    if (limit > 0 && n > limit) {
      ;(wx as any).showToast({ title: `最多只能选 ${limit} 张`, icon: 'none' })
      return
    }
    ;(wx as any).showModal({
      title: `确认提交这 ${n} 张？`,
      content: '提交后你的选择将锁定，不能再自行修改；如需调整请联系摄影师解锁。',
      cancelText: '再看看',
      confirmText: '确认提交',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ submitting: true })
        if (this.dirty) await this.syncNow()
        const ids = this.data.photos.filter((p) => p.selected).map((p) => p._id)
        const res = await submitSelection(this.projectId, this.modelId, ids)
        if (!res.ok) {
          this.setData({ submitting: false })
          ;(wx as any).showModal({ title: '提交失败', content: res.error || '', showCancel: false })
          return
        }
        this.setData({
          submitting: false,
          phase: 'locked',
          resubmitHint: true,
          selectedCount: res.data!.selectedCount,
        })
      },
    })
  },

})
