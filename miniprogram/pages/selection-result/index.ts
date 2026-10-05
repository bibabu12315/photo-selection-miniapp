import { getProject } from '../../services/project'
import { getResult, resetLock, ResultPhoto } from '../../services/selection'
import { listPhotos, getPreviewUrl, refreshThumbUrls, WallPhoto, WallModel } from '../../services/photo'
import { getCached, putBatch, cachedIds, drop } from '../../services/urlcache'
import { packageText, formatDate } from '../../utils/format'
import { Project } from '../../types'

/**
 * 摄影师端 · 选片结果 / 照片墙（与网页端同构，U-W1）
 *
 * 两种视图（默认照片墙，view=list 为文件名清单）：
 *   wall = 照片墙（数据源 photo.list）：两行导航（筛选 Tab + 模特 chips）+ 搜索 + 2 列瀑布流，
 *          点格子看大图（photo.previewUrl 服务端取链）
 *   list = 清单（数据源 selection.getResult）：某位模特的已选文件名，复制回 Lightroom
 */

const PAGE_SIZE = 18

/**
 * 瀑布流：小程序端不用 WXSS column-count（渲染器差异有风险），改为 JS 分列。
 * 页面左右各 24rpx 内边距 + 8rpx 列间距 → 单列宽 = (750 - 48 - 8) / 2 = 347rpx
 */
const COL_W = 347
const COL_GAP = 8
const CELL_MIN_H = 220
const CELL_MAX_H = 700

interface ModelTab {
  modelId: string
  name: string
  label: string
  active: boolean
}

