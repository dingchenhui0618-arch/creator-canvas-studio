import { Check, CircleAlert, CircleDashed, CircleSlash, Loader, X } from 'lucide-react'
import { NODE_META } from './catalog'
import type { RunNodeResult, RunRecord } from '../api/flows'
import { useUiMode } from '../api/app'

type RunDrawerProps = {
  open: boolean
  running: boolean
  flowName: string
  runId: string
  total: number
  nodes: RunNodeResult[]
  record: RunRecord | null
  error: string
  onClose: () => void
  onSelectNode: (nodeId: string) => void
}

const STATUS_LABEL: Record<string, string> = {
  success: '完成',
  error: '失败',
  skipped: '已跳过',
  unsupported: '不支持',
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return ms + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'success') return <Check size={13} strokeWidth={2} />
  if (status === 'error') return <CircleAlert size={13} strokeWidth={1.5} />
  if (status === 'skipped') return <CircleSlash size={13} strokeWidth={1.5} />
  if (status === 'unsupported') return <CircleDashed size={13} strokeWidth={1.5} />
  return <Loader size={13} strokeWidth={1.5} />
}

function nodeOutputText(output: RunNodeResult['output']): string {
  if (!output) return ''
  const text = output.text
  return typeof text === 'string' ? text : ''
}

export function RunDrawer({ open, running, flowName, runId, total, nodes, record, error, onClose, onSelectNode }: RunDrawerProps) {
  const { internal } = useUiMode()
  const progress = total > 0 ? Math.round((nodes.length / total) * 100) : 0
  const duration = record ? record.durationMs : nodes.reduce((sum, node) => sum + (node.ms || 0), 0)
  const statusText = running ? 'RUNNING' : record ? (record.status === 'success' ? 'DONE' : 'ERROR') : error ? 'ERROR' : 'IDLE'
  const statusClass = running ? 'is-running' : record?.status === 'error' || error ? 'is-error' : record ? 'is-done' : 'is-idle'

  return (
    <aside className={`cv-drawer ${open ? 'is-open' : ''}`} aria-label="运行结果" aria-hidden={!open}>
      <header className="cv-drawer-head">
        <div>
          <span className="cv-kicker">运行结果</span>
          <strong>{flowName || '当前流程'}</strong>
        </div>
        <div className="cv-drawer-head-right">
          <span className={`cv-run-badge ${statusClass}`}>{statusText}</span>
          <button className="cv-icon-btn" type="button" onClick={onClose} aria-label="关闭运行结果"><X size={14} /></button>
        </div>
      </header>

      <div className="cv-drawer-meta">
        <span className="cv-mono">{runId || '尚未运行'}</span>
        <span>{formatMs(duration)}</span>
        <span>{nodes.length} / {total || nodes.length} 节点</span>
        {record?.credits && record.credits.cost > 0 ? (
          <span>{record.credits.refunded ? '已退回 ' + record.credits.cost + ' 积分' : '消耗 ' + record.credits.cost + ' 积分'}</span>
        ) : null}
      </div>
      <div className="cv-drawer-progress"><span style={{ width: progress + '%' }} /></div>

      <div className="cv-drawer-body">
        {error && (
          <div className="cv-drawer-error">
            <CircleAlert size={14} />
            <div>
              <strong>运行失败</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        {!nodes.length && !error && (
          <div className="cv-drawer-empty">
            {running ? <p>已提交运行，等待第一个节点返回…</p> : <p>点「运行流程」后，这里会按节点顺序显示状态、耗时和输出。</p>}
          </div>
        )}

        <ol className="cv-run-list">
          {nodes.map((node, index) => (
            <li className={`cv-run-item is-${node.status}`} key={node.id}>
              <button type="button" className="cv-run-item-head" onClick={() => onSelectNode(node.id)}>
                <span className="cv-run-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="cv-run-status"><StatusIcon status={node.status} /></span>
                <span className="cv-run-title">
                  <strong>{node.title}</strong>
                  <span className="cv-mono">{NODE_META[node.kind]?.mono ?? node.kind}</span>
                </span>
                <span className="cv-run-ms">{formatMs(node.ms)}</span>
                <span className="cv-run-state">{STATUS_LABEL[node.status] ?? node.status}</span>
              </button>
              {node.error && <p className="cv-run-error">{node.error}</p>}
              {!node.error && nodeOutputText(node.output) && <pre className="cv-run-output">{nodeOutputText(node.output)}</pre>}
              {!node.error && !nodeOutputText(node.output) && node.message && <p className="cv-run-message">{node.message}</p>}
            </li>
          ))}
        </ol>

        {record?.output && (
          <section className="cv-run-final">
            <div className="cv-section-title">最终输出</div>
            <pre className="cv-run-output cv-run-output--final">{record.output}</pre>
          </section>
        )}
      </div>

      <footer className="cv-drawer-foot">
        <span>{internal ? '运行记录写入 data/runs.json' : '运行记录保存在你的账号下'}</span>
        <span className="cv-mono">{internal ? 'GET /api/runs' : '最近一次运行'}</span>
      </footer>
    </aside>
  )
}
