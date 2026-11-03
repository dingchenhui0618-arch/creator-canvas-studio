import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, Film, Heart, MessageCircle, Play, RefreshCw, Search, Share2, Sparkles, Star } from 'lucide-react'
import { coverSrc, formatCount, formatDuration, getHealth, searchMedia } from '../api/radar'
import type { MediaItem } from '../domain/radar'
import { ReplicateModal } from '../components/ReplicateModal'
import '../styles/radar.css'

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
]

const dayOffset = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().slice(0, 10)
}

export function RadarPage({ onToast, onOpenTemplates }: { onToast: (message: string) => void; onOpenTemplates: () => void }) {
  const [platform, setPlatform] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [range, setRange] = useState('')
  const [sort, setSort] = useState('likes')
  const [items, setItems] = useState<MediaItem[]>([])
  const [mode, setMode] = useState<'live' | 'mock'>('mock')
  const [note, setNote] = useState('')
  const [quota, setQuota] = useState<{ code: string; message: string; rechargeUrl?: string; goodsName?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [visionReady, setVisionReady] = useState(false)
  const [modalItem, setModalItem] = useState<MediaItem | null>(null)

  const runSearch = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await searchMedia({ platform, q: keyword.trim(), start: range ? dayOffset(Number(range)) : '', end: range ? dayOffset(0) : '' })
      setItems(result.items)
      setMode(result.mode)
      setNote(result.note || '')
      setQuota(result.quota ? { code: result.quota.code, message: result.quota.message, rechargeUrl: result.quota.rechargeUrl, goodsName: result.quota.goodsName } : null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [keyword, platform, range])

  useEffect(() => {
    getHealth()
      .then((health) => { setHasKey(health.redfox); setVisionReady(health.vision) })
      .catch(() => { setHasKey(false); setVisionReady(false) })
    void runSearch()
    // 首屏只检索一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sorted = useMemo(() => {
    const copy = [...items]
    copy.sort((a, b) => (b.stats as Record<string, number>)[sort] - (a.stats as Record<string, number>)[sort])
    return copy
  }, [items, sort])

  const totalLikes = sorted.reduce((sum, item) => sum + item.stats.likes, 0)

  return (
    <div className="page page--radar">
      <div className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" />内容雷达</div>
          <h1>爆款雷达</h1>
          <p>按关键词检索抖音与小红书的内容与互动数据，挑一条直接拆成可复用的脚本与分镜模板。</p>
        </div>
        <div className="heading-actions">
          <span className={`status-pill ${hasKey ? (quota ? 'is-error' : 'is-live') : 'is-mock'}`}>
            <span className="status-dot" />
            {hasKey ? (quota ? '红狐接口异常' : '红狐接口已连接') : '示例数据模式'}
          </span>
          <button className="button button--ghost" onClick={onOpenTemplates}>模板库</button>
        </div>
      </div>

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
        <button className="button button--primary" onClick={() => void runSearch()} disabled={loading}>
          {loading ? <RefreshCw size={15} className="spin" /> : <Search size={15} />}
          {loading ? '检索中' : '检索'}
        </button>
      </div>

      {quota ? (
        <div className="radar-banner radar-banner--quota">
          <AlertCircle size={15} />
          <span>
            红狐接口已连通，但<strong>{quota.code === 'REDFOX_DISABLED' ? 'Key 已被禁用' : '账号积分不足'}</strong>：{quota.message}。当前显示的是示例数据，不是真实平台数据。
            {quota.goodsName ? '（充值商品：' + quota.goodsName + '）' : ''}
            {quota.rechargeUrl ? <a href={quota.rechargeUrl} target="_blank" rel="noreferrer">{quota.code === 'REDFOX_DISABLED' ? '去红狐后台查看 Key' : '去红狐后台充值'}</a> : null}
          </span>
        </div>
      ) : !hasKey ? (
        <div className="radar-banner">
          <AlertCircle size={15} />
          <span>{note || '未配置红狐 API Key，当前展示的是示例数据（标题与互动数都不是真实平台数据）。接入 Key 后，这一屏会直接显示真实检索结果。'}</span>
        </div>
      ) : null}

      {error && (
        <div className="radar-banner radar-banner--error">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="radar-summary">
        <span><strong>{sorted.length}</strong> 条内容</span>
        <span><strong>{formatCount(totalLikes)}</strong> 累计点赞</span>
        <span className="radar-summary-note">{mode === 'live' ? '数据来自红狐接口' : hasKey ? '示例数据 · 接口不可用' : '示例数据 · 未连接红狐'}</span>
      </div>

      {loading && !sorted.length ? (
        <div className="radar-grid">
          {[0, 1, 2, 3, 4, 5].map((key) => <div className="radar-card radar-card--skeleton" key={key}><div className="skeleton skeleton--cover" /><div className="skeleton skeleton--line" /><div className="skeleton skeleton--line skeleton--short" /></div>)}
        </div>
      ) : sorted.length ? (
        <div className="radar-grid">
          {sorted.map((item) => (
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
                <button className="radar-hover" onClick={() => setModalItem(item)} aria-label={`一键复刻 ${item.title}`}>
                  <span className="radar-hover-pill"><Sparkles size={14} />一键复刻</span>
                  <span className="radar-hover-hint">FFmpeg 拆帧 · 逐帧分析 · 存成模板</span>
                </button>
              </div>
              <div className="radar-copy">
                <strong className="radar-title">{item.title || '（无标题）'}</strong>
                <span className="radar-author">{item.author || '未知作者'}{item.publishedAt ? ' · ' + item.publishedAt : ''}</span>
                <div className="radar-stats">
                  <span><Heart size={12} />{formatCount(item.stats.likes)}</span>
                  <span><Star size={12} />{formatCount(item.stats.collects)}</span>
                  <span><MessageCircle size={12} />{formatCount(item.stats.comments)}</span>
                  <span><Share2 size={12} />{formatCount(item.stats.shares)}</span>
                </div>
              </div>
              <div className="radar-actions">
                <button className="button button--ghost button--tiny" disabled={!item.url} onClick={() => item.url && window.open(item.url, '_blank', 'noopener')}>
                  <ExternalLink size={13} />原视频
                </button>
                <button className="button button--primary button--tiny" onClick={() => setModalItem(item)}>
                  <Play size={13} />一键复刻
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="radar-empty">
          <Sparkles size={22} />
          <strong>没有检索到内容</strong>
          <span>换一个更细的关键词（例如「通勤穿搭」而不是「穿搭」），或放宽时间范围。</span>
        </div>
      )}

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
