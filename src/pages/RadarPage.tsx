import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  BookmarkPlus,
  Check,
  ExternalLink,
  Film,
  Heart,
  History,
  MessageCircle,
  Play,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Star,
} from 'lucide-react'
import { clearSearchHistory, coverSrc, formatCount, formatDuration, getHealth, listSearchHistory, saveTemplate, searchMedia, toggleSearchFavorite } from '../api/radar'
import type { MediaItem, SearchHistoryEntry } from '../domain/radar'
import { ReplicateModal } from '../components/ReplicateModal'
import PageHead from '../components/PageHead'
import { getCredits, type CreditsResponse } from '../api/credits'
import '../styles/radar.css'
import '../styles/credits.css'

const PLATFORMS = [
  { value: 'all', label: '全部平台' },
  { value: 'douyin', label: '抖音' },
  { value: 'xiaohongshu', label: '小红书' },
]

const RANGES = [
  { value: '', label: '不限时间' },
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
]

const SORTS = [
  { value: 'likes', label: '按点赞' },
  { value: 'collects', label: '按收藏' },
  { value: 'comments', label: '按评论' },
  { value: 'shares', label: '按转发' },
  { value: 'plays', label: '按播放' },
]

const dayOffset = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

// 互动率 =（点赞 + 收藏 + 评论 + 转发）/ 播放，播放量缺失时不显示，别拿点赞去凑分母
function interactionRate(item: MediaItem) {
  const plays = item.stats.plays || 0
  if (!plays) return 0
  const sum = item.stats.likes + item.stats.collects + item.stats.comments + item.stats.shares
  return (sum / plays) * 100
}

const statValue = (value: number | undefined) => formatCount(value || 0)

