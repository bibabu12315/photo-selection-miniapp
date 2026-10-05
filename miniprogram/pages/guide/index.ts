import { bindAdmin } from '../../services/project'
import { whoami } from '../../services/selection'
import { claimLoginTicket } from '../../services/session'

/**
 * 身份引导页
 * 只有「既不是摄影师、也不是模特」的人才会看到这里。
 * 摄影师：零门槛，点一下即开通（openid 即身份，不用口令）；模特：必须由摄影师发链接进入。
 * 另外承担网页扫码登录的认领入口（scene 带 22 位 loginTicket 时，T-P1-2）。
 */

/** 登录票据固定 22 位（session 云函数 TICKET_LEN），防止把普通 scene 误判成票据 */
const TICKET_RE = /^[A-Za-z0-9]{22}$/

/** 邀请 token 与登录票据同规格（project 云函数 randomBase62(22)） */
const INVITE_RE = /^[A-Za-z0-9]{22}$/

/**
 * 从模特粘贴的内容里抠出邀请 token（B-1）。
 * 支持两种粘贴：整条链接 `/pages/client-select/index?t=xxx`，或只粘了 token。
 * 抠不出来返回空，由调用方提示「向摄影师要一条邀请链接」——不跳转、不留空白页。
 */
function pickInviteToken(raw: string): string {
  const s = (raw || '').trim()
  const m = /[?&]t=([A-Za-z0-9]+)/.exec(s)
  const t = m ? m[1] : s
  return INVITE_RE.test(t) ? t : ''
}

Page({
  data: {
    binding: false,
    bindError: '',
    checking: true,
    claimState: '', // '' | 'ok' | 'err'：扫码登录认领结果
    claimError: '',
    /** 模特粘贴的邀请链接（B-1） */
    link: '',
  },

  /** 输入框内容存到实例上即可，不必每敲一个字都 setData */
  linkText: '',

  onLoad(this: any, options?: { scene?: string }) {
    // scene 必须最先解析：已开通摄影师的人扫码进来，下面的身份检查会把他直接跳走
    const scene = decodeURIComponent((options && options.scene) || '')
    if (TICKET_RE.test(scene)) {
      this.claimLogin(scene)
      return
    }
    this.checkIdentity()
  },

  /** 网页扫码登录：认领票据后提示回电脑（不跳转，避免打断） */
  async claimLogin(this: any, ticket: string) {
    this.setData({ checking: false })
    const res = await claimLoginTicket(ticket)
    if (res.ok) {
      this.setData({ claimState: 'ok' })
      return
    }
    this.setData({ claimState: 'err', claimError: res.error || '登录失败，请在电脑上刷新二维码重试' })
  },

  /** 进页面先确认身份：已绑定的直接放行，防止冷启动误跳到这页后又要求输口令 */
  async checkIdentity(this: any) {
    const res = await whoami()
    if (res.ok && res.data) {
      if (res.data.isAdmin) {
        ;(wx as any).reLaunch({ url: '/pages/home/index' })
        return
      }
      if (res.data.isModel) {
        ;(wx as any).reLaunch({ url: '/pages/model-home/index' })
        return
      }
    }
    this.setData({ checking: false })
  },

  retryCheck(this: any) {
    this.setData({ checking: true })
    this.checkIdentity()
  },

  onLinkInput(this: any, e: any) {
    this.linkText = e.detail.value || ''
  },

  /** 模特用粘贴的邀请链接进入选片（B-1） */
  openInviteLink(this: any) {
    const token = pickInviteToken(this.linkText)
    if (!token) {
      ;(wx as any).showToast({ title: '向摄影师要一条邀请链接', icon: 'none' })
      return
    }
    ;(wx as any).navigateTo({ url: '/pages/client-select/index?t=' + token })
  },

  async bindAdminAction(this: any) {
    if (this.data.binding) return
    this.setData({ binding: true, bindError: '' })
    const res = await bindAdmin()
    if (!res.ok) {
      this.setData({ binding: false, bindError: res.error || '绑定失败' })
      return
    }
    const app: any = getApp()
    app.globalData.isAdmin = true
    app.globalData.loginReady = true
    ;(wx as any).showToast({ title: '绑定成功', icon: 'success' })
    setTimeout(() => {
      ;(wx as any).reLaunch({ url: '/pages/home/index' })
    }, 600)
  },
})
