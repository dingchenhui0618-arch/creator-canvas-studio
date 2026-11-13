import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BookmarkPlus,
  Check,
  Clock,
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
import { clearSearchHistory, coverSrc, formatCount, formatDuration, getHealth, getTakenOrigins, listSearchHistory, lookupLibrary, saveTemplate, searchMedia, toggleSearchFavorite } from '../api/radar'
import type { LibraryMark, MediaItem, SearchHistoryEntry, TakenOrigins } from '../domain/radar'
import { ago, stampTime } from '../domain/share'
import { createProject } from '../api/projects'
import { ReplicateModal } from '../components/ReplicateModal'
import { Select } from '../components/Select'
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

// 「上次检索的结果还在」：回到发现页不用重查一遍（重查就是再花一次检索费）。
// 只留最近一次、最多 48 条；超过 7 天就丢掉——平台上的数字早变了，留着反而骗人。
// 放在 sessionStorage：关掉标签页就没了，不占长期存储，也不往服务端写。
const LAST_SEARCH_KEY = 'vq.radar.lastSearch.v1'
const LAST_SEARCH_MAX_AGE = 7 * 24 * 60 * 60 * 1000
const LAST_SEARCH_ITEMS = 48

type LastSearch = {
  at: string
  platform: string
  keyword: string
  range: string
  sort: string
  mode: 'live' | 'mock'
  items: MediaItem[]
  total: number
  page: number
  hasMore: boolean
  snapshot: { platform: string; q: string; start: string; end: string } | null
  note: string
}

function readLastSearch(): LastSearch | null {
  try {
    const raw = window.sessionStorage.getItem(LAST_SEARCH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastSearch
    if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return null
    const at = Date.parse(parsed.at)
    if (!Number.isFinite(at) || Date.now() - at > LAST_SEARCH_MAX_AGE) return null
    return parsed
  } catch {
    return null
  }
}

// 存不下（隐私模式 / 配额满）就当没记住：记不住一次检索是小事，挡住检索本身是大事
function writeLastSearch(value: LastSearch | null) {
  try {
    if (value) window.sessionStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(value))
    else window.sessionStorage.removeItem(LAST_SEARCH_KEY)
  } catch {
    /* 忽略：见上 */
  }
}

