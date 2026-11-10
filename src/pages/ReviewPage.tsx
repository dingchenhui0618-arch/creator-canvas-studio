import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Loader2, Play, RefreshCw, ScanEye, TriangleAlert } from 'lucide-react'
import { getReview, getReviewStatus, listReviews, runReview, type ReviewResult, type ReviewStatus, type ReviewSummary } from '../api/review'
import { getCredits, type CreditsResponse } from '../api/credits'
import { listTemplates, coverSrc } from '../api/radar'
import type { ReplicaTemplate } from '../domain/radar'
import { consumeReviewTarget, onReviewRequest, type ReviewTarget } from '../state/review'
import { useUiMode } from '../api/app'
import PageHead from '../components/PageHead'
import '../styles/review.css'

const SEVERITY_LABEL: Record<string, string> = { blocker: '阻塞', major: '主要', minor: '次要', info: '信息' }
const VERDICT_LABEL: Record<string, string> = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }

type Picked = { media?: string; imageUrl?: string; label: string; preview: string }

export default function ReviewPage() {
  const { internal } = useUiMode()
  const [status, setStatus] = useState<ReviewStatus | null>(null)
  const [templates, setTemplates] = useState<ReplicaTemplate[]>([])
  const [picked, setPicked] = useState<Picked | null>(null)
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [historyError, setHistoryError] = useState('')
  const [manualUrl, setManualUrl] = useState('')
  const timerRef = useRef<number | null>(null)
  const startedRef = useRef(0)

  const pick = useCallback((target: Picked) => {
    setPicked(target)
    setResult(null)
    setError('')
    setActive(null)
  }, [])

  useEffect(() => {
    let alive = true
    getCredits(1).then((next) => { if (alive) setCredits(next) }).catch(() => { if (alive) setCredits(null) })
    listReviews(6)
      .then((data) => { if (alive) setReviews(data.items) })
      .catch((caught) => { if (alive) setHistoryError(caught instanceof Error ? caught.message : '评审历史读取失败') })
    Promise.all([getReviewStatus(), listTemplates({})])
      .then(([health, list]) => {
        if (!alive) return
        setStatus(health)
        setTemplates(list.items)
      })
      .catch(() => undefined)
    const stop = onReviewRequest((target: ReviewTarget) => {
      pick({
        media: target.media,
        imageUrl: target.imageUrl,
        label: target.label,
        preview: target.imageUrl || (target.media ? '/media/' + target.media.replace(/^media\//, '') : ''),
      })
    })
    const pending = consumeReviewTarget()
    if (pending) {
      window.setTimeout(() => {
        pick({ media: pending.media, imageUrl: pending.imageUrl, label: pending.label, preview: pending.imageUrl || (pending.media ? '/media/' + pending.media : '') })
      }, 0)
    }
    return () => {
      alive = false
      stop()
    }
  }, [pick])

  useEffect(() => {
    if (!running) return
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedRef.current) / 1000))
    }, 500)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [running])

  const run = async () => {
    if (!picked) return
    startedRef.current = Date.now()
    setElapsed(0)
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const next = await runReview({ media: picked.media, imageUrl: picked.imageUrl, intent: picked.label, label: picked.label })
      setResult(next)
      setActive(next.observations[0]?.id ?? null)
      // 评审已落库：刷新历史与余额，不靠本地缓存假装有记录
      void listReviews(6).then((data) => setReviews(data.items)).catch(() => undefined)
    } catch (reason) {
      setError(String((reason as Error)?.message || reason))
    } finally {
      setRunning(false)
      getCredits(1).then(setCredits).catch(() => undefined)
    }
  }

  const openHistory = useCallback(async (id: string) => {
    try {
      const record = await getReview(id)
      const media = record.source.media || ''
      const imageUrl = record.source.imageUrl || ''
      setPicked({
        media: media || undefined,
        imageUrl: imageUrl || undefined,
        label: record.source.label || record.intent || '历史评审',
        preview: imageUrl || (media ? '/media/' + media.replace(/^media\//, '') : ''),
      })
      setResult(record.result)
      setActive(record.result.observations?.[0]?.id ?? null)
      setError('')
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : '读取评审记录失败')
    }
  }, [])

  const anchors = useMemo(() => (result?.observations || []).filter((item) => item.evidence && (item.evidence.w > 0 || item.evidence.h > 0)), [result])

  return (
    <div className="review-page">
      <PageHead
        kicker="VisionQA · visual-baseline"
        title="视觉评审"
        desc="选一张画面，按 VisionQA 的 visual-baseline 规则出结论：每条判断都带证据锚点，没有证据的一律标记为「无法判断」。"
        actions={
          <div className="review-head-status">
            <span className={`vq-chip ${status?.service ? 'is-pass' : 'is-warn'}`}>
              <ScanEye size={13} /> 插件服务 {status?.service ? '已连接' : '未启动'}
            </span>
            <span className={`vq-chip ${status?.model ? 'is-pass' : 'is-fail'}`}>评审模型 {status?.model ? '可用' : '未配置'}</span>
            {credits ? (
              <span className="vq-chip" title="评审按次扣积分，失败原路退回">
                每次 {credits.prices.review} {credits.unit} · 余额 {credits.balance ?? '—'}
              </span>
            ) : null}
          </div>
        }
      />

      <div className="review-body">
        <aside className="review-picker">
          <div className="review-picker-head">
            <h2>被检视对象</h2>
            <span className="vq-mono">{templates.length} 个模板</span>
          </div>

          <div className="review-grid">
            {templates.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`review-thumb ${picked?.label === item.title ? 'is-active' : ''}`}
                onClick={() => pick({ imageUrl: item.thumb ? undefined : coverSrc(item.cover), media: item.thumb ? item.thumb.replace(/^\/media\//, '') : undefined, label: item.title, preview: item.thumb || coverSrc(item.cover) })}
                title={item.title}
              >
                {item.thumb || item.cover ? <img src={item.thumb || coverSrc(item.cover)} alt="" loading="lazy" /> : <span className="review-thumb-fallback">{item.contentType}</span>}
                <span className="review-thumb-name">{item.title}</span>
              </button>
            ))}
            {!templates.length ? <p className="review-empty">模板库还是空的，先去「爆款雷达」复刻一条。</p> : null}
          </div>

          <div className="review-manual">
            <label htmlFor="review-url">或粘贴图片地址</label>
            <div className="review-manual-row">
              <input
                id="review-url"
                value={manualUrl}
                placeholder="https://…jpg"
                onChange={(event) => setManualUrl(event.target.value)}
              />
              <button
                type="button"
                className="button button--ghost button--tiny"
                onClick={() => {
                  const value = manualUrl.trim()
                  if (!value) return
                  pick({ imageUrl: value, label: value.split('/').pop() || '远程图片', preview: value })
                }}
              >
                载入
              </button>
            </div>
          </div>

          <div className="review-history">
            <div className="review-picker-head">
              <span className="vq-mono">最近评审</span>
              <span className="vq-mono">{reviews.length}</span>
            </div>
            {historyError ? <p className="review-empty">{historyError}</p> : null}
            {reviews.length ? (
              <ul>
                {reviews.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="review-history-item" onClick={() => void openHistory(item.id)}>
                      <span className={item.verdict ? 'vq-chip is-verdict is-' + item.verdict : 'vq-chip'}>
                        {VERDICT_LABEL[item.verdict] || '未记录'}
                      </span>
                      <span className="review-history-title">{item.source.label || item.intent || '未命名评审'}</span>
                      <span className="vq-mono">
                        {new Date(item.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="review-empty">还没有评审记录；评审成功一次就会出现在这里。</p>
            )}
          </div>
        </aside>

        <section className="review-stage">
          {picked ? (
            <div className="review-canvas">
              <div className="review-canvas-frame vq-frame">
                <div className="review-canvas-shot">
                  <img src={picked.preview} alt={picked.label} />
                  {anchors.map((item) => (
                  <span
                      key={item.id}
                      className={`review-anchor is-${item.severity} ${active === item.id ? 'is-active' : ''}`}
                      style={{
                        left: (item.evidence as { x: number }).x * 100 + '%',
                        top: (item.evidence as { y: number }).y * 100 + '%',
                        width: (item.evidence as { w: number }).w * 100 + '%',
                        height: (item.evidence as { h: number }).h * 100 + '%',
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="review-canvas-meta">
                <span className="vq-mono">{picked.label}</span>
                <div className="review-canvas-actions">
                  <button type="button" className="button button--primary button--tiny" disabled={running || !status?.model} onClick={run}>
                    {running ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                    {running ? '评审中 ' + elapsed + 's' : result ? '重新评审' : '开始评审'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="review-empty-state">
              <div className="review-empty-head">
                <Crosshair size={18} strokeWidth={1.5} />
                <div>
                  <strong>先选一张要被检视的画面</strong>
                  <span>左侧点模板首帧，或粘贴图片地址。</span>
                </div>
              </div>
              <ol className="review-steps">
                <li>
                  <span className="vq-mono">01</span>
                  <div><strong>选对象</strong><p>模板首帧、远程图片都可以；画幅越接近投放尺寸，结论越可靠。</p></div>
                </li>
                <li>
                  <span className="vq-mono">02</span>
                  <div><strong>出结论</strong><p>{internal ? '按 visual-baseline 七项维度评审' : '按七项视觉维度评审'}，结论只有通过 / 需人工确认 / 不通过三种。</p></div>
                </li>
                <li>
                  <span className="vq-mono">03</span>
                  <div><strong>看证据</strong><p>每条判断带像素锚点，右侧高亮对应区域；没有证据的写进「无法判断」。</p></div>
                </li>
              </ol>
              <p className="review-empty-note">
                {status?.service
                  ? internal
                    ? '当前由 VisionQA 插件服务出结论；fixture provider 只证明链路可用，不代表模型准确率。'
                    : '当前由本地评审服务出结论，结果里会标明来源。'
                  : internal
                    ? 'VisionQA 插件服务未启动（127.0.0.1:6300），当前由本地视觉模型按同一套 visual-baseline 规则评审，provider 会写进结果。'
                    : '本地评审插件未启动，本次由平台视觉模型按同一套评审规则完成。'}
              </p>
            </div>
          )}

          {error ? (
            <div className="review-error">
              <TriangleAlert size={14} />
              <span>{error}</span>
              <button type="button" className="button button--ghost button--tiny" onClick={run}>
                <RefreshCw size={12} /> 重试
              </button>
            </div>
          ) : null}

          {result ? (
            <div className="review-result">
              <div className="review-verdict">
                <span className={`vq-chip is-verdict is-${result.verdict}`}>{VERDICT_LABEL[result.verdict]}</span>
                <p>{result.summary}</p>
                <span className="vq-mono">{result.provider} · {(result.ms / 1000).toFixed(1)}s</span>
              </div>

              <ol className="review-observations">
                {result.observations.map((item) => (
                  <li
                    key={item.id}
                    className={`review-obs ${active === item.id ? 'is-active' : ''} sev-${item.severity}`}
                    onMouseEnter={() => setActive(item.id)}
                    onFocus={() => setActive(item.id)}
                  >
                    <div className="review-obs-head">
                      <span className="vq-mono">{item.dimension}</span>
                      <span className={`vq-chip is-sev sev-${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span>
                      {item.evidence ? <span className="vq-mono">锚点 {Math.round(item.confidence * 100)}%</span> : <span className="vq-mono">无锚点</span>}
                    </div>
                    <p>{item.statement}</p>
                  </li>
                ))}
              </ol>

              {result.fixes.length ? (
                <div className="review-fixes">
                  <h3>有界修正建议</h3>
                  <ul>
                    {result.fixes.map((item) => (
                      <li key={item.title}>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {result.notAssessable.length ? (
                <div className="review-gaps">
                  <h3>无法判断</h3>
                  <ul>
                    {result.notAssessable.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              ) : null}

              <p className="review-note">{result.note}</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}
