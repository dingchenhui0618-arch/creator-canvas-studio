import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, CreditCard, Trash2 } from 'lucide-react'
import {
  createAdminPlan,
  deleteAdminPlan,
  listAdminPlans,
  updateAdminPlan,
  type AdminPlan,
  type PlanInput,
} from '../../api/plans'
import QuotaCard from './QuotaCard'
import { formatDateTime } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton } from './ui'

// 计费页：只回答一个问题——「多少钱换多少积分」这张表，由谁来改。
// 三个刻意的决定：
//   1. 价格在这里是数据，不是代码：改价不用发版，改完设置页下一次刷新就按新价渲染；
//   2. 付款通道没接入就不装开通：页面直说「下单会失败」，购买动作留成「申请开通」；
//   3. 已提交的申请带档位快照：这里删档位、改价，都不改历史单据上的数字。

type Form = {
  id: string
  name: string
  credits: string
  price: string
  note: string
  enabled: boolean
}

const EMPTY_FORM: Form = { id: '', name: '', credits: '', price: '', note: '', enabled: true }

function formFromPlan(plan: AdminPlan): Form {
  return {
    id: plan.id,
    name: plan.name,
    credits: String(plan.credits),
    price: (plan.priceCents / 100).toFixed(2),
    note: plan.note,
    enabled: plan.enabled,
  }
}

/** 元字符串 → 分：只认数字与一个小数点，拒绝「99,00」「-1」「1e3」这类输入。 */
function centsOf(raw: string): number | null {
  const text = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  return Math.round(Number(text) * 100)
}

