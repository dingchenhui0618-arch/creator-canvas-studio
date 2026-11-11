import { useState } from 'react'
import { formatDateTime, useApi } from './data'
import { Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'
import {
  previewModelRoute,
  type RouteKeyRow,
  type RouteList,
  type RoutePreview,
} from '../../api/modelKeys'

const CAPABILITIES = [
  { id: 'text', label: '文本' },
  { id: 'vision', label: '视觉' },
  { id: 'image', label: '出图' },
  { id: 'video', label: '出视频' },
]

function capabilityLabel(id: string) {
  return CAPABILITIES.find((item) => item.id === id)?.label || id
}

function sourceLabel(source: string) {
  if (source === 'pool') return 'Key 池'
  if (source === 'env') return '环境变量旧凭证'
  return '没有可用 Key'
}

type KeyBadge = { tone: 'ok' | 'warn' | 'neutral' | 'fail'; text: string }

function keyBadge(key: RouteKeyRow, group: RouteKeyRow[]): KeyBadge {
  if (key.state !== 'eligible') return { tone: key.state === 'cooling' ? 'warn' : 'neutral', text: key.reason }
  if (!group.some((item) => item.id === key.id)) return { tone: 'neutral' as const, text: key.reason }
  if (group.length === 1) return { tone: 'ok' as const, text: '会用这把' }
  return { tone: 'ok' as const, text: '候选 · 约 ' + (key.share ?? 0) + '%' }
}

/**
 * 路由决策：预演「现在调一次会走哪把」，以及「刚才那次真实调用走了哪把」。
 * 判定与真实调用共用服务端同一套规则，所以这里写什么，实际就按什么选。
 */
export default function ModelRoutePanel() {
  const routes = useApi<RouteList>('/api/admin/model-keys/routes?limit=50')
  const [capability, setCapability] = useState('text')
  const [model, setModel] = useState('')
  const [preview, setPreview] = useState<RoutePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const runPreview = async () => {
    if (busy) return
    setBusy(true)
    setPreviewError('')
    try {
      setPreview(await previewModelRoute({ capability, model: model.trim() }))
    } catch (cause) {
      setPreview(null)
      setPreviewError(cause instanceof Error ? cause.message : '预演失败')
    } finally {
      setBusy(false)
    }
  }

  const summary = routes.data?.summary

  return (
    <>
      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">路由预演</p>
            <p className="admin-sub">
              改完 Key 先预演：现在调一次会落在哪把、为什么跳过别的。判定和真实调用是同一套规则，预演说走哪把，实际就按这个选。
            </p>
          </div>
          <SourceTag kind="api" source="POST /api/admin/model-keys/preview" />
        </div>

        <div className="admin-route-form">
          <label className="admin-edit-field">
            <span>能力</span>
            <select value={capability} onChange={(event) => setCapability(event.target.value)}>
              {CAPABILITIES.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label className="admin-edit-field">
            <span>模型（留空 = 不看模型，只按能力选）</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="例如 deepseek-flash"
            />
          </label>
          <button type="button" className="admin-btn admin-btn--primary" onClick={runPreview} disabled={busy}>
            {busy ? '预演中…' : '预演路由'}
          </button>
        </div>

        {previewError ? <p className="admin-hint" role="alert">{previewError}</p> : null}
        {preview ? <p className="admin-route-result">{preview.description}</p> : null}

        {preview && preview.keys.length === 0 ? (
          <EmptyState
            title="Key 池里没有可用的 Key"
            description="这次调用会回落到环境变量里的旧凭证；环境变量也没配就会直接报「未配置模型凭证」。"
          />
        ) : null}

        {preview && preview.keys.length > 0 ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>优先级 · 权重</th>
                  <th>这次调用</th>
                </tr>
              </thead>
              <tbody>
                {preview.keys.map((key) => {
                  const badge = keyBadge(key, preview.group)
                  return (
                    <tr key={key.id}>
                      <td>
                        <strong>{key.name}</strong>
                        <span className="admin-cell-sub admin-mono">{key.provider}</span>
                      </td>
                      <td className="admin-mono admin-nowrap">P{key.priority} · W{key.weight}</td>
                      <td>
                        <Badge tone={badge.tone}>{badge.text}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="admin-card admin-block">
        <div className="admin-block-head">
          <div>
            <p className="admin-label">最近路由</p>
            <p className="admin-sub">
              每次真实模型调用记一条：走了哪把 Key、为什么、多快、成没成。出图 / 出视频一把失败会自动换下一把，
              每次尝试各记一条，能看出是第几把接住的。只存在内存里，重启清空；不含 Key 明文，也不含对话内容。
            </p>
          </div>
          <div className="admin-row-actions">
            <RefreshButton onClick={routes.reload} busy={routes.loading} />
            <SourceTag kind="api" source="GET /api/admin/model-keys/routes" />
          </div>
        </div>

        {routes.error ? (
          <ErrorBanner message={`GET /api/admin/model-keys/routes：${routes.error}`} onRetry={routes.reload} />
        ) : null}
        {routes.loading && !routes.data ? <LoadingLine label="/api/admin/model-keys/routes" /> : null}

        {routes.data && summary ? (
          <>
            <p className="admin-hint">
              本次运行 {summary.total} 次 · 成功 {summary.ok} · 失败 {summary.fail} · 平均 {summary.avgMs} ms
              {summary.failover ? ` · 换 Key 成功 ${summary.failover} 次` : ''}
              {summary.env ? ` · 回落环境变量 ${summary.env} 次` : ''}
              {summary.none ? ` · 没有可用 Key ${summary.none} 次` : ''}
              {summary.lastAt ? ` · 最近一次 ${formatDateTime(summary.lastAt)}` : ''}
            </p>
            {summary.byKey.length ? (
              <p className="admin-hint admin-mono">
                {summary.byKey
                  .map(
                    (item) =>
                      `${item.keyName || sourceLabel('none')} ${item.count} 次（成功 ${item.ok} / 失败 ${item.fail}，平均 ${item.avgMs} ms）`,
                  )
                  .join(' · ')}
              </p>
            ) : null}

            {routes.data.items.length === 0 ? (
              <EmptyState
                title="还没有路由记录"
                description="发起一次对话或视觉评审，这里会记下那次调用走的是哪把 Key。"
              />
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table admin-table--routes">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>能力 · 模型</th>
                      <th>走的是哪把</th>
                      <th>耗时</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routes.data.items.map((item) => (
                      <tr key={item.id}>
                        <td className="admin-mono admin-nowrap">{formatDateTime(item.at)}</td>
                        <td>
                          <strong>{capabilityLabel(item.capability)}</strong>
                          <span className="admin-cell-sub admin-mono">
                            {item.model || '（未指定模型）'}
                            {item.attempt > 1 ? ` · 第 ${item.attempt} 次尝试` : ''}
                          </span>
                        </td>
                        <td>
                          <strong>{item.keyName || sourceLabel(item.source)}</strong>
                          <span className="admin-cell-sub">{item.reason}</span>
                        </td>
                        <td className="admin-mono admin-nowrap">{item.ms} ms</td>
                        <td>
                          <Badge tone={item.ok ? 'ok' : 'fail'}>{item.ok ? '成功' : '失败'}</Badge>
                          {item.error ? (
                            <span className="admin-key-test" title={item.detail || item.error}>
                              {item.error}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </section>
    </>
  )
}
