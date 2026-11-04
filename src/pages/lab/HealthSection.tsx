import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { formatClock, formatField, formatMs, pickField, probeJson } from './probe'
import type { ProbeResult } from './probe'

type FieldSpec = { label: string; path: string }

type Endpoint = {
  id: string
  name: string
  path: string
  hint: string
  fields: FieldSpec[]
}

const ENDPOINTS: Endpoint[] = [
  {
    id: 'health',
    name: '运行健康',
    path: '/api/health',
    hint: '服务端进程与模型 / 模板统计',
    fields: [
      { label: 'visionModel', path: 'visionModel' },
      { label: 'vision', path: 'vision' },
      { label: 'templates', path: 'templates' },
    ],
  },
  {
    id: 'bdc',
    name: 'BD Canvas 探活',
    path: '/api/bdc/status',
    hint: 'BD Canvas 三个本机入口',
    fields: [
      { label: 'deployed', path: 'deployed' },
      { label: 'web', path: 'web.status' },
      { label: 'api', path: 'api.status' },
    ],
  },
  {
    id: 'review',
    name: '评审服务',
    path: '/api/review/health',
    hint: '插件服务与本地模型是否可用',
    fields: [
      { label: 'service', path: 'service' },
      { label: 'model', path: 'model' },
      { label: 'profiles', path: 'profiles' },
    ],
  },
  {
    id: 'version',
    name: '版本',
    path: '/api/version',
    hint: '服务端 package.json 与启动时间',
    fields: [
      { label: 'version', path: 'version' },
      { label: 'startedAt', path: 'startedAt' },
    ],
  },
  {
    id: 'agents',
    name: '智能体',
    path: '/api/agents',
    hint: '真实落盘的自建智能体',
    fields: [
      { label: 'total', path: 'total' },
      { label: 'runs', path: 'runs' },
      { label: 'defaultModel', path: 'defaultModel' },
    ],
  },
  {
    id: 'flows',
    name: '画布流程',
    path: '/api/flows',
    hint: 'data/flows.json 中的流程',
    fields: [{ label: 'total', path: 'total' }],
  },
  {
    id: 'runs',
    name: '运行记录',
    path: '/api/runs',
    hint: 'data/runs.json 中的最近运行',
    fields: [{ label: 'total', path: 'total' }],
  },
  {
    id: 'templates',
    name: '模板库',
    path: '/api/templates',
    hint: 'data/templates.json 与帧图',
    fields: [{ label: 'total', path: 'total' }],
  },
]

function toneOf(value: unknown): 'ok' | 'bad' | 'idle' {
  if (value === false) return 'bad'
  if (typeof value === 'number' && value === 0) return 'bad'
  if (value === undefined || value === null) return 'idle'
  return 'ok'
}

