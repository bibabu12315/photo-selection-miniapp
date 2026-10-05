import { waitForSession } from '../../utils/auth'
import { myProjects, MyProjectItem } from '../../services/selection'
import { shootText, expireText, daysLeft, packageText } from '../../utils/format'

/**
 * 模特端 · 我的拍摄
 * 列出这位模特名下全部项目（拍几次就有几个），按拍摄时间倒序。
 * 身份由 openid 自动识别，模特无需登录、无需输入。
 */

interface ItemVM extends MyProjectItem {
  status: string
  statusClass: string
  shoot: string
  meta: string
  selectText: string
  locked: boolean
  /** 「剩 X 天」，≤7 天标橙（C-1 / E-4） */
  remainText: string
  remainClass: string
  /** 已选进度百分比，0 = 不展示进度条 */
  progress: number
}

Page({
  data: {
    loading: false,
    loadError: false,
    displayName: '',
    items: [] as ItemVM[],
  },

  async onShow(this: any) {
    let s = await waitForSession(3000)
    // 冷启动超时就主动重查一次身份，避免误跳引导页
    if (!s.ready && !s.isModel) {
      const app: any = getApp()
      if (app && app.fetchIdentity) await app.fetchIdentity()
      s = await waitForSession(4000)
    }
    if (!s.isModel) {
      ;(wx as any).redirectTo({ url: '/pages/guide/index' })
      return
    }
    await this.load()
  },

  async onPullDownRefresh(this: any) {
    await this.load()
    ;(wx as any).stopPullDownRefresh()
  },

  async load(this: any) {
    this.setData({ loading: true, loadError: false })
    const res = await myProjects()
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      this.setData({ loadError: true })
      return
    }

    const items: ItemVM[] = (res.data.items || []).map((it: MyProjectItem) => {
      let status = '待选片'
      let statusClass = ''
      if (it.expired) {
        status = '已过期'
        statusClass = 'red'
      } else if (it.locked) {
        status = '已提交'
        statusClass = 'green'
      } else if (it.selectedCount > 0) {
        status = '选片中'
        statusClass = 'amber'
      }

      const pkg = packageText(it.packageCount)
      // 剩余天数单独成一个 chip：≤7 天标橙提醒（到期照片真会没，属止损提示）
      const d = daysLeft(it.expireAt)
      const remainText = it.expired ? '已过期' : `剩 ${d} 天`
      const remainClass = it.expired ? 'red' : d >= 0 && d <= 7 ? 'amber' : ''

      // 进度：有套餐上限按上限算，否则按总张数算；都没有就不画进度条
      const base = it.packageCount > 0 ? it.packageCount : it.photoCount
      const progress = base > 0 ? Math.min(100, Math.round((it.selectedCount / base) * 100)) : 0

      return Object.assign({}, it, {
        status,
        statusClass,
        shoot: shootText(it.shootDate),
        meta: `${it.photoCount} 张`,
        selectText: it.locked
          ? `已选 ${it.selectedCount} 张`
          : it.selectedCount > 0
          ? `已选 ${it.selectedCount} / ${pkg}`
          : '还没开始',
        remainText,
        remainClass,
        progress,
      })
    })

    this.setData({ items, displayName: res.data.displayName || '' })
  },

  openProject(this: any, e: any) {
    const item = this.data.items[Number(e.currentTarget.dataset.index)]
    if (!item) return
    if (item.expired) {
      ;(wx as any).showToast({ title: '项目已过期，请联系摄影师', icon: 'none' })
      return
    }
    ;(wx as any).navigateTo({
      url: `/pages/client-select/index?pid=${item.projectId}&mid=${item.modelId}`,
    })
  },

  /** E-3：空态的下一步——摄影师发来的链接可以在这里直接打开 */
  goGuide(this: any) {
    ;(wx as any).navigateTo({ url: '/pages/guide/index' })
  },
})
