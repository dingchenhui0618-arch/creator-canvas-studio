import { useCallback, useEffect, useState } from 'react'
import { Activity, CreditCard, KeyRound, LogOut, RefreshCw } from 'lucide-react'
import { MonoTag } from '../components/ui'
import PageHead from '../components/PageHead'
import { getBillingOverview, type BillingOverview } from '../api/billing'
import { useUiMode } from '../api/app'
import { creditKindLabel, getCredits, getMyCreditRequest, requestCredits, getSystemHealth, type CreditEntry, type CreditRequest, type CreditsResponse, type SystemHealth } from '../api/credits'
import { changePassword } from '../api/auth'
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
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNext, setPwNext] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwMessage, setPwMessage] = useState('')
  // 额度申请：充值没接，用户要有可执行的出口
  const [reqPending, setReqPending] = useState<CreditRequest | null>(null)
  const [reqOpen, setReqOpen] = useState(false)
  const [reqAmount, setReqAmount] = useState('200')
  const [reqReason, setReqReason] = useState('')
  const [reqBusy, setReqBusy] = useState(false)
  const [reqError, setReqError] = useState('')
  const [reqMessage, setReqMessage] = useState('')

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
    getMyCreditRequest()
      .then((data) => setReqPending(data.pending))
      .catch(() => setReqPending(null))
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

  const submitCreditRequest = async () => {
    if (reqBusy) return
    setReqBusy(true)
    setReqError('')
    setReqMessage('')
    try {
      const result = await requestCredits(Number(reqAmount) || 0, reqReason.trim())
      setReqPending(result.pending || result.request)
      setReqMessage(result.created ? '已提交，管理员处理后积分会自动到账。' : '你已经有一条待处理的申请，不用重复提交。')
      setReqOpen(false)
      setReqReason('')
    } catch (caught) {
      setReqError(caught instanceof Error ? caught.message : '提交失败')
    } finally {
      setReqBusy(false)
    }
  }
  const submitPassword = async () => {
    if (pwBusy) return
    setPwError('')
    setPwMessage('')
    if (!pwCurrent) {
      setPwError('请输入当前口令')
      return
    }
    if (pwNext.length < 8 || !/[A-Za-z]/.test(pwNext) || !/[0-9]/.test(pwNext)) {
      setPwError('新口令至少 8 位，且同时包含字母和数字')
      return
    }
    if (pwNext !== pwConfirm) {
      setPwError('两次输入的新口令不一致')
      return
    }
    setPwBusy(true)
    try {
      const result = await changePassword(pwCurrent, pwNext)
      setPwMessage(result.signedOut > 0 ? '口令已更新，其它设备上的 ' + result.signedOut + ' 个登录已退出。' : '口令已更新。')
      setPwCurrent('')
      setPwNext('')
      setPwConfirm('')
    } catch (caught) {
      setPwError(caught instanceof Error ? caught.message : '口令没有更新，请稍后重试')
    } finally {
      setPwBusy(false)
    }
  }

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
                <span>{internal ? '单工作区部署；多工作区切换还没有后端' : '当前账号所属的工作区'}</span>
              </div>
              <span className="vq-row-value">{session.user.workspace}</span>
            </div>
          </div>
        </section>

        <section className="vq-card vq-card--wide" id="account-security">
          <div className="vq-card-head">
            <div>
              <span className="vq-mono">安全 / Security</span>
              <h2>修改口令</h2>
              <p>
                {internal
                  ? '当前口令与新口令都由服务端校验；成功后其它设备上的会话会立即注销，这一条保留。'
                  : '修改后，其它设备上的登录会自动退出，当前设备保持登录。'}
              </p>
            </div>
            <MonoTag>口令</MonoTag>
          </div>
          <div className="vq-inline-form vq-password-form">
            <label className="vq-field">
              <span>当前口令</span>
              <input
                className="vq-input"
                type="password"
                autoComplete="current-password"
                value={pwCurrent}
                onChange={(event) => setPwCurrent(event.target.value)}
                disabled={pwBusy}
              />
            </label>
            <label className="vq-field">
              <span>新口令</span>
              <input
                className="vq-input"
                type="password"
                autoComplete="new-password"
                placeholder="至少 8 位，含字母和数字"
                value={pwNext}
                onChange={(event) => setPwNext(event.target.value)}
                disabled={pwBusy}
              />
            </label>
            <label className="vq-field">
              <span>再输一次</span>
              <input
                className="vq-input"
                type="password"
                autoComplete="new-password"
                value={pwConfirm}
                onChange={(event) => setPwConfirm(event.target.value)}
                disabled={pwBusy}
              />
            </label>
            <button type="button" className="vq-button vq-button--primary" onClick={() => void submitPassword()} disabled={pwBusy}>
              <KeyRound size={14} />
              {pwBusy ? '更新中…' : '更新口令'}
            </button>
          </div>
          {pwError ? <p className="vq-field-error" role="alert">{pwError}</p> : null}
          {pwMessage ? <p className="vq-password-ok" role="status">{pwMessage}</p> : null}
          <p className="vq-password-note">
            {internal
              ? '口令用 scrypt 加盐存储；管理员重置口令时会给一次性临时口令，同样会注销旧会话。'
              : '口令只用于你本人登录，平台不会以明文保存。'}
          </p>
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

            <div className="vq-row">
              <div className="vq-row-copy">
                <strong>额度不够用</strong>
                <span>
                  {reqPending
                    ? '已提交申请（' + reqPending.amount + ' 积分），管理员处理前会保留这条。'
                    : '充值通道还没开通。写一条申请，管理员在后台直接把积分发到你的账号。'}
                </span>
              </div>
              <div className="vq-billing-actions">
                <button type="button" className="vq-button vq-button--ghost" onClick={() => setReqOpen((value) => !value)}>
                  {reqOpen ? '收起' : reqPending ? '查看申请' : '申请额度'}
                </button>
              </div>
            </div>
            {reqOpen ? (
              reqPending ? (
                <p className="vq-billing-note">
                  申请 {reqPending.id} · {reqPending.amount} 积分 · 提交于 {formatStamp(reqPending.createdAt)}。
                  {reqPending.reason ? ' 用途：' + reqPending.reason : ' 未填用途。'}
                </p>
              ) : (
                <div className="vq-inline-form vq-password-form">
                  <label className="vq-field">
                    <span>需要多少积分</span>
                    <input
                      className="vq-input"
                      value={reqAmount}
                      onChange={(event) => setReqAmount(event.target.value.replace(/[^0-9]/g, ''))}
                      inputMode="numeric"
                      placeholder="200"
                    />
                  </label>
                  <label className="vq-field">
                    <span>用途（可选）</span>
                    <input
                      className="vq-input"
                      value={reqReason}
                      onChange={(event) => setReqReason(event.target.value)}
                      placeholder="例如：本周解析 10 条模板"
                      maxLength={120}
                    />
                  </label>
                  <button type="button" className="vq-button vq-button--primary" onClick={() => void submitCreditRequest()} disabled={reqBusy}>
                    {reqBusy ? '提交中…' : '提交申请'}
                  </button>
                </div>
              )
            ) : null}
            {reqError ? <p className="vq-billing-note" role="alert">{reqError}</p> : null}
            {reqMessage ? <p className="vq-billing-note">{reqMessage}</p> : null}
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
              <span className="vq-mono">可用性 / Status</span>
              <h2>功能可用性</h2>
              <p>{internal ? '这里会真连数据库、数据目录、模板库、模型接口和检索接口，不是「环境变量填了没填」。' : '看一下检索、评审、模型与数据存储现在能不能用。细节在后台「系统」页。'}</p>
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
                    {internal ? (
                      <span className="detail" title={check.detail}>
                        {check.detail}
                      </span>
                    ) : null}
                    {internal ? <span className="ms">{check.ms}ms</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="vq-ledger-empty">检测中…</p>
            )}
            <p className="vq-billing-note">
              {internal ? '结果缓存 10 秒，避免刷新把上游探活打成刷屏' : '结果缓存 10 秒'}
              ；最后检测于 {health ? formatStamp(health.checkedAt) : '—'}。
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
