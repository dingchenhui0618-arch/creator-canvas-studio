import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CreditCard, Wallet } from 'lucide-react'
import PageHead from '../components/PageHead'
import { Pill, Tag } from '../components/ui'
import { getCredits, type CreditsResponse } from '../api/credits'
import {
  createBillingOrder,
  getBillingOverview,
  listBillingOrders,
  type BillingOrder,
  type BillingOverview,
} from '../api/billing'
import { navigate } from '../router'
import '../styles/credits.css'
import '../styles/recharge.css'

const stamp = (value: string) => {
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

const number = (value: number) => value.toLocaleString('zh-CN')

/**
 * 充值（v0.9.162）：一屏只做一件事——选一档换积分，并能当场看到余额变了。
 * 口径只有一处：1 元 = N 积分来自服务端配置（/api/billing/overview 的 pointsPerCny），
 * 页面不自己写死倍数；档位由后台维护，这里只如实渲染。
 * 支付通道还没接入，所以这一屏必须把「内测直充」说清楚，不能让人以为付了款。
 */
export default function RechargePage({ onToast }: { onToast?: (message: string) => void }) {
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [orders, setOrders] = useState<BillingOrder[]>([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [last, setLast] = useState<{ credits: number; balance: number } | null>(null)

  const load = useCallback(async () => {
    const [bill, mine] = await Promise.allSettled([getBillingOverview(), getCredits(1, 0)])
    if (bill.status === 'fulfilled') setOverview(bill.value)
    if (mine.status === 'fulfilled') setCredits(mine.value)
    if (bill.status === 'rejected') {
      setError(bill.reason instanceof Error ? bill.reason.message : '充值档位读取失败')
    }
    try {
      const list = await listBillingOrders()
      setOrders(list.items)
      setOrderTotal(list.total)
    } catch {
      // 订单只是凭据，读不到不影响充值本身；上面那行已经会说清档位为什么没出来
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const balance = typeof credits?.balance === 'number' ? credits.balance : null
  const unit = overview?.unit || credits?.unit || '积分'
  const rate = overview?.pointsPerCny || 10
  const plans = useMemo(() => overview?.plans ?? [], [overview])

  const recharge = async (planId: string) => {
    if (busy) return
    setBusy(planId)
    setError('')
    try {
      const result = await createBillingOrder(planId)
      setLast({ credits: result.credits, balance: result.balance })
      onToast?.('已到账 ' + number(result.credits) + ' ' + unit + ' · 余额 ' + number(result.balance))
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '充值失败，刷新后再试')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="page rg-page">
      <PageHead
        kicker={<span className="vq-mono">钱包 / Wallet</span>}
        title="充值"
        desc={
          <>
            积分是站内额度，按次扣、失败原路退回。当前口径 <b className="rg-rate">1 元 = {rate} 积分</b>
            ，由服务端配置下发；调价只改那一处，充值页与画布会一起变。
          </>
        }
        actions={
          <button type="button" className="vq-button vq-button--ghost" onClick={() => navigate({ kind: 'page', page: 'settings' })}>
            <ArrowLeft size={14} />
            返回设置
          </button>
        }
      />

      <section className="vq-card vq-card--wide rg-balance">
        <div className="rg-balance-main">
          <span className="vq-mono">当前余额</span>
          <strong className="rg-balance-number">
            {balance === null ? '—' : number(balance)}
            <em>{unit}</em>
          </strong>
          <span className="rg-balance-note">
            {credits ? '来自服务端积分账本，不是浏览器缓存' : '正在读积分账本…'}
          </span>
        </div>
        <div className="rg-balance-side">
          <Tag tone={overview?.enabled ? 'ink' : 'plain'}>{overview?.enabled ? '可自助充值' : '暂不可充值'}</Tag>
          <span className="rg-balance-side-note">
            {overview?.enabled ? '选一档就到账，充多少由档位决定' : '需要管理员在后台开通档位'}
          </span>
        </div>
      </section>

      <section className="vq-card vq-card--wide rg-plans-card">
        <div className="vq-card-head">
          <div>
            <span className="vq-mono">档位 / Plans</span>
            <h2>选一档</h2>
            <p>金额与积分都由后台的档位决定：客户端改不了数目，也不会出现「付了没到」的中间态。</p>
          </div>
          <Tag>{plans.length} 档</Tag>
        </div>
        <div className="vq-card-body">
          {plans.length ? (
            <div className="rg-plans">
              {plans.map((plan, index) => (
                <article key={plan.id} className={'rg-plan' + (index === 1 ? ' is-featured' : '')}>
                  {plan.name.replace(/\s/g, '') !== number(plan.credits) + unit ? (
                    <span className="rg-plan-name">{plan.name}</span>
                  ) : null}
                  <strong className="rg-plan-credits">
                    {number(plan.credits)}
                    <em>{unit}</em>
                  </strong>
                  <span className="rg-plan-price">
                    {plan.priceCents > 0 ? '¥' + plan.price.toFixed(plan.price % 1 === 0 ? 0 : 2) : '不收费'}
                  </span>
                  {plan.note ? <span className="rg-plan-note">{plan.note}</span> : <span className="rg-plan-note">按 1 元 = {rate} 积分折算</span>}
                  <button
                    type="button"
                    className={'vq-button ' + (index === 1 ? 'vq-button--primary' : 'vq-button--ghost') + ' rg-plan-button'}
                    disabled={!overview?.enabled || Boolean(busy)}
                    onClick={() => void recharge(plan.id)}
                  >
                    <CreditCard size={14} />
                    {busy === plan.id ? '到账中…' : '充这一档'}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="rg-empty">还没有可选的档位：管理员在后台「计费」里加一档，这里就会跟着出现。</p>
          )}

          <p className="rg-honest">
            <Wallet size={14} />
            <span>
              {overview?.mode === 'off'
                ? '支付通道还没接入，自助充值暂时关闭：去「设置 → 积分」提交开通申请，管理员确认后发放。'
                : '支付通道还没接入（商户号还没下来）：现在是内测直充，点一下就入账，不会扣任何真实款项；上线后换成扫码支付。'}
            </span>
          </p>
          {last ? (
            <p className="rg-ok" role="status">
              上一笔：+{number(last.credits)} {unit}，余额 {number(last.balance)} {unit}
            </p>
          ) : null}
          {error ? (
            <p className="rg-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <section className="vq-card vq-card--wide rg-orders">
        <div className="vq-card-head">
          <div>
            <span className="vq-mono">充值记录 / Orders</span>
            <h2>最近充过什么</h2>
            <p>只列你自己的订单；每一笔到账在「设置 → 积分」的流水里都有一条对应的记录。</p>
          </div>
          <Tag>{orderTotal} 笔</Tag>
        </div>
        <div className="vq-card-body">
          {orders.length ? (
            <div className="rg-order-list">
              {orders.map((order) => (
                <div className="rg-order" key={order.id}>
                  <span className="rg-order-main">
                    {order.planName || '充值'}
                    <em>{stamp(order.createdAt)}</em>
                  </span>
                  <span className="rg-order-amount">
                    +{number(order.credits)} {unit}
                    {order.priceCents > 0 ? <em>¥{(order.priceCents / 100).toFixed(0)}</em> : null}
                  </span>
                  <Pill tone={order.status === 'paid' ? 'pass' : 'warn'}>
                    {order.status === 'paid' ? (order.channel === 'internal' ? '内测直充已到账' : '已到账') : '待确认'}
                  </Pill>
                </div>
              ))}
            </div>
          ) : (
            <p className="rg-empty">还没有充值记录：充一档之后这里会留下一条，带时间与积分。</p>
          )}
        </div>
      </section>
    </div>
  )
}
