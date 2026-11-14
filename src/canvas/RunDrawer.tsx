import { Check, CircleAlert, CircleDashed, CircleSlash, Loader, X } from 'lucide-react'
import { NODE_META } from './catalog'
import type { RunNodeResult, RunRecord, RunResumePlan } from '../api/flows'
import { useUiMode } from '../api/app'
import { runResumeInfo } from '../domain/run'
import { Pill } from '../components/ui'

type RunDrawerProps = {
  open: boolean
  running: boolean
  flowName: string
  runId: string
  total: number
  nodes: RunNodeResult[]
  record: RunRecord | null
  /** 停止 / 失败后还能接着跑的那条运行（v0.9.102）：有它才显示「继续」 */
  resume?: RunRecord | null
  /** 续跑预检（v0.9.103）：画布改过之后，旧记录里的跑完数不等于还能复用数 */
  resumePlan?: RunResumePlan | null
  onResume?: () => void
  /** 画布改到没有可复用节点时，抽屉里直接给「从头运行」 */
  onRestart?: () => void
  /** 这次运行之前排了多久（v0.9.96）；0 = 没排队，不写这一项 */
  queuedMs?: number
  /** 正在排队时的名次（v0.9.96）：顶栏被运行抽屉盖住时，这里也要说清「在第几位等」 */
  queue?: { position: number; waitedMs: number; waiting: number } | null
  /** 排队已等了几秒（页面自己的秒表，和顶栏胶囊同一个数） */
  queueElapsed?: number
  /** 刚取消过排队：空状态写清「没跑、没扣积分」，别让抽屉看起来像一次失败 */
  cancelled?: boolean
  /** 排队时可以在这里退出（v0.9.97）：顶栏被抽屉盖住时，这个入口仍然够得着 */
  onCancelQueue?: () => void
  error: string
  onClose: () => void
  onSelectNode: (nodeId: string) => void
}

const STATUS_LABEL: Record<string, string> = {
  success: '完成',
  error: '失败',
  interrupted: '中断',
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
  if (status === 'error' || status === 'interrupted') return <CircleAlert size={13} strokeWidth={1.5} />
  if (status === 'skipped') return <CircleSlash size={13} strokeWidth={1.5} />
  if (status === 'unsupported') return <CircleDashed size={13} strokeWidth={1.5} />
  return <Loader size={13} strokeWidth={1.5} />
}

function nodeOutputText(output: RunNodeResult['output']): string {
  if (!output) return ''
  const text = output.text
  return typeof text === 'string' ? text : ''
}

