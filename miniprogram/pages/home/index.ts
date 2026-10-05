import { waitForSession } from '../../utils/auth'
import { listProjects, extendProject } from '../../services/project'
import { expireText, packageText, shootText, daysLeft } from '../../utils/format'
import { Project } from '../../types'
import { UPLOAD_PAGE_URL } from '../../env'

/**
 * 摄影师端 · 我的项目
 * 非摄影师按身份分流：模特 → 我的拍摄；路人 → 身份引导页
 */

interface ProjectVM {
  _id: string
  name: string
  meta: string
  status: string
  statusClass: string
  modelsLine: string
  expired: boolean
  /** 「剩 X 天」，≤3 天标红、≤7 天标橙（B-2 / E-4） */
  remainText: string
  remainClass: string
  /** E-4：快到期 / 已过期 / 已归档时，卡片上直接给续期入口（到期照片真会没，这是止损） */
  extendable: boolean
  /** 模特提交进度百分比，0 = 不展示进度条 */
  progress: number
}

Page({
  data: {
    loading: false,
    loadError: false,
    projects: [] as ProjectVM[],
  },

  async onShow(this: any) {
    await this.boot()
  },

  /** 身份确认 + 加载列表。身份没就绪时绝不显示「还没有项目」空态 */
  async boot(this: any, fromRetry = false) {
    let s = await waitForSession(3000)
    // 云函数冷启动可能很慢：没等到就主动再查一次身份，总共最多等 15 秒
    if (!s.ready) {
      const app: any = getApp()
      if (app && app.fetchIdentity) await app.fetchIdentity()
      s = await waitForSession(12000)
    }
    if (s.isAdmin) {
      this.setData({ loadError: false })
      await this.loadProjects()
      return
    }
    if (s.isModel) {
      ;(wx as any).redirectTo({ url: '/pages/model-home/index' })
      return
    }
    if (!s.ready || !fromRetry) {
      // 身份一直没就绪：显示明确的失败态（可点击重试），而不是伪装成「还没有项目」
      this.setData({ loadError: true })
      return
    }
    ;(wx as any).redirectTo({ url: '/pages/guide/index' })
  },

  async onPullDownRefresh(this: any) {
    await this.boot()
    ;(wx as any).stopPullDownRefresh()
  },

  retryLoad(this: any) {
    this.setData({ loadError: false })
    this.boot(true)
  },

  async loadProjects(this: any, retried = false) {
    this.setData({ loading: true })
    const res = await listProjects()
    this.setData({ loading: false })
    if (!res.ok || !res.data) {
      // 冷启动超时等瞬时失败自动重试一次；仍失败则给出明确的重试入口
      if (!retried) {
        await new Promise((r) => setTimeout(r, 800))
        return this.loadProjects(true)
      }
      this.setData({ loadError: true })
      ;(wx as any).showToast({ title: res.error || '加载失败，点页面重试', icon: 'none' })
      return
    }
    this.setData({ loadError: false })

    const projects: ProjectVM[] = (res.data.projects || []).map((p: Project) => {
      const expired = daysLeft(p.expireAt) < 0
      const models = p.models || []
      const submitted = models.filter((m) => m.status === '已提交').length
      let status = '待选片'
      let statusClass = ''
      if (p.status === 'ARCHIVED') {
        status = '已归档'
        statusClass = 'grey'
      } else if (expired) {
        status = '已过期'
        statusClass = 'red'
      } else if (models.length && submitted === models.length) {
        status = '已提交'
        statusClass = 'green'
      } else if (submitted > 0 || models.some((m) => m.status === '选片中')) {
        status = '选片中'
        statusClass = 'amber'
      }

      const d = daysLeft(p.expireAt)
      const remainText = expired ? '已过期' : `剩 ${d} 天`
      // E-4：剩 3 天红、剩 7 天橙（红 = 真的快没了，橙 = 该安排续期了）
      const remainClass = expired || d <= 3 ? 'red' : d <= 7 ? 'amber' : ''
      const extendable = expired || d <= 7 || p.status === 'ARCHIVED'
      // 进度 = 已提交模特 / 总模特；没邀请模特就没有可衡量的进度，不画条
      const progress = models.length ? Math.round((submitted / models.length) * 100) : 0

      return {
        _id: p._id as string,
        name: p.name,
        meta: `${shootText(p.shootDate)} · ${p.photoCount || 0} 张 · ${expireText(p.expireAt)}`,
        status,
        statusClass,
        remainText,
        remainClass,
        extendable,
        progress,
        modelsLine: models.length
          ? models
              .map(
                (m) =>
                  `${m.name} ${m.status === '已提交' ? '已提交' : m.selectedCount + ' / ' + packageText(p.packageCount)}`
              )
              .join('　·　')
          : '还没有邀请模特',
        expired,
      }
    })

    this.setData({ projects })
  },

  /** 复制控制台地址：手机上只做补充，新建/上传/导出都在电脑端（P-M1 改动 4） */
  copyConsoleUrl(this: any) {
    ;(wx as any).setClipboardData({
      data: UPLOAD_PAGE_URL,
      success: () => {
        ;(wx as any).showToast({ title: '已复制，在电脑浏览器打开', icon: 'none' })
      },
    })
  },

  openProject(this: any, e: any) {
    ;(wx as any).navigateTo({
      url: `/pages/project-detail/index?id=${e.currentTarget.dataset.id}`,
    })
  },

  /** E-4：卡片上直接续期 30 天（复用已有 project.extend，不用先进详情页） */
  tapExtend(this: any, e: any) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const it = this.data.projects.find((p: ProjectVM) => p._id === id)
    ;(wx as any).showModal({
      title: '延期 30 天？',
      content:
        it && it.expired
          ? '项目已过期，模特现在进不去选片；延期后立刻恢复 30 天。'
          : '给模特多留 30 天选片时间，照片不会丢。',
      confirmText: '延期',
      success: async (r: any) => {
        if (!r.confirm) return
        const res = await extendProject(id)
        if (!res.ok) {
          ;(wx as any).showModal({ title: '延期失败', content: res.error || '', showCancel: false })
          return
        }
        ;(wx as any).showToast({ title: '已延期 30 天', icon: 'success' })
        await this.loadProjects()
      },
    })
  },
})
