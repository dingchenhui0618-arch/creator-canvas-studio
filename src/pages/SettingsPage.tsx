import { useCallback, useEffect, useState } from 'react'
import { Activity, CreditCard, LogOut, RefreshCw } from 'lucide-react'
import { MonoTag } from '../components/ui'
import PageHead from '../components/PageHead'
import { getBillingOverview, type BillingOverview } from '../api/billing'
import { useUiMode } from '../api/app'
import { creditKindLabel, getCredits, getSystemHealth, type CreditEntry, type CreditsResponse, type SystemHealth } from '../api/credits'
import { initialsFor, sessionKindLabel, type Session } from '../auth/session'
import '../styles/shell.css'
import '../styles/credits.css'

type Props = {
  session: Session
  onSignOut: () => void
  onSwitchAccount: () => void
}

const HEALTH_LABEL: Record<string, string> = { ok: '正常', warn: '注意', fail: '异常' }

function formatStamp(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/**
 * 设置页只放能兑现的东西：会话是服务端真的、积分是服务端账本真的、系统状态是真的探活。
 * 充值通道还没接（用户还没定价），所以那块仍然是「未开通」占位，不摆假档位。
 */
const LEDGER_PAGE = 12

export function SettingsPage({ session, onSignOut, onSwitchAccount }: Props) {
  const { internal } = useUiMode()
  const [billing, setBilling] = useState<BillingOverview | null>(null)
  const [billingError, setBillingError] = useState('')
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [creditsError, setCreditsError] = useState('')
  const [ledgerMore, setLedgerMore] = useState<CreditEntry[]>([])
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [health, setHealth] = useState<SystemHealth | null>(null)
  const [healthError, setHealthError] = useState('')
  const [healthLoading, setHealthLoading] = useState(true)

  const loadCredits = useCallback(() => {
    getCredits(LEDGER_PAGE)
      .then((next) => {
        setCredits(next)
        setLedgerMore([])
        setCreditsError('')
      })
      .catch((caught) => setCreditsError(caught instanceof Error ? caught.message : '积分读取失败'))
  }, [])

  useEffect(() => {
    getBillingOverview()
      .then(setBilling)
      .catch((caught) => setBillingError(caught instanceof Error ? caught.message : '充值状态读取失败'))
    loadCredits()
  }, [loadCredits])

  const ledger = credits ? [...credits.ledger, ...ledgerMore] : []
  const ledgerTotal = credits?.ledgerTotal ?? ledger.length
  const ledgerHasMore = ledger.length < ledgerTotal

  const loadMoreLedger = () => {
    if (!credits || ledgerLoading) return
    setLedgerLoading(true)
    getCredits(LEDGER_PAGE, ledger.length)
      .then((next) => setLedgerMore((prev) => [...prev, ...next.ledger]))
      .catch((caught) => setCreditsError(caught instanceof Error ? caught.message : '积分流水读取失败'))
      .finally(() => setLedgerLoading(false))
  }

  const loadHealth = useCallback(() => {
    setHealthLoading(true)
    setHealthError('')
    getSystemHealth()
      .then(setHealth)
      .catch((caught) => setHealthError(caught instanceof Error ? caught.message : '系统状态读取失败'))
      .finally(() => setHealthLoading(false))
  }, [])

  useEffect(() => {
    loadHealth()
  }, [loadHealth])

  const signedInAt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(session.signedInAt))

  const balance = credits?.balance
  const prices = credits?.prices
  const lowBalance = typeof balance === 'number' && prices ? balance < prices.search : false

  return (
    <div className="vq-page">
      <PageHead
        kicker="工作区设置"
        title="设置"
        desc={
          internal
            ? '账号、积分、系统状态都是服务端真实数据；充值通道还没定价，保持未开通。'
            : '账号、积分与运行状态都来自真实数据；充值通道还没开通，暂不开放购买。'
        }
      />

      <div className="vq-settings-grid">
        <section className="vq-card vq-card--wide">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">账号 / Account</span>
              <h2>当前会话</h2>
              <p>{internal ? '会话保存在服务端，凭据是 HttpOnly cookie；关掉浏览器再打开仍是登录状态。' : '登录状态会安全保存，关掉浏览器再打开仍然是登录状态。'}</p>
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
                <span>{internal ? '客户端只持 cookie；服务端只存 token 的 sha256' : '登录凭证只保存在本机浏览器，平台不保存明文'}</span>
              </div>
              <span className="vq-row-value vq-mono">{internal ? 'vq_session · HttpOnly' : '已安全保存'}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>本次登录时间</strong>
                <span>{internal ? '服务端会话的创建时间，用于会话过期判断' : '本次登录的时间，用于判断登录是否过期'}</span>
              </div>
              <span className="vq-row-value vq-mono">{signedInAt}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>工作区</strong>
                <span>{internal ? '单工作区部署；多工作区切换还没有后端' : '当前工作区；多工作区切换暂未开放'}</span>
              </div>
              <span className="vq-row-value">{session.user.workspace}</span>
            </div>
          </div>
        </section>

        <section className="vq-card vq-card--wide">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">积分 / Credits</span>
              <h2>积分余额与消耗</h2>
              <p>检索、复刻、评审、对话都按次扣积分；失败会原路退回。充值通道未开通，积分由管理员发放。</p>
            </div>
            <MonoTag>{lowBalance ? '余额偏低' : '按次计费'}</MonoTag>
          </div>
          <div className="vq-card-body">
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>当前余额</strong>
                <span>{creditsError || (internal ? '来自服务端积分账本，不是浏览器缓存' : '来自真实积分记录，不是浏览器缓存')}</span>
              </div>
              <span className="vq-credit-balance">
                <b>{typeof balance === 'number' ? balance : '—'}</b>
                <span>{credits?.unit || '积分'}</span>
              </span>
            </div>

            <div className="vq-price-grid">
              <div className="vq-price-item">
                <span>检索（一页）</span>
                <strong>{prices ? prices.search : '—'}</strong>
              </div>
              <div className="vq-price-item">
                <span>一键复刻</span>
                <strong>{prices ? prices.replicate : '—'}</strong>
              </div>
              <div className="vq-price-item">
                <span>视觉评审</span>
                <strong>{prices ? prices.review : '—'}</strong>
              </div>
              <div className="vq-price-item">
                <span>智能体对话</span>
                <strong>{prices ? prices.chat : '—'}</strong>
              </div>
            </div>

            {ledger.length ? (
              <table className="vq-ledger">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th>说明</th>
                    <th style={{ textAlign: 'right' }}>变动</th>
                    <th style={{ textAlign: 'right' }}>余额</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td className="time">{formatStamp(entry.createdAt)}</td>
                      <td>{creditKindLabel(entry.kind)}</td>
                      <td>{entry.ref || '—'}</td>
                      <td className={'num ' + (entry.delta > 0 ? 'plus' : 'minus')}>
                        {entry.delta > 0 ? '+' : ''}
                        {entry.delta}
                      </td>
                      <td className="num">{entry.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="vq-ledger-empty">还没有积分流水：检索一次就会在这里留一条记录。</p>
            )}
            {ledger.length ? (
              <div className="vq-ledger-more">
                <span>
                  共 {ledgerTotal} 条，已显示 {ledger.length} 条
                  {creditsError ? '（' + creditsError + '）' : ''}
                </span>
                {ledgerHasMore ? (
                  <button type="button" className="vq-button vq-button--ghost" onClick={loadMoreLedger} disabled={ledgerLoading}>
                    {ledgerLoading ? '加载中…' : '加载更多'}
                  </button>
                ) : null}
              </div>
            ) : null}
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
                <strong>充值通道</strong>
                <span>{billing?.message || billingError || '读取中…'}</span>
              </div>
              <span className="vq-row-value vq-mono">{billing?.provider || '未接入'}</span>
            </div>
            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>充值档位</strong>
                <span>{billing?.plans?.length ? '价格以下单页为准' : '档位与价格待定，暂不开放购买'}</span>
              </div>
              <span className="vq-row-value">{billing?.plans?.length ?? 0} 个档位</span>
            </div>
            <div className="vq-billing-actions">
              <button type="button" className="vq-button vq-button--primary" disabled={!billing?.enabled || !billing?.plans?.length}>
                <CreditCard size={14} />
                充值
              </button>
              <span className="vq-billing-note">
                {billing?.enabled ? '选择一个档位后进入支付' : '充值通道未开通，按钮暂不可用；积分由管理员发放'}
              </span>
            </div>
          </div>
        </section>

        <section className="vq-card vq-card--wide" id="system-status">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">系统状态 / Health</span>
              <h2>健康检查</h2>
              <p>{internal ? '这里会真连数据库、数据目录、模板库、模型接口和检索接口，不是「环境变量填了没填」。' : '这里会真实检查数据存储、模板库、模型与检索服务是否可用，而不只是看配置有没有填。'}</p>
            </div>
            <div className="vq-account-actions">
              {health ? <MonoTag>{HEALTH_LABEL[health.status] || health.status}</MonoTag> : null}
              <button type="button" className="vq-button vq-button--ghost" onClick={loadHealth} disabled={healthLoading}>
                <Activity size={14} />
                {healthLoading ? '检测中…' : '重新检测'}
              </button>
            </div>
          </div>
          <div className="vq-card-body">
            {healthError ? (
              <p className="vq-ledger-empty">{healthError}</p>
            ) : health ? (
              <div className="vq-health">
                {health.checks.map((check) => (
                  <div className="vq-health-row" key={check.id}>
                    <strong>{check.label}</strong>
                    <span className={'vq-health-tag ' + check.status}>{HEALTH_LABEL[check.status] || check.status}</span>
                    <span className="detail" title={check.detail}>
                      {check.detail}
                    </span>
                    <span className="ms">{check.ms}ms</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="vq-ledger-empty">检测中…</p>
            )}
            <p className="vq-billing-note">
              结果缓存 10 秒，避免刷新把上游探活打成刷屏；最后检测于 {health ? formatStamp(health.checkedAt) : '—'}。
            </p>
          </div>
        </section>
      </div>

      <footer className="vq-settings-foot">
        <span>{internal ? '设置项不落浏览器；账号、积分与系统状态都由服务端校验。' : '设置项不保存在浏览器；账号、积分与运行状态都会实时校验。'}</span>
        <span className="vq-mono">VisionQA · Workbench</span>
      </footer>
    </div>
  )
}
