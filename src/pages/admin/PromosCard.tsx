// 运营位后台编辑卡（r320）：服务端是唯一真源，这里只负责把整份列表改完再写回。
//
// 为什么是「整份覆盖」而不是逐条接口：运营位的顺序、权重、条数上限是一起生效的，
// 逐条保存会出现中间状态（删了旧的、新的还没进）。草稿留在页面里，点保存才一次性提交。
// 保存时按行序重算 weight：第 1 行最高，下一行依次 -10；同权重时服务端按数组顺序稳定排序。
import { useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, Plus, RotateCcw, Save, Sparkles, Trash2, X } from 'lucide-react'
import { request } from '../../api/client'
import { pageLabels, type Page } from '../../domain/types'
import { useApi, formatDateTime } from './data'
import { Badge, ErrorBanner, LoadingLine, SourceTag } from './ui'
import '../../styles/promos.css'

type Promo = {
  id: string
  placement: string
  weight: number
  kicker: string
  title: string
  body: string
  cta: string
  page: string
  from: string
  until: string
  internal: boolean
}

type PromoLimits = {
  total: number
  perPlacement: number
  id: number
  kicker: number
  title: number
  body: number
  cta: number
}

type PromoPlacement = { value: string; label: string }

type PromosResponse = {
  ok: boolean
  promos: Promo[]
  source: 'admin' | 'default' | 'error'
  error?: string
  updatedAt?: string
  updatedBy?: string
  limits: PromoLimits
  placements: PromoPlacement[]
  pages: string[]
}

const SOURCE_LABEL = {
  admin: { tone: 'ok' as const, label: '后台编辑' },
  default: { tone: 'neutral' as const, label: '默认内容' },
  error: { tone: 'fail' as const, label: '读不出来' },
}

function withOrderWeights(rows: Promo[]): Promo[] {
  const total = rows.length
  return rows.map((row, index) => ({ ...row, weight: (total - index) * 10 }))
}

function trimPromo(row: Promo): Promo {
  return {
    ...row,
    id: row.id.trim(),
    kicker: row.kicker.trim(),
    title: row.title.trim(),
    body: row.body.trim(),
    cta: row.cta.trim(),
  }
}

/** 前端先挡一遍最常见的手误；服务端仍会逐条校验，这里只是少一次白等的往返。 */
function validatePromos(rows: Promo[], data: PromosResponse): string {
  const limits = data.limits
  if (rows.length > limits.total) return '最多 ' + limits.total + ' 条，现在有 ' + rows.length + ' 条'
  for (const [index, row] of rows.entries()) {
    const prefix = '第 ' + (index + 1) + ' 条：'
    if (!row.id) return prefix + 'ID 不能为空'
    if (!/^[a-z0-9-]+$/.test(row.id)) return prefix + 'ID 只能用小写英文、数字和横杠'
    if (row.id.length > limits.id) return prefix + 'ID 最多 ' + limits.id + ' 个字符'
    if (!row.placement) return prefix + '请选择位置'
    if (!data.placements.some((item) => item.value === row.placement)) return prefix + '位置不在白名单里'
    if (!row.page) return prefix + '请选择跳转页面'
    if (!data.pages.includes(row.page)) return prefix + '跳转页面不在白名单里'
    if (!row.kicker) return prefix + '小标签不能为空'
    if (!row.title) return prefix + '标题不能为空'
    if (!row.body) return prefix + '一句话说明不能为空'
    if (!row.cta) return prefix + '按钮文字不能为空'
    if (row.kicker.length > limits.kicker) return prefix + '小标签最多 ' + limits.kicker + ' 个字符'
    if (row.title.length > limits.title) return prefix + '标题最多 ' + limits.title + ' 个字符'
    if (row.body.length > limits.body) return prefix + '一句话最多 ' + limits.body + ' 个字符'
    if (row.cta.length > limits.cta) return prefix + '按钮文字最多 ' + limits.cta + ' 个字符'
    if (row.from && row.until && row.from > row.until) return prefix + '起始日不能晚于截止日'
  }
  const ids = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.id)) return 'ID 不能重复：' + row.id
    ids.add(row.id)
  }
  const perPlacement = new Map<string, number>()
  for (const row of rows) perPlacement.set(row.placement, (perPlacement.get(row.placement) || 0) + 1)
  for (const [placement, count] of perPlacement) {
    if (count > limits.perPlacement) {
      const label = data.placements.find((item) => item.value === placement)?.label || placement
      return '「' + label + '」最多 ' + limits.perPlacement + ' 条，现在有 ' + count + ' 条'
    }
  }
  return ''
}

