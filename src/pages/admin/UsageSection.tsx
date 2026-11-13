import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatCost, getUsage, saveUsagePrices, type UsagePrices, type UsageResponse } from '../../api/usage'
import { formatDateTime } from './data'
import { AdminHead, Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton } from './ui'

// 成本页回答一个具体问题：这几天的钱花在哪个能力、哪个模型上。
// 三个刻意的决定：
//   1. 只展示 usage_events 里真实记过的事件，不按「调用次数 × 单价」反推次数；
//   2. 单价没填就显示「未定价」，不拿积分倍率当金额（两者没有换算关系）；
//   3. 历史回填单独标出来：它只有次数，没有 token 与张数，也不进金额。

const PRICE_FIELDS: { key: keyof UsagePrices; label: string; hint: string }[] = [
  { key: 'inPerMillion', label: '输入 token', hint: '元 / 百万 token' },
  { key: 'outPerMillion', label: '输出 token', hint: '元 / 百万 token' },
  { key: 'imagePerShot', label: '出图', hint: '元 / 张' },
  { key: 'videoPerSecond', label: '出视频', hint: '元 / 秒' },
  { key: 'judgePerCall', label: '判断模型', hint: '元 / 次' },
  { key: 'searchPerCall', label: '检索', hint: '元 / 次' },
  { key: 'replicatePerCall', label: '复刻', hint: '元 / 次' },
  { key: 'runPerCall', label: '画布运行', hint: '元 / 次' },
]

type Form = Record<keyof UsagePrices, string>

function formFrom(prices?: UsagePrices): Form {
  const source = prices || ({} as Partial<UsagePrices>)
  const next = {} as Form
  for (const field of PRICE_FIELDS) next[field.key] = String(source[field.key] ?? 0)
  return next
}

function unitLabel(unit: string): string {
  if (unit === 'token') return 'token'
  if (unit === 'image') return '张'
  if (unit === 'second') return '秒'
  return '次'
}

