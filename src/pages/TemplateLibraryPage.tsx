import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowRight, Check as CheckIcon, Clapperboard, Copy, Download, ExternalLink, Film, Heart, Layers, Link2, MessageCircle, PenLine, Play, Printer, RefreshCw, ScanEye, Search, Share2, Sparkles, Star, Trash2, X } from 'lucide-react'
import {
  adaptTemplate as adaptTemplateApi,
  applyTemplate,
  coverSrc,
  createTemplateShare,
  deleteTemplate,
  formatCount,
  formatDuration,
  getHealth,
  getTemplate,
  listTemplates,
  revokeTemplateShare,
} from '../api/radar'
import { downloadTemplateMarkdown } from '../lib/templateExport'
import { describeTiming, paceLabel } from '../domain/radar'
import { readTemplatesView, writeTemplatesView, type TemplatesView } from '../domain/list-view'
import type { MediaItem, ReplicaTemplate, ScriptBeat, StoryboardShot, TemplateSourceCount, TemplateSourceKey } from '../domain/radar'
import { requestReview } from '../state/review'
import { createProject } from '../api/projects'
import { ReplicateModal } from '../components/ReplicateModal'
import { TrashModal } from '../components/TrashModal'
import { ReportModal } from '../components/ReportModal'
import type { ReportTarget } from '../api/reports'
import PageHead from '../components/PageHead'
import { Tag } from '../components/ui'
import '../styles/radar.css'

// 类型标签按库里真实的内容类型生成：写死一份清单，一旦运营改了分类就会出现「点了没结果」的空标签
const pickTypes = (byType: Record<string, number>, saved: number) => {
  const names = Object.entries(byType)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name)
  if (saved > 0 && !names.includes('待解析')) names.push('待解析')
  return ['全部', ...names]
}

// 模板详情里需要 MediaItem 才能跑复刻：这里把模板还原成检索卡片
function asMedia(template: ReplicaTemplate): MediaItem {
  return {
    id: template.sourceId,
    platform: template.platform,
    platformLabel: template.platformLabel,
    title: template.title,
    author: template.author,
    cover: template.cover,
    url: template.sourceUrl,
    publishedAt: template.publishedAt,
    durationSec: template.durationSec || null,
    stats: template.stats,
  }
}

const isParsed = (template: ReplicaTemplate) => template.kind !== 'saved'

// 卡片脚注上的来源标签：只有不是「发现」的才贴（发现是库里最大的一类，贴了等于每张卡都多一个词）。
// 文案与抽屉、来源胶囊同一套口径，服务端 templateSource 决定 key。
const SOURCE_TAG: Record<string, string> = {
  project: '来自作品',
  adapted: '改编版',
  agent: '智能体',
  canvas: '画布',
  shared: '官方示例',
}

// 改编草稿：只带「这一版」要改的三样东西，其余字段照抄原模板
type AdaptDraft = {
  title: string
  hook: string
  structure: ScriptBeat[]
  storyboard: StoryboardShot[]
}

// 解析过的模板用本地帧图；只存链接的用平台封面，必须走 /api/cover 代理（直连会 403 / mixed content）
const coverFor = (template: ReplicaTemplate) => {
  const url = template.thumb || template.cover || ''
  if (!url) return ''
  return url.startsWith('/media/') || url.startsWith('/api/') ? url : coverSrc(url)
}