Page({
  data: {
    id: '',
    loading: true,
    loadError: '',
    pkg: '',
    tabs: [] as ModelTab[],
    currentModelId: '',
    currentName: '',
    locked: false,
    selectedCount: 0,
    submittedText: '',
    photos: [] as ResultPhoto[],
    view: 'wall' as 'wall' | 'list',
    resetting: false,

    /** 照片墙：filter 三档 + 模特 chips + 搜索 + 分页 + 瀑布流两列 */
    filter: 'all' as 'all' | 'selected' | 'unselected',
    wallModels: [] as WallModel[],
    wallModelId: '',
    kw: '',
    wallPhotos: [] as (WallPhoto & { selectedNames: string })[],
    colA: [] as any[],
    colB: [] as any[],
    hasMore: false,
    loadingMore: false,
    wallError: false,
    wallTotal: 0,
    previewing: false,
  },

  /** modelId → 模特名，给「这张被谁选中」用 */
  nameMap: {} as Record<string, string>,
  /** 格子高度缓存：同一张照片重复布局不重算，翻页时已有格子不抖动 */
  hMap: {} as Record<string, number>,
  /** 搜索防抖句柄 */
  searchTimer: 0 as any,
  /** 缩略图已自动重取过的 photoId（换过链接还失败 → 转手动重试） */
  imgTried: {} as Record<string, boolean>,
  /** 正在重取链接的 photoId，避免同一张并发请求 */
  imgPending: {} as Record<string, boolean>,

  onLoad(this: any, query: Record<string, string>) {
    // E-8：视图偏好记忆。入口显式带 view= 就用它并记下来；没带就读上次的选择
    const q = (query && query.view) || ''
    let view = q === 'list' || q === 'wall' ? q : ''
    if (!view) {
      try {
        view = (wx as any).getStorageSync('ps_result_view') || ''
      } catch (e) {
        view = ''
      }
      if (view !== 'list' && view !== 'wall') view = 'wall'
    }
    this.setData({ id: query.id || '', view })
    this.saveView(view)
  },

  /** 记住这次选的是照片墙还是清单，下次进同一页直接落在同一个视图 */
  saveView(this: any, view: string) {
    try {
      ;(wx as any).setStorageSync('ps_result_view', view)
    } catch (e) {
      // 存不下就退化为每次默认照片墙，不影响使用
    }
  },

  onShow(this: any) {
    if (this.data.id) this.loadProject()
  },

  async loadProject(this: any) {
    this.setData({ loading: true, loadError: '' })
    const res = await getProject(this.data.id)
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      this.setData({ loadError: res.error || '加载失败' })
      return
    }
    const p: Project = res.data.project
    const models = p.models || []
    const first = models[0]

    // 照片墙「这张被谁选中」要用 modelId → 名字 的映射
    this.nameMap = {}
    models.forEach((m) => {
      this.nameMap[m.modelId] = m.name
    })

    this.setData({
      pkg: packageText(p.packageCount),
      tabs: models.map((m, i) => ({
        modelId: m.modelId,
        name: m.name,
        label: `${m.name} ${m.selectedCount} 张`,
        active: i === 0,
      })),
      currentModelId: first ? first.modelId : '',
    })

    // 清单视图要的数据；照片墙第一次切换时才拉（switchView / onShow 已覆盖）
    if (first) await this.loadResult(first.modelId)
    if (this.data.view === 'wall' && this.data.wallPhotos.length === 0) this.loadWall()
  },

  async loadResult(this: any, modelId: string) {
    this.setData({ loading: true, loadError: '' })
    const res = await getResult(this.data.id, modelId)
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      this.setData({ loadError: res.error || '加载失败' })
      return
    }
    const name = (this.data.tabs.find((t: ModelTab) => t.modelId === modelId) || {} as ModelTab).name
    this.setData({
      locked: res.data.locked,
      selectedCount: res.data.selectedCount,
      submittedText: res.data.submittedAt ? formatDate(res.data.submittedAt) + ' 提交' : '',
      photos: res.data.photos,
      currentName: name || '',
      currentModelId: modelId,
    })
  },

  /** 错误态重试：模特列表已加载出来时只重试当前模特，否则整页重来 */
  retryLoad(this: any) {
    this.setData({ loadError: '' })
    if (this.data.tabs.length > 0 && this.data.currentModelId) {
      this.loadResult(this.data.currentModelId)
    } else {
      this.loadProject()
    }
  },

  async switchModel(this: any, e: any) {
    const modelId = e.currentTarget.dataset.id as string
    if (!modelId || modelId === this.data.currentModelId) return
    const tabs = this.data.tabs.map((t: ModelTab) =>
      Object.assign({}, t, { active: t.modelId === modelId })
    )
    this.setData({ tabs })
    await this.loadResult(modelId)
    // 照片墙「已选」档是按当前模特筛的，换人必须重新拉
    if (this.data.view === 'wall') {
      this.setData({ wallModelId: modelId })
      this.resetWall()
      this.loadWall()
    }
  },

  /** E-3：照片墙空态的下一步——回项目详情（那里有「去电脑上传」的引导） */
  goDetail(this: any) {
    if (!this.data.id) return
    ;(wx as any).navigateTo({ url: `/pages/project-detail/index?id=${this.data.id}` })
  },

  /** wall ↔ list 切换；第一次进照片墙才拉数据 */
  switchView(this: any) {
    const view = this.data.view === 'wall' ? 'list' : 'wall'
    this.setData({ view })
    this.saveView(view)
    if (view === 'wall' && this.data.wallPhotos.length === 0) this.loadWall()
  },

  /* ---------- 照片墙（数据源 photo.list） ---------- */

  resetWall(this: any) {
    this.setData({
      wallPhotos: [],
      colA: [],
      colB: [],
      hasMore: false,
      wallError: false,
      wallTotal: 0,
    })
  },

  switchFilter(this: any, e: any) {
    const f = e.currentTarget.dataset.f as string
    if (!f || f === this.data.filter) return
    // 换档位清空模特筛选（与网页端一致：chips 只在「已选」下出现）
    this.setData({ filter: f, wallModelId: '' })
    this.resetWall()
    this.loadWall()
  },

  /** 「已选」档下的模特 chips（数据来自 photo.list 的 models，不额外发请求） */
  pickModel(this: any, e: any) {
    const m = (e.currentTarget.dataset.m || '') as string
    if (m === this.data.wallModelId) return
    this.setData({ wallModelId: m })
    this.resetWall()
    this.loadWall()
  },

  /** 搜文件名：只过滤已加载进端的照片（与网页端口径一致），防抖 300ms 重排 */
  onSearchInput(this: any, e: any) {
    const kw = (e.detail && e.detail.value) || ''
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.setData({ kw })
      this.layout()
    }, 300)
  },

  clearSearch(this: any) {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.setData({ kw: '' })
    this.layout()
  },

  /** 重试入口单独一层：bindtap 会把 event 当第一个参数传进来 */
  retryWall(this: any) {
    this.loadWall()
  },

  async loadWall(this: any, auto = 0) {
    if (this.data.loadingMore) return
    this.setData({ loadingMore: true, wallError: false })
    const res = await listPhotos({
      projectId: this.data.id,
      skip: this.data.wallPhotos.length,
      limit: PAGE_SIZE,
      filter: this.data.filter,
      // modelId 只在「已选」档生效：看这位模特选了哪些（55 文档 1.2）
      modelId: this.data.filter === 'selected' ? this.data.wallModelId : '',
      have: cachedIds(this.data.id, 'thumb'),
    })
    if (!res.ok || !res.data) {
      this.setData({ loadingMore: false, wallError: true })
      return
    }

    const raw = res.data.photos || []
    // IDE 降级编译会把展开运算符转成 @babel/runtime helper，项目无 node_modules → 页面白屏，故一律 Object.assign / concat
    const incoming = raw.map((p) =>
      Object.assign({}, p, {
        thumbUrl: p.thumbUrl || getCached(this.data.id, 'thumb', p._id),
        // 「这张被谁选中」：把 modelId 换成模特名，摄影师一眼看出多人选中的是哪张
        selectedNames: (p.selectedBy || [])
          .map((id) => this.nameMap[id] || '')
          .filter(Boolean)
          .join('、'),
      })
    )
    putBatch(
      this.data.id,
      'thumb',
      raw.filter((p) => !p.cached && p.thumbUrl).map((p) => ({ photoId: p._id, url: p.thumbUrl }))
    )

    this.setData({
      loadingMore: false,
      wallPhotos: this.data.wallPhotos.concat(incoming),
      hasMore: !!res.data.hasMore,
      wallTotal: res.data.total || 0,
      // 模特 chips 随每页带回来，覆盖即可（同一项目数据不变）
      wallModels: res.data.models || [],
    })
    this.layout()

    // 「未选」是服务端取页后过滤，可能整页都不合格但还有下一页 → 自动续拉（上限 5 次防死循环）
    if (res.data.hasMore && incoming.length === 0 && auto < 5) {
      return this.loadWall(auto + 1)
    }
  },

  /** 瀑布流分列：每张投放到当前较矮的一列，高度按原始宽高比算；搜索词先过滤再分列 */
  layout(this: any) {
    const kw = String(this.data.kw || '').trim().toLowerCase()
    const list = kw
      ? this.data.wallPhotos.filter(
          (p: any) => String(p.filename || '').toLowerCase().indexOf(kw) >= 0
        )
      : this.data.wallPhotos

    const a: any[] = []
    const b: any[] = []
    let ha = 0
    let hb = 0
    list.forEach((p: any) => {
      let h = this.hMap[p._id]
      if (!h) {
        const w = Number(p.width) || 0
        const ht = Number(p.height) || 0
        h = Math.round(COL_W * (w > 0 && ht > 0 ? ht / w : 1.5))
        if (h < CELL_MIN_H) h = CELL_MIN_H
        if (h > CELL_MAX_H) h = CELL_MAX_H
        this.hMap[p._id] = h
      }
      const cell = Object.assign({}, p, { h })
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
   * 缩略图加载失败（云端临时链接只有约 10 分钟有效期，慢慢滚必然有链接过期）：
   * 第一次自动丢缓存换一条新链接重试；还失败才挂「点此重试」交给用户点。
   */
  async onImgError(this: any, e: any) {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) as string
    if (!id) return
    // 自动重试每张只做一次，避免坏链接反复打服务端
    if (this.imgTried[id]) {
      this.patchWallPhoto(id, { failed: true })
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

  /** 丢掉本地缓存 → 服务端重取一条缩略图链接 → 回填格子（src 变了图片会自己重新加载） */
  async refreshThumb(this: any, id: string) {
    if (!id || this.imgPending[id]) return
    this.imgPending[id] = true
    drop(this.data.id, 'thumb', id)
    const res = await refreshThumbUrls(this.data.id, [id])
    delete this.imgPending[id]
    const list = (res.ok && res.data && res.data.list) || []
    const hit = list.filter((x: any) => x.photoId === id)[0]
    if (!hit || !hit.thumbUrl) {
      this.patchWallPhoto(id, { failed: true })
      return
    }
    this.patchWallPhoto(id, { thumbUrl: hit.thumbUrl, failed: false })
  },

  /** 只改一张照片的字段再重排瀑布流，不重拉整页 */
  patchWallPhoto(this: any, id: string, patch: Record<string, any>) {
    const list = this.data.wallPhotos.map((p: any) =>
      p._id === id ? Object.assign({}, p, patch) : p
    )
    this.setData({ wallPhotos: list })
    this.layout()
  },

  onReachBottom(this: any) {
    if (this.data.view !== 'wall') return
    if (!this.data.hasMore || this.data.loadingMore || this.data.wallError) return
    this.loadWall()
  },

  /** 点格子看大图：服务端取临时链接后交给系统图片查看器 */
  async onCellTap(this: any, e: any) {
    const id = e.currentTarget.dataset.id as string
    if (!id || this.data.previewing) return
    this.setData({ previewing: true })
    const res = await getPreviewUrl(this.data.id, id)
    this.setData({ previewing: false })
    if (!res.ok || !res.data || !res.data.previewUrl) {
      ;(wx as any).showToast({ title: res.error || '大图加载失败', icon: 'none' })
      return
    }
    ;(wx as any).previewImage({ urls: [res.data.previewUrl] })
  },

  /** 清单视图：点行内缩略图看大图（与照片墙 onCellTap 同一条取链路径） */
  async onRowTap(this: any, e: any) {
    const id = e.currentTarget.dataset.id as string
    if (!id || this.data.previewing) return
    this.setData({ previewing: true })
    const res = await getPreviewUrl(this.data.id, id)
    this.setData({ previewing: false })
    if (!res.ok || !res.data || !res.data.previewUrl) {
      ;(wx as any).showToast({ title: res.error || '大图加载失败', icon: 'none' })
      return
    }
    ;(wx as any).previewImage({ urls: [res.data.previewUrl] })
  },

  /* ---------- 清单视图（数据源 selection.getResult，核心交付物） ---------- */

  copyAll(this: any) {
    const names = this.data.photos.map((p) => p.filename).join('\n')
    if (!names) {
      ;(wx as any).showToast({ title: '这位模特还没有选片', icon: 'none' })
      return
    }
    ;(wx as any).setClipboardData({
      data: names,
      success: () => {
        ;(wx as any).showToast({ title: `已复制 ${this.data.photos.length} 个文件名`, icon: 'none' })
      },
    })
  },

  /** 重新开放某位模特的选片 */
  reopen(this: any) {
    if (!this.data.currentModelId) return
    ;(wx as any).showModal({
      title: `重新开放「${this.data.currentName}」的选片？`,
      // R-2：后端保留原选择，文案必须同义——「可加可减」，不能说清空
      content: '她将可以在已选的基础上继续调整（可加可减），微信身份保留，不需要重新发链接。',
      confirmText: '确认开放',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ resetting: true })
        const res = await resetLock(this.data.id, this.data.currentModelId)
        this.setData({ resetting: false })
        if (!res.ok) {
          ;(wx as any).showModal({ title: '操作失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: '已重新开放', icon: 'success' })
        await this.loadResult(this.data.currentModelId)
      },
    })
  },
})
