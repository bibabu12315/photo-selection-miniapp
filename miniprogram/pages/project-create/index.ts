import { createProject } from '../../services/project'

/**
 * 摄影师端 · 新建项目
 * 只填项目名就能建，其余都有默认值；模特在项目详情里邀请。
 */

const EXPIRE_OPTIONS = ['7', '15', '30', '60', '90']
const PACKAGE_OPTIONS = ['0', '6', '10', '12', '20', '30', '50']

Page({
  data: {
    name: '',
    note: '',
    shootDate: '',
    expireOptions: EXPIRE_OPTIONS.map((d) => `${d} 天`),
    expireIndex: 2,
    packageOptions: PACKAGE_OPTIONS.map((n) => (n === '0' ? '不限' : `${n} 张`)),
    packageIndex: 0,
    submitting: false,
  },

  onLoad(this: any) {
    const today = new Date()
    const p = (n: number) => (n < 10 ? '0' + n : '' + n)
    this.setData({
      shootDate: `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`,
    })
  },

  onName(this: any, e: any) {
    this.setData({ name: e.detail.value })
  },

  onNote(this: any, e: any) {
    this.setData({ note: e.detail.value })
  },

  onShootDate(this: any, e: any) {
    this.setData({ shootDate: e.detail.value })
  },

  onExpire(this: any, e: any) {
    this.setData({ expireIndex: Number(e.detail.value) })
  },

  onPackage(this: any, e: any) {
    this.setData({ packageIndex: Number(e.detail.value) })
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
      note: this.data.note.trim(),
      shootDate: this.data.shootDate,
      expireDays: parseInt(EXPIRE_OPTIONS[this.data.expireIndex], 10),
      packageCount: parseInt(PACKAGE_OPTIONS[this.data.packageIndex], 10),
    })

    if (!res.ok || !res.data) {
      this.setData({ submitting: false })
      ;(wx as any).showModal({ title: '创建失败', content: res.error || '', showCancel: false })
      return
    }

    ;(wx as any).showToast({ title: '创建成功', icon: 'success' })
    // 创建后直接进入工作台，第一步就是上传照片
    setTimeout(() => {
      ;(wx as any).redirectTo({
        url: `/pages/project-detail/index?id=${res.data!._id}`,
      })
    }, 600)
  },
})