export function TemplateLibraryPage({
  onToast,
  onBack,
  onOpenCanvas,
  onOpenProject,
  templateId,
  onOpenTemplate,
  onCloseTemplate,
}: {
  onToast: (message: string) => void
  onBack: () => void
  onOpenCanvas: (flowId?: string) => void
  onOpenProject: (projectId: string) => void
  /** 地址里的单条模板（#/templates/<id>）：刷新、后退、从作品页点进来都落在这条上 */
  templateId?: string
  /** 打开某条模板：只改地址，详情按地址取（页面自己不另存一份「开着哪条」） */
  onOpenTemplate?: (templateId: string) => void
  /** 关掉抽屉：把地址换回列表（replace，后退回到进来之前那一页） */
  onCloseTemplate?: () => void
}) {
  const [items, setItems] = useState<ReplicaTemplate[]>([])
  const [byType, setByType] = useState<Record<string, number>>({})
  const [parsed, setParsed] = useState(0)
  // 全库条数（筛选时不变）与当前来源下还没解析的条数：两个数不能混用
  const [total, setTotal] = useState(0)
  const [pending, setPending] = useState(0)
  // 每个来源各有几条：胶囊由服务端给，前端不另写一份分类表
  const [sources, setSources] = useState<TemplateSourceCount[]>([])

  // 上次在这张页面上筛过的条件（v0.9.44）：去作品看一眼再回来，搜索词与来源都还在。
  // 只跟着这一个标签页（sessionStorage），关掉就忘；坏数据由 domain/list-view 退回「全部」。
  const [savedView] = useState<TemplatesView>(() => readTemplatesView(window.sessionStorage))
  const [type, setType] = useState(savedView.type || '全部')
  const [source, setSource] = useState<TemplateSourceKey | ''>(savedView.source as TemplateSourceKey | '')
  const [keyword, setKeyword] = useState(savedView.keyword)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ReplicaTemplate | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // 正在为哪条模板取详情：点得快时，慢的那次回来不许盖住刚点的那条
  const lastRequested = useRef('')
  const [health, setHealth] = useState<{ redfox: boolean; vision: boolean }>({ redfox: false, vision: false })
  const [replicateItem, setReplicateItem] = useState<MediaItem | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null)
  // 改编草稿：从这条模板拷一份出来改，存的是新模板，原条目不动
  const [adapt, setAdapt] = useState<AdaptDraft | null>(null)
  const [adaptSaving, setAdaptSaving] = useState(false)
  const [projectSaving, setProjectSaving] = useState(false)

  // 顶部汇总那格「作品在用」：直接用列表接口现算的总数，不再累加 reuseCount 那种只增不减的计数器
  const [projectTotal, setProjectTotal] = useState(0)
  const typeOptions = useMemo(() => pickTypes(byType, pending), [byType, pending])
  // 分类被后台改名后，旧分类已经不在标签里：渲染时直接落回「全部」，不用再开一个 setState 副作用
  const activeType = type === '全部' || typeOptions.includes(type) ? type : '全部'
  // 来源也一样：删光某个来源的最后一条后，它的胶囊会消失，这时也落回「全部」
  const sourceOptions = useMemo(() => sources.filter((entry) => entry.count > 0), [sources])
  const activeSource = sourceOptions.some((entry) => entry.key === source) ? source : ''
  const sourceLabel = useCallback(
    (key?: string) => sources.find((entry) => entry.key === key)?.label || '',
    [sources],
  )
  const searching = keyword.trim()
  // 只有搜索词也是一次筛选：以前这一行只在选了类型/来源时出现，搜完想清掉只能手动删字
  const filtering = activeType !== '全部' || Boolean(activeSource) || Boolean(searching)

  // 条件一变就记下来；三样都空就把键删掉（「清空条件」= 不留一条空记录）。
  // 记的是上面那三个原始值，不写 activeType：首屏数据还没到、类型清单只有一个「全部」时，
  // 写 activeType 会把刚读出来的类型当场抹掉。
  useEffect(() => {
    writeTemplatesView(window.sessionStorage, { keyword, type, source })
  }, [keyword, type, source])
  const clearFilters = () => {
    setType('全部')
    setSource('')
    setKeyword('')
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listTemplates({ q: keyword.trim(), type: activeType === '全部' ? '' : activeType, source: activeSource })
      setItems(result.items)
      setByType(result.byType || {})
      setParsed(result.parsed || 0)
      setPending(result.pending ?? result.saved ?? 0)
      setTotal(result.total || 0)
      setSources(result.sources || [])
      setProjectTotal(result.projectTotal || 0)

    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [keyword, activeType, activeSource])

  // 数据来自本地 API，挂载与筛选变化时由外部系统触发一次重新拉取
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    getHealth()
      .then((result) => setHealth({ redfox: result.redfox, vision: result.vision }))
      .catch(() => setHealth({ redfox: false, vision: false }))
  }, [])

  // 分享的目标读者是没有账号的人（剪辑、客户）：链接在服务端生成，这里只管显示、复制和停用
  const shareUrl = (token?: string) => (token ? window.location.origin + '/#/share/' + token : '')

  const startShare = async (template: ReplicaTemplate) => {
    setShareBusy(true)
    try {
      const result = await createTemplateShare(template.id)
      setDetail({ ...template, shareToken: result.token, shareCreatedAt: result.createdAt })
      onToast('已生成只读链接，拿到链接的人不用登录就能看')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '生成分享链接失败')
    } finally {
      setShareBusy(false)
    }
  }

  const stopShare = async (template: ReplicaTemplate) => {
    setShareBusy(true)
    try {
      await revokeTemplateShare(template.id)
      setDetail({ ...template, shareToken: undefined, shareCreatedAt: undefined })
      onToast('已停止分享，旧链接立即失效')
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '停止分享失败')
    } finally {
      setShareBusy(false)
    }
  }

  const copyShare = async (token?: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token))
      onToast('链接已复制，可以直接发给剪辑或客户')
    } catch {
      onToast('复制失败，请手动选中链接复制')
    }
  }

  const openDetail = async (id: string, options?: { adapt?: boolean }) => {
    lastRequested.current = id
    setAdapt(null)
    setDetailLoading(true)
    try {
      const next = await getTemplate(id)
      if (lastRequested.current !== id) return
      setDetail(next)
      // 卡片上的「用这条改编」：详情一到位就直接进改编模式，不用再点一次
      if (options?.adapt && next.structure?.length) enterAdapt(next)
    } catch (caught) {
      if (lastRequested.current !== id) return
      onToast(caught instanceof Error ? caught.message : String(caught))
      // 地址里那条打不开（删了、或不在这个账号下）：把地址换回列表，别让地址栏说一条不存在的模板
      lastRequested.current = ''
      onCloseTemplate?.()
    } finally {
      if (lastRequested.current === id) setDetailLoading(false)
    }
  }

  // 点卡片：先改地址，详情交给下面的 effect；没有路由（组件单用时）就直接取
  const openTemplate = (id: string, options?: { adapt?: boolean }) => {
    if (onOpenTemplate) onOpenTemplate(id)
    void openDetail(id, options)
  }

  const closeDetail = () => {
    lastRequested.current = ''
    setDetail(null)
    setAdapt(null)
    onCloseTemplate?.()
  }

  // 地址是唯一真源：地址里有 id 就开那一条，地址里没了就收起抽屉（后退、前进都跟着走）
  useEffect(() => {
    if (!templateId) {
      if (lastRequested.current) {
        lastRequested.current = ''
        setDetail(null)
      }
      return
    }
    if (lastRequested.current !== templateId) void openDetail(templateId)
    // openDetail / onCloseTemplate 每次渲染都是新函数，进依赖会重复取详情；真源只有地址这一项
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  const enterAdapt = (template: ReplicaTemplate) => {
    setAdapt({
      title: template.title + '（改编）',
      hook: template.hook,
      structure: template.structure.map((beat) => ({ ...beat })),
      storyboard: template.storyboard.map((shot) => ({ ...shot })),
    })
  }

  const patchBeat = (index: number, patch: Partial<ScriptBeat>) =>
    setAdapt((current) =>
      current ? { ...current, structure: current.structure.map((beat, i) => (i === index ? { ...beat, ...patch } : beat)) } : current,
    )

  const patchShot = (index: number, patch: Partial<StoryboardShot>) =>
    setAdapt((current) =>
      current ? { ...current, storyboard: current.storyboard.map((shot, i) => (i === index ? { ...shot, ...patch } : shot)) } : current,
    )

  const saveAdapt = async () => {
    if (!detail || !adapt) return
    setAdaptSaving(true)
    try {
      const result = await adaptTemplateApi(detail.id, {
        title: adapt.title,
        hook: adapt.hook,
        structure: adapt.structure,
        storyboard: adapt.storyboard,
      })
      setAdapt(null)
      setDetail(result.template)
      onToast('已存为你的模板：' + result.template.title)
      void load()
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '保存改编失败')
    } finally {
      setAdaptSaving(false)
    }
  }

  // 「用它做作品」：作品只绑模板，不复制脚本分镜；建完直接进作品页，
  // 下一步（套用模板开画布）由作品页统一给，不在两个地方各写一套流程。
  const startProject = async (template: ReplicaTemplate) => {
    setProjectSaving(true)
    try {
      const result = await createProject({ templateId: template.id, title: template.title })
      lastRequested.current = ''
      setDetail(null)
      onToast('已建作品：' + result.project.title)
      onOpenProject(result.project.id)
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : '建作品失败')
    } finally {
      setProjectSaving(false)
    }
  }

  return (
    <div className="page page--templates">
      <PageHead
        kicker="模板库 / TEMPLATES"
        title="模板库"
        desc="只存原链接、互动数据和解析出来的脚本与分镜，不保存原视频文件。雷达里点「加入模板库」先存一条待解析条目，点「解析」才补上脚本与分镜；解析结果可直接交给拍摄，平台当前不出成片。"
        actions={
          <>
            <button className="vq-button vq-button--ghost" onClick={onBack}>回到雷达</button>
            <button className="vq-button vq-button--ghost" onClick={() => setTrashOpen(true)}>
              <Trash2 size={15} />回收站
            </button>
            <button className="vq-button vq-button--ghost" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} />刷新
            </button>
          </>
        }
      />

      <div className="asset-summary template-summary">
        <div><span className="section-kicker">模板总数</span><strong>{total}</strong><span>条</span></div>
        <div><span className="section-kicker">已解析</span><strong>{parsed}</strong><span>有脚本与分镜</span></div>
        <div><span className="section-kicker">作品在用</span><strong>{projectTotal}</strong><span>条</span></div>
      </div>

      <div className="asset-toolbar">
        <label className="inline-search">
          <Search size={15} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索标题、钩子、标签或可复用规则" />
        </label>
        <div className="template-facets">
          {/* 两排筛选各回答一个问题：类型是「这条是什么」，来源是「这条从哪来」。
              类型的数字跟着来源算（来源=作品时不该还挂着只有雷达条目才有的类型）。 */}
          <div className="template-facet">
            <span className="template-facet__label">类型</span>
            <div className="vq-filter-row">
              {typeOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={'vq-filter-chip' + (activeType === value ? ' is-active' : '')}
                  aria-pressed={activeType === value}
                  onClick={() => setType(value)}
                >
                  {value}
                  {value !== '全部' && byType[value] ? <span className="vq-filter-chip__count">{byType[value]}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="template-facet">
            <span className="template-facet__label">来源</span>
            <div className="vq-filter-row">
              <button
                type="button"
                className={'vq-filter-chip' + (activeSource === '' ? ' is-active' : '')}
                aria-pressed={activeSource === ''}
                onClick={() => setSource('')}
              >
                全部
              </button>
              {sourceOptions.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={'vq-filter-chip' + (activeSource === entry.key ? ' is-active' : '')}
                  aria-pressed={activeSource === entry.key}
                  title={'只看从「' + entry.label + '」来的模板'}
                  onClick={() => setSource(entry.key)}
                >
                  {entry.label}
                  <span className="vq-filter-chip__count">{entry.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {filtering && total > 0 ? (
        <div className="template-filter-note">
          <span>
            筛到 <b>{items.length}</b> 条
            {searching ? ' · 搜索「' + searching + '」' : ''}
            {activeSource ? ' · 来源：' + sourceLabel(activeSource) : ''}
            {activeType !== '全部' ? ' · 类型：' + activeType : ''}
            {total > 0 ? ' · 全库 ' + total + ' 条' : ''}
          </span>
          <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={clearFilters}>清空条件</button>
        </div>
      ) : null}

      {error && <div className="radar-banner radar-banner--error"><AlertCircle size={15} /><span>{error}</span></div>}

      {!loading && !items.length ? (
        total > 0 ? (
          // 库里有东西、只是这次没筛到：说清是哪几个条件没匹配上，别写成「模板库还是空的」
          <div className="radar-empty">
            <Search size={22} />
            <strong>没有筛到模板</strong>
            <span>
              {[keyword.trim() ? '搜索「' + keyword.trim() + '」' : '', activeSource ? '来源「' + sourceLabel(activeSource) + '」' : '', activeType !== '全部' ? '类型「' + activeType + '」' : ''].filter(Boolean).join(' · ') || '当前条件'}
              {' 一条都没匹配上；全库 ' + total + ' 条，清掉条件就能看到。'}
            </span>
            <button className="vq-button vq-button--ghost" onClick={clearFilters}>清空条件</button>
          </div>
        ) : (
          <div className="radar-empty">
            <Layers size={22} />
            <strong>模板库还是空的</strong>
            <span>去「发现」检索一条：点「加入模板库」先存链接与互动数据，点「解析」再拆脚本和分镜（出成片要自己拍）。</span>
            <button className="vq-button vq-button--primary" onClick={onBack}>去检索一条</button>
          </div>
        )
      ) : (
        <div className="template-grid">
          {items.map((item) => (
            <article className="template-card" key={item.id} onClick={() => openTemplate(item.id)}>
              <div className="template-cover">
                {coverFor(item) ? <img src={coverFor(item)} alt="" loading="lazy" /> : <span className="template-cover-empty">{item.platformLabel || '没有封面'}</span>}
                <span className={'template-type' + (isParsed(item) ? '' : ' is-pending')}>{isParsed(item) ? item.contentType : '待解析'}</span>
                <span className="radar-duration"><Film size={11} />{item.kind === 'flow' ? (item.flowNodes?.length ?? 0) + ' 节点' : formatDuration(item.durationSec)}</span>
              </div>
              <div className="template-copy">
                <strong>{item.title}</strong>
                <span className="template-hook">
                  {item.kind === 'flow'
                    ? '来自画布 · 套用后原样开回一张新画布'
                    : isParsed(item) ? item.hook : item.author ? item.author + ' · 只有原链接，还没解析' : '只有原链接，还没解析'}
                </span>
                {item.kind === 'flow' || item.kind === 'adapted' || item.kind === 'agent' ? null : (
                  <div className="template-stats">
                    {(item.stats?.plays || 0) > 0 && <span><Play size={11} />{formatCount(item.stats.plays || 0)}</span>}
                    <span><Heart size={11} />{formatCount(item.stats?.likes || 0)}</span>
                    <span><Star size={11} />{formatCount(item.stats?.collects || 0)}</span>
                    <span><MessageCircle size={11} />{formatCount(item.stats?.comments || 0)}</span>
                    <span><Share2 size={11} />{formatCount(item.stats?.shares || 0)}</span>
                  </div>
                )}
                <div className="template-meta">
                  {item.kind === 'flow' ? (
                    <>
                      <span>{(item.flowNodes || []).slice(0, 3).map((node) => node.title).join(' · ') || '流程节点'}</span>
                    </>
                  ) : isParsed(item) ? (
                    <>
                      <span>{item.structure.length} 段脚本</span>
                      <span>{item.storyboard.length} 个分镜</span>
                    </>
                  ) : (
                    <span>解析后才能改编与开作品</span>
                  )}
                  {/* 用量的位置放在这排数字里，不挤脚注：脚注要留给平台、作者与「用这条改编」按钮 */}
                  {item.projectCount ? <span className="template-uses">{item.projectCount} 条作品在用</span> : null}
                </div>
                <div className="template-foot">
                  {/* 平台与作者单行省略：长作者名不再把脚注顶成两行 */}
                  <span className="template-foot-info">
                    {/* 来源标签由服务端的 source 决定：卡片、抽屉、来源胶囊说的是一件事 */}
                    {item.source && SOURCE_TAG[item.source] ? <Tag tone="ink">{SOURCE_TAG[item.source]}</Tag> : null}
                    {item.platformLabel}
                    {item.author ? ' · ' + item.author : ''}
                  </span>
                  {isParsed(item) ? (
                    <button
                      type="button"
                      className="template-adapt"
                      title="以这条为底，改脚本与分镜，存成你自己的模板"
                      onClick={(event) => {
                        event.stopPropagation()
                        openTemplate(item.id, { adapt: true })
                      }}
                    >
                      <PenLine size={12} />用这条改编
                    </button>
                  ) : (
                    // 只存了链接的卡片（v0.9.40）：以前这一格是灰字「待解析」，等于告诉用户
                    // 「这里没东西」。现在它是这条卡片自己的下一步——原地跑一次解析。
                    <button
                      type="button"
                      className="template-adapt template-adapt--parse"
                      title={item.sourceUrl ? '跑一次解析：拆出脚本与分镜，这条原地变成已解析模板' : '这条没有原链接：先贴一条视频直链再解析'}
                      disabled={!item.sourceUrl}
                      onClick={(event) => {
                        event.stopPropagation()
                        setReplicateItem(asMedia(item))
                      }}
                    >
                      <Sparkles size={12} />去解析
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {(detail || detailLoading) && createPortal(
        <div className="drawer-backdrop" onMouseDown={closeDetail}>
          <aside className="template-drawer" onMouseDown={(event) => event.stopPropagation()}>
            {detailLoading && !detail ? (
              <div className="drawer-loading"><RefreshCw size={16} className="spin" />加载模板详情</div>
            ) : detail ? (
              <>
                <header className="drawer-head">
                  <div>
                    <span className="section-kicker">
                      {detail.kind === 'flow'
                        ? '工作流'
                        : detail.kind === 'adapted'
                          ? (detail.origin === 'project' ? '来自作品 · ' : '改编版 · ') + (detail.contentType || '脚本')
                          : detail.kind === 'agent'
                            ? '智能体 · ' + (detail.contentType || '脚本')
                            : (isParsed(detail) ? detail.contentType : '待解析') + ' · ' + detail.platformLabel}
                    </span>
                    <strong>{detail.title}</strong>
                    <span className="drawer-sub">
                      {detail.kind === 'flow'
                        ? '来自画布 · 套用后开回一张新画布 · ' + (detail.flowNodes?.length || 0) + ' 个节点'
                        : detail.kind === 'agent'
                          ? '来自智能体' + (detail.agentName ? ' ' + detail.agentName : '') + ' · ' + detail.structure.length + ' 段 · ' + detail.storyboard.length + ' 镜'
                          : detail.kind === 'adapted' && detail.origin === 'project'
                            ? '来自作品《' + (detail.projectTitle || '已删的作品') + '》' +
                              (detail.projectVersion ? ' · 第 ' + detail.projectVersion + ' 版' : ' · 还没开画布') +
                              ' · ' + detail.structure.length + ' 段 · ' + detail.storyboard.length + ' 镜'
                            : (detail.author || '未知作者') + ' · ' + formatDuration(detail.durationSec)}
                      {' · 模板 ' + detail.id}
                      {detail.kind === 'adapted' && detail.adaptedFrom ? ' · 改编自 ' + detail.adaptedFrom : ''}
                    </span>
                  </div>
                  <button className="vq-button vq-button--icon" onClick={closeDetail} aria-label="关闭"><X size={16} /></button>
                </header>

                <div className="drawer-body">
                  {/* 用这条模板的作品：先回答「是不是已经做过了」，再决定是接着做还是再开一条 */}
                  {detail.projects && detail.projects.length ? (
                    <section className="drawer-section drawer-section--works">
                      <div className="drawer-section-head">
                        <h3>用这条模板的作品</h3>
                        <span>{detail.projectCount ?? detail.projects.length} 条 · 点一行进作品</span>
                      </div>
                      <div className="drawer-works">
                        {detail.projects.map((project) => (
                          <button
                            type="button"
                            className="drawer-work"
                            key={project.id}
                            onClick={() => onOpenProject(project.id)}
                          >
                            <span className="drawer-work-main">
                              <strong>{project.title}</strong>
                              <span>
                                {project.version > 1 ? 'v' + project.version : '第 1 版'}
                                {' · '}
                                {(project.delivered ?? project.status === 'done') ? '已交付' : '在做'}
                              </span>
                            </span>
                            <ArrowRight size={13} />
                          </button>
                        ))}
                      </div>
                      {detail.projectCount && detail.projectCount > detail.projects.length ? (
                        <p className="drawer-works-more">
                          还有 {detail.projectCount - detail.projects.length} 条没列出来，去作品列表看全部
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                  {adapt ? (
                    <section className="drawer-section drawer-section--adapt">
                      <div className="drawer-section-head">
                        <h3>这一版叫什么</h3>
                        <span>存成你的模板</span>
                      </div>
                      <input
                        className="adapt-input adapt-input--title"
                        value={adapt.title}
                        aria-label="模板名"
                        onChange={(event) => setAdapt({ ...adapt, title: event.target.value })}
                      />
                      <textarea
                        className="adapt-input"
                        rows={2}
                        value={adapt.hook}
                        placeholder="开头钩子"
                        aria-label="开头钩子"
                        onChange={(event) => setAdapt({ ...adapt, hook: event.target.value })}
                      />
                      <p className="adapt-note">改编只改这一份的脚本与分镜，原模板不动；存下来的是你自己的新模板，之后可以再改、再套到画布。</p>
                    </section>
                  ) : null}

                  {detail.kind === 'flow' ? (
                    <section className="drawer-section">
                      <div className="drawer-section-head"><h3>流程节点</h3><span>{detail.flowNodes?.length || 0} 个</span></div>
                      <ul className="drawer-list drawer-list--flow">
                        {(detail.flowNodes || []).map((node, index) => (
                          <li key={index}><span className="vq-mono">{String(index + 1).padStart(2, '0')}</span>{node.title}<em>{node.kind}</em></li>
                        ))}
                      </ul>
                      {detail.analysis && detail.analysis.reusableRules.length ? (
                        <>
                          <div className="drawer-section-head drawer-section-head--tight"><h4>节点提示词</h4></div>
                          <ul className="drawer-list drawer-list--rules">
                            {detail.analysis.reusableRules.map((rule, index) => <li key={index}>{rule}</li>)}
                          </ul>
                        </>
                      ) : null}
                    </section>
                  ) : (
                  <>
                  {detail.kind === 'adapted' || detail.kind === 'agent' ? null : (
                    <section className="drawer-section">
                      <div className="drawer-section-head"><h3>互动数据</h3><span>来自检索结果</span></div>
                      <div className="drawer-stats">
                        {(detail.stats?.plays || 0) > 0 && <span>播放 <b>{formatCount(detail.stats.plays || 0)}</b></span>}
                        <span>点赞 <b>{formatCount(detail.stats?.likes || 0)}</b></span>
                        <span>收藏 <b>{formatCount(detail.stats?.collects || 0)}</b></span>
                        <span>评论 <b>{formatCount(detail.stats?.comments || 0)}</b></span>
                        <span>转发 <b>{formatCount(detail.stats?.shares || 0)}</b></span>
                      </div>
                    </section>
                  )}

                  {isParsed(detail) ? (
                    <>
                      {adapt ? null : (
                        <section className="drawer-section">
                          <div className="drawer-section-head"><h3>开头钩子</h3><span className="tag">{detail.hookType}</span></div>
                          <p className="drawer-quote">{detail.hook}</p>
                          <div className="drawer-tags">{detail.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
                        </section>
                      )}

                      <section className="drawer-section">
                        <div className="drawer-section-head">
                          <h3>脚本结构</h3>
                          <span>{adapt ? adapt.structure.length : detail.structure.length} 段</span>
                        </div>
                        {adapt ? (
                          <ol className="beat-list">
                            {adapt.structure.map((beat, index) => (
                              <li key={index} className="beat-item beat-item--edit">
                                <span className="beat-time">{beat.startSec}s – {beat.endSec}s</span>
                                <div className="beat-edit">
                                  <input
                                    className="adapt-input adapt-input--beat"
                                    value={beat.beat}
                                    aria-label={'第 ' + (index + 1) + ' 段的节拍'}
                                    onChange={(event) => patchBeat(index, { beat: event.target.value })}
                                  />
                                  <textarea
                                    className="adapt-input"
                                    rows={2}
                                    value={beat.voiceover}
                                    aria-label={'第 ' + (index + 1) + ' 段的口播'}
                                    onChange={(event) => patchBeat(index, { voiceover: event.target.value })}
                                  />
                                  <input
                                    className="adapt-input"
                                    value={beat.onScreen}
                                    placeholder="屏幕字（可空）"
                                    aria-label={'第 ' + (index + 1) + ' 段的屏幕字'}
                                    onChange={(event) => patchBeat(index, { onScreen: event.target.value })}
                                  />
                                </div>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <ol className="beat-list">
                            {detail.structure.map((beat, index) => (
                              <li key={index} className="beat-item">
                                <span className="beat-time">
                                  {beat.startSec}s – {beat.endSec}s
                                  {beat.fit === 'tight' && <em className="beat-time-warn">台词约需 {beat.expectedSec}s</em>}
                                </span>
                                <div>
                                  <strong>{beat.beat}</strong>
                                  <p>{beat.voiceover}</p>
                                  {beat.onScreen && (
                                    <span className="beat-onscreen">
                                      屏幕字：{beat.onScreen.replace(/^(建议)?(屏幕字|字幕)s*[：:]s*/, '')}
                                    </span>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </section>

                      <section className="drawer-section">
                        <div className="drawer-section-head"><h3>分镜表</h3><span>{detail.storyboard.length} 个镜头</span></div>
                        {!adapt && detail.timing && detail.timing.estimatedSec > 0 ? (
                          <p className={`timing-note timing-note--${detail.timing.fit}`}>
                            <strong>台词约需 {detail.timing.estimatedSec}s</strong>
                            <span>
                              {detail.kind === 'agent' ? '分镜' : '原片'} {detail.timing.durationSec}s · 按语速档「{paceLabel(detail.timing.pace)}」估（{detail.timing.rate ?? 0} 字/秒）· {describeTiming(detail.timing)}
                            </span>
                          </p>
                        ) : null}
                        <div className="shot-table">
                          {(adapt ? adapt.storyboard : detail.storyboard).map((shot, index) => (
                            <div className="shot-row" key={shot.shotNo + '-' + index}>
                              <div className="shot-frame">
                                {shot.frameUrl ? <img src={shot.frameUrl} alt="" loading="lazy" /> : <span>{shot.shotNo}</span>}
                                <em>#{shot.shotNo} · {shot.startSec}s</em>
                              </div>
                              {adapt ? (
                                <div className="shot-copy shot-copy--edit">
                                  <textarea
                                    className="adapt-input"
                                    rows={2}
                                    value={shot.visual}
                                    placeholder="这一镜拍什么"
                                    aria-label={'第 ' + shot.shotNo + ' 镜的画面'}
                                    onChange={(event) => patchShot(index, { visual: event.target.value })}
                                  />
                                  <div className="adapt-row">
                                    <input
                                      className="adapt-input"
                                      value={shot.camera}
                                      placeholder="机位"
                                      aria-label={'第 ' + shot.shotNo + ' 镜的机位'}
                                      onChange={(event) => patchShot(index, { camera: event.target.value })}
                                    />
                                    <input
                                      className="adapt-input"
                                      value={shot.caption}
                                      placeholder="字幕"
                                      aria-label={'第 ' + shot.shotNo + ' 镜的字幕'}
                                      onChange={(event) => patchShot(index, { caption: event.target.value })}
                                    />
                                  </div>
                                  <input
                                    className="adapt-input"
                                    value={shot.audio}
                                    placeholder="配音 / 音效"
                                    aria-label={'第 ' + shot.shotNo + ' 镜的声音'}
                                    onChange={(event) => patchShot(index, { audio: event.target.value })}
                                  />
                                </div>
                              ) : (
                                <div className="shot-copy">
                                  <strong>{shot.visual || '画面描述待补充'}</strong>
                                  <div className="shot-tags">
                                    <span>{shot.camera || '机位未标注'}</span>
                                    {shot.caption && <span>字幕：{shot.caption}</span>}
                                    {shot.expectedSec && shot.fit === 'tight' ? <span className="is-tight">念完约 {shot.expectedSec}s</span> : null}
                                    {shot.audio && <span>{shot.audio}</span>}
                                  </div>
                                  {shot.purpose && <p>{shot.purpose}</p>}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </section>

                      {detail.analysis ? (
                        <section className="drawer-section">
                          <div className="drawer-section-head"><h3>爆款分析</h3><span>节奏：{detail.analysis.pacing}</span></div>
                          <ul className="drawer-list">
                            {detail.analysis.viralPoints.map((point, index) => <li key={index}>{point}</li>)}
                          </ul>
                          <div className="drawer-section-head drawer-section-head--tight"><h4>可复用规则</h4></div>
                          <ul className="drawer-list drawer-list--rules">
                            {detail.analysis.reusableRules.map((rule, index) => <li key={index}>{rule}</li>)}
                          </ul>
                        </section>
                      ) : null}
                    </>
                  ) : (
                    <section className="drawer-section drawer-section--pending">
                      <div className="drawer-section-head"><h3>还没解析</h3><span>只有原链接</span></div>
                      <p className="drawer-pending-copy">
                        这条是你在雷达里点「加入模板库」存下来的：原链接、作者、互动数据都在，
                        脚本结构和分镜需要跑一次解析才有。解析要下载视频抽帧，所以单独点一次。
                        解析完这条会<strong>原地升级</strong>成已解析模板（还是这一条，不多出一格），接着就能开成作品。
                      </p>
                      {/* 一个界面只留一个主按钮（v0.9.40）：解析这件事由底部「去解析这条」承担，
                          这里说清入口在哪，不再摆第二枚一样的按钮。 */}
                      <p className="drawer-pending-hint">
                        {detail.sourceUrl ? '底部「去解析这条」会打开解析弹窗，先说清积分再开始。' : '这条没有原链接：要解析得先有一条视频直链。'}
                      </p>
                    </section>
                  )}

                  <section className="drawer-section">
                    <div className="drawer-section-head"><h3>来源</h3><span>{sourceLabel(detail.source) || '模板'}</span></div>
                    <div className="drawer-source">
                      {/* 以前这里只有一条「平台 · 作者 · 平台 ID + 原链接」，于是从作品/智能体/画布来的模板
                          也被写成「原链接缺失（示例数据或直链测试）」——它们本来就没有原片，不是链接丢了。 */}
                      {detail.kind === 'agent' ? (
                        <span>智能体{detail.agentName ? ' ' + detail.agentName : ''}的草稿 · 不存原视频</span>
                      ) : detail.kind === 'adapted' && (detail.origin === 'project' || detail.projectId) ? (
                        <>
                          <span>
                            来自作品《{detail.projectTitle || '已删的作品'}》
                            {detail.projectVersion ? ' · 第 ' + detail.projectVersion + ' 版' : ' · 还没开画布'}
                            {' · 这一版的分镜不是原片，作者与互动数据不复制'}
                          </span>
                          {detail.projectId ? (
                            <button
                              type="button"
                              className="vq-button vq-button--ghost vq-button--sm"
                              onClick={() => {
                                const target = detail.projectId
                                lastRequested.current = ''
                                setDetail(null)
                                if (target) onOpenProject(target)
                              }}
                            >
                              <ArrowRight size={13} />打开这条作品
                            </button>
                          ) : null}
                        </>
                      ) : detail.kind === 'adapted' ? (
                        <span>改编自{detail.adaptedFrom ? '模板 ' + detail.adaptedFrom : '另一条模板'} · 原片的作者、链接与互动数据不复制</span>
                      ) : (
                        <>
                          <span>
                            {detail.platformLabel}
                            {detail.author ? ' · ' + detail.author : ''} · {detail.sourceId}
                          </span>
                          {detail.sourceUrl ? <a href={detail.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开原视频</a> : <span className="is-muted">这条没有原链接</span>}
                        </>
                      )}
                      {detail.shared ? (
                        <button
                          type="button"
                          className="vq-button vq-button--ghost vq-button--sm"
                          onClick={() => setReportTarget({ kind: 'template', id: detail.id, title: detail.title, url: detail.sourceUrl })}
                        >
                          举报
                        </button>
                      ) : null}
                    </div>
                    {/* 这条原片在库里的全貌（v0.9.38）：同源的改编版、跨模板开出的作品。
                        以前只看得见「这条模板」自己的作品，改编版一多就不知道它们其实是同一条原片。 */}
                    {detail.footprint ? (
                      <div className="drawer-origin">
                        <p className="drawer-origin-count">
                          <span>这条原片在库里</span>
                          <b>{detail.footprint.templateCount} 条模板</b>
                          <em>·</em>
                          <b>{detail.footprint.workCount} 条作品</b>
                          {detail.footprint.applied > 0 ? (
                            <>
                              <em>·</em>
                              <span>套用过 {detail.footprint.applied} 次</span>
                            </>
                          ) : null}
                        </p>
                        {detail.footprint.siblings.length ? (
                          <div className="drawer-origin-siblings">
                            {detail.footprint.siblings.map((sibling) => (
                              <button
                                type="button"
                                className="drawer-origin-sibling"
                                key={sibling.id}
                                title={'打开这条同源模板：' + sibling.title}
                                onClick={() => onOpenTemplate?.(sibling.id)}
                                disabled={!onOpenTemplate}
                              >
                                <span>{sibling.title}</span>
                                <em>
                                  {SOURCE_TAG[sibling.source] || '模板'}
                                  {sibling.shared ? ' · 官方' : ''}
                                </em>
                              </button>
                            ))}
                            {detail.footprint.siblingTotal > detail.footprint.siblings.length ? (
                              <span className="drawer-origin-more">
                                还有 {detail.footprint.siblingTotal - detail.footprint.siblings.length} 条
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <p className="drawer-origin-note">
                            {detail.footprint.shared
                              ? '官方示例：改编或套用都会另存成你自己的那条，这条不动。'
                              : '这条原片在库里只有这一条模板。'}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </section>
                  </>
                  )}

                  <section className="drawer-section drawer-section--export">
                    <div className="drawer-section-head"><h3>导出</h3><span>复制、评审与 Markdown</span></div>
                    <div className="drawer-export-actions">
                      {adapt || detail.kind === 'flow' ? null : (
                        <>
                          <button
                            className="vq-button vq-button--ghost"
                            title="打开视觉评审页并用这条的首帧预填；在评审页点「开始评审」才会扣积分"
                            onClick={() => {
                              const firstFrame = detail.frames?.[0]?.url || ''
                              const media = firstFrame.replace(/^\/media\//, '')
                              requestReview({
                                media: media || undefined,
                                imageUrl: media ? undefined : detail.cover || undefined,
                                label: detail.title,
                                intent: '评审这条模板的首帧是否适合作为封面/开场',
                              })
                            }}>
                            <ScanEye size={14} />去评审
                          </button>
                          <button
                            className="vq-button vq-button--ghost"
                            disabled={!isParsed(detail)}
                            onClick={() => {
                              const list = [detail.hook, ...detail.structure.map((beat) => beat.beat + '：' + beat.voiceover), 'CTA：' + (detail.structure.at(-1)?.purpose || '')].join('\n')
                              void navigator.clipboard?.writeText(list).then(() => onToast('脚本已复制到剪贴板')).catch(() => onToast('复制失败'))
                            }}>
                            <Copy size={14} />复制脚本
                          </button>
                        </>
                      )}
                      <button
                        className="vq-button vq-button--ghost"
                        onClick={() => {
                          const name = downloadTemplateMarkdown(detail)
                          onToast('已下载 ' + name + '，可直接贴进飞书或 Notion')
                        }}>
                        <Download size={14} />下载 Markdown
                      </button>
                      <button className="vq-button vq-button--ghost" onClick={() => window.print()}>
                        <Printer size={14} />打印或存 PDF
                      </button>
                    </div>
                    <p className="drawer-export-note">
                      Markdown 里是分镜表、口播和每镜建议秒数；打印出来是纯白 A4 稿，在打印对话框里选「另存为 PDF」就能归档或发给剪辑。
                    </p>
                  </section>

                  <section className="drawer-section drawer-section--share">
                    <div className="drawer-section-head"><h3>分享</h3><span>只读链接</span></div>
                    {detail.shareToken ? (
                      <>
                        <div className="drawer-share-row">
                          <input
                            className="drawer-share-input"
                            readOnly
                            value={shareUrl(detail.shareToken)}
                            onFocus={(event) => event.currentTarget.select()}
                            aria-label="模板只读分享链接"
                          />
                          <button className="vq-button vq-button--ghost" onClick={() => void copyShare(detail.shareToken)}>
                            <Copy size={14} />复制
                          </button>
                          <button className="vq-button vq-button--ghost" onClick={() => void stopShare(detail)} disabled={shareBusy}>
                            {shareBusy ? <RefreshCw size={14} className="spin" /> : <X size={14} />}停止分享
                          </button>
                        </div>
                        <p className="drawer-share-note">
                          拿到链接的人不用登录就能看这条模板，只能看，不能改也不能套用。停止分享后旧链接立即失效，重新开启会生成一条新链接。
                        </p>
                      </>
                    ) : (
                      <>
                        <button className="vq-button vq-button--ghost" onClick={() => void startShare(detail)} disabled={shareBusy}>
                          {shareBusy ? <RefreshCw size={14} className="spin" /> : <Link2 size={14} />}生成只读链接
                        </button>
                        <p className="drawer-share-note">
                          给剪辑或客户看这条拆解结果，不用给他们开账号；链接随时可以停用。
                        </p>
                      </>
                    )}
                  </section>
                </div>

                <footer className="drawer-foot">
                  {adapt ? (
                    <>
                      <button type="button" className="vq-button vq-button--ghost" onClick={() => setAdapt(null)} disabled={adaptSaving}>
                        取消
                      </button>
                      <button type="button" className="vq-button vq-button--primary" onClick={() => void saveAdapt()} disabled={adaptSaving}>
                        {adaptSaving ? <RefreshCw size={14} className="spin" /> : <CheckIcon size={14} />}
                        {adaptSaving ? '保存中' : '存为我的模板'}
                      </button>
                    </>
                  ) : null}
                  {adapt ? null : (
                    <>
                    {detail.kind === 'flow' || !isParsed(detail) || !detail.storyboard?.length ? null : (
                      <button
                        type="button"
                        className="vq-button vq-button--ghost"
                        title="以这条为底改脚本与分镜，存成你自己的模板（原模板不动）"
                        onClick={() => enterAdapt(detail)}
                      >
                        <PenLine size={14} />改编这条
                      </button>
                    )}
                    {detail.kind !== 'flow' && isParsed(detail) ? (
                      <button
                        type="button"
                        className="vq-button vq-button--primary"
                        disabled={projectSaving}
                        title="把这条模板变成一条作品：脚本与分镜跟着走，之后在作品页开画布、送评审"
                        onClick={() => void startProject(detail)}
                      >
                        <Clapperboard size={14} />{projectSaving ? '建作品中' : '用它做作品'}
                      </button>
                    ) : null}
                    {/* 只存了链接的这条（v0.9.40）：主操作是解析。以前这里是一枚**禁用**的
                        「套用到画布」还占着主按钮的位置——点不动，却把真正的下一步挤到上面去。 */}
                    {detail.kind !== 'flow' && !isParsed(detail) ? (
                      <button
                        type="button"
                        className="vq-button vq-button--primary"
                        disabled={!detail.sourceUrl}
                        title="跑一次解析：拆出脚本与分镜，这条原地变成已解析模板"
                        onClick={() => setReplicateItem(asMedia(detail))}
                      >
                        <Sparkles size={14} />去解析这条
                      </button>
                    ) : (
                    <button
                      className={'vq-button ' + (detail.kind !== 'flow' && isParsed(detail) ? 'vq-button--ghost' : 'vq-button--primary')}
                      disabled={detail.kind !== 'flow' && !isParsed(detail)}
                      onClick={() => {
                        void applyTemplate(detail.id)
                          .then((result) => {
                            setDetail({ ...detail, reuseCount: result.template.reuseCount })
                            onToast(detail.kind === 'flow' ? '已打开画布：' + result.flow.name : '已生成画布草稿：' + result.flow.name)
                            onOpenCanvas(result.flow.id)
                          })
                          .catch((caught) => onToast(caught instanceof Error ? caught.message : '套用模板失败'))
                      }}
                    >
                      <Layers size={14} />{detail.kind === 'flow' ? '在画布打开' : '套用到画布'}
                    </button>
                    )}
                    <button className="vq-button vq-button--danger vq-button--sm" onClick={() => { void deleteTemplate(detail.id).then(() => { closeDetail(); onToast('已移到回收站，30 天内可以恢复'); void load() }) }}>
                      <Trash2 size={13} />删除
                    </button>
                    </>
                  )}
                </footer>
              </>
            ) : null}
          </aside>
        </div>,
        document.body,
      )}

      {reportTarget ? createPortal(
        <ReportModal
          target={reportTarget}
          onClose={() => setReportTarget(null)}
          onDone={(message) => {
            setReportTarget(null)
            onToast(message)
          }}
        />,
        document.body,
      ) : null}

      {trashOpen && (
        <TrashModal
          onClose={() => setTrashOpen(false)}
          onToast={onToast}
          onRestored={() => { void load() }}
        />
      )}

      {/* 弹窗挂在 body 上（v0.9.40）：抽屉也是 portal 到 body 的，弹窗留在页面树里
          会被抽屉遮罩压住——从抽屉里点「去解析这条」，弹窗发灰、点击还会落到遮罩上。 */}
      {replicateItem && createPortal(
        <ReplicateModal
          item={replicateItem}
          mode="parse"
          hasKey={health.redfox}
          visionReady={health.vision}
          onClose={() => setReplicateItem(null)}
          onDone={(title, upgradedId) => {
            setReplicateItem(null)
            void load()
            if (upgradedId) {
              // 解析把这条原地升级了新 id：抽屉跟着换到升级后的那条，用户眼前就是脚本与分镜
              onToast('解析完成，这条已升级成已解析模板：' + title)
              openTemplate(upgradedId)
              return
            }
            closeDetail()
            onToast('解析完成，模板已更新：' + title)
          }}
          onOpenTemplates={() => { setReplicateItem(null); closeDetail(); void load() }}
        />,
        document.body,
      )}
    </div>
  )
}
