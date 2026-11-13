import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { listReviews, type ReviewFacets, type ReviewSummary } from '../api/review'
import { ReviewHistoryRow } from './ReviewHistoryRow'
import { Select } from './Select'

// 「查看全部」：评审历史存最多 200 条，左侧那 6 条只够看最近发生过什么。
// 这里做三件事：按结论 / 按作品筛，一页 20 条往下翻，点一条回到那次评审的证据页。
// 筛选与翻页都在服务端做——200 条正文加起来几十 MB，不能一次全发给浏览器。

const PAGE = 20
/** 作品筛选里的「没记入作品」：普通首帧评审，或作品删掉后留下的历史 */
const ORPHAN = '__orphan'
const VERDICT_FILTERS = [
  { value: '', label: '全部' },
  { value: 'pass', label: '通过' },
  { value: 'needs_review', label: '需人工确认' },
  { value: 'fail', label: '不通过' },
]

function verdictCount(facets: ReviewFacets | null, value: string) {
  if (!facets) return 0
  if (!value) return facets.verdicts.pass + facets.verdicts.needs_review + facets.verdicts.fail + facets.verdicts.none
  const key = value as 'pass' | 'needs_review' | 'fail'
  return facets.verdicts[key] || 0
}

export default function ReviewHistoryModal({
  currentId,
  onClose,
  onOpenReview,
}: {
  /** 页面上正打开的那条评审 */
  currentId?: string
  onClose: () => void
  onOpenReview: (reviewId: string) => void
}) {
  const [verdict, setVerdict] = useState('')
  const [scope, setScope] = useState('')
  const [items, setItems] = useState<ReviewSummary[]>([])
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState<ReviewFacets | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  // 换筛选时上一页的请求可能还在路上：只认最新那一次的响应
  const seqRef = useRef(0)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // 作品 id → 标题：某一结论下这条作品一条都没有时，下拉里仍然要显示「正在筛哪条作品」
  const [titles, setTitles] = useState<Record<string, string>>({})

  const query = useMemo(
    () => ({
      limit: PAGE,
      verdict,
      projectId: scope === ORPHAN ? '' : scope,
      orphan: scope === ORPHAN,
    }),
    [verdict, scope],
  )

  const rememberTitles = useCallback((projects: { id: string; title: string }[]) => {
    setTitles((current) => {
      const next = { ...current }
      for (const entry of projects) next[entry.id] = entry.title
      return next
    })
  }, [])

  const loadFirst = useCallback(() => {
    const seq = ++seqRef.current
    setLoading(true)
    setError('')
    listReviews({ ...query, offset: 0 })
      .then((page) => {
        if (seqRef.current !== seq) return
        rememberTitles(page.facets.projects)
        setItems(page.items)
        setTotal(page.total)
        setFacets(page.facets)
      })
      .catch((caught) => {
        if (seqRef.current !== seq) return
        setError(caught instanceof Error ? caught.message : '评审历史读取失败')
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false)
      })
  }, [query, rememberTitles])

  // 与评审页同一套写法：先让这一帧画完再发请求，免得同一帧里连锁改状态
  useEffect(() => {
    const timer = window.setTimeout(loadFirst, 0)
    return () => window.clearTimeout(timer)
  }, [loadFirst])

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadMore = () => {
    const seq = seqRef.current
    setLoadingMore(true)
    listReviews({ ...query, offset: items.length })
      .then((page) => {
        if (seqRef.current !== seq) return
        rememberTitles(page.facets.projects)
        setItems((current) => [...current, ...page.items])
        setTotal(page.total)
        setFacets(page.facets)
      })
      .catch((caught) => {
        if (seqRef.current !== seq) return
        setError(caught instanceof Error ? caught.message : '读取更多评审失败')
      })
      .finally(() => setLoadingMore(false))
  }

  const projectOptions = useMemo(() => {
    const options = [{ value: '', label: '全部作品' }]
    const listed = new Set<string>()
    for (const entry of facets?.projects || []) {
      options.push({ value: entry.id, label: entry.title + ' · ' + entry.count })
      listed.add(entry.id)
    }
    // 筛着的作品在这一结论下一条都没有时，计数是 0 也要留在下拉里：
    // 否则触发器退回占位文案，看见 0 条却不知道是哪个筛选在起作用
    if (scope && scope !== ORPHAN && !listed.has(scope)) {
      options.push({ value: scope, label: (titles[scope] || '当前作品') + ' · 0' })
    }
    if (facets?.orphans) options.push({ value: ORPHAN, label: '没记入作品 · ' + facets.orphans })
    return options
  }, [facets, scope, titles])

  const filtered = Boolean(verdict) || Boolean(scope)

  return (
    <div className="review-history-backdrop" onMouseDown={onClose}>
      <div
        className="review-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-history-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="review-history-head">
          <div>
            <span className="section-kicker">视觉评审 · 历史</span>
            <h2 id="review-history-title">每一次评审，都能翻到当时的画面</h2>
          </div>
          <button ref={closeRef} type="button" className="vq-button vq-button--icon" onClick={onClose} aria-label="关闭评审历史">
            <X size={16} />
          </button>
        </header>
        <p className="review-history-note">
          按结论或作品筛，一页 {PAGE} 条往下翻；点一条就回到那次评审的画面、结论与问题锚点。历史只读，不会再扣积分。
        </p>

        <div className="review-history-filters">
          <div className="vq-filter-row">
            {VERDICT_FILTERS.map((item) => (
              <button
                key={item.value || 'all'}
                type="button"
                className={'vq-filter-chip' + (verdict === item.value ? ' is-active' : '')}
                aria-pressed={verdict === item.value}
                onClick={() => setVerdict(item.value)}
              >
                {item.label}
                <span className="vq-filter-chip__count">{verdictCount(facets, item.value)}</span>
              </button>
            ))}
          </div>
          <div className="review-history-scope">
            <Select value={scope} options={projectOptions} onChange={setScope} label="按作品筛选" size="sm" />
            {filtered ? (
              <button
                type="button"
                className="review-history-clear"
                onClick={() => {
                  setVerdict('')
                  setScope('')
                }}
              >
                清除筛选
              </button>
            ) : null}
          </div>
        </div>

        {error ? <p className="review-history-error">{error}</p> : null}

        <div className="review-history-scroll">
          {loading ? (
            <div className="review-history-empty">
              <Loader2 size={16} className="spin" />
              <span>正在读评审历史</span>
            </div>
          ) : items.length ? (
            <ul className="review-history-list">
              {items.map((item) => (
                <li key={item.id}>
                  <ReviewHistoryRow
                    item={item}
                    current={item.id === currentId}
                    onOpen={(id) => {
                      onOpenReview(id)
                      onClose()
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="review-history-empty">
              <span>{filtered ? '这个筛选下还没有评审。' : '还没有评审记录；评审成功一次就会出现在这里。'}</span>
              {filtered ? (
                <button
                  type="button"
                  className="vq-button vq-button--ghost vq-button--sm"
                  onClick={() => {
                    setVerdict('')
                    setScope('')
                  }}
                >
                  看全部评审
                </button>
              ) : null}
            </div>
          )}
        </div>

        <footer className="review-history-foot">
          <span className="vq-mono">
            已显示 {items.length} / 共 {total} 条
          </span>
          <div className="review-history-foot-actions">
            {items.length < total ? (
              <button type="button" className="vq-button vq-button--ghost vq-button--sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? <Loader2 size={12} className="spin" /> : null}
                {loadingMore ? '正在读' : '再看 ' + Math.min(PAGE, total - items.length) + ' 条'}
              </button>
            ) : null}
            <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
