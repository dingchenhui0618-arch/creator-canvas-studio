import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical, RefreshCw } from 'lucide-react'
import {
  agents as mockAgents,
  assets as mockAssets,
  initialEdges,
  initialNodes,
  recentReplications,
  reviewQueue,
  runs as mockRuns,
  workbenchTasks,
} from '../../data/mock'
import { countOf, formatClock, formatMs, itemsOf, probeJson } from './probe'
import type { ProbeResult } from './probe'

const LIVE_ENDPOINTS = [
  { id: 'templates', label: '模板库', path: '/api/templates' },
  { id: 'agents', label: '智能体', path: '/api/agents' },
  { id: 'flows', label: '画布流程', path: '/api/flows' },
  { id: 'runs', label: '运行记录', path: '/api/runs' },
]

type SampleRow = {
  name: string
  count: number
  where: string
  status: string
  note: string
}

const SAMPLES: SampleRow[] = [
  {
    name: 'reviewQueue',
    count: reviewQueue.length,
    status: '仍为示例',
    where: 'OverviewPage · 03 待评审',
    note: '评审接口已可用，但这里的 ' + reviewQueue.length + ' 条仍为硬编码示例',
  },
  {
    name: 'recentReplications',
    count: recentReplications.length,
    status: '时间写死',
    where: 'OverviewPage · 02 最近复刻',
    note: '注释称来自模板库，但「入库时间」等字段是写死的',
  },
  {
    name: 'workbenchTasks',
    count: workbenchTasks.length,
    status: '文案过期',
    where: 'OverviewPage · 01 今天要做什么',
    note: '第 2 条仍写「待接入」，与当前 /api/review/health 不一致',
  },
  {
    name: 'agents',
    count: mockAgents.length,
    status: '数量不一致',
    where: 'App 侧栏 badge + openAgent 查找',
    note: '侧栏仍显示示例数量，实际列表走 /api/agents',
  },
  {
    name: 'assets',
    count: mockAssets.length,
    status: '无接口',
    where: 'App · 资产库列表',
    note: '资产页全部是静态条目，没有真实上传接口',
  },
  {
    name: 'runs',
    count: mockRuns.length,
    status: '未使用',
    where: 'data/mock.ts 导出（当前页面未使用）',
    note: 'RunsPage 已改用 /api/runs',
  },
  {
    name: 'initialNodes',
    count: initialNodes.length,
    status: '示例',
    where: '画布初始节点',
    note: '首次进入画布的示例图，不代表已保存流程',
  },
  {
    name: 'initialEdges',
    count: initialEdges.length,
    status: '示例',
    where: '画布初始连线',
    note: '与 initialNodes 配套的示例连线',
  },
]

type TemplateRow = {
  id: string
  title: string
  platform: string
  contentType: string
  duration: number | null
  shots: number | null
}

function toTemplateRows(data: unknown): TemplateRow[] {
  return itemsOf(data).map((item) => {
    const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const structure = Array.isArray(record.structure) ? record.structure.length : null
    return {
      id: String(record.id ?? '—'),
      title: String(record.title ?? '—'),
      platform: String(record.platformLabel ?? record.platform ?? '—'),
      contentType: String(record.contentType ?? '—'),
      duration: typeof record.durationSec === 'number' ? record.durationSec : null,
      shots: structure,
    }
  })
}