export default function UsageSection() {
  const [days, setDays] = useState(14)
  const [data, setData] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState<Form>(() => formFrom())
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    getUsage(days)
      .then((next) => {
        setData(next)
        setForm(formFrom(next.prices))
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '用量读取失败'))
      .finally(() => setLoading(false))
  }, [days])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const save = async () => {
    setSaving(true)
    setNote('')
    try {
      const patch: Partial<UsagePrices> = {}
      for (const field of PRICE_FIELDS) patch[field.key] = Number(form[field.key]) || 0
      const saved = await saveUsagePrices(patch)
      setNote(saved.priced ? '单价已保存：金额按新单价重算（已在页面刷新）' : '已保存，但单价全是 0：页面仍然只统计用量，不折算金额')
      load()
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '单价保存失败')
    } finally {
      setSaving(false)
    }
  }

  const totals = data?.totals
  const priced = Boolean(data?.priced)
  const dayMax = useMemo(() => Math.max(1, ...(data?.byDay || []).map((row) => row.calls)), [data])

  return (
    <>
      <AdminHead
        kicker="成本"
        title="用量与成本"
        description="每次模型调用、出图、出视频、检索都记一条事件：后台按能力、模型和日期看用量，单价由你填，金额只是估算口径，不是上游账单。"
        actions={
          <>
            <label className="vq-field admin-usage-range">
              <span>窗口</span>
              <select className="vq-input" value={days} onChange={(event) => setDays(Number(event.target.value))}>
                <option value={7}>近 7 天</option>
                <option value={14}>近 14 天</option>
                <option value={30}>近 30 天</option>
              </select>
            </label>
            <RefreshButton onClick={load} busy={loading} />
          </>
        }
      />

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/usage" /> : null}

      {data ? (
        <>
          <div className="admin-grid admin-grid--stats">
            <article className="admin-card admin-stat">
              <div className="admin-stat-top">
                <span className="admin-label">调用次数</span>
              </div>
              <p className="admin-value">{totals?.calls ?? 0}</p>
              <p className="admin-foot">
                成功 {totals?.okCalls ?? 0} · 失败 {totals?.failedCalls ?? 0}
              </p>
            </article>

            <article className="admin-card admin-stat">
              <div className="admin-stat-top">
                <span className="admin-label">估算成本</span>
              </div>
              <p className="admin-value admin-value--text">{priced ? '¥' + formatCost(totals?.estCostMilli || 0) : '未定价'}</p>
              <p className="admin-foot">{priced ? '按下方单价折算，不是上游账单' : '填好单价后按真实用量折算'}</p>
            </article>

            <article className="admin-card admin-stat">
              <div className="admin-stat-top">
                <span className="admin-label">出图 / 出视频</span>
              </div>
              <p className="admin-value">
                {totals?.images ?? 0}
                <span className="admin-value-unit"> 张</span>
              </p>
              <p className="admin-foot">出视频 {totals?.videoSeconds ?? 0} 秒（按提交口径）</p>
            </article>

            <article className="admin-card admin-stat">
              <div className="admin-stat-top">
                <span className="admin-label">窗口</span>
              </div>
              <p className="admin-value">{data.days} 天</p>
              <p className="admin-foot">
                {data.backfill.count ? '含历史回填 ' + data.backfill.count + ' 条（只有次数）' : '从这一版开始逐条记录'}
              </p>
            </article>
          </div>

          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">单价（估算口径）</p>
                <p className="admin-sub">
                  {data.priceNote} 保存只改金额折算，不动已有事件；改动会进审计。
                  {data.priceUpdatedAt ? ' 上次更新：' + formatDateTime(data.priceUpdatedAt) + (data.priceUpdatedBy ? ' · ' + data.priceUpdatedBy : '') : ''}
                </p>
              </div>
            </div>

            <div className="admin-price-form">
              {PRICE_FIELDS.map((field) => (
                <label key={field.key} className="vq-field admin-price-field">
                  <span>{field.label}</span>
                  <input
                    className="vq-input"
                    value={form[field.key]}
                    onChange={(event) => setForm((previous) => ({ ...previous, [field.key]: event.target.value }))}
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                  />
                  <small>{field.hint}</small>
                </label>
              ))}
              <div className="admin-doc-actions">
                <button type="button" className="vq-button" onClick={() => void save()} disabled={saving}>
                  {saving ? '保存中…' : '保存单价'}
                </button>
              </div>
            </div>
            {note ? <p className="admin-hint" role="status">{note}</p> : null}
          </section>

          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">按能力</p>
                <p className="admin-sub">同一窗口内的分布：哪类调用最多、失败几次、token 与张数各多少。</p>
              </div>
            </div>

            {data.byKind.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>能力</th>
                      <th className="admin-num">调用</th>
                      <th className="admin-num">失败</th>
                      <th className="admin-num">token（入 / 出）</th>
                      <th className="admin-num">数量</th>
                      <th className="admin-num">估算</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byKind.map((row) => (
                      <tr key={row.kind}>
                        <td>{row.label}</td>
                        <td className="admin-num admin-mono">{row.calls}</td>
                        <td className="admin-num admin-mono">{row.failedCalls || '—'}</td>
                        <td className="admin-num admin-mono">
                          {row.unit === 'token' ? (row.tokensIn || row.tokensOut ? row.tokensIn + ' / ' + row.tokensOut : '未回') : '—'}
                        </td>
                        <td className="admin-num admin-mono">
                          {row.unit === 'token' ? '—' : row.units + ' ' + unitLabel(row.unit)}
                        </td>
                        <td className="admin-num admin-mono">{priced ? '¥' + formatCost(row.estCostMilli) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="这个窗口还没有计量数据" description="跑一次评审、出一张图或检索一次，这里就会出现真实事件。" />
            )}
          </section>

          <div className="admin-grid admin-grid--two">
            <section className="admin-card admin-block">
              <div className="admin-block-head">
                <div>
                  <p className="admin-label">按天</p>
                  <p className="admin-sub">按服务器日期（UTC）归档；柱子高度是当天调用次数。</p>
                </div>
              </div>
              <ul className="admin-usage-days">
                {data.byDay.map((row) => (
                  <li key={row.day} className="admin-bar">
                    <span className="admin-mono">{row.day.slice(5)}</span>
                    <span className="admin-bar-track">
                      <span className="admin-bar-fill" style={{ width: (row.calls / dayMax) * 100 + '%' }} />
                    </span>
                    <span className="admin-mono admin-num">
                      {row.calls ? row.calls + ' 次' : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="admin-card admin-block">
              <div className="admin-block-head">
                <div>
                  <p className="admin-label">按模型</p>
                  <p className="admin-sub">模型名取上游回包或请求参数；「未标注模型」是检索、复刻这类非模型调用。</p>
                </div>
              </div>
              {data.byModel.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th className="admin-num">调用</th>
                        <th className="admin-num">token 入 / 出</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byModel.map((row) => (
                        <tr key={row.model}>
                          <td className="admin-mono">{row.model}</td>
                          <td className="admin-num admin-mono">{row.calls}</td>
                          <td className="admin-num admin-mono">
                            {row.tokensIn || row.tokensOut ? row.tokensIn + ' / ' + row.tokensOut : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="还没有模型调用" description="评审、智能体对话、画布运行都会记在这里。" />
              )}
            </section>
          </div>

          <section className="admin-card admin-block">
            <div className="admin-block-head">
              <div>
                <p className="admin-label">最近事件</p>
                <p className="admin-sub">最多 12 条：排查「这笔成本是哪来的」用；上游没回 usage 时 token 显示「未回」，不写成 0。</p>
              </div>
            </div>
            {data.recent.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>能力</th>
                      <th>模型</th>
                      <th className="admin-num">用量</th>
                      <th>作品 / 单据</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((row) => (
                      <tr key={row.id}>
                        <td className="admin-mono">{formatDateTime(row.at)}</td>
                        <td>{row.label}</td>
                        <td className="admin-mono">{row.model || '—'}</td>
                        <td className="admin-num admin-mono">
                          {row.unit === 'token'
                            ? row.tokensKnown
                              ? row.tokensIn + ' / ' + row.tokensOut
                              : '未回'
                            : row.units + ' ' + unitLabel(row.unit)}
                        </td>
                        <td className="admin-mono">{row.projectId || row.ref || '—'}</td>
                        <td>
                          <Badge tone={row.ok ? 'ok' : 'fail'}>{row.source === 'backfill' ? '历史回填' : row.ok ? '成功' : '失败'}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="还没有事件" description="计量写入不会阻塞业务：这里为空说明这个窗口确实没有调用。" />
            )}
          </section>

          <section className="admin-note">
            <p>口径与边界</p>
            <ul>
              <li>数字来自服务端 usage_events：评审、智能体对话、画布运行、出图、出视频、检索各记一条真实事件。</li>
              <li>金额 = 真实用量 × 你填的单价，是估算口径；上游账单打折、赠金、退款都不会自动同步进这里。</li>
              <li>余额与积分在「账号」页：积分是对用户的虚拟倍率，不是成本，两者不互相换算。</li>
              <li>出视频按提交时长记；上游失败后退款不会自动冲回，需要按上游账单人工核对。</li>
              <li>画布服务端自己的模型调用不经本平台通道，不在这个表里；画布只把出图/出视频转发过来。</li>
              {data.backfill.count ? <li>历史回填 {data.backfill.count} 条来自积分流水（计量上线前发生过），只有次数，没有 token 与张数，也不折算金额。</li> : null}
            </ul>
          </section>
        </>
      ) : null}
    </>
  )
}
