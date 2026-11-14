import { useEffect, useState } from 'react'
import { Check, CircleAlert, CircleDashed, CircleSlash, Loader, X } from 'lucide-react'
import { getRunCompare, type RunCompare, type RunCompareNode, type RunCompareNodeSide, type RunCompareSide } from '../api/flows'
import { NODE_META } from '../canvas/catalog'
import { runSpentText, runStatusMeta } from '../domain/run'
import { Pill } from './ui'
import '../styles/canvas.css'

// 运行对照（v0.9.110）：只读弹窗。同一条画布的两条运行摆在一起，
// 回答「这次和上次比，哪个节点变了、慢了多久、多花了多少」。
// 只比结果与指纹；完整输出仍在单条运行详情里，不在这里再铺一遍。

const NODE_STATUS_LABEL: Record<string, string> = {
  success: '完成',
  error: '失败',
  skipped: '已跳过',
  unsupported: '不支持',
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

function formatDelta(ms: number): string {
  if (!ms) return '一样'
  const abs = Math.abs(ms)
  return (ms > 0 ? '+' : '-') + formatMs(abs)
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function costText(side: RunCompareSide): string {
  if (side.cost > 0) return '扣 ' + side.cost + ' 积分'
  if (side.refunded) return '已退回'
  return '没扣积分'
}

function NodeStatusIcon({ status }: { status: string }) {
  if (status === 'success') return <Check size={12} strokeWidth={2} />
  if (status === 'error') return <CircleAlert size={12} strokeWidth={1.5} />
  if (status === 'skipped') return <CircleSlash size={12} strokeWidth={1.5} />
  if (status === 'unsupported') return <CircleDashed size={12} strokeWidth={1.5} />
  return <Loader size={12} strokeWidth={1.5} />
}

function SideCard({ label, side }: { label: string; side: RunCompareSide }) {
  const meta = runStatusMeta(side.status, side.canceled)
  return (
    <div className="rc-side-card">
      <div className="rc-side-card-head">
        <span className="vq-mono">{label}</span>
        <Pill tone={meta.tone}>{meta.label}</Pill>
      </div>
      <strong className="rc-side-card-when">{formatWhen(side.startedAt)}</strong>
      <div className="rc-side-card-meta">
        <span>{runSpentText(side)}</span>
        <span>{side.finished} / {side.total} 节点</span>
        <span>{costText(side)}</span>
      </div>
      {side.failed > 0 ? <p className="rc-side-card-failed">{side.failed} 个节点失败</p> : null}
    </div>
  )
}

function NodeSide({ side, label, showPreview }: { side: RunCompareNodeSide | null; label: string; showPreview: boolean }) {
  if (!side) {
    return (
      <div className="rc-side is-missing" role="cell">
        <span className="rc-side-name">{label}</span>
        <span className="rc-side-empty">—</span>
      </div>
    )
  }
  return (
    <div className={'rc-side is-' + side.status} role="cell">
      <span className="rc-side-name">{label}</span>
      <span className="rc-side-line">
        <span className="rc-node-status"><NodeStatusIcon status={side.status} />{NODE_STATUS_LABEL[side.status] || side.status}</span>
        <span className="rc-node-ms">{formatMs(side.ms)}</span>
      </span>
      {side.error ? <span className="rc-node-error">{side.error}</span> : null}
      {!side.error && showPreview && side.preview ? <span className="rc-node-preview">{side.preview}</span> : null}
    </div>
  )
}

function compareChips(node: RunCompareNode) {
  const chips: { key: string; label: string }[] = []
  if (node.added) chips.push({ key: 'added', label: '这次新增' })
  if (node.removed) chips.push({ key: 'removed', label: '这次没有' })
  if (node.statusChanged) chips.push({ key: 'status', label: '状态变了' })
  if (node.outputChanged) chips.push({ key: 'output', label: '输出变了' })
  if (node.revisionChanged) chips.push({ key: 'revision', label: '输入或配置改了' })
  if (!chips.length) chips.push({ key: 'same', label: '结果一致' })
  return chips
}

export function RunCompareModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [data, setData] = useState<RunCompare | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  // 只有点在「重新读取」时才同步切回加载态：effect 里同步 setState 会多一轮渲染，
  // 首屏的 loading 已由 useState 初值给出（弹窗每次打开都是新挂载）。
  useEffect(() => {
    let alive = true
    getRunCompare(runId)
      .then((result) => { if (alive) setData(result) })
      .catch((caught) => { if (alive) setError(caught instanceof Error ? caught.message : '读取对照没有成功') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [runId, attempt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="vq-modal-backdrop rc-backdrop" onMouseDown={onClose}>
      <div className={'rc-modal' + (data && !data.comparable ? ' is-alone' : '')} role="dialog" aria-modal="true" aria-labelledby="rc-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="rc-head">
          <div>
            <span className="vq-mono">Run compare / 运行对照</span>
            <h2 id="rc-title">{data && data.comparable ? '和上一条运行比' : '运行对照'}</h2>
            <p className="rc-sub">
              {data && data.comparable
                ? data.flowName + ' · 只读对照，不重跑、不扣积分'
                : '只读对照，不重跑、不扣积分'}
            </p>
          </div>
          <button type="button" className="vq-button vq-button--icon" aria-label="关闭运行对照" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        {loading ? (
          <div className="rc-state" role="status">正在读取两条运行…</div>
        ) : error ? (
          <div className="rc-state is-error">
            <p>{error}</p>
            <button
              type="button"
              className="vq-button vq-button--ghost vq-button--sm"
              onClick={() => { setLoading(true); setError(''); setAttempt((value) => value + 1) }}
            >
              重新读取
            </button>
          </div>
        ) : !data ? (
          <div className="rc-state">没有读到对照数据。</div>
        ) : !data.comparable ? (
          <div className="rc-alone">
            <SideCard label="这一条运行" side={data.current} />
            <p className="rc-alone-note">{data.reason}</p>
            <p className="rc-alone-hint">对照需要同一条画布上的两条运行；运行结果本身不会因此改变。</p>
          </div>
        ) : (
          <div className="rc-body">
            <div className="rc-cards">
              <SideCard label="上一条" side={data.previous} />
              <SideCard label="这一条" side={data.current} />
            </div>

            <div className="rc-totals">
              <div className="rc-total">
                <span className="vq-mono">耗时</span>
                <strong className={data.totals.durationDelta > 0 ? 'is-slow' : data.totals.durationDelta < 0 ? 'is-fast' : ''}>
                  {formatDelta(data.totals.durationDelta)}
                </strong>
              </div>
              <div className="rc-total">
                <span className="vq-mono">扣费</span>
                <strong className={data.totals.costDelta > 0 ? 'is-slow' : data.totals.costDelta < 0 ? 'is-fast' : ''}>
                  {data.totals.costDelta === 0 ? '一样' : (data.totals.costDelta > 0 ? '+' : '') + data.totals.costDelta + ' 积分'}
                </strong>
              </div>
              <div className="rc-total">
                <span className="vq-mono">结果</span>
                <strong>{data.totals.changed === 0 ? '全部一致' : data.totals.changed + ' / ' + data.nodes.length + ' 个节点变了'}</strong>
              </div>
            </div>

            <p className={'rc-graph' + (data.graph.changed ? ' is-changed' : '')}>
              {data.graph.changed
                ? '两次之间画布改过：参数或连线不同，对照按节点 id 对齐，只比同 id 节点的结果。'
                : data.graph.unknown
                  ? '有一条运行没有留下画布指纹，无法判断两次是否同一版画布；下面按节点 id 对齐。'
                  : '两次运行用的是同一版画布。'}
            </p>

            <div className="rc-table" role="table" aria-label="逐节点对照">
              <div className="rc-row rc-row--head" role="row">
                <span role="columnheader">节点</span>
                <span role="columnheader">上一条</span>
                <span role="columnheader">这一条</span>
                <span role="columnheader">变化</span>
              </div>
              {data.nodes.map((node) => {
                const showPreview = node.outputChanged || node.added || node.removed
                const chips = compareChips(node)
                return (
                  <div className={'rc-row' + (node.added ? ' is-added' : node.removed ? ' is-removed' : '')} role="row" key={node.id}>
                    <div className="rc-node" role="cell">
                      <strong>{node.title || '未命名节点'}</strong>
                      <span className="vq-mono">{NODE_META[node.kind]?.mono || node.kind}</span>
                    </div>
                    <NodeSide side={node.previous} label="上一条" showPreview={showPreview} />
                    <div className="rc-side" role="cell">
                      <span className="rc-side-name">这一条</span>
                      {node.current ? (
                        <>
                          <span className="rc-side-line">
                            <span className="rc-node-status"><NodeStatusIcon status={node.current.status} />{NODE_STATUS_LABEL[node.current.status] || node.current.status}</span>
                            <span className="rc-node-ms">{formatMs(node.current.ms)}</span>
                            {node.msDelta !== null && node.msDelta !== 0 ? (
                              <span className={'rc-delta ' + (node.msDelta > 0 ? 'is-slow' : 'is-fast')}>{formatDelta(node.msDelta)}</span>
                            ) : null}
                          </span>
                          {node.current.error ? <span className="rc-node-error">{node.current.error}</span> : null}
                          {!node.current.error && showPreview && node.current.preview ? <span className="rc-node-preview">{node.current.preview}</span> : null}
                        </>
                      ) : <span className="rc-side-empty">—</span>}
                    </div>
                    <div className="rc-changes" role="cell">
                      {chips.map((chip) => <span className={'rc-chip is-' + chip.key} key={chip.key}>{chip.label}</span>)}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <footer className="rc-foot">
          <span>输出按完整内容比对，首段只用于辨认；两次运行都没有被改动。</span>
          <button type="button" className="vq-button vq-button--primary vq-button--sm" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
