import { useCallback, useEffect, useState } from 'react'
import { Calculator } from 'lucide-react'
import { getPricingEstimate, rateText, type PricingEstimate, type PricingRow } from '../../api/pricing'
import { formatCost } from '../../api/usage'
import { Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton } from './ui'

// 按次算账（v0.9.81）：价格定不下来时，先让人看见「一次赚多少」。
// 三个刻意的决定：
//   1. 汇率只有一个来源——档位（多少钱换多少积分），或手填一个「每积分多少钱」；
//      没有汇率就整张表不出钱，写「先定汇率」，不拿积分数字冒充金额；
//   2. 成本照旧来自「成本」页的上游估算单价；算不出来就写「未定价 + 为什么」，
//      不写 0.00——0 成本会让每一行的毛利率变成 100%，那是骗自己；
//   3. 画布出图 / 出视频现在不扣积分，但上游真的花钱：单独列出来标「倒贴」，
//      这不是 bug 展示，是定价前最该看见的一行。

const WINDOWS = [7, 14, 30, 90]

function money(milli: number | null): string {
  if (milli === null) return '—'
  return '¥' + formatCost(Math.abs(milli))
}

function signedMoney(milli: number | null): string {
  if (milli === null) return '—'
  if (!milli) return '¥0.00'
  return (milli < 0 ? '−' : '+') + money(milli)
}

function percentText(pct: number | null): string {
  if (pct === null) return '—'
  return (Math.round(pct * 10) / 10).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%'
}

function windowCell(row: PricingRow): string {
  if (row.perUnit && row.units > 0) {
    const units = row.units.toLocaleString('zh-CN') + ' ' + row.unit
    return row.costMilli ? units + ' · ' + money(row.costMilli) : units
  }
  if (!row.measured) return row.calls ? row.calls + ' 次（回填）' : '—'
  const calls = row.measured.toLocaleString('zh-CN') + ' 次'
  return row.costMilli ? calls + ' · ' + money(row.costMilli) : calls
}

/** 动作名下面的小字：不收费的行要说清「有成本」，按张 / 按秒算的还要说清按什么算。 */
function rowNote(row: PricingRow): string {
  if (!row.subsidized) return ''
  return row.perUnit ? '不扣积分 · 有成本 · 按' + row.unit + '算' : '不扣积分 · 有成本'
}

