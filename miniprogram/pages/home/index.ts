import { waitForSession } from '../../utils/auth'
import { listProjects } from '../../services/project'
import { expireText, packageText, shootText, daysLeft } from '../../utils/format'
import { Project } from '../../types'

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
      if (expired) {
        status = '已过期'
        statusClass = 'red'
      } else if (models.length && submitted === models.length) {
        status = '已提交'
        statusClass = 'green'
      } else if (submitted > 0 || models.some((m) => m.status === '选片中')) {
        status = '选片中'
        statusClass = 'amber'
      }

      return {
        _id: p._id as string,
        name: p.name,
        meta: `${shootText(p.shootDate)} · ${p.photoCount || 0} 张 · ${expireText(p.expireAt)}`,
        status,
        statusClass,
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

  goCreate(this: any) {
    ;(wx as any).navigateTo({ url: '/pages/project-create/index' })
  },

  openProject(this: any, e: any) {
    ;(wx as any).navigateTo({
      url: `/pages/project-detail/index?id=${e.currentTarget.dataset.id}`,
    })
  },
})