export function HealthSection() {
  const [results, setResults] = useState<Record<string, ProbeResult>>({})
  const [probing, setProbing] = useState(false)
  const [lastAt, setLastAt] = useState('')
  const runId = useRef(0)
  const alive = useRef(true)

  const runProbe = useCallback(async () => {
    const id = ++runId.current
    setProbing(true)
    const pairs = await Promise.all(
      ENDPOINTS.map(async (endpoint) => [endpoint.id, await probeJson(endpoint.path)] as const),
    )
    if (!alive.current || runId.current !== id) return
    setResults(Object.fromEntries(pairs))
    setLastAt(new Date().toISOString())
    setProbing(false)
  }, [])

  useEffect(() => {
    alive.current = true
    const timer = window.setTimeout(() => {
      void runProbe()
    }, 0)
    return () => {
      alive.current = false
      window.clearTimeout(timer)
    }
  }, [runProbe])

  const rows = useMemo(() => ENDPOINTS.map((endpoint) => ({ endpoint, result: results[endpoint.id] })), [results])
  const finished = rows.filter((row) => Boolean(row.result))
  const failed = finished.filter((row) => !row.result?.ok)
  const slowest = finished.reduce<{ name: string; ms: number } | null>((current, row) => {
    if (!row.result) return current
    if (!current || row.result.ms > current.ms) return { name: row.endpoint.name, ms: row.result.ms }
    return current
  }, null)

  return (
    <div className="lab-stack">
      <div className="lab-toolbar">
        <div className="lab-toolbar-copy">
          <span className="lab-mono">8 个端点 · 并发 GET</span>
          <span className="lab-dim">单端点 4.5s 超时；这里只做探测，不改服务状态。</span>
        </div>
        <div className="lab-toolbar-actions">
          <span className="lab-mono">最近探测时间：{lastAt ? formatClock(lastAt) : '尚未完成'}</span>
          <button type="button" className="lab-btn lab-btn--ink" onClick={() => void runProbe()} disabled={probing}>
            <RefreshCw size={13} className={probing ? 'lab-spin' : undefined} />
            {probing ? '探测中…' : '全部重测'}
          </button>
        </div>
      </div>

      <div className="lab-metrics">
        <div className="lab-metric">
          <span className="lab-metric-label">通过</span>
          <strong>{finished.length - failed.length}</strong>
          <span className="lab-metric-foot">/ {ENDPOINTS.length} 端点</span>
        </div>
        <div className="lab-metric">
          <span className="lab-metric-label">失败</span>
          <strong className={failed.length ? 'lab-bad' : undefined}>{failed.length}</strong>
          <span className="lab-metric-foot">{failed.length ? '看下方错误列' : '没有失败请求'}</span>
        </div>
        <div className="lab-metric">
          <span className="lab-metric-label">最慢</span>
          <strong>{slowest ? formatMs(slowest.ms) : '—'}</strong>
          <span className="lab-metric-foot">{slowest?.name ?? '等待探测'}</span>
        </div>
        <div className="lab-metric">
          <span className="lab-metric-label">探测完成</span>
          <strong>{finished.length}</strong>
          <span className="lab-metric-foot">{finished.length ? '结果来自当前进程' : '尚未返回'}</span>
        </div>
      </div>

      <div className="lab-panel">
        <div className="lab-panel-head">
          <div>
            <span className="lab-panel-kicker">HEALTH MATRIX</span>
            <h2>接口体检</h2>
          </div>
          <span className="lab-mono">{formatClock(lastAt)}</span>
        </div>
        <div className="lab-table-wrap">
          <table className="lab-table lab-table--health">
            <thead>
              <tr>
                <th>端点</th>
                <th>状态</th>
                <th>耗时</th>
                <th>关键字段</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ endpoint, result }) => (
                <tr key={endpoint.id} className={result && !result.ok ? 'is-fail' : undefined}>
                  <td>
                    <div className="lab-endpoint" title={endpoint.hint}>
                      <strong>{endpoint.name}</strong>
                      <span className="lab-mono">{endpoint.path}</span>
                    </div>
                  </td>
                  <td>
                    {result ? (
                      <span className={'lab-status ' + (result.ok ? 'lab-status--ok' : 'lab-status--bad')}>
                        <i aria-hidden="true" />
                        {result.status || 'ERR'}
                        <em>{result.ok ? 'OK' : '失败'}</em>
                      </span>
                    ) : (
                      <span className="lab-status lab-status--idle">
                        <i aria-hidden="true" />
                        {probing ? '探测中' : '等待'}
                      </span>
                    )}
                  </td>
                  <td className="lab-mono">{result ? formatMs(result.ms) : '—'}</td>
                  <td>
                    <div className="lab-fields">
                      {endpoint.fields.map((field) => {
                        const value = result ? pickField(result.data, field.path) : undefined
                        return (
                          <span className={'lab-field lab-field--' + toneOf(value)} key={field.label}>
                            <em>{field.label}</em>
                            {result ? formatField(value) : '—'}
                          </span>
                        )
                      })}
                    </div>
                  </td>
                  <td className={result && !result.ok ? 'lab-bad lab-error-cell' : 'lab-dim'}>
                    {result ? result.error || '—' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="lab-footnote">
        <Activity size={12} />
        <span>
          探测时间与耗时均来自浏览器 performance 计时；后端进程未启动、端口拒绝或字段缺失都会如实显示为失败 / 空值，不做兜底。
        </span>
      </p>
    </div>
  )
}