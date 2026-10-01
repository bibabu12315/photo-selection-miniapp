import { waitForSession } from '../../utils/auth'
import { listProjects, bindAdmin } from '../../services/project'
import { statusText, formatDate } from '../../utils/format'
import { Project } from '../../types'

interface ProjectVM {
  _id: string
  name: string
  meta: string
}

Page({
  data: {
    openid: '',
    isAdmin: false,
    loginReady: false,
    loading: false,
    projects: [] as ProjectVM[],
    key: '',
    binding: false,
    bindError: '',
  },

  async onShow(this: any) {
    // 云函数冷启动可能晚于 onLoad，每次回前台都等一次登录态
    const s = await waitForSession(3000)
    this.setData({ openid: s.openid, isAdmin: s.isAdmin, loginReady: true })
    if (s.isAdmin) {
      await this.loadProjects()
    }
  },

  async onPullDownRefresh(this: any) {
    if (this.data.isAdmin) {
      await this.loadProjects()
    }
    ;(wx as any).stopPullDownRefresh()
  },

  async loadProjects(this: any) {
    this.setData({ loading: true })
    const res = await listProjects()
    if (!res.ok || !res.data) {
      this.setData({ loading: false })
      ;(wx as any).showToast({ title: res.error || '加载失败', icon: 'none' })
      return
    }
    const projects: ProjectVM[] = (res.data.projects || []).map((p: Project) => ({
      _id: p._id as string,
      name: p.name,
      meta: [
        p.clientName || '未填客户名',
        `${p.photoCount || 0} 张`,
        p.selectedCount ? `已选 ${p.selectedCount} 张` : '',
        statusText(p.status),
      ]
        .filter(Boolean)
        .join(' · '),
    }))
    this.setData({ loading: false, projects })
  },

  /* ---------- 管理员绑定 ---------- */

  onKeyInput(this: any, e: any) {
    this.setData({ key: e.detail.value, bindError: '' })
  },

  async bindAdminAction(this: any) {
    if (!this.data.key) {
      this.setData({ bindError: '请输入口令' })
      return
    }
    this.setData({ binding: true, bindError: '' })
    const res = await bindAdmin(this.data.key)
    if (!res.ok) {
      this.setData({ binding: false, bindError: res.error || '绑定失败' })
      return
    }
    // 绑定成功后刷新全局登录态
    const app: any = getApp()
    app.globalData.isAdmin = true
    app.globalData.loginReady = true
    this.setData({ binding: false, isAdmin: true })
    ;(wx as any).showToast({ title: '绑定成功', icon: 'success' })
    await this.loadProjects()
  },

  /* ---------- 导航 ---------- */

  goCreate(this: any) {
    ;(wx as any).navigateTo({ url: '/pages/project-create/index' })
  },

  openProject(this: any, e: any) {
    ;(wx as any).navigateTo({
      url: `/pages/project-detail/index?id=${e.currentTarget.dataset.id}`,
    })
  },
})
