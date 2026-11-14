import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, CircleDashed, CircleSlash, FileDiff, Loader, X } from 'lucide-react'
import {
  getRunCompare,
  getRunOutputDiff,
  type RunCompare,
  type RunCompareNode,
  type RunCompareNodeSide,
  type RunCompareSide,
  type RunDiffLine,
  type RunOutputDiff,
} from '../api/flows'
import { NODE_META } from '../canvas/catalog'
import { runSpentText, runStatusMeta } from '../domain/run'
import { Pill } from './ui'
import { Select } from './Select'
import '../styles/run-compare.css'

// 运行对照（v0.9.110）：只读弹窗。两条运行摆在一起，
// 回答「这两次比，哪个节点变了、慢了多久、多花了多少」。
// v0.9.111 起可以自己挑对照对象，不再只认更早的那一条；最早那条也能回头挑之后的一次。
// v0.9.113 起候选里还有同一件作品其它版本的运行：开过新版之后也能对着看。
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

function versionText(side: RunCompareSide): string {
  const version = Number(side.project?.version) || 0
  return version > 0 ? 'v' + version : ''
}

/** 跨版本对照的「v1 与 v2」：不写箭头，谁是对照、谁是当前由两张卡片各自标。 */
function crossVersionText(data: RunCompare | null): string {
  if (!data || !data.comparable || !data.crossVersion) return ''
  const from = Number(data.previous.project?.version) || 0
  const to = Number(data.current.project?.version) || 0
  if (!from || !to) return ''
  return from === to ? 'v' + from : 'v' + Math.min(from, to) + ' 与 v' + Math.max(from, to)
}

