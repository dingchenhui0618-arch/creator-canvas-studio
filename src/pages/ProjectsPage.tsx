import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Clapperboard, RefreshCw, Search, X } from 'lucide-react'
import PageHead from '../components/PageHead'
import ProjectStatusPill from '../components/ProjectStatus'
import { listProjects } from '../api/projects'
import { listTemplates } from '../api/radar'
import { reviewsForVersion, type ProjectBucket, type ProjectListFacets, type ProjectShareBrief, type ProjectSummary } from '../domain/project'
import { CLIENT_LABEL, stampTime } from '../domain/share'
import '../styles/projects.css'

const pad2 = (value: number) => String(value).padStart(2, '0')

function updatedLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  return sameDay ? '今天 ' + time : pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + time
}

/**
 * 卡片上的分享状态只说三件事：还在不在分享、打开过几次、最近一次什么时候。
 * 详细到每一轮的记录在作品页的分享面板里，卡片上不铺开。
 */
function shareHint(share: ProjectShareBrief): string {
  const rounds = share.rounds > 1 ? '共 ' + share.rounds + ' 轮链接' : '一条链接'
  if (!share.opens) return rounds + (share.live ? '，还没人打开' : '，停用前没人打开')
  const client = CLIENT_LABEL[share.lastClient] || '未知设备'
  const when = share.lastAt ? '，最近一次 ' + stampTime(share.lastAt) + '（' + client + '）' : ''
  return rounds + '，打开 ' + share.opens + ' 次' + when
}

// 三种筛法只回答「交没交出去」：评审结论、人工拍板仍然写在胶囊里，不重复切成筛选项。
const BUCKETS: Array<{ value: ProjectBucket; label: string; hint: string }> = [
  { value: 'all', label: '全部', hint: '账号下所有作品' },
  { value: 'active', label: '在做', hint: '当前这一版还没交出去：待开画布、评过没交、交过旧版又开了新版都算' },
  { value: 'delivered', label: '已交付', hint: '当前这一版交出去了；交付过旧版、又开了新版的不算' },
]

const EMPTY_FACETS: ProjectListFacets = { all: 0, active: 0, delivered: 0 }

/**
 * 作品列表：一条内容一条记录。
 * 列表只回答「做到哪一步」——脚本和分镜的段数、评审次数、最后一次改动；
 * 打开某一项才进作品页看脚本、画布与评审结论。
 *
 * 作品多起来以后，第一件事是「找得到那一条」：标题 / 模板名搜、按交没交出去筛。
 * 筛选与计数走服务端（/api/projects?q=&state=），与状态胶囊同一套交付口径，界面不另算一遍。
 */