export default function UnitEconomicsCard() {
  const [days, setDays] = useState(30)
  // auto = 取最划算的档位；'custom' = 手填汇率；其余值是档位 id
  const [mode, setMode] = useState('auto')
  const [rateDraft, setRateDraft] = useState('')
  const [rate, setRate] = useState(0)
  const [view, setView] = useState<PricingEstimate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  // 手填汇率必须先「应用」：否则每敲一个字符就发一次请求，边打字边闪
  const waitingForRate = mode === 'custom' && rate <= 0

  const load = useCallback(() => {
    if (mode === 'custom' && rate <= 0) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    getPricingEstimate({
      days,
      planId: mode === 'auto' || mode === 'custom' ? '' : mode,
      rate: mode === 'custom' ? rate : 0,
    })
      .then((data) => setView(data))
      .catch((caught) => setError(caught instanceof Error ? caught.message : '算账失败'))
      .finally(() => setLoading(false))
  }, [days, mode, rate])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const applyRate = () => {
    const value = Number(rateDraft)
    if (!Number.isFinite(value) || value <= 0) {
      setNote('每积分多少钱要写大于 0 的数字，例如 0.05（= 1 积分 5 分钱）')
      return
    }
    setNote('')
    setRate(value)
  }

  const rows = view?.rows || []
  const totals = view?.totals
  const billed = view ? view.rate.source !== 'none' : false

  return (
    <section className="admin-card admin-block admin-block--econ">
      <div className="admin-card-head">
        <div>
          <h2>按次算账</h2>
          <p>
            把「扣多少积分」按档位折成钱，和上游估算成本放在一行里：一次检索、一次复刻、一次评审、一次画布运行，
            各自赚还是倒贴。只读，不扣积分、不调上游。
          </p>
        </div>
        <div className="admin-row-actions">
          <Badge tone={billed ? 'ok' : 'warn'}>
            {view ? (billed ? rateText(view.rate.rmbPerCredit) + ' / 积分' : '还没有汇率') : '读取中'}
          </Badge>
          <RefreshButton onClick={load} busy={loading} />
        </div>
      </div>

      <div className="admin-quota-form">
        <label className="vq-field">
          <span>窗口</span>
          <select className="vq-input" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {WINDOWS.map((value) => (
              <option key={value} value={value}>
                最近 {value} 天
              </option>
            ))}
          </select>
        </label>
        <label className="vq-field">
          <span>汇率按哪一档算</span>
          <select className="vq-input" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="auto">自动（取最划算的一档）</option>
            {(view?.plans || []).map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name}（{rateText(plan.rmbPerCredit)} / 积分）
              </option>
            ))}
            <option value="custom">手填汇率</option>
          </select>
        </label>
        {mode === 'custom' ? (
          <>
            <label className="vq-field admin-quota-limit">
              <span>每积分多少钱（元）</span>
              <input
                className="vq-input"
                value={rateDraft}
                inputMode="decimal"
                onChange={(event) => setRateDraft(event.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.05"
              />
            </label>
            <button type="button" className="vq-button vq-button--ghost" onClick={applyRate}>
              <Calculator size={14} />
              按这个汇率算
            </button>
          </>
        ) : null}
        <span className="admin-cell-note">
          {view && billed
            ? '当前汇率来自' + (view.rate.source === 'custom' ? '手填' : '档位「' + view.rate.planName + '」') +
              '；收入按它折算，是理论值，不是真实收款。'
            : '还没有汇率：先在「档位表」加一条档位，或用「手填汇率」试算。'}
        </span>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {note ? <p className="admin-cell-note" role="status">{note}</p> : null}

      {waitingForRate ? (
        <EmptyState title="先填一个汇率：1 积分等于多少钱" description="没有档位也能算：填「0.05」（1 积分 5 分钱）再点「按这个汇率算」，表格就会按窗口里的真实用量折成钱。" />
      ) : null}

      {!waitingForRate && loading && !view ? <LoadingLine label="按次算账" /> : null}

      {!waitingForRate && view && totals ? (
        <>
          <p className="admin-hint">
            {totals.measured === 0
              ? '最近 ' + view.days + ' 天没有带用量的调用：窗口收入与成本都算不出来。下面每一行的「折算收入」是按汇率折的每次收入，可以先据此定价。'
              : '最近 ' + view.days + ' 天：真有用量的上游调用 ' + totals.measured.toLocaleString('zh-CN') + ' 次 · 理论收入 ' +
                money(totals.revenueMilli) + ' · 上游估算成本 ' + money(totals.costMilli) + ' · 毛利 ' + signedMoney(totals.marginMilli) +
                (totals.unbilledCostMilli ? '（其中 ' + money(totals.unbilledCostMilli) + ' 来自不扣积分的画布出图 / 出视频）' : '')}
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table admin-table--econ">
              <thead>
                <tr>
                  <th>动作</th>
                  <th style={{ textAlign: 'right' }}>扣积分</th>
                  <th style={{ textAlign: 'right' }}>折算收入</th>
                  <th style={{ textAlign: 'right' }}>上游成本</th>
                  <th style={{ textAlign: 'right' }}>毛利</th>
                  <th style={{ textAlign: 'right' }}>毛利率</th>
                  <th>本窗口用量</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.action}>
                    <td>
                      <strong>{row.label}</strong>
                      {row.subsidized ? <span className="admin-cell-note">{rowNote(row)}</span> : null}
                    </td>
                    <td className="admin-mono num-col">
                      {row.subsidized ? <span className="admin-econ-unknown">不收费</span> : row.credits + ' 积分'}
                    </td>
                    <td className="admin-mono num-col">{money(row.revenueMilli)}</td>
                    <td className="admin-mono num-col">
                      {row.costKnown ? money(row.unitCostMilli) : <span className="admin-econ-unknown">未定价</span>}
                      {!row.costKnown && row.calls ? <span className="admin-cell-note">{row.costReason}</span> : null}
                    </td>
                    <td className={'admin-mono num-col' + (row.marginMilli !== null && row.marginMilli < 0 ? ' admin-econ-neg' : '')}>
                      {row.marginMilli !== null && row.marginMilli < 0 ? '倒贴 ' + money(row.marginMilli) : signedMoney(row.marginMilli)}
                    </td>
                    <td className={'admin-mono num-col' + (row.marginPct !== null && row.marginPct < 0 ? ' admin-econ-neg' : '')}>{percentText(row.marginPct)}</td>
                    <td className="admin-cell-note">{windowCell(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-note">
            <p>这张表怎么算的 · 边界</p>
            <ul>
              {view.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </section>
  )
}
