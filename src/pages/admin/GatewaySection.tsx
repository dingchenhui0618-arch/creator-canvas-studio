import { useState } from 'react'
import { useApi } from './data'
import { Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'
import type { GatewayStatus } from '../../api/gateway'

const ENDPOINTS: { key: keyof GatewayStatus['endpoints']; label: string; note: string }[] = [
  { key: 'images', label: '出图', note: '同步返回 data[].url，画布直接取图' },
  { key: 'videoCreate', label: '出视频 · 建任务', note: '返回任务 id，画布按 id 轮询' },
  { key: 'videoPoll', label: '出视频 · 轮询', note: '回到建任务的那把 Key 查进度' },
]

/**
 * 生成通道：画布的出图 / 出视频请求经这里，按「能力 → 模型 → 优先级 → 权重」选平台 Key。
 * 这里只展示「开没开、有几把 Key、什么模型、跑着几个任务」——令牌与上游 Key 不出浏览器。
 */
export default function GatewaySection() {
  const state = useApi<GatewayStatus>('/api/admin/gateway')
  const [copied, setCopied] = useState('')

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied('已复制接入地址')
    } catch {
      setCopied('复制失败，请手动选择')
    }
  }

  const data = state.data

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">生成通道</p>
          <p className="admin-sub">
            画布的出图 / 出视频请求已经走这里：按能力选平台 Key 再转发上游。接口按火山方舟（Ark）形态实现，
            令牌与上游 Key 都不进浏览器。
          </p>
        </div>
        <div className="admin-row-actions">
          <RefreshButton onClick={state.reload} busy={state.loading} />
          <SourceTag kind="api" source="GET /api/admin/gateway" />
        </div>
      </div>

      {state.error ? (
        <ErrorBanner message={`GET /api/admin/gateway：${state.error}`} onRetry={state.reload} />
      ) : null}
      {state.loading && !data ? <LoadingLine label="/api/admin/gateway" /> : null}

      {data ? (
        <>
          <p className="admin-hint">
            <Badge tone={data.configured ? 'ok' : 'warn'}>{data.configured ? '通道已开启' : '通道未开启'}</Badge>{' '}
            出图 Key {data.keys.image} 把 · 出视频 Key {data.keys.video} 把 · 正在跑 {data.activeTasks} 个视频任务
            {data.models.image.length ? ` · 可出图模型 ${data.models.image.join(' / ')}` : ' · 还没有声明出图模型的 Key'}
            {data.models.video.length ? ` · 可出视频模型 ${data.models.video.join(' / ')}` : ''}
          </p>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>画布要的模型</th>
                  <th>现在谁接</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {data.coverage.map((row) => (
                  <tr key={row.model}>
                    <td>
                      <strong>{row.label}</strong>
                      <div className="admin-cell-sub admin-mono">{row.model}</div>
                    </td>
                    <td>
                      <Badge tone={row.ready ? 'ok' : 'warn'}>
                        {row.ready ? (row.coveredBy === 'generic' ? '通用 Key 接' : '已接入') : '缺 Key'}
                      </Badge>
                    </td>
                    <td className="admin-cell-sub">
                      {row.ready ? row.keys.map((key) => key.name).join(' / ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="admin-hint">
            {data.coverage.some((row) => !row.ready)
              ? '还不通：' +
                data.coverage
                  .filter((row) => !row.ready)
                  .map((row) => row.label)
                  .join('、') +
                '。补一把方舟 Key 就都通了——模型清单留空表示通用，或照上面一列的名字填。'
              : '三个出图模型都有人接，画布点哪个都能出图。'}
          </p>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>用途</th>
                  <th>接口</th>
                  <th>返回</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map((item) => (
                  <tr key={item.key}>
                    <td><strong>{item.label}</strong></td>
                    <td className="admin-mono">{data.endpoints[item.key]}</td>
                    <td className="admin-cell-sub">{item.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="admin-doc-row">
            <code>{data.baseUrl}</code>
            <div className="admin-doc-actions">
              <button type="button" className="admin-btn admin-btn--ghost" onClick={() => copy(data.baseUrl)}>
                复制接入地址
              </button>
            </div>
          </div>
          {copied ? <p className="admin-hint">{copied}</p> : null}
          <p className="admin-hint">
            {data.configured
              ? `服务令牌已配置（${data.tokenMasked}），画布侧用 Authorization: Bearer 调用。`
              : '服务令牌还没配置：通道会直接回 503，不会匿名放行。'}
            {data.keys.image === 0 && data.keys.video === 0
              ? ' 现在还没有声明出图 / 出视频能力的 Key：贴一把方舟 Key 并勾上对应能力，通道就能出图。'
              : ''}
          </p>

          {data.recentTasks.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table admin-table--routes">
                <thead>
                  <tr>
                    <th>视频任务</th>
                    <th>模型</th>
                    <th>走的 Key</th>
                    <th>创建于</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentTasks.map((task) => (
                    <tr key={task.id}>
                      <td className="admin-mono">{task.id}</td>
                      <td className="admin-mono">{task.model || '—'}</td>
                      <td>{task.keyName || '—'}</td>
                      <td className="admin-mono admin-nowrap">{task.ageSec} 秒前</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="还没有进行中的生成任务"
              description="画布发起出图 / 出视频后，这里会显示任务与它走的那把 Key。"
            />
          )}
        </>
      ) : null}
    </section>
  )
}