export function RadarPage({ onToast, onOpenTemplates }: { onToast: (message: string) => void; onOpenTemplates: () => void }) {
  const [platform, setPlatform] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [range, setRange] = useState('')
  const [sort, setSort] = useState('likes')
  const [items, setItems] = useState<MediaItem[]>([])
  const [mode, setMode] = useState<'live' | 'mock'>('mock')
  const [note, setNote] = useState('')
  // 分页：每次「加载更多」都是一次真实检索（按次计费），所以页码、快照和是否还有下一页都要记住
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [snapshot, setSnapshot] = useState<{ platform: string; q: string; start: string; end: string } | null>(null)
  const [quota, setQuota] = useState<{ code: string; message: string; rechargeUrl?: string; goodsName?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  // 进页面不自动检索：红狐按次计费，必须由用户点「检索」才发请求
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [visionReady, setVisionReady] = useState(false)
  const [modalItem, setModalItem] = useState<MediaItem | null>(null)
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [savingId, setSavingId] = useState('')
  // 积分：检索前告诉用户这一下花多少，检索后显示扣了多少、还剩多少
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [insufficient, setInsufficient] = useState('')
  const [history, setHistory] = useState<SearchHistoryEntry[]>([])

  // 积分余额是服务端账本，检索成功/失败后都重新拉一次，界面上的数字永远可信
  const refreshCredits = useCallback(() => {
    getCredits(1).then(setCredits).catch(() => setCredits(null))
  }, [])

  // 历史只存条件：点一下把条件填回表单，不自动检索——每次检索 2 积分，不能替用户花
  const loadHistory = useCallback(() => {
    listSearchHistory()
      .then((result) => setHistory(result.items || []))
      .catch(() => setHistory([]))
  }, [])

  const applyHistory = useCallback((entry: SearchHistoryEntry) => {
    setPlatform(entry.platform || 'all')
    setKeyword(entry.keyword || '')
    setSort(entry.sort || 'likes')
    setRange(entry.range || '')
    onToast('已填回「' + entry.keyword + '」的检索条件，确认后点检索')
  }, [onToast])

  const favoriteHistory = useCallback((entry: SearchHistoryEntry) => {
    toggleSearchFavorite(entry.id)
      .then(() => loadHistory())
      .catch((caught) => onToast(caught instanceof Error ? caught.message : '收藏失败'))
  }, [loadHistory, onToast])

  const removeHistory = useCallback(() => {
    clearSearchHistory()
      .then((result) => {
        loadHistory()
        onToast(result.removed ? '已清空 ' + result.removed + ' 条历史，收藏的还留着' : '没有可清空的记录，收藏的还留着')
      })
      .catch((caught) => onToast(caught instanceof Error ? caught.message : '清空失败'))
  }, [loadHistory, onToast])

  const runSearch = useCallback(async () => {
    setLoading(true)
    setError('')
    setInsufficient('')
    const query = { platform, q: keyword.trim(), range, start: range ? dayOffset(Number(range)) : '', end: range ? dayOffset(0) : '' }
    try {
      const result = await searchMedia({ ...query, page: 1, sort })
      setItems(result.items)
      setTotal(Number(result.total) || result.items.length)
      setPage(1)
      setHasMore(Boolean(result.hasMore))
      setSnapshot(query)
      setMode(result.mode)
      setNote(result.note || '')
      setQuota(result.quota ? { code: result.quota.code, message: result.quota.message, rechargeUrl: result.quota.rechargeUrl, goodsName: result.quota.goodsName } : null)
      setSearched(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      // 余额不足不是「出错」，是明确的状态：单独提示，并禁用检索按钮
      if (/积分不足/.test(message)) setInsufficient(message)
      setSearched(true)
    } finally {
      setLoading(false)
      refreshCredits()
      loadHistory()
    }
  }, [keyword, platform, range, sort, refreshCredits, loadHistory])

  // 加载更多：沿用第一次检索的筛选快照，只把页码往后翻；同一批结果按 id 去重
  const loadMore = useCallback(async () => {
    if (!snapshot || loadingMore || !hasMore) return
    setLoadingMore(true)
    setError('')
    setInsufficient('')
    try {
      const result = await searchMedia({ ...snapshot, page: page + 1, sort })
      setItems((current) => {
        const seen = new Set(current.map((entry) => entry.id))
        return [...current, ...result.items.filter((entry) => !seen.has(entry.id))]
      })
      setTotal(Number(result.total) || total)
      setPage((value) => value + 1)
      setHasMore(Boolean(result.hasMore))
      if (result.note) setNote(result.note)
      if (result.quota) setQuota({ code: result.quota.code, message: result.quota.message, rechargeUrl: result.quota.rechargeUrl, goodsName: result.quota.goodsName })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (/积分不足/.test(message)) setInsufficient(message)
      else setError(message)
    } finally {
      setLoadingMore(false)
      refreshCredits()
    }
  }, [snapshot, page, sort, hasMore, loadingMore, total, refreshCredits])

  useEffect(() => {
    getHealth()
      .then((health) => { setHasKey(health.redfox); setVisionReady(health.vision) })
      .catch(() => { setHasKey(false); setVisionReady(false) })
    refreshCredits()
    loadHistory()
    // 首屏只读健康状态、积分余额与检索历史，不检索：检索必须由用户点按钮触发
  }, [refreshCredits, loadHistory])

  const sorted = useMemo(() => {
    const copy = [...items]
    copy.sort((a, b) => ((b.stats as Record<string, number>)[sort] || 0) - ((a.stats as Record<string, number>)[sort] || 0))
    return copy
  }, [items, sort])

  // 筛选改动后旧结果还在屏上：明确告诉用户要点「重新检索」，加载更多也停住，避免混进两套条件
  const currentStart = range ? dayOffset(Number(range)) : ''
  const stale = Boolean(searched && snapshot && (snapshot.platform !== platform || snapshot.q !== keyword.trim() || snapshot.start !== currentStart))
  // 有些关键词上游没回播放量，按播放排就排不动：与其静默不动，不如说清缺哪项数据
  const sortLabel = SORTS.find((entry) => entry.value === sort)?.label || '排序'
  const sortHasData = sorted.some((item) => ((item.stats as Record<string, number>)[sort] || 0) > 0)

  const totalLikes = sorted.reduce((sum, item) => sum + item.stats.likes, 0)
  const totalPlays = sorted.reduce((sum, item) => sum + (item.stats.plays || 0), 0)

  const addToLibrary = useCallback(
    async (item: MediaItem) => {
      setSavingId(item.id)
      try {
        const result = await saveTemplate(item)
        setSavedIds((current) => (current.includes(item.id) ? current : [...current, item.id]))
        onToast(result.created ? '已加入模板库：只存了原链接与互动数据' : '这条已经在模板库里了')
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : '加入模板库失败')
      } finally {
        setSavingId('')
      }
    },
    [onToast],
  )

  return (
    <div className="page page--radar">
      <PageHead
        kicker="内容雷达"
        title="爆款雷达"
        desc="按关键词检索抖音与小红书的内容与互动数据：点赞、收藏、评论、转发、播放都取原始值。挑一条加进模板库只存链接，或者直接拆成脚本与分镜。"
        actions={
          <>
            <span className={`status-pill ${hasKey ? (quota ? 'is-error' : 'is-live') : 'is-mock'}`}>
              <span className="status-dot" />
              {hasKey ? (quota ? '检索服务异常' : '检索服务已连接') : '示例数据模式'}
            </span>
            <span
              className={'radar-credit' + (insufficient || (credits && credits.balance !== null && credits.balance < credits.prices.search) ? ' is-low' : '')}
              title="积分余额来自服务端记录；示例结果不扣积分"
            >
              余额 <strong>{credits?.balance ?? '—'}</strong> {credits?.unit || '积分'}
              {credits ? ' · 每次 ' + credits.prices.search : ''}
            </span>
            <button className="button button--ghost" onClick={onOpenTemplates}>模板库</button>
          </>
        }
      />

      <div className="radar-toolbar">
        <div className="filter-tabs">
          {PLATFORMS.map((item) => (
            <button key={item.value} className={platform === item.value ? 'is-active' : ''} onClick={() => setPlatform(item.value)}>{item.label}</button>
          ))}
        </div>
        <label className="inline-search radar-search">
          <Search size={15} />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }}
            placeholder="搜索赛道或选题，例如：春季通勤穿搭 / 咖啡开箱 / 租房改造"
          />
        </label>
        <select className="select select--compact" value={range} onChange={(event) => setRange(event.target.value)} aria-label="时间范围">
          {RANGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <select className="select select--compact" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="排序方式">
          {SORTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <button
          className="button button--primary"
          onClick={() => void runSearch()}
          disabled={loading || Boolean(insufficient)}
          title={insufficient ? '积分不足，先让管理员发放积分' : ''}
        >
          {loading ? <RefreshCw size={15} className="spin" /> : <Search size={15} />}
          {loading ? '检索中' : searched ? '重新检索' : '检索'}
        </button>
      </div>
      {credits ? (
        <p className="radar-credit-note">
          每次检索消耗 <strong>{credits.prices.search}</strong> {credits.unit}，检索失败会原路退回；示例结果不扣积分。
        </p>
      ) : null}

      {history.length ? (
        <div className="radar-history">
          <span className="radar-history-label"><History size={13} />检索历史</span>
          <div className="radar-history-list">
            {history.map((entry) => (
              <span className={'radar-history-chip' + (entry.favorite ? ' is-favorite' : '')} key={entry.id}>
                <button
                  type="button"
                  className="radar-history-main"
                  onClick={() => applyHistory(entry)}
                  title="点一下把这组条件填回上面，确认后再点检索（不会自动扣积分）"
                >
                  <em>{entry.platform === 'douyin' ? '抖音' : entry.platform === 'xiaohongshu' ? '小红书' : '全部'}</em>
                  <b>{entry.keyword}</b>
                  {entry.total ? <span>{formatCount(entry.total)} 条</span> : null}
                </button>
                <button
                  type="button"
                  className={'radar-history-star' + (entry.favorite ? ' is-on' : '')}
                  onClick={() => favoriteHistory(entry)}
                  aria-label={entry.favorite ? '取消收藏' : '收藏这组关键词'}
                  title={entry.favorite ? '取消收藏' : '收藏这组关键词'}
                >
                  <Star size={12} fill={entry.favorite ? 'currentColor' : 'none'} />
                </button>
              </span>
            ))}
          </div>
          <button type="button" className="radar-history-clear" onClick={removeHistory}>清空</button>
        </div>
      ) : null}

      {quota ? (
        <div className="radar-banner radar-banner--quota">
          <AlertCircle size={15} />
          <span>
            VisionQA 检索服务已连通，但<strong>{quota.code === 'REDFOX_DISABLED' ? 'Key 已被禁用' : '账号积分不足'}</strong>：{quota.message}。当前显示的是示例数据，不是真实平台数据。
            {quota.goodsName ? '（充值商品：' + quota.goodsName + '）' : ''}
            {quota.code === 'REDFOX_DISABLED' ? '（请管理员到服务端确认检索凭证）' : '（请管理员补充服务端额度）'}
          </span>
        </div>
      ) : !hasKey ? (
        <div className="radar-banner">
          <AlertCircle size={15} />
          <span>{note || '检索服务还没接入，当前展示的是示例数据（标题与互动数都不是真实平台数据）。接入后，这一屏会直接显示真实检索结果。'}</span>
        </div>
      ) : null}

      {insufficient ? (
        <div className="radar-banner radar-banner--error">
          <AlertCircle size={15} />
          <span>
            {insufficient}。充值通道还没开通，请让管理员在「设置 → 账号与积分」里发放，或稍后余额到账再试。
          </span>
        </div>
      ) : error ? (
        <div className="radar-banner radar-banner--error">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {searched && (
        <div className="radar-summary">
          <span>
            <strong>{sorted.length}</strong> 条已加载
            {total > sorted.length ? ' · 共 ' + formatCount(total) + ' 条' : ''}
          </span>
          {totalPlays > 0 && <span><strong>{formatCount(totalPlays)}</strong> 累计播放</span>}
          <span><strong>{formatCount(totalLikes)}</strong> 累计点赞</span>
          <span className="radar-summary-note">{mode === 'live' ? '数据来自 VisionQA 检索' : hasKey ? '示例数据 · 服务不可用' : '示例数据 · 检索未接入'}</span>
        </div>
      )}

      {loading && !sorted.length ? (
        <div className="radar-grid">
          {[0, 1, 2, 3, 4, 5].map((key) => <div className="radar-card radar-card--skeleton" key={key}><div className="skeleton skeleton--cover" /><div className="skeleton skeleton--line" /><div className="skeleton skeleton--line skeleton--short" /></div>)}
        </div>
      ) : sorted.length ? (
        <div className="radar-grid">
          {sorted.map((item) => {
            const rate = interactionRate(item)
            const saved = savedIds.includes(item.id)
            return (
              <article className="radar-card" key={item.id}>
                <div className="radar-cover">
                  {item.cover ? (
                    <img src={coverSrc(item.cover)} alt="" loading="lazy" />
                  ) : (
                    <span className="radar-cover-empty">
                      <span className="vq-mono">示例数据 · 无封面</span>
                    </span>
                  )}
                  <span className="radar-badge">{item.platformLabel}</span>
                  <span className="radar-duration"><Film size={11} />{formatDuration(item.durationSec)}</span>
                  <button
                    className="radar-hover"
                    disabled={mode === 'mock'}
                    onClick={() => setModalItem(item)}
                    aria-label={`一键复刻 ${item.title}`}
                    title={mode === 'mock' ? '示例数据没有原视频，无法复刻' : undefined}
                  >
                    <span className="radar-hover-pill"><Sparkles size={14} />一键复刻</span>
                    <span className="radar-hover-hint">抽帧 · 逐帧分析 · 存成模板</span>
                  </button>
                </div>
                <div className="radar-copy">
                  <strong className="radar-title">{item.title || '（无标题）'}</strong>
                  <span className="radar-author">{item.author || '未知作者'}{item.publishedAt ? ' · ' + item.publishedAt : ''}</span>
                  <div className="radar-stats">
                    {(item.stats.plays || 0) > 0 && (
                      <span title={'播放 ' + statValue(item.stats.plays)}><Play size={12} />{statValue(item.stats.plays)}</span>
                    )}
                    <span title={'点赞 ' + statValue(item.stats.likes)}><Heart size={12} />{statValue(item.stats.likes)}</span>
                    <span title={'收藏 ' + statValue(item.stats.collects)}><Star size={12} />{statValue(item.stats.collects)}</span>
                    <span title={'评论 ' + statValue(item.stats.comments)}><MessageCircle size={12} />{statValue(item.stats.comments)}</span>
                    <span title={'转发 ' + statValue(item.stats.shares)}><Share2 size={12} />{statValue(item.stats.shares)}</span>
                    {rate > 0 && <em className="radar-rate" title="互动率 =（点赞 + 收藏 + 评论 + 转发）/ 播放">互动率 {rate.toFixed(1)}%</em>}
                  </div>
                </div>
                <div className="radar-actions">
                  <button className="button button--ghost button--tiny" disabled={!item.url} onClick={() => item.url && window.open(item.url, '_blank', 'noopener')}>
                    <ExternalLink size={13} />原视频
                  </button>
                  <button
                    className="button button--ghost button--tiny"
                    disabled={!item.url || savingId === item.id || saved}
                    title={!item.url ? '示例数据没有原链接，无法加入模板库' : '只存原链接与互动数据，不下载视频'}
                    onClick={() => void addToLibrary(item)}
                  >
                    {saved ? <Check size={13} /> : <BookmarkPlus size={13} />}
                    {saved ? '已加入' : savingId === item.id ? '加入中' : '加入模板库'}
                  </button>
                  <button
                    className="button button--primary button--tiny"
                    disabled={mode === 'mock'}
                    title={mode === 'mock' ? '示例数据没有原视频，无法复刻' : undefined}
                    onClick={() => setModalItem(item)}
                  >
                    <Play size={13} />一键复刻
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}

      {searched && sorted.length ? (
        <div className="radar-more">
          <span className="radar-more-note">
            {stale
              ? '筛选条件已改，点「重新检索」才会更新结果；加载更多已暂停。'
              : hasMore
                ? '已加载 ' + sorted.length + ' 条' + (total > sorted.length ? ' / 共 ' + formatCount(total) + ' 条' : '') + '，排序作用于已加载范围。'
                : '已加载全部 ' + sorted.length + ' 条。'}
            {!sortHasData ? ' 当前结果缺少' + sortLabel + '所需的数据，顺序不会变化。' : ''}
          </span>
          <button
            className="button button--ghost"
            disabled={loadingMore || stale || !hasMore || Boolean(insufficient)}
            title={stale ? '先点「重新检索」' : hasMore ? '每次加载一页，和检索一样按次计费' : '没有更多了'}
            onClick={() => void loadMore()}
          >
            {loadingMore ? <RefreshCw size={14} className="spin" /> : null}
            {hasMore ? (loadingMore ? '加载中' : '加载更多 · 每次 ' + (credits?.prices.search ?? 2) + ' 积分') : '已加载全部'}
          </button>
        </div>
      ) : null}

      {!searched ? (
        <div className="radar-idle">
          <Search size={20} />
          <strong>先输入关键词，再点「检索」</strong>
          <span>
            {hasKey
              ? '检索按次计费，进页面不会自动检索；点一次检索才发一次请求。'
              : '检索服务还没接入：检索会返回明确标注的示例数据。'}
          </span>
          <div className="radar-idle-tags">
            {['春季通勤穿搭', '咖啡开箱', '租房改造', '护肤台收纳'].map((value) => (
              <button key={value} className="radar-idle-tag" onClick={() => { setKeyword(value); void runSearch() }}>{value}</button>
            ))}
          </div>
        </div>
      ) : !sorted.length && !loading ? (
        <div className="radar-empty">
          <Sparkles size={22} />
          <strong>没有检索到内容</strong>
          <span>换一个更细的关键词（例如「通勤穿搭」而不是「穿搭」），或放宽时间范围。</span>
        </div>
      ) : null}

      {modalItem && (
        <ReplicateModal
          item={modalItem}
          hasKey={hasKey}
          visionReady={visionReady}
          onClose={() => setModalItem(null)}
          onDone={(title) => { setModalItem(null); onToast('复刻完成，已存入模板库：' + title) }}
          onOpenTemplates={() => { setModalItem(null); onOpenTemplates() }}
        />
      )}
    </div>
  )
}
