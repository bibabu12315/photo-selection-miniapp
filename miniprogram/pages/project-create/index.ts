import { createProject } from '../../services/project'

Page({
  data: {
    name: '',
    clientName: '',
    expireDays: '30',
    submitting: false,
  },

  onName(this: any, e: any) {
    this.setData({ name: e.detail.value })
  },

  onClientName(this: any, e: any) {
    this.setData({ clientName: e.detail.value })
  },

  onExpireDays(this: any, e: any) {
    this.setData({ expireDays: e.detail.value })
  },

  async submit(this: any) {
    if (this.data.submitting) return

    const name = this.data.name.trim()
    if (!name) {
      ;(wx as any).showToast({ title: '请填写项目名称', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    const res = await createProject({
      name,
      clientName: this.data.clientName.trim(),
      expireDays: parseInt(this.data.expireDays, 10) || 30,
    })

    if (!res.ok || !res.data) {
      this.setData({ submitting: false })
      ;(wx as any).showModal({ title: '创建失败', content: res.error || '', showCancel: false })
      return
    }

    ;(wx as any).showToast({ title: '创建成功', icon: 'success' })
    // 直接进入项目详情（上传码在详情页签发）
    setTimeout(() => {
      ;(wx as any).redirectTo({
        url: `/pages/project-detail/index?id=${res.data!._id}`,
      })
    }, 600)
  },
})