function yuan(cents: number): string {
  return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function perCredit(plan: AdminPlan): string {
  if (!plan.credits) return '—'
  const value = plan.priceCents / plan.credits / 100
  if (!plan.priceCents) return '赠送'
  return '¥' + value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

export default function BillingSection() {
  const [items, setItems] = useState<AdminPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    listAdminPlans()
      .then((data) => setItems(data.items))
      .catch((caught) => setError(caught instanceof Error ? caught.message : '档位读取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const editing = Boolean(form.id)
  const totalCredits = useMemo(() => items.reduce((sum, item) => sum + item.credits, 0), [items])

  const submit = async () => {
    if (busy) return
    setNote('')
    const credits = Math.trunc(Number(form.credits))
    const priceCents = centsOf(form.price)
    if (!form.name.trim()) {
      setNote('先写一个档位名，例如「体验档」')
      return
    }
    if (!Number.isFinite(credits) || credits < 1) {
      setNote('积分数量要写正整数')
      return
    }
    if (priceCents === null) {
      setNote('价格写成「99」或「99.50」这样的数字；送体验额度就写 0')
      return
    }
    setBusy(true)
    try {
      const input: PlanInput = {
        name: form.name.trim(),
        credits,
        priceCents,
        note: form.note.trim(),
        enabled: form.enabled,
      }
      const saved = editing
        ? await updateAdminPlan(form.id, input)
        : await createAdminPlan(input)
      setNote(editing ? '已更新「' + saved.plan.name + '」：设置页下一次刷新按新价显示' : '已加档位「' + saved.plan.name + '」：设置页现在就能按它申请开通')
      setForm(EMPTY_FORM)
      load()
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (plan: AdminPlan) => {
    if (busy) return
    if (!window.confirm('删除档位「' + plan.name + '」？已提交的申请里仍保留当时的档位与价格。')) return
    setBusy(true)
    setNote('')
    try {
      await deleteAdminPlan(plan.id)
      setNote('已删除「' + plan.name + '」')
      if (form.id === plan.id) setForm(EMPTY_FORM)
      load()
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <AdminHead
        kicker="计费"
        title="定价档位"
        description="「多少钱换多少积分」和「一个账号一个月最多花多少」，都在这一页定。价格只是档位，不等于支付已开通：付款通道没接入之前，用户提交的是开通申请，管理员确认到账后在「账号」页发放积分。"
        actions={<RefreshButton onClick={load} busy={loading} />}
      />

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <section className="admin-card admin-block">
        <div className="admin-card-head">
          <div>
            <h2>档位表</h2>
            <p>
              {items.length
                ? items.length + ' 个档位，合计 ' + totalCredits.toLocaleString('zh-CN') + ' 积分；停用的档位不出现在用户的充值卡上。'
                : '还没有档位。设置页的充值卡现在显示「档位与价格待定」，加一条之后用户就能按档位申请开通。'}
            </p>
          </div>
          <Badge tone={items.length ? 'ok' : 'neutral'}>{items.length ? items.length + ' 个' : '待定'}</Badge>
        </div>
        {loading && !items.length ? <LoadingLine label="档位" /> : null}
        {!loading && !items.length && !error ? (
          <EmptyState title="还没有定价档位" description="价格由你定：填档位名、积分数量与价格（元）即可，代码里没有任何写死的价格。" />
        ) : null}
        {items.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>档位</th>
                  <th style={{ textAlign: 'right' }}>积分</th>
                  <th style={{ textAlign: 'right' }}>价格</th>
                  <th style={{ textAlign: 'right' }}>每积分</th>
                  <th>状态</th>
                  <th>最近修改</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <strong>{plan.name}</strong>
                      {plan.note ? <span className="admin-cell-note">{plan.note}</span> : null}
                    </td>
                    <td className="admin-mono num-col">{plan.credits.toLocaleString('zh-CN')}</td>
                    <td className="admin-mono num-col">¥{yuan(plan.priceCents)}</td>
                    <td className="admin-mono num-col">{perCredit(plan)}</td>
                    <td>
                      <Badge tone={plan.enabled ? 'ok' : 'neutral'}>{plan.enabled ? '在售' : '停用'}</Badge>
                    </td>
                    <td className="admin-cell-time">
                      {formatDateTime(plan.updatedAt)}
                      {plan.updatedBy ? <span className="admin-cell-note">{plan.updatedBy}</span> : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="admin-row-actions">
                        <button type="button" className="vq-button vq-button--ghost" onClick={() => setForm(formFromPlan(plan))} disabled={busy}>
                          编辑
                        </button>
                        <button type="button" className="vq-button vq-button--ghost" onClick={() => void remove(plan)} disabled={busy}>
                          <Trash2 size={14} />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="admin-card admin-block">
        <div className="admin-card-head">
          <div>
            <h2>{editing ? '编辑档位' : '新增档位'}</h2>
            <p>积分按个、价格按元（最多两位小数）。写 0 元就是赠送额度，不会让用户付钱，也不会伪造支付成功。</p>
          </div>
          {editing ? (
            <button type="button" className="vq-button vq-button--ghost" onClick={() => setForm(EMPTY_FORM)} disabled={busy}>
              取消编辑
            </button>
          ) : null}
        </div>
        <div className="admin-form-grid">
          <label className="vq-field">
            <span>档位名</span>
            <input
              className="vq-input"
              value={form.name}
              maxLength={40}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="例如：体验档"
            />
          </label>
          <label className="vq-field">
            <span>积分数量</span>
            <input
              className="vq-input"
              value={form.credits}
              inputMode="numeric"
              onChange={(event) => setForm({ ...form, credits: event.target.value.replace(/[^0-9]/g, '') })}
              placeholder="1000"
            />
          </label>
          <label className="vq-field">
            <span>价格（元）</span>
            <input
              className="vq-input"
              value={form.price}
              inputMode="decimal"
              onChange={(event) => setForm({ ...form, price: event.target.value.replace(/[^0-9.]/g, '') })}
              placeholder="99.00"
            />
          </label>
          <label className="vq-field">
            <span>备注（可选）</span>
            <input
              className="vq-input"
              value={form.note}
              maxLength={120}
              onChange={(event) => setForm({ ...form, note: event.target.value })}
              placeholder="例如：内测期按成本价"
            />
          </label>
        </div>
        <label className="admin-check">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
          <span>在售（关掉后用户看不到这个档位，已提交的申请不受影响）</span>
        </label>
        <div className="admin-row-actions">
          <button type="button" className="vq-button vq-button--primary" onClick={() => void submit()} disabled={busy}>
            <Check size={14} />
            {busy ? '保存中…' : editing ? '保存修改' : '加档位'}
          </button>
          <span className="admin-cell-note">
            <CreditCard size={14} /> 付款通道未接入：下单接口会返回 501，不会有假订单。
          </span>
        </div>
        {note ? <p className="admin-cell-note" role="status">{note}</p> : null}
      </section>

      <QuotaCard />
    </>
  )
}
