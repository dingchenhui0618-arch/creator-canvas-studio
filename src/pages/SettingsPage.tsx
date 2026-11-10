import { useEffect, useState } from 'react'
import { CreditCard, LogOut, RefreshCw } from 'lucide-react'
import { MonoTag } from '../components/ui'
import { getBillingOverview, type BillingOverview } from '../api/billing'
import { initialsFor, sessionKindLabel, type Session } from '../auth/session'
import '../styles/shell.css'

type Props = {
  session: Session
  onSignOut: () => void
  onSwitchAccount: () => void
}

/** 设置页只放能兑现的东西：会话是服务端真的、凭据是 cookie 真的；没有运行适配器可配。 */
export function SettingsPage({ session, onSignOut, onSwitchAccount }: Props) {
  const [billing, setBilling] = useState<BillingOverview | null>(null)
  const [billingError, setBillingError] = useState('')

  useEffect(() => {
    getBillingOverview()
      .then(setBilling)
      .catch((caught) => setBillingError(caught instanceof Error ? caught.message : '充值状态读取失败'))
  }, [])

  const signedInAt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(session.signedInAt))

  return (
    <div className="vq-page">
      <header className="vq-page-head">
        <div>
          <span className="vq-mono">Workspace settings</span>
          <h1>设置</h1>
          <p>只有账号这一块有服务端接口。工作区偏好、运行适配器还没有后端，所以不在这里摆开关。</p>
        </div>
      </header>

      <div className="vq-settings-grid">
        <section className="vq-card vq-card--wide">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">账号 / Account</span>
              <h2>当前会话</h2>
              <p>会话保存在服务端，凭据是 HttpOnly cookie；关掉浏览器再打开仍是登录状态。</p>
            </div>
            <MonoTag>{sessionKindLabel(session.user.kind)}</MonoTag>
          </div>
          <div className="vq-account">
            <span className="vq-account-avatar">{initialsFor(session.user.name)}</span>
            <div className="vq-account-meta">
              <strong>{session.user.name}</strong>
              <span>{session.user.email}</span>
            </div>
            <div className="vq-account-actions">
              <button type="button" className="vq-button vq-button--ghost" onClick={onSwitchAccount}>
                <RefreshCw size={14} />
                切换账号
              </button>
              <button type="button" className="vq-button vq-button--danger" onClick={onSignOut}>
                <LogOut size={14} />
                退出登录
              </button>
            </div>
          </div>
          <div className="vq-card-body">
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>会话存储</strong>
                <span>客户端只持 cookie；服务端只存 token 的 sha256</span>
              </div>
              <span className="vq-row-value vq-mono">vq_session · HttpOnly</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>登录方式</strong>
                <span>邮箱 + 口令，服务端 scrypt 比对；密码不存明文</span>
              </div>
              <span className="vq-row-value">{sessionKindLabel(session.user.kind)}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>本次登录时间</strong>
                <span>服务端会话的创建时间，用于会话过期判断</span>
              </div>
              <span className="vq-row-value vq-mono">{signedInAt}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>工作区</strong>
                <span>单工作区部署；多工作区切换还没有后端</span>
              </div>
              <span className="vq-row-value">{session.user.workspace}</span>
            </div>
          </div>
        </section>

        <section className="vq-card vq-card--wide">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">充值 / Billing</span>
              <h2>余额与充值</h2>
              <p>计费方式与价格还没定，暂时不能下单，也不显示额度。开通后这里会出现档位与支付入口。</p>
            </div>
            <MonoTag>{billing?.enabled ? '已开通' : '未开通'}</MonoTag>
          </div>
          <div className="vq-card-body">
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>当前余额</strong>
                <span>{billing?.message || billingError || '读取中…'}</span>
              </div>
              <span className="vq-row-value vq-mono">
                {billing?.balance?.credits == null ? '—' : billing.balance.credits + ' ' + (billing.balance.unit || '次')}
              </span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>充值档位</strong>
                <span>{billing?.plans?.length ? '价格以下单页为准' : '档位与价格待定，暂不开放购买'}</span>
              </div>
              <span className="vq-row-value">{billing?.plans?.length ?? 0} 个档位</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>支付通道</strong>
                <span>开通后可扫码或跳转支付</span>
              </div>
              <span className="vq-row-value">{billing?.provider || '未接入'}</span>
            </div>
            <div className="vq-billing-actions">
              <button type="button" className="vq-button vq-button--primary" disabled={!billing?.enabled || !billing?.plans?.length}>
                <CreditCard size={14} />
                充值
              </button>
              <span className="vq-billing-note">
                {billing?.enabled ? '选择一个档位后进入支付' : '充值通道未开通，按钮暂不可用'}
              </span>
            </div>
          </div>
        </section>
      </div>

      <footer className="vq-settings-foot">
        <span>设置项不落浏览器；账号与会话由服务端校验。</span>
        <span className="vq-mono">VisionQA · Workbench</span>
      </footer>
    </div>
  )
}