export default function ProjectsPage({
  onOpenProject,
  onBrowseTemplates,
  onDiscover,
}: {
  onOpenProject: (id: string) => void
  onBrowseTemplates: () => void
  // 模板库也是空的时，这一屏的下一步是「去发现检索一条」，不是把人送进一个空库（v0.9.42）
  onDiscover: () => void
}) {
  const [items, setItems] = useState<ProjectSummary[]>([])
  const [facets, setFacets] = useState<ProjectListFacets>(EMPTY_FACETS)
  const [total, setTotal] = useState(0)
  const [shown, setShown] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [bucket, setBucket] = useState<ProjectBucket>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 空作品页的下一步要看模板库有没有东西：只问总条数，不拉整库（v0.9.42）
  const [templateTotal, setTemplateTotal] = useState<number | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (filter: { q: string; state: ProjectBucket }) => {
    setLoading(true)
    setError('')
    try {
      const data = await listProjects(filter)
      setItems(data.items)
      setFacets(data.facets ?? EMPTY_FACETS)
      setTotal(data.total ?? data.items.length)
      setShown(data.shown ?? data.items.length)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '作品列表读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 模板库总条数只取一次：作品列表刷新不重拉它，人也不会在这一屏看见它变。
  // 读失败就留 null——空作品页会同时给两条路，而不是断言「模板库是空的」。
  useEffect(() => {
    let alive = true
    listTemplates({})
      .then((data) => { if (alive) setTemplateTotal(Number(data.total ?? data.items?.length ?? 0)) })
      .catch(() => { if (alive) setTemplateTotal(null) })
    return () => { alive = false }
  }, [])

  // 输入时等一下（220ms）再问服务端；切状态是点击，立刻问。
  // 首屏不等待：打开页面就按「全部」取一次。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load({ q: keyword, state: bucket })
    }, keyword ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [bucket, keyword, load])

  const filtered = keyword.trim() !== '' || bucket !== 'all'

  const reset = useCallback(() => {
    setKeyword('')
    setBucket('all')
    searchRef.current?.focus()
  }, [])

  // 「/」聚焦搜索、「Esc」清掉关键字：列表页的两个顺手键，正在输入的地方不抢键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing = target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if (event.key === '/' && !editing) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (event.key === 'Escape' && target === searchRef.current && keyword) {
        setKeyword('')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [keyword])

  const headLoading = loading && !items.length

  return (
    <div className="page vq-page vq-project-page" aria-busy={loading}>
      <PageHead
        kicker="作品 / PROJECTS"
        title={headLoading ? '正在读取…' : '作品'}
        desc="一条内容一条记录：用的哪条模板、开过几块画布、评审与交付都挂在这里。搜标题或模板名找一条，按「在做 / 已交付」看还剩哪些。"
        actions={
          <>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => void load({ q: keyword, state: bucket })} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'vq-spin' : undefined} />
              刷新
            </button>
            {/* 页头这个主按钮也按模板库分流（v0.9.42）：模板库是空的，「从模板开始」就是把人送进空库 */}
            {templateTotal === 0 ? (
              // 一屏只留一个实心主按钮：还没有作品时它在下面的空状态里（那条路才是这一屏的下一步），
              // 这里就跟着降成次要，别和它抢
              <button type="button" className={'vq-button' + (total > 0 ? ' vq-button--primary' : ' vq-button--ghost')} onClick={onDiscover}>
                <Search size={14} />
                去发现检索一条
              </button>
            ) : (
              <button type="button" className="vq-button vq-button--primary" onClick={onBrowseTemplates}>
                <Clapperboard size={14} />
                从模板开始
              </button>
            )}
          </>
        }
      />

      {total > 0 || filtered ? (
        <div className="vq-toolbar">
          <label className="vq-toolbar-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索作品或模板名"
              aria-label="搜索作品或模板名"
              autoComplete="off"
              spellCheck={false}
            />
            {keyword ? (
              <button
                type="button"
                className="vq-toolbar-search-clear"
                aria-label="清掉搜索"
                title="清掉搜索（Esc）"
                onClick={() => {
                  setKeyword('')
                  searchRef.current?.focus()
                }}
              >
                <X size={12} />
              </button>
            ) : (
              <kbd aria-hidden="true">/</kbd>
            )}
          </label>

          <div className="vq-filter-row" role="group" aria-label="按状态筛选">
            {BUCKETS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className={'vq-filter-chip' + (bucket === entry.value ? ' is-active' : '')}
                aria-pressed={bucket === entry.value}
                title={entry.hint}
                onClick={() => setBucket(entry.value)}
              >
                {entry.label}
                <span className="vq-filter-chip__count">{facets[entry.value]}</span>
              </button>
            ))}
          </div>

          <p className="vq-toolbar-count">
            {filtered ? (
              <>
                筛出 <strong className="vq-mono">{shown}</strong> / 共 {total} 条
              </>
            ) : (
              <>共 {total} 条</>
            )}
          </p>
          {filtered ? (
            <button type="button" className="vq-toolbar-reset" onClick={reset}>
              清掉筛选
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="vq-note vq-note--error" role="status">
          {error}
        </p>
      ) : null}

      {!loading && !error && !items.length ? (
        filtered ? (
          <div className="vq-empty vq-projects-empty">
            <strong>没有符合的作品</strong>
            <span>换个关键词，或把状态切回「全部」。搜索只匹配作品标题与模板名，两个字之间用空格是「都要命中」。</span>
            <button type="button" className="vq-button" onClick={reset}>
              清掉搜索与筛选
            </button>
          </div>
        ) : (
          <div className="vq-empty vq-projects-empty">
            <strong>还没有作品</strong>
            {/* 空作品页的下一步得看模板库有没有东西（v0.9.42）：
                模板库也是空的，还写「去模板库挑一条」就是一个把人送进空库的假出口。 */}
            {templateTotal === 0 ? (
              <>
                <span>
                  作品要从一条拆好的模板开始，模板库现在也还是空的：先去「发现」检索一条，把脚本与分镜拆出来，再回这里点「用它做作品」。
                </span>
                <button type="button" className="vq-button vq-button--primary" onClick={onDiscover}>
                  去发现检索一条
                  <ArrowRight size={13} />
                </button>
              </>
            ) : templateTotal === null ? (
              <>
                <span>
                  作品要从一条拆好的模板开始。模板库的条数这次没读到：先看模板库有没有能用的那条；模板库也是空的，就从「发现」检索一条。
                </span>
                <span className="vq-projects-empty-actions">
                  <button type="button" className="vq-button" onClick={onBrowseTemplates}>
                    去模板库
                    <ArrowRight size={13} />
                  </button>
                  <button type="button" className="vq-button vq-button--ghost" onClick={onDiscover}>
                    去发现检索一条
                  </button>
                </span>
              </>
            ) : (
              <>
                <span>作品要从一条拆好的模板开始：在模板库挑一条，点「用它做作品」，脚本和分镜会跟着进这条作品。</span>
                <button type="button" className="vq-button vq-button--primary" onClick={onBrowseTemplates}>
                  去模板库挑一条
                  <ArrowRight size={13} />
                </button>
              </>
            )}
          </div>
        )
      ) : null}

      {items.length ? (
        <div className="vq-projects-grid">
          {items.map((item) => (
            <button type="button" className="vq-project-card" key={item.id} onClick={() => onOpenProject(item.id)}>
              <span className="vq-project-card-head">
                <span className="vq-project-card-tags">
                  <ProjectStatusPill project={item} reviews={reviewsForVersion(item.versionCounts || {}, item.version)} decision={item.decision ?? null} />
                  {item.share ? (
                    <span className={'vq-project-share' + (item.share.live ? ' is-live' : '')} title={shareHint(item.share)}>
                      {item.share.live ? <span className="vq-project-share-dot" aria-hidden="true" /> : null}
                      {item.share.live ? '分享中' : '已停用'}
                    </span>
                  ) : null}
                  {item.version > 1 ? <span className="vq-project-card-version vq-mono">v{item.version}</span> : null}
                </span>
                <span className="vq-mono">{updatedLabel(item.updatedAt)}</span>
              </span>
              <strong className="vq-project-card-title">{item.title}</strong>
              {item.template ? (
                // 作品标题默认就是模板标题：两者一样时不再重复一遍，只保留真正多出来的信息
                item.template.title !== item.title ? <span className="vq-project-card-source">模板 · {item.template.title}</span> : null
              ) : (
                <span className="vq-project-card-source">绑定的模板已删除</span>
              )}
              <span className="vq-project-card-meta">
                <span>
                  <em>脚本</em>
                  <b>{item.template ? item.template.beats + ' 段' : '—'}</b>
                </span>
                <span>
                  <em>分镜</em>
                  <b>{item.template ? item.template.shots + ' 镜' : '—'}</b>
                </span>
                <span>
                  <em>评审</em>
                  <b>{item.reviews.count ? item.reviews.count + ' 次' : '—'}</b>
                </span>
                <span>
                  <em>运行</em>
                  <b>{item.runs?.count ? item.runs.count + ' 次' : '—'}</b>
                </span>
                <span>
                  <em>打开</em>
                  <b>{item.share?.opens ? item.share.opens + ' 次' : '—'}</b>
                </span>
              </span>
              <span className="vq-project-card-go">
                打开作品
                <ArrowRight size={13} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