export function RadarPage({ onToast, onOpenTemplates, onOpenTemplate, onOpenProject }: {
  onToast: (message: string) => void
  onOpenTemplates: () => void
  onOpenTemplate?: (templateId: string) => void
  onOpenProject?: (projectId: string) => void
}) {
  // 上一次检索的条件与条目：初始化时就取（不是进页面再补发请求），所以回来这一屏是现成的
  const [restored] = useState(readLastSearch)
  const [platform, setPlatform] = useState(restored?.platform || 'all')
  const [keyword, setKeyword] = useState(restored?.keyword || '')
  const [range, setRange] = useState(restored?.range || '')
  const [sort, setSort] = useState(restored?.sort || 'likes')
  const [items, setItems] = useState<MediaItem[]>(restored?.items.slice(0, LAST_SEARCH_ITEMS) || [])
  const [mode, setMode] = useState<'live' | 'mock'>(restored?.mode === 'live' ? 'live' : 'mock')
  const [note, setNote] = useState(restored?.note || '')
  // 分页：每次「加载更多」都是一次真实检索（按次计费），所以页码、快照和是否还有下一页都要记住
  const [page, setPage] = useState(Number(restored?.page) || 1)
  const [total, setTotal] = useState(Number(restored?.total) || restored?.items.length || 0)
  const [hasMore, setHasMore] = useState(Boolean(restored?.hasMore))
  const [loadingMore, setLoadingMore] = useState(false)
  const [snapshot, setSnapshot] = useState<{ platform: string; q: string; start: string; end: string } | null>(restored?.snapshot || null)
  const [quota, setQuota] = useState<{ code: string; message: string; rechargeUrl?: string; goodsName?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  // 进页面不自动检索：红狐按次计费，必须由用户点「检索」才发请求。
  // 但「上次检索的结果」不算检索：那是已经付过费的条目，原样放回来，不重新请求
  const [searched, setSearched] = useState(Boolean(restored))
  const [error, setError] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [visionReady, setVisionReady] = useState(false)
  const [modalItem, setModalItem] = useState<MediaItem | null>(null)
  // 这一屏里哪几条已经在库里：按平台 id 认（链接带分享参数也认得出来），只读现查，不检索、不扣积分
  const [marks, setMarks] = useState<Record<string, LibraryMark>>({})
  const [savingId, setSavingId] = useState('')
  // 正在照哪条模板开作品：按钮当场写「正在建」，不给第二次点击再开一条
  const [workSaving, setWorkSaving] = useState('')
  // 积分：检索前告诉用户这一下花多少，检索后显示扣了多少、还剩多少
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [insufficient, setInsufficient] = useState('')
  const [history, setHistory] = useState<SearchHistoryEntry[]>([])
  // 发现页开场那块「带走的原片」：只读现算，不检索、不扣积分
  const [taken, setTaken] = useState<TakenOrigins | null>(null)
  // 这一屏结果是不是「上次检索」留下的（有时间就写着，重新检索或清掉才没了）
  const [restoredAt, setRestoredAt] = useState(restored?.at || '')

  // 积分余额是服务端账本，检索成功/失败后都重新拉一次，界面上的数字永远可信
  const refreshCredits = useCallback(() => {
    getCredits(1).then(setCredits).catch(() => setCredits(null))
  }, [])

  // 库里带走过什么：模板上留着原片链接，作品那侧只有模板指针，服务端现算
  const loadTaken = useCallback(() => {
    getTakenOrigins(4)
      .then(setTaken)
      .catch(() => setTaken(null))
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

  // 清掉这一屏（不动服务端的检索历史：历史存的是条件，不存结果）
  const clearLastSearch = useCallback(() => {
    writeLastSearch(null)
    setRestoredAt('')
    setSearched(false)
    setItems([])
    setTotal(0)
    setPage(1)
    setHasMore(false)
    setSnapshot(null)
    setNote('')
    setError('')
    setInsufficient('')
    onToast('已清掉上次检索的结果，检索历史还留着')
  }, [onToast])

  // override：点子里的建议关键词要按那个词搜——setKeyword 之后同一个事件里读到的还是旧 keyword，
  // 以前「点建议」实际搜的是上一次的关键词（首屏就是个空关键词），等于把建议做成了摆设
  const runSearch = useCallback(async (override?: string) => {
    setLoading(true)
    setError('')
    setInsufficient('')
    const query = { platform, q: (override ?? keyword).trim(), range, start: range ? dayOffset(Number(range)) : '', end: range ? dayOffset(0) : '' }
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
      // 这一屏是刚查的：把「上次检索」的旧标签换掉，并记下这次（下次回来不用再花一次检索费）
      setRestoredAt('')
      writeLastSearch({
        at: new Date().toISOString(),
        platform,
        keyword: query.q,
        range,
        sort,
        mode: result.mode,
        items: result.items.slice(0, LAST_SEARCH_ITEMS),
        total: Number(result.total) || result.items.length,
        page: 1,
        hasMore: Boolean(result.hasMore),
        snapshot: query,
        note: result.note || '',
      })
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
      const seen = new Set(items.map((entry) => entry.id))
      const merged = [...items, ...result.items.filter((entry) => !seen.has(entry.id))]
      setItems(merged)
      setTotal(Number(result.total) || total)
      setPage((value) => value + 1)
      setHasMore(Boolean(result.hasMore))
      if (result.note) setNote(result.note)
      // 翻页也是这一屏的一部分：连着上次的条件一起存，回来后页码与「还有没有下一页」都对得上
      writeLastSearch({
        at: restoredAt || new Date().toISOString(),
        platform,
        keyword: keyword.trim(),
        range,
        sort,
        mode: result.mode,
        items: merged.slice(0, LAST_SEARCH_ITEMS),
        total: Number(result.total) || total,
        page: page + 1,
        hasMore: Boolean(result.hasMore),
        snapshot,
        note: result.note || note,
      })
      if (result.quota) setQuota({ code: result.quota.code, message: result.quota.message, rechargeUrl: result.quota.rechargeUrl, goodsName: result.quota.goodsName })
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (/积分不足/.test(message)) setInsufficient(message)
      else setError(message)
    } finally {
      setLoadingMore(false)
      refreshCredits()
    }
  }, [snapshot, page, sort, hasMore, loadingMore, total, refreshCredits, items, restoredAt, platform, keyword, range, note])

  useEffect(() => {
    getHealth()
      .then((health) => { setHasKey(health.redfox); setVisionReady(health.vision) })
      .catch(() => { setHasKey(false); setVisionReady(false) })
    refreshCredits()
    loadHistory()
    loadTaken()
    // 首屏只读健康状态、积分余额、检索历史与库里带走的原片，不检索：检索必须由用户点按钮触发
  }, [refreshCredits, loadHistory, loadTaken])


  const sorted = useMemo(() => {
    const copy = [...items]
    copy.sort((a, b) => ((b.stats as Record<string, number>)[sort] || 0) - ((a.stats as Record<string, number>)[sort] || 0))
    return copy
  }, [items, sort])

  // 结果一换就问一次「这几条库里有没有」：只读、不扣积分，问的是平台 id 而不是链接原文
  useEffect(() => {
    if (!sorted.length) return
    let live = true
    lookupLibrary(sorted.slice(0, 24).map((item) => ({ id: item.id, platform: item.platform, url: item.url || '' })))
      .then((result) => {
        if (!live) return
        const next: Record<string, LibraryMark> = {}
        for (const mark of result.items) next[mark.id] = mark
        setMarks(next)
      })
      .catch(() => {
        if (live) setMarks({})
      })
    return () => {
      live = false
    }
  }, [sorted])

  // 筛选改动后旧结果还在屏上：明确告诉用户要点「重新检索」，加载更多也停住，避免混进两套条件
  const currentStart = range ? dayOffset(Number(range)) : ''
  const stale = Boolean(searched && snapshot && (snapshot.platform !== platform || snapshot.q !== keyword.trim() || snapshot.start !== currentStart))
  // 有些关键词上游没回播放量，按播放排就排不动：与其静默不动，不如说清缺哪项数据
  const sortLabel = SORTS.find((entry) => entry.value === sort)?.label || '排序'
  const sortHasData = sorted.some((item) => ((item.stats as Record<string, number>)[sort] || 0) > 0)

  const totalLikes = sorted.reduce((sum, item) => sum + item.stats.likes, 0)
  const totalPlays = sorted.reduce((sum, item) => sum + (item.stats.plays || 0), 0)

  // 复刻完成之后这张卡片当场变成「库里已有」：不刷新的话按钮还是「加入模板库」，
  // 再点一次只会被去重成一句「这条已经在模板库里了」（v0.9.39 顺手修）
  const refreshMark = useCallback((item: MediaItem) => {
    lookupLibrary([{ id: item.id, platform: item.platform, url: item.url || '' }])
      .then((result) => {
        const mark = result.items[0]
        if (!mark) return
        setMarks((current) => ({ ...current, [item.id]: mark }))
      })
      .catch(() => undefined)
  }, [])

  // 照一条已解析的模板开成作品（v0.9.39）：建完直接进作品页——下一步（开画布）由作品页统一给，
  // 发现页不另写一套流程。能不能开由服务端的 entry 判断（kind: blocked 时按钮点不动），这里不重复一份。
  const startWork = useCallback(
    async (templateId: string, title: string) => {
      if (!templateId || workSaving) return
      setWorkSaving(templateId)
      try {
        const result = await createProject({ templateId, title })
        onToast('已开成作品：' + result.project.title)
        // 回到发现页时这一行已经是「作品 · …」：先把这块刷新一遍，导航被拦下也看得到结果
        loadTaken()
        if (onOpenProject) onOpenProject(result.project.id)
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : '开成作品没有成功，稍后再试一次')
      } finally {
        setWorkSaving('')
      }
    },
    [onOpenProject, onToast, loadTaken, workSaving],
  )

  const addToLibrary = useCallback(
    async (item: MediaItem) => {
      setSavingId(item.id)
      try {
        const result = await saveTemplate(item)
        // 刚存下的这一条当场变成「库里已有」，按钮跟着换成「打开模板」：不必等下一次检索
        setMarks((current) => ({
          ...current,
          [item.id]: {
            id: item.id,
            templateId: result.template.id,
            title: result.template.title,
            source: '',
            shared: false,
            workCount: 0,
            project: null,
            entry: null,
          },
        }))
        // 再问一次服务端：这一条的下一步（还没解析 / 开成作品）由同一个口径给出，界面不自己编
        refreshMark(item)
        loadTaken()
        onToast(result.created ? '已加入模板库：只存了原链接与互动数据' : '这条已经在模板库里了')
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : '加入模板库失败')
      } finally {
        setSavingId('')
      }
    },
    [onToast, loadTaken, refreshMark],
  )

  return (
    <div className="page page--radar">
      <PageHead
        kicker="内容发现"
        title="发现"
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
        <div className="vq-filter-row">
          {PLATFORMS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={'vq-filter-chip' + (platform === item.value ? ' is-active' : '')}
              aria-pressed={platform === item.value}
              onClick={() => setPlatform(item.value)}
            >
              {item.label}
            </button>
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
        <Select value={range} options={RANGES} onChange={setRange} label="时间范围" />
        <Select value={sort} options={SORTS} onChange={setSort} label="排序方式" />
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

      {/* 库里的原片（v0.9.36）：开场先说清库里已经有哪些原片、哪条已经开成作品。
          只是看库，不检索、不扣积分；有结果时让位给结果。 */}
      {!searched && taken && taken.total ? (
        <section className="radar-taken" aria-labelledby="radar-taken-title">
          <div className="radar-taken-head">
            <div>
              <h2 id="radar-taken-title">库里的原片</h2>
              <p className="radar-taken-sub">
                {'库里 ' + taken.total + ' 条原片'}
                {taken.official === taken.total
                  ? '，都是官方示例'
                  : taken.official
                    ? '（其中 ' + taken.official + ' 条是官方示例）'
                    : ''}
                {taken.withProject ? '，' + taken.withProject + ' 条已经开成作品' : '，都还没开成作品'}
                {taken.pending ? '，还有 ' + taken.pending + ' 条没开成作品' : ''}
                {taken.lastAt ? '；最近一条：' + ago(taken.lastAt) + '。' : '。'}
                {'点一行打开它的模板；还没开成作品的那行可以直接开一条。'}
              </p>
            </div>
            <button type="button" className="vq-link" onClick={onOpenTemplates}>
              模板库
              <ArrowRight size={13} />
            </button>
          </div>
          <div className="radar-taken-list">
            {taken.items.map((row) => (
              <div className="radar-taken-row" key={row.templateId}>
                <button
                  type="button"
                  className="radar-taken-main"
                  onClick={() => onOpenTemplate?.(row.templateId)}
                  aria-label={'打开这条原片存成的模板：' + (row.title || '（无标题）')}
                  title="打开这条原片存成的模板（里面能看到用它的作品）"
                >
                  <span className="radar-taken-platform">{row.platformLabel || '原片'}</span>
                  <span className="radar-taken-copy">
                    <strong>{row.title || '（无标题）'}</strong>
                    <span className="radar-taken-meta">
                      {row.official ? <span className="radar-taken-flag">官方示例</span> : null}
                      <span>{row.author || '作者没记下'}</span>
                      {row.templates > 1 ? <span>{'存成 ' + row.templates + ' 条模板'}</span> : null}
                      {row.stats ? (
                        <>
                          <span>点赞 {formatCount(row.stats.likes)}</span>
                          <span>收藏 {formatCount(row.stats.collects)}</span>
                          <span>评论 {formatCount(row.stats.comments)}</span>
                        </>
                      ) : (
                        <span>没记互动数据</span>
                      )}
                    </span>
                  </span>
                  <ArrowRight size={13} />
                </button>
                {/* 每一行的下一步（v0.9.39）：已经开过作品就进那条，没开就照这条模板开一条。
                    文案与能不能开都由服务端的 entry 给，界面不另写一份判断。 */}
                {row.entry?.kind === 'open-work' ? (
                  <button
                    type="button"
                    className="radar-taken-work"
                    onClick={() => onOpenProject?.(row.entry?.projectId || '')}
                    aria-label={row.entry.hint}
                    title={row.entry.hint}
                  >
                    {row.entry.label}
                    <ArrowRight size={12} />
                  </button>
                ) : row.entry?.kind === 'create-work' ? (
                  <button
                    type="button"
                    className="radar-taken-work radar-taken-work--start"
                    disabled={workSaving === row.templateId}
                    onClick={() => void startWork(row.templateId, row.title)}
                    aria-label={row.entry.hint}
                    title={row.entry.hint}
                  >
                    {workSaving === row.templateId ? '正在建' : row.entry.label}
                    {workSaving === row.templateId ? null : <ArrowRight size={12} />}
                  </button>
                ) : (
                  <span className="radar-taken-work is-blocked" title={row.entry?.hint || '这条还没解析'}>
                    {row.entry?.label || '还没解析'}
                  </span>
                )}
              </div>
            ))}
          </div>
          {taken.total > taken.items.length ? (
            <p className="radar-taken-more">
              {'另外 ' + (taken.total - taken.items.length) + ' 条在模板库里。'}
            </p>
          ) : null}
        </section>
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

      {/* 这一屏是上次检索留下的：说清是什么时候的、没重新扣费，给「重新检索」与「清掉」两个出口 */}
      {restoredAt ? (
        <div className="radar-restored">
          <Clock size={14} />
          <span className="radar-restored-copy">
            {'这是 '}
            <b>{stampTime(restoredAt)}</b>
            {' 那次检索留下的结果，没有重新请求，也没再扣积分；平台上的数字可能已经变了。'}
          </span>
          <button
            type="button"
            className="button button--ghost button--tiny"
            onClick={() => void runSearch()}
            disabled={loading || Boolean(insufficient)}
          >
            {loading ? '检索中' : '重新检索'}
          </button>
          <button type="button" className="radar-restored-clear" onClick={clearLastSearch}>清掉</button>
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
            const mark = marks[item.id]
            // 下一步只认「能点得动的两种」：还没解析的不抢「打开模板」那一格
            const entry = mark && (mark.entry?.kind === 'open-work' || mark.entry?.kind === 'create-work') ? mark.entry : null
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
                  {mark ? (
                    <span className="radar-owned" title={'已经在模板库里：' + mark.title}>
                      <Check size={11} />库里已有{mark.workCount ? ' · ' + mark.workCount + ' 条作品' : ''}
                    </span>
                  ) : null}
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
                  {mark && entry ? (
                    // 已经在库里、下一步清楚的，第二格直接给下一步（v0.9.39）：
                    // 开过作品的进作品，没开过的照这条模板开一条。还不清楚（没解析）的仍是「打开模板」。
                    <button
                      className="button button--primary button--tiny"
                      title={entry.hint}
                      disabled={workSaving === mark.templateId}
                      onClick={() => {
                        if (entry.kind === 'open-work') onOpenProject?.(entry.projectId)
                        else void startWork(mark.templateId, mark.title)
                      }}
                    >
                      {workSaving === mark.templateId ? <RefreshCw size={13} className="spin" /> : <ArrowRight size={13} />}
                      {workSaving === mark.templateId ? '正在建' : entry.label}
                    </button>
                  ) : mark ? (
                    <button
                      className="button button--ghost button--tiny"
                      title={'已经在模板库里：打开「' + mark.title + '」'}
                      onClick={() => onOpenTemplate?.(mark.templateId)}
                      disabled={!onOpenTemplate}
                    >
                      <ArrowRight size={13} />打开模板
                    </button>
                  ) : (
                    <button
                      className="button button--ghost button--tiny"
                      disabled={!item.url || savingId === item.id}
                      title={!item.url ? '示例数据没有原链接，无法加入模板库' : '只存原链接与互动数据，不下载视频'}
                      onClick={() => void addToLibrary(item)}
                    >
                      <BookmarkPlus size={13} />{savingId === item.id ? '加入中' : '加入模板库'}
                    </button>
                  )}
                  {/* 一张卡片只有一个主按钮：已经在库里、下一步清楚的，主按钮是「往下做」，复刻降成次要动作 */}
                  <button
                    className={'button button--tiny ' + (mark && entry ? 'button--ghost' : 'button--primary')}
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
              <button key={value} className="radar-idle-tag" onClick={() => { setKeyword(value); void runSearch(value) }}>{value}</button>
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
          onDone={(title) => {
      const done = modalItem
      setModalItem(null)
      loadTaken()
      onToast('复刻完成，已存入模板库：' + title)
      // 这张卡片当场翻成「库里已有」：再点「加入模板库」只会被去重成一句「已经在库里了」
      if (done) refreshMark(done)
    }}
          onOpenTemplates={() => { setModalItem(null); onOpenTemplates() }}
        />
      )}
    </div>
  )
}