export default function PromosCard() {
  const { data, error, loading, reload } = useApi<PromosResponse>('/api/admin/promos')
  // draft 为空 = 还在看接口值；一动手才生成草稿。保存 / 恢复默认后丢草稿，重新以服务端为准。
  const [draft, setDraft] = useState<Promo[] | null>(null)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [conflict, setConflict] = useState(false)

  const stored = data?.promos ?? []
  const list = draft ?? [...stored].sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
  const limits = data?.limits
  const placements = data?.placements ?? []
  const pages = data?.pages ?? []
  const preview = list[0] || null
  const source = data?.source ? SOURCE_LABEL[data.source] : null
  const canReset = data?.source === 'admin'

  const updateRow = (index: number, patch: Partial<Promo>) => {
    setDraft(list.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }

  const moveRow = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= list.length) return
    const next = [...list]
    const current = next[index]
    next[index] = next[target]
    next[target] = current
    setDraft(withOrderWeights(next))
  }

  const removeRow = (index: number) => {
    setDraft(withOrderWeights(list.filter((_, rowIndex) => rowIndex !== index)))
    setNote('')
  }

  const addRow = () => {
    const next: Promo = {
      id: '',
      placement: placements[0]?.value || '',
      weight: (list.length + 1) * 10,
      kicker: '',
      title: '',
      body: '',
      cta: '',
      page: pages.includes('overview') ? 'overview' : pages[0] || '',
      from: '',
      until: '',
      internal: false,
    }
    setDraft(withOrderWeights([...list, next]))
    setNote('')
  }

  const save = async (force = false) => {
    if (!data || busy) return
    const rows = withOrderWeights(list).map(trimPromo)
    const problem = validatePromos(rows, data)
    if (problem) {
      setNote(problem)
      return
    }
    setBusy(force ? 'force' : 'save')
    setNote('')
    try {
      await request<PromosResponse>('/api/admin/promos', {
        method: 'PUT',
        body: JSON.stringify({ promos: rows, ...(force ? { force: true } : {}) }),
      })
      setDraft(null)
      setConflict(false)
      setNote('已保存 ' + rows.length + ' 条运营位；用户刷新页面后生效。')
      reload()
    } catch (cause) {
      const failure = cause as Error & { status?: number; body?: { conflict?: boolean; error?: string } }
      if (failure.status === 409 || failure.body?.conflict) setConflict(true)
      setNote(failure.message || '保存失败')
    } finally {
      setBusy('')
    }
  }

  const reset = async () => {
    if (!data || busy) return
    setBusy('clear')
    setNote('')
    try {
      await request<PromosResponse>('/api/admin/promos', { method: 'DELETE' })
      setDraft(null)
      setConflict(false)
      setNote('已恢复默认内容；用户刷新页面后生效。')
      reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '恢复默认失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">运营位</p>
          <p className="admin-sub">
            工作台 / 模板库顶部的动态条。改完保存，用户刷新页面就生效，不用发版；一个位置最多显示 2 条，关掉一条下一条补位。
            文案只说已经真跑通过的能力，涉及扣费要写明扣多少、失败怎么办。
          </p>
        </div>
        <div className="admin-alert-actions">
          <SourceTag kind="api" source="GET /api/admin/promos" />
          {source ? <Badge tone={source.tone}>{source.label}</Badge> : null}
        </div>
      </div>

      {loading && !data ? <LoadingLine label="/api/admin/promos" /> : null}
      {error ? <ErrorBanner message={error} onRetry={reload} title="运营位读取失败" /> : null}

      {data?.source === 'default' ? (
        <p className="admin-hint">现在显示的是默认内容，保存后才会存进数据目录。</p>
      ) : null}

      {data?.source === 'error' ? (
        <p className="admin-hint admin-hint--fail">
          {data.error || '运营位文件读不出来'}
          <br />
          现在页面显示的是默认内容；直接保存会被拒，确认要覆盖请用下面的「覆盖坏文件」。
        </p>
      ) : null}

      {data?.updatedAt ? (
        <p className="admin-cell-sub admin-mono">
          上次保存 {formatDateTime(data.updatedAt)}
          {data.updatedBy ? ' · ' + data.updatedBy : ''}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="admin-promo-toolbar">
            <span className="admin-cell-sub">
              {list.length} 条
              {limits ? ' · 最多 ' + limits.total + ' 条 / 每个位置 ' + limits.perPlacement + ' 条' : ''}
            </span>
            <button type="button" className="vq-button vq-button--ghost" onClick={addRow} disabled={Boolean(busy)}>
              <Plus size={14} />
              新增一条
            </button>
          </div>

          <fieldset className="admin-promo-fieldset" disabled={Boolean(busy)}>
            {list.length ? (
              <ul className="admin-alert-list admin-promo-list">
                {list.map((row, index) => (
                  <li className="admin-promo-row" key={'promo-' + index}>
                    <div className="admin-promo-row-head">
                      <div className="admin-promo-row-title">
                        <strong>第 {index + 1} 条</strong>
                        <span className="admin-cell-sub admin-mono">{row.id || '新草稿'}</span>
                      </div>
                      <div className="admin-promo-row-actions">
                        <button
                          type="button"
                          className="vq-button vq-button--ghost"
                          onClick={() => moveRow(index, -1)}
                          disabled={index === 0}
                          aria-label="上移这一条"
                          title="上移"
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="vq-button vq-button--ghost"
                          onClick={() => moveRow(index, 1)}
                          disabled={index === list.length - 1}
                          aria-label="下移这一条"
                          title="下移"
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          type="button"
                          className="vq-button vq-button--danger"
                          onClick={() => removeRow(index)}
                          aria-label="删除这一条"
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    <div className="admin-promo-fields">
                      <label className="vq-field admin-promo-field admin-promo-field--id">
                        <span>ID</span>
                        <input
                          className="vq-input admin-mono"
                          value={row.id}
                          maxLength={limits?.id}
                          placeholder="例如 rooms-beta"
                          onChange={(event) => updateRow(index, { id: event.target.value })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>位置</span>
                        <select
                          className="vq-input"
                          value={row.placement}
                          onChange={(event) => updateRow(index, { placement: event.target.value })}
                        >
                          {placements.map((item) => (
                            <option key={item.value} value={item.value}>{item.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>跳转页面</span>
                        <select
                          className="vq-input"
                          value={row.page}
                          onChange={(event) => updateRow(index, { page: event.target.value })}
                        >
                          {pages.map((page) => (
                            <option key={page} value={page}>{pageLabels[page as Page] || page}</option>
                          ))}
                        </select>
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>权重</span>
                        <input
                          className="vq-input"
                          type="number"
                          step={10}
                          value={row.weight}
                          onChange={(event) => updateRow(index, { weight: Number(event.target.value) || 0 })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>小标签</span>
                        <input
                          className="vq-input"
                          value={row.kicker}
                          maxLength={limits?.kicker}
                          placeholder="例如 Beta · 聊天室"
                          onChange={(event) => updateRow(index, { kicker: event.target.value })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>按钮文字</span>
                        <input
                          className="vq-input"
                          value={row.cta}
                          maxLength={limits?.cta}
                          placeholder="例如 去聊天室"
                          onChange={(event) => updateRow(index, { cta: event.target.value })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>起始日</span>
                        <input
                          className="vq-input"
                          type="date"
                          value={row.from}
                          onChange={(event) => updateRow(index, { from: event.target.value })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field">
                        <span>截止日</span>
                        <input
                          className="vq-input"
                          type="date"
                          value={row.until}
                          onChange={(event) => updateRow(index, { until: event.target.value })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field admin-promo-field--title">
                        <span>标题</span>
                        <input
                          className="vq-input"
                          value={row.title}
                          maxLength={limits?.title}
                          placeholder="一句话说清点进去能拿到什么"
                          onChange={(event) => updateRow(index, { title: event.target.value })}
                        />
                      </label>
                      <label className="vq-field admin-promo-field admin-promo-field--body">
                        <span>一句话说明</span>
                        <input
                          className="vq-input"
                          value={row.body}
                          maxLength={limits?.body}
                          placeholder="涉及扣费就写扣多少、失败怎么办"
                          onChange={(event) => updateRow(index, { body: event.target.value })}
                        />
                      </label>
                    </div>

                    <div className="admin-promo-row-foot">
                      <label className="admin-promo-check">
                        <input
                          type="checkbox"
                          checked={row.internal}
                          onChange={(event) => updateRow(index, { internal: event.target.checked })}
                        />
                        <span>只给管理员看（内部口径）</span>
                      </label>
                      <span className="admin-cell-sub">保存时按行序重排权重：第 1 行最高，依次 -10</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="admin-hint">还没有运营位：点「新增一条」写第一条，或恢复默认内容。</p>
            )}
          </fieldset>

          {note ? <p className="admin-hint" role="status">{note}</p> : null}

          <div className="admin-doc-actions admin-promo-actions">
            <button type="button" className="vq-button" onClick={() => void save()} disabled={Boolean(busy)}>
              <Save size={14} />
              {busy === 'save' ? '保存中…' : '保存运营位'}
            </button>
            {conflict ? (
              <button type="button" className="vq-button vq-button--danger" onClick={() => void save(true)} disabled={Boolean(busy)}>
                {busy === 'force' ? '覆盖中…' : '覆盖坏文件'}
              </button>
            ) : null}
            <button
              type="button"
              className="vq-button vq-button--ghost"
              onClick={() => void reset()}
              disabled={Boolean(busy) || !canReset}
              title={canReset ? '删掉后台保存的运营位，回到默认内容' : '当前没有后台保存的内容'}
            >
              <RotateCcw size={14} />
              {busy === 'clear' ? '恢复中…' : '恢复默认'}
            </button>
          </div>

          <div className="admin-promo-preview">
            <span className="admin-cell-sub">实时预览 · 第 1 条</span>
            {preview ? (
              <article className="vq-promo vq-lift">
                <span className="vq-promo-icon" aria-hidden="true">
                  <Sparkles size={16} />
                </span>
                <div className="vq-promo-copy">
                  <span className="vq-promo-kicker">{preview.kicker || '小标签'}</span>
                  <h3 className="vq-promo-title">{preview.title || '运营位标题'}</h3>
                  <p className="vq-promo-body">{preview.body || '一句话说明会显示在这里。'}</p>
                </div>
                <button type="button" className="vq-button vq-button--ghost vq-promo-cta" disabled>
                  {preview.cta || '按钮'}
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
                <button type="button" className="vq-promo-close" disabled aria-hidden="true" tabIndex={-1}>
                  <X size={14} aria-hidden="true" />
                </button>
              </article>
            ) : (
              <p className="admin-hint">新增一条后，这里会按真实运营位的样式预览文案长短。</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  )
}
