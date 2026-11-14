import { useEffect, useState } from 'react'
import { ArrowLeftRight, X } from 'lucide-react'
import { compareProjectVersions } from '../api/projects'
import { REVIEW_VERDICT_LABEL, deliveryDrift, deliveryDriftText, deliveryReviewText, issueGap, issueLine } from '../domain/review'
import type {
  ProjectVersionCompare,
  ProjectVersionCompareField,
  ProjectVersionCompareNode,
  ProjectVersionCompareReview,
  ProjectVersionCompareReviewChange,
  ProjectVersionCompareSide,
} from '../domain/project'

export type VersionCompareOption = {
  n: number
  name: string
  current?: boolean
}

type CompareGroupTone = 'added' | 'removed' | 'changed'

function reviewAtLabel(at: string) {
  if (!at) return '时间没记录'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '时间没记录'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function reviewIssueText(review: ProjectVersionCompareReview) {
  if (!review.count) return ''
  const line = issueLine(review.issues)
  const gap = issueGap(review.issues)
  if (line && gap) return line + ' · 另有 ' + gap + ' 条没记严重度'
  if (line) return line
  if (gap) return '另有 ' + gap + ' 条没记严重度'
  return '没记问题数'
}

function ReviewOutcome({
  base,
  target,
  change,
}: {
  base: ProjectVersionCompareSide
  target: ProjectVersionCompareSide
  change?: ProjectVersionCompareReviewChange
}) {
  return (
    <section className="vq-vcompare-section">
      <div className="vq-vcompare-section-head">
        <h3>评审与交付</h3>
        <span className="vq-mono">改完有没有变好</span>
      </div>
      <div className="vq-vcompare-review-pair">
        {[base, target].map((side) => {
          const review = side.review
          const issues = reviewIssueText(review)
          const delivery = side.delivery
          // 交时快照和这一版最近一评比：只在两边都记着认得出的结论时开口，
          // 老记录或交时没评过就只说快照本身，不编一句「后来变了」（v0.9.120）。
          const drift = delivery ? deliveryDrift(delivery.review, review) : null
          return (
            <article className="vq-vcompare-review-card" key={side.n}>
              <div className="vq-vcompare-review-head">
                <span className="vq-mono">v{side.n}</span>
                {review.count ? (
                  <span className={'vq-project-verdict is-' + (review.verdict || 'none')}>
                    {REVIEW_VERDICT_LABEL[review.verdict] || '未记结论'}
                  </span>
                ) : (
                  <span className="vq-project-verdict">未评审</span>
                )}
              </div>
              <p className="vq-vcompare-review-meta">
                {review.count ? review.count + ' 次评审' : '还没评过'}
                {issues ? ' · ' + issues : ''}
              </p>
              <p className="vq-vcompare-review-delivery">
                {delivery ? '交付过 · ' + reviewAtLabel(delivery.at) : '没交付'}
              </p>
              {delivery ? (
                <p className="vq-vcompare-review-snapshot">
                  交时评审：{deliveryReviewText(delivery.review)}
                </p>
              ) : null}
              {drift ? (
                <p className={'vq-vcompare-review-drift is-' + drift.tone}>
                  交付{deliveryDriftText(drift)}
                </p>
              ) : null}
            </article>
          )
        })}
      </div>
      {change ? <p className={'vq-vcompare-review-change is-' + change.tone}>{change.text}</p> : null}
    </section>
  )
}

function nodeTone(tone: CompareGroupTone) {
  return tone === 'added' ? '+' : tone === 'removed' ? '−' : '~'
}

function NodeGroup({ tone, label, items }: { tone: CompareGroupTone; label: string; items: ProjectVersionCompareNode[] }) {
  if (!items.length) return null
  return (
    <div className={'vq-vcompare-group is-' + tone}>
      <span className="vq-vcompare-tag" aria-hidden="true">{nodeTone(tone)}</span>
      <div className="vq-vcompare-group-body">
        <p className="vq-vcompare-group-label">{label} {items.length}</p>
        <ul className="vq-vcompare-items">
          {items.map((item) => (
            <li
              key={item.id}
              title={tone === 'changed' ? '这个节点的配置改过；移动位置或改标题不算' : tone === 'added' ? '这一版新增的节点' : '这一版去掉的节点'}
            >
              {item.title}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function BeatGroup({ tone, label, items }: { tone: CompareGroupTone; label: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div className={'vq-vcompare-group is-' + tone}>
      <span className="vq-vcompare-tag" aria-hidden="true">{nodeTone(tone)}</span>
      <div className="vq-vcompare-group-body">
        <p className="vq-vcompare-group-label">{label} {items.length}</p>
        <ul className="vq-vcompare-items">
          {items.map((name) => <li key={name}>{name}</li>)}
        </ul>
      </div>
    </div>
  )
}

function ChangedNodes({ items, fields }: { items: ProjectVersionCompareNode[]; fields?: Record<string, ProjectVersionCompareField[]> }) {
  if (!items.length) return null
  return (
    <div className="vq-vcompare-group is-changed">
      <span className="vq-vcompare-tag" aria-hidden="true">~</span>
      <div className="vq-vcompare-group-body">
        <p className="vq-vcompare-group-label">改 {items.length}</p>
        <ul className="vq-vcompare-node-list">
          {items.map((item) => {
            const changes = fields?.[item.id] || []
            return (
              <li className="vq-vcompare-node" key={item.id}>
                <div className="vq-vcompare-node-head">
                  <strong>{item.title}</strong>
                  <span className="vq-mono">{changes.length ? changes.length + ' 项参数' : '配置改过'}</span>
                </div>
                {changes.length ? (
                  <ul className="vq-vcompare-fields">
                    {changes.map((field) => (
                      <li className="vq-vcompare-field" key={field.key}>
                        <span className="vq-vcompare-field-label">{field.label}</span>
                        <span className="vq-vcompare-field-values">
                          <span className="vq-vcompare-value is-before" title={field.before}>{field.before}</span>
                          <span className="vq-vcompare-field-arrow" aria-hidden="true">→</span>
                          <span className="vq-vcompare-value is-after" title={field.after}>{field.after}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/**
 * 任意两版对照（v0.9.117）：只读弹窗。
 * 默认拿当前版的上一版 / 底座当基准；两边都能换，换完立刻重读，不发写请求。
 */
export function VersionCompareModal({
  projectId,
  versions,
  initialBase,
  initialTarget,
  onClose,
}: {
  projectId: string
  versions: VersionCompareOption[]
  initialBase: number
  initialTarget: number
  onClose: () => void
}) {
  const has = (n: number) => versions.some((item) => item.n === n)
  const fallback = versions.find((item) => item.n < initialTarget)?.n || versions[0]?.n || 1
  const [base, setBase] = useState(has(initialBase) && initialBase !== initialTarget ? initialBase : fallback)
  const [target, setTarget] = useState(has(initialTarget) ? initialTarget : versions[0]?.n || 1)
  // 请求结果按「哪两版」存：换选择器时不必在 effect 里同步清状态，直接看当前 key 有没有结果。
  // 这样也躲开 react(set-state-in-effect)：effect 里只在异步回来后 setState（v0.9.117）。
  const key = base + ':' + target
  const same = base === target
  const [read, setRead] = useState<{
    key: string
    busy: boolean
    error: string
    result: ProjectVersionCompare | null
  }>({ key: '', busy: true, error: '', result: null })

  useEffect(() => {
    if (same) return
    let cancelled = false
    compareProjectVersions(projectId, base, target)
      .then((next) => {
        if (cancelled) return
        setRead({ key, busy: false, error: '', result: next })
      })
      .catch((caught) => {
        if (cancelled) return
        setRead({ key, busy: false, error: caught instanceof Error ? caught.message : '两版没读出来', result: null })
      })
    return () => { cancelled = true }
  }, [projectId, base, target, key, same])

  const busy = !same && (read.key !== key || read.busy)
  const error = read.key === key ? read.error : ''
  const result = read.key === key ? read.result : null

  const swap = () => {
    setBase(target)
    setTarget(base)
  }

  const canvasTouched = Boolean(result?.canvas && (
    result.canvas.added.length || result.canvas.removed.length || result.canvas.changed.length
  ))
  const scriptTouched = Boolean(result?.script && (
    result.script.added.length || result.script.removed.length || result.script.changed.length || result.script.hookChanged
  ))
  const changedFieldCount = result?.canvas?.fields
    ? Object.values(result.canvas.fields).reduce((sum, list) => sum + list.length, 0)
    : 0

  return (
    <div className="vq-modal-backdrop" onMouseDown={onClose}>
      <div
        className="vq-vcompare-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vq-vcompare-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="vq-vcompare-head">
          <div>
            <span className="vq-mono">两版对照 / VERSION DIFF</span>
            <h2 id="vq-vcompare-title">v{base} 到 v{target}</h2>
          </div>
          <button type="button" className="vq-button vq-button--icon" aria-label="关闭两版对照" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="vq-vcompare-pickers">
          <label className="vq-vcompare-picker">
            <span>基准</span>
            <select value={base} onChange={(event) => setBase(Number(event.target.value))}>
              {versions.map((item) => (
                <option key={item.n} value={item.n}>
                  v{item.n} · {item.name}{item.current ? '（最新）' : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="vq-button vq-button--icon vq-vcompare-swap"
            onClick={swap}
            title="交换基准与对照"
            aria-label="交换基准与对照"
          >
            <ArrowLeftRight size={15} />
          </button>
          <label className="vq-vcompare-picker">
            <span>对照</span>
            <select value={target} onChange={(event) => setTarget(Number(event.target.value))}>
              {versions.map((item) => (
                <option key={item.n} value={item.n}>
                  v{item.n} · {item.name}{item.current ? '（最新）' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div aria-live="polite">
          {base === target ? (
            <p className="vq-vcompare-state">两版对照要选两个不同的版本。</p>
          ) : busy ? (
            <p className="vq-vcompare-state">正在读这两版…</p>
          ) : error ? (
            <p className="vq-vcompare-state is-error">{error}</p>
          ) : result ? (
            <>
              <p className="vq-vcompare-summary">
                <span className="vq-mono">v{result.base.n} → v{result.target.n}</span>
                <span>{result.summary || '这两版没有可比的数据'}</span>
              </p>

              <ReviewOutcome base={result.base} target={result.target} change={result.reviewChange} />

              <section className="vq-vcompare-section">
                <div className="vq-vcompare-section-head">
                  <h3>画布</h3>
                  <span className="vq-mono">
                    {result.base.canvasAvailable ? result.base.nodes : '—'} → {result.target.canvasAvailable ? result.target.nodes : '—'} 节点
                    {changedFieldCount ? ' · ' + changedFieldCount + ' 项参数' : ''}
                  </span>
                </div>
                {result.canvas ? (
                  canvasTouched ? (
                    <div className="vq-vcompare-groups">
                      <NodeGroup tone="added" label="多" items={result.canvas.added} />
                      <NodeGroup tone="removed" label="少" items={result.canvas.removed} />
                      <ChangedNodes items={result.canvas.changed} fields={result.canvas.fields} />
                    </div>
                  ) : (
                    <p className="vq-vcompare-state">节点没动。</p>
                  )
                ) : (
                  <p className="vq-vcompare-state">有一侧画布读不到，画布这一侧不比。</p>
                )}
              </section>

              <section className="vq-vcompare-section">
                <div className="vq-vcompare-section-head">
                  <h3>脚本</h3>
                  <span className="vq-mono">
                    {result.base.scriptAvailable ? result.base.beats : '—'} → {result.target.scriptAvailable ? result.target.beats : '—'} 段
                  </span>
                </div>
                {result.script ? (
                  <>
                    {result.script.added.length || result.script.removed.length || result.script.changed.length ? (
                      <div className="vq-vcompare-groups">
                        <BeatGroup tone="added" label="多" items={result.script.added} />
                        <BeatGroup tone="removed" label="少" items={result.script.removed} />
                        {result.script.changed.length ? (
                          <div className="vq-vcompare-group is-changed">
                            <span className="vq-vcompare-tag" aria-hidden="true">~</span>
                            <div className="vq-vcompare-group-body">
                              <p className="vq-vcompare-group-label">口播改过 {result.script.changed.length}</p>
                              <ul className="vq-vcompare-changed">
                                {result.script.changed.map((beat) => (
                                  <li key={beat.name}>
                                    <strong>{beat.name}</strong>
                                    <span className="vq-vcompare-quote">
                                      {beat.before.join(' ') || '（空）'} → {beat.after.join(' ') || '（空）'}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {result.script.hookChanged ? (
                      <div className="vq-vcompare-hook">
                        <span className="vq-vcompare-group-label">开头钩子换过</span>
                        <div className="vq-vcompare-hook-pair">
                          <p><span className="vq-mono">v{result.base.n}</span>{result.script.hookBefore || '（空）'}</p>
                          <p><span className="vq-mono">v{result.target.n}</span>{result.script.hookAfter || '（空）'}</p>
                        </div>
                      </div>
                    ) : !scriptTouched ? (
                      <p className="vq-vcompare-state">口播与钩子都没动。</p>
                    ) : null}
                  </>
                ) : (
                  <p className="vq-vcompare-state">有一侧脚本没存快照，脚本这一侧不比。</p>
                )}
              </section>

              {result.notes.length ? (
                <ul className="vq-vcompare-notes">
                  {result.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
              ) : null}
            </>
          ) : null}
        </div>

        <p className="vq-vcompare-note">
          只读：不改画布、不改脚本、不扣积分。节点只比类型与配置，移动位置或改标题不算；脚本按段名比口播，开版时存下的快照才算；评审读这一版最近一次，交付只认这一版的记录，交时评审照写当初、不被后来重评改写。没有快照或没评过的一侧不猜「没变」。
        </p>
      </div>
    </div>
  )
}