export function RunDrawer({ open, running, flowName, runId, total, nodes, record, resume = null, resumePlan = null, onResume, onRestart, queuedMs = 0, queue = null, queueElapsed = 0, cancelled = false, onCancelQueue, error, onClose, onSelectNode }: RunDrawerProps) {
  const { internal } = useUiMode()
  const progress = total > 0 ? Math.round((nodes.length / total) * 100) : 0
  const recordedResume = runResumeInfo(resume || record)
  // 预检结果比旧记录更准：改过画布后，旧记录说「跑完 3 个」，实际只有 2 个还能复用。
  const resumeLeft = resumePlan ? resumePlan.rerun : recordedResume.left
  const resumeReused = resumePlan ? resumePlan.reused : recordedResume.reused
  const resumeCost = resumePlan ? resumePlan.cost : recordedResume.cost
  const resumePossible = resumePlan ? resumePlan.resumable : recordedResume.resumable
  const resumeStale = resumePlan?.stale ?? 0
  const resumeReady = Boolean(onResume) && !running && resumePossible && resumeLeft > 0
  // 预检说不能续、但旧记录看起来还能续：这是「画布改过了」，要给一个明确的出口，不能只把按钮藏掉。
  const resumeBlocked = Boolean(resume) && resumePlan !== null && !resumePlan.resumable && recordedResume.resumable && !running
  const duration = record ? record.durationMs : nodes.reduce((sum, node) => sum + (node.ms || 0), 0)
  // 排队也是一段时间：抽屉开着的时候顶栏会被它盖住，所以状态胶囊直接写 QUEUED，别让用户以为节点在跑
  const statusText = queue
    ? 'QUEUED'
    : running
      ? 'RUNNING'
      : record
        ? (record.status === 'success' ? 'DONE' : record.status === 'interrupted' ? (record.canceled ? 'STOPPED' : 'INTERRUPTED') : 'ERROR')
        : error ? 'ERROR' : 'IDLE'
  const statusTone = running
    ? 'live'
    : record?.canceled
      ? 'warn'
      : record?.status === 'error' || record?.status === 'interrupted' || error ? 'fail' : record ? 'pass' : 'idle'

  return (
    <aside className={`cv-drawer ${open ? 'is-open' : ''}`} aria-label="运行结果" aria-hidden={!open}>
      <header className="cv-drawer-head">
        <div>
          <span className="cv-kicker">运行结果</span>
          <strong>{flowName || '当前流程'}</strong>
        </div>
        <div className="cv-drawer-head-right">
          <Pill tone={statusTone}>{statusText}</Pill>
          <button className="vq-button vq-button--icon" type="button" onClick={onClose} aria-label="关闭运行结果"><X size={14} /></button>
        </div>
      </header>

      <div className="cv-drawer-meta">
        <span className="cv-mono">{runId || '尚未运行'}</span>
        <span>{formatMs(duration)}</span>
        <span>{nodes.length} / {total || nodes.length} 节点</span>
        {record?.resumeOf ? (
          <span title={'上次运行 ' + record.resumeOf + ' 已跑完的节点直接复用'}>
            续跑 · 复用 {record.reusedNodes ?? 0} 个已跑节点
          </span>
        ) : null}
        {queuedMs > 0 ? <span>排队 {Math.round(queuedMs / 1000)} 秒后开始</span> : null}
        {record?.credits && record.credits.cost > 0 ? (
          <span>
            {record.credits.refunded
              ? record.credits.kept != null
                ? '已退 ' + (record.credits.refundedAmount ?? 0) + ' 积分 · 已跑部分 ' + record.credits.kept + ' 积分'
                : '已退回 ' + record.credits.cost + ' 积分'
              : '消耗 ' + record.credits.cost + ' 积分'}
          </span>
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

        {!error && record?.canceled && record.error ? (
          <div className="cv-drawer-stopped">
            <CircleSlash size={14} strokeWidth={1.75} />
            <div>
              <strong>运行已停止</strong>
              <p>{record.error}</p>
            </div>
          </div>
        ) : null}

        {resumeReady ? (
          <div className="cv-drawer-resume">
            <div>
              <strong>还差 {resumeLeft} 个节点</strong>
              <p>
                {resumeStale > 0
                  ? '上次跑完的 ' + resumeReused + ' 个节点内容没变，继续复用；改过的 ' + resumeStale + ' 个和它的下游会重跑，只补没付过的部分。'
                  : '上次跑完的 ' + resumeReused + ' 个节点直接复用，不重复调用、也不重复扣费。'}
              </p>
            </div>
            <button className="vq-button vq-button--primary vq-button--sm" type="button" onClick={onResume}>
              {resumeCost > 0 ? '继续运行 · ' + resumeCost + ' 积分' : '继续运行'}
            </button>
          </div>
        ) : null}

        {resumeBlocked ? (
          <div className="cv-drawer-resume is-blocked">
            <div>
              <strong>这次没有能原样复用的节点</strong>
              <p>{resumePlan?.reason || '画布改过了；从头运行会用最新画布。'}</p>
            </div>
            {onRestart ? (
              <button className="vq-button vq-button--ghost vq-button--sm" type="button" onClick={onRestart}>
                从头运行
              </button>
            ) : null}
          </div>
        ) : null}

        {!nodes.length && !error && (
          <div className="cv-drawer-empty">
            {running ? (
              queue ? (
                <>
                  <p>正在排队 · 第 {queue.position} 位 · 已等 {queueElapsed} 秒（排到才开始跑，现在退出不会扣费）</p>
                  {onCancelQueue ? (
                    <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onCancelQueue}>
                      取消排队
                    </button>
                  ) : null}
                </>
              ) : <p>已提交运行，等待第一个节点返回…</p>
            ) : cancelled ? (
              <p>已退出排队：这条流程没有跑，也没有扣积分。</p>
            ) : <p>点「运行流程」后，这里会按节点顺序显示状态、耗时和输出。</p>}
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
                <span className="cv-run-ms">{node.reused ? '复用' : formatMs(node.ms)}</span>
                <span className="cv-run-state">{node.reused ? '已跑过' : (STATUS_LABEL[node.status] ?? node.status)}</span>
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