export function FixturesSection() {
  const [live, setLive] = useState<Record<string, ProbeResult>>({})
  const [probing, setProbing] = useState(false)
  const [at, setAt] = useState('')
  const alive = useRef(true)
  const runId = useRef(0)

  const runProbe = useCallback(async () => {
    const id = ++runId.current
    setProbing(true)
    const pairs = await Promise.all(
      LIVE_ENDPOINTS.map(async (endpoint) => [endpoint.id, await probeJson(endpoint.path)] as const),
    )
    if (!alive.current || runId.current !== id) return
    setLive(Object.fromEntries(pairs))
    setAt(new Date().toISOString())
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

  const templates = useMemo(() => toTemplateRows(live.templates?.data), [live.templates])
  const mockTemplateIds = useMemo(() => new Set(recentReplications.map((item) => item.id)), [])
  const liveTemplateIds = useMemo(() => new Set(templates.map((row) => row.id)), [templates])
  const overlapped = templates.filter((row) => mockTemplateIds.has(row.id)).length
  const onlyLive = templates.length - overlapped
  const missingFromLive = recentReplications.filter((item) => !liveTemplateIds.has(item.id)).length
  const liveAgentTotal = countOf(live.agents?.data)
  const fetchFailed = LIVE_ENDPOINTS.filter((endpoint) => live[endpoint.id] && !live[endpoint.id].ok)

  return (
    <div className="lab-stack">
      <div className="lab-toolbar">
        <div className="lab-toolbar-copy">
          <span className="lab-mono">FIXTURE MAP</span>
          <span className="lab-dim">绿=真实接口，琥珀=示例数据，灰=未使用；左侧是 src/data/mock.ts，右侧是当前服务。</span>
        </div>
        <div className="lab-toolbar-actions">
          <span className="lab-mono">最近刷新：{at ? formatClock(at) : '尚未完成'}</span>
          <button type="button" className="lab-btn" onClick={() => void runProbe()} disabled={probing}>
            <RefreshCw size={13} className={probing ? 'lab-spin' : undefined} />
            {probing ? '读取中…' : '刷新对照'}
          </button>
        </div>
      </div>


      <div className="lab-grid lab-grid--fixtures">
        <section className="lab-panel">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">SAMPLE DATA</span>
              <h2>示例数据（{SAMPLES.length} 组 / {SAMPLES.reduce((sum, item) => sum + item.count, 0)} 条）</h2>
            </div>
            <span className="lab-mono">src/data/mock.ts</span>
          </div>
          <div className="lab-table-wrap">
            <table className="lab-table lab-table--compact">
              <thead>
                <tr>
                  <th>导出</th>
                  <th>条数</th>
                  <th>使用位置</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {SAMPLES.map((sample) => (
                  <tr key={sample.name}>
                    <td>
                      <span className="lab-mono">{sample.name}</span>
                    </td>
                    <td className="lab-mono">{sample.count}</td>
                    <td>{sample.where}</td>
                    <td>
                      <span className="lab-chip lab-chip--quiet" title={sample.note}>{sample.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lab-panel">
          <div className="lab-panel-head">
            <div>
              <span className="lab-panel-kicker">LIVE API</span>
              <h2>真实接口（当前进程）</h2>
            </div>
            <span className="lab-mono">{fetchFailed.length ? fetchFailed.length + ' 个失败' : '全部可用'}</span>
          </div>
          <div className="lab-table-wrap">
            <table className="lab-table lab-table--compact">
              <thead>
                <tr>
                  <th>接口</th>
                  <th>状态</th>
                  <th>条数</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {LIVE_ENDPOINTS.map((endpoint) => {
                  const result = live[endpoint.id]
                  return (
                    <tr key={endpoint.id} className={result && !result.ok ? 'is-fail' : undefined}>
                      <td>
                        <div className="lab-endpoint lab-endpoint--inline">
                          <strong>{endpoint.label}</strong>
                          <span className="lab-mono">{endpoint.path}</span>
                        </div>
                      </td>
                      <td>
                        <span className={'lab-status ' + (result ? (result.ok ? 'lab-status--ok' : 'lab-status--bad') : 'lab-status--idle')}>
                          <i aria-hidden="true" />
                          {result ? result.status || 'ERR' : '等待'}
                        </span>
                      </td>
                      <td className="lab-mono">{result?.ok ? (countOf(result.data) ?? '—') : '—'}</td>
                      <td className="lab-mono">{result ? formatMs(result.ms) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

        </section>
      </div>

      <div className="lab-callouts lab-callouts--strip">
        <div className={'lab-callout ' + (liveAgentTotal !== mockAgents.length ? 'lab-callout--warn' : '')}>
          <span className="lab-mono">AGENTS</span>
          <p>
            侧栏 badge 用 mock 的 <strong>{mockAgents.length}</strong> 条；/api/agents 实际
            <strong> {liveAgentTotal ?? '—'} </strong>条。
            {liveAgentTotal !== null && liveAgentTotal !== mockAgents.length
              ? ' 两个数字不一致，侧栏需要改读接口。'
              : ' 当前一致。'}
          </p>
        </div>
        <div className="lab-callout">
          <span className="lab-mono">TEMPLATES</span>
          <p>
            示例清单 {recentReplications.length} 条，接口 {templates.length || '—'} 条；交集 {overlapped} 条，
            只在接口里 {onlyLive} 条，接口里找不到的示例 {missingFromLive} 条。
          </p>
        </div>
      </div>

      <section className="lab-panel">
        <div className="lab-panel-head">
          <div>
            <span className="lab-panel-kicker">TEMPLATE CROSSCHECK</span>
            <h2>模板库 7 条真实模板 × 示例清单</h2>
          </div>
          <span className="lab-mono">
            {templates.length ? templates.length + ' 条真实模板' : probing ? '读取中' : '接口未返回'}
          </span>
        </div>
        {live.templates && !live.templates.ok ? (
          <div className="lab-alert lab-alert--bad">
            <FlaskConical size={14} />
            <span>/api/templates {live.templates.status || '请求失败'}：{live.templates.error || '没有返回数据'}</span>
          </div>
        ) : (
          <div className="lab-table-wrap">
            <table className="lab-table lab-table--compact lab-table--templates">
              <thead>
                <tr>
                  <th>模板 ID</th>
                  <th>标题</th>
                  <th>平台</th>
                  <th>类型</th>
                  <th>时长</th>
                  <th>镜头</th>
                  <th>在示例清单</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((row) => (
                  <tr key={row.id}>
                    <td className="lab-mono">{row.id}</td>
                    <td>{row.title}</td>
                    <td>{row.platform}</td>
                    <td>{row.contentType}</td>
                    <td className="lab-mono">{row.duration === null ? '—' : row.duration + 's'}</td>
                    <td className="lab-mono">{row.shots === null ? '—' : row.shots}</td>
                    <td>
                      <span className={'lab-chip ' + (mockTemplateIds.has(row.id) ? 'lab-chip--sample' : 'lab-chip--quiet')}>
                        {mockTemplateIds.has(row.id) ? '已列' : '仅接口'}
                      </span>
                    </td>
                  </tr>
                ))}
                {!templates.length && (
                  <tr>
                    <td colSpan={7} className="lab-dim">
                      {probing ? '正在读取 /api/templates…' : '接口没有返回模板条目。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="lab-footnote">
        <FlaskConical size={12} />
        <span>
          示例数组本身不做删改；这里只做清点与对照。真实模板数以 /api/templates 当前返回为准，模板库页面和 overview
          的「最近复刻」并不会自动同步。
        </span>
      </p>
    </div>
  )
}