function compareSub(data: RunCompare | null): string {
  const tail = '只读对照，不重跑、不扣积分'
  if (data?.comparable && data.crossVersion) {
    const title = data.project?.title || data.flowName
    return [title, crossVersionText(data), tail].filter(Boolean).join(' · ')
  }
  return data?.flowName ? data.flowName + ' · ' + tail : tail
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
  const version = versionText(side)
  return (
    <div className="rc-side-card">
      <div className="rc-side-card-head">
        <span className="vq-mono">{label}</span>
        <Pill tone={meta.tone}>{meta.label}</Pill>
      </div>
      {version ? <span className="rc-side-card-version">{version}</span> : null}
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

function optionLabel(side: RunCompareSide): string {
  const meta = runStatusMeta(side.status, side.canceled)
  const cost = side.cost > 0 ? '扣 ' + side.cost : side.refunded ? '已退' : '没扣'
  const version = versionText(side)
  return (version ? version + ' · ' : '') + formatWhen(side.startedAt) + ' · ' + meta.label + ' · ' + formatMs(side.durationMs) + ' · ' + cost + ' · ' + side.id.slice(-8)
}

// 输出差异（v0.9.112）：只在点开某个「输出变了」的节点时读取。
// 不把整份输出搬进对照弹窗；面板里只出现改动附近的行，超限就说只比了一部分。
type DiffState = {
  nodeId: string
  status: 'loading' | 'ready' | 'error'
  data?: RunOutputDiff
  message?: string
}

function DiffLineRow({ line }: { line: RunDiffLine }) {
  if (line.op === 'skip') {
    return <div className="rc-diff-skip">… {line.count} 行未变 …</div>
  }
  const sign = line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '
  return (
    <div className={'rc-diff-line is-' + line.op}>
      <span className="rc-diff-no">{line.oldNo ?? ''}</span>
      <span className="rc-diff-no">{line.newNo ?? ''}</span>
      <span className="rc-diff-sign">{sign}</span>
      <span className="rc-diff-text">{line.text || ' '}</span>
    </div>
  )
}

function OutputDiffPanel({ state, onRetry }: { state: DiffState; onRetry: () => void }) {
  return (
    <div className="rc-diff" role="region" aria-label="输出差异">
      <div className="rc-diff-head">
        <strong>输出差异</strong>
        <span className="vq-mono">对照运行 → 当前运行</span>
        {state.status === 'ready' && state.data ? (
          <span className="rc-diff-stats vq-mono">
            +{state.data.stats.added} / -{state.data.stats.removed}
          </span>
        ) : null}
      </div>
      {state.status === 'loading' ? (
        <p className="rc-diff-state"><Loader size={13} className="vq-spin" />正在取改动附近的几行…</p>
      ) : state.status === 'error' ? (
        <div className="rc-diff-state is-error">
          <span>{state.message || '输出差异没有读出来'}</span>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onRetry}>重新读取</button>
        </div>
      ) : state.data ? (
        <>
          {state.data.lines.length ? (
            <div className="rc-diff-lines">
              {state.data.lines.map((line, index) => <DiffLineRow key={line.op + '-' + index} line={line} />)}
            </div>
          ) : (
            <p className="rc-diff-state">两端文字一样，差异在其它字段里。</p>
          )}
          {state.data.truncated ? (
            <p className="rc-diff-cut">内容较长，只比了前 2.4 万字符或前 1200 行；差异也只列了 260 行以内。</p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

export function RunCompareModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [data, setData] = useState<RunCompare | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  // 空串 = 默认（同一条画布上更早的最近一条）；点名后带 ?with= 取任意一条已结束运行。
  const [withId, setWithId] = useState('')
  // 当前展开差异的节点与那一次请求的状态；同一时间只开一个，换对照对象时收起。
  const [diffOpen, setDiffOpen] = useState('')
  const [diffState, setDiffState] = useState<DiffState | null>(null)
  // 换对照对象时，上一次差异请求可能还在路上；用序号把晚到的结果丢掉。
  const diffSeq = useRef(0)

  // 只有点在「重新读取」或换了对照对象时才同步切回加载态：effect 里同步 setState 会多一轮渲染，
  // 首屏的 loading 已由 useState 初值给出（弹窗每次打开都是新挂载）。
  useEffect(() => {
    let alive = true
    getRunCompare(runId, withId)
      .then((result) => { if (alive) setData(result) })
      .catch((caught) => { if (alive) setError(caught instanceof Error ? caught.message : '读取对照没有成功') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [runId, withId, attempt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadDiff = (nodeId: string) => {
    if (!data || !data.comparable) return
    const seq = diffSeq.current + 1
    diffSeq.current = seq
    setDiffState({ nodeId, status: 'loading' })
    getRunOutputDiff(runId, data.previous.id, nodeId)
      .then((result) => {
        if (seq !== diffSeq.current) return
        setDiffState({ nodeId, status: 'ready', data: result })
      })
      .catch((caught) => {
        if (seq !== diffSeq.current) return
        setDiffState({
          nodeId,
          status: 'error',
          message: caught instanceof Error ? caught.message : '输出差异没有读出来',
        })
      })
  }

  const toggleDiff = (nodeId: string) => {
    if (diffOpen === nodeId) {
      setDiffOpen('')
      return
    }
    setDiffOpen(nodeId)
    loadDiff(nodeId)
  }

  return (
    <div className="vq-modal-backdrop rc-backdrop" onMouseDown={onClose}>
      <div className={'rc-modal' + (data && !data.comparable ? ' is-alone' : '')} role="dialog" aria-modal="true" aria-labelledby="rc-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="rc-head">
          <div>
            <span className="vq-mono">Run compare / 运行对照</span>
            <h2 id="rc-title">两条运行摆一起</h2>
            <p className="rc-sub">{compareSub(data)}</p>
          </div>
          <button type="button" className="vq-button vq-button--icon" aria-label="关闭运行对照" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        {data && data.options.length ? (
          <div className="rc-pick">
            <span className="rc-pick-label">对照对象</span>
            <Select
              size="sm"
              label="选择要对照的运行"
              value={withId}
              options={[
                { value: '', label: '自动：这条画布上一条已结束运行' },
                ...data.options.map((side) => ({ value: side.id, label: optionLabel(side) })),
              ]}
              onChange={(value) => {
                if (value === withId) return
                setWithId(value)
                diffSeq.current += 1
                setDiffOpen('')
                setDiffState(null)
                setLoading(true)
                setError('')
              }}
            />
            <span className="rc-pick-hint">
              {data.optionsScoped === 'project'
                ? (data.optionsTruncated
                    ? '同一件作品共 ' + data.optionsTotal + ' 条已结束运行（含其它版本），这里列最近 ' + data.options.length + ' 条；差值 = 当前 − 对照'
                    : '同一件作品另有 ' + data.optionsTotal + ' 条已结束运行（含其它版本）；差值 = 当前 − 对照')
                : (data.optionsTruncated
                    ? '同一条画布共 ' + data.optionsTotal + ' 条已结束运行，这里列最近 ' + data.options.length + ' 条；差值 = 当前 − 对照'
                    : '同一条画布上另有 ' + data.optionsTotal + ' 条已结束运行；差值 = 当前 − 对照')}
            </span>
          </div>
        ) : null}

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
            <SideCard label="当前运行" side={data.current} />
            <p className="rc-alone-note">{data.reason}</p>
            <p className="rc-alone-hint">
              {data.options.length
                ? (data.optionsScoped === 'project'
                    ? '从上面「对照对象」挑一条运行（同一件作品的其它版本也可以）；运行结果本身不会因此改变。'
                    : '从上面「对照对象」挑一条之后的运行，就能逐节点对照；运行结果本身不会因此改变。')
                : '对照需要同一张画布、或同一件作品另一版画布上的两条运行；运行结果本身不会因此改变。'}
            </p>
          </div>
        ) : (
          <div className="rc-body">
            <div className="rc-cards">
              <SideCard label="对照运行" side={data.previous} />
              <SideCard label="当前运行" side={data.current} />
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

            <p className={'rc-graph' + (data.graph.changed ? ' is-changed' : '') + (data.crossVersion ? ' is-cross' : '')}>
              {data.crossVersion
                ? '这两条运行在同一件作品的不同版本画布上' +
                  (crossVersionText(data) ? '（' + crossVersionText(data) + '）' : '') +
                  '：逐节点按 id 对齐' +
                  (data.graph.changed
                    ? '，画布参数或连线也改过。'
                    : data.graph.unknown
                      ? '；有一条没留下画布指纹，画布是否同一版无从判断。'
                      : '，画布内容没改，只是开了新版。')
                : data.graph.changed
                  ? '这两次之间画布改过：参数或连线不同，对照按节点 id 对齐，只比同 id 节点的结果。'
                  : data.graph.unknown
                    ? '有一条运行没有留下画布指纹，无法判断是否同一版画布；下面按节点 id 对齐。'
                    : '两条运行用的是同一版画布。'}
            </p>

            <div className="rc-table" role="table" aria-label="逐节点对照">
              <div className="rc-row rc-row--head" role="row">
                <span role="columnheader">节点</span>
                <span role="columnheader">对照运行</span>
                <span role="columnheader">当前运行</span>
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
                    <NodeSide side={node.previous} label="对照运行" showPreview={showPreview} />
                    <div className="rc-side" role="cell">
                      <span className="rc-side-name">当前运行</span>
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
                      {node.outputChanged && node.current && node.previous ? (
                        <button
                          type="button"
                          className={'rc-diff-toggle' + (diffOpen === node.id ? ' is-open' : '')}
                          aria-expanded={diffOpen === node.id}
                          onClick={() => toggleDiff(node.id)}
                        >
                          <FileDiff size={12} />
                          {diffOpen === node.id ? '收起差异' : '看改了哪几行'}
                        </button>
                      ) : null}
                    </div>
                    {diffOpen === node.id ? (
                      <OutputDiffPanel
                        state={diffState?.nodeId === node.id ? diffState : { nodeId: node.id, status: 'loading' }}
                        onRetry={() => loadDiff(node.id)}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <footer className="rc-foot">
          <span>输出按完整内容比对，首段只用于辨认；差值 = 当前 − 对照，看差异也是只读，两次运行都没有被改动。</span>
          <button type="button" className="vq-button vq-button--primary vq-button--sm" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
