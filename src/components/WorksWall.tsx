import { useCallback, useEffect, useRef, useState } from 'react'
import { Clapperboard, Download, Image as ImageIcon, Loader2, Play, Search, Workflow, X } from 'lucide-react'
import MediaLightbox from './MediaLightbox'
import { listWorks, type WorkItem, type WorksCounts } from '../api/works'
import { safeFetch } from '../api/client'
import { deleteMediaTask, listMediaAssets, uploadMediaAsset } from '../api/media-gen'
import type { MediaAsset } from '../api/media-gen'
import { probeMediaFile } from '../domain/media-file'
import { writeRefHandoff } from '../domain/media-handoff'
import { refFileName } from '../domain/media-refs'
import type { RefKind } from '../domain/media-refs'
import { readWorksFilter, readWorksQuery, runStatusLabel, workDetailLabel, WORKS_QUERY_MAX, writeWorksFilter, writeWorksQuery, type WorksFilter } from '../domain/works-view'
import '../styles/works.css'

const FILTERS: Array<{ value: WorksFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'run', label: '工作流' },
  { value: 'canvas', label: '无限画布' },
]

const KIND_ICON = { image: ImageIcon, video: Play, run: Workflow, canvas: Clapperboard }

const NO_COUNTS: WorksCounts = { all: 0, image: 0, video: 0, run: 0, canvas: 0 }

/** 筛到某一类而这一类是空的：说清「是这一类没有」，不是「账号下什么都没有」。 */
const FILTER_NOUN: Record<WorksFilter, string> = {
  all: '作品',
  image: '图片',
  video: '视频',
  run: '工作流运行',
  canvas: '无限画布',
}

/** 这一类的东西从哪里来：空状态里给一条真能走的路，不笼统地叫人「去生成一条」。 */
const FILTER_HINT: Record<WorksFilter, string> = {
  all: '',
  image: '「快捷创作 → 图片」生成的图会进这里。',
  video: '「快捷创作 → 视频」或工作流里出的视频会进这里。',
  run: '跑过一次工作流（哪怕失败或中途停止）就会进这里。',
  canvas: '在无限画布上出过图或视频，就会进这里；只摆过素材、没出过东西的画布不算。',
}

const REF_ROUTE = '#/agents'

/** 删完之后说一句「释放了多少」：单位跟服务端字节数一致，不四舍五入成 0 MB。 */
function mbText(bytes: number): string {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10) + ' MB'
}

function stamp(at: number): string {
  if (!at) return ''
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function ratioClass(aspect: string): string {
  if (aspect === '9:16') return 'is-portrait'
  if (aspect === '16:9') return 'is-landscape'
  if (aspect === '1:1') return 'is-square'
  return 'is-unknown'
}

/** 这条作品有没有能取回的文件：快捷创作 / 工作流的成品，以及画布里出过的图与视频。 */
function mediaUrl(item: WorkItem): string {
  return item.previewUrl || item.thumbUrl || ''
}

/** 图片还是视频：画布节点与快捷创作看 kind，工作流封面看 mediaKind。 */
function workKind(item: WorkItem): RefKind {
  if (item.kind === 'video' || item.mediaKind === 'video') return 'video'
  return 'image'
}

/**
 * 能从这里删掉的：只有快捷创作生成的图与视频（作品号是 media:<任务号>）。
 *
 * 为什么不给运行卡与画布卡一个「删」：那些记录属于工作流与无限画布，删它们要动那边的
 * 运行记录 / 画布内容，是各自应用里的事。作品流这边只删自己真正拥有的那份东西。
 */
function canDelete(item: WorkItem): boolean {
  return item.id.startsWith('media:')
}

/** 能当参考素材的：有文件，而且确实是图或视频（画布那张「一块画布」的卡片没有文件）。 */
function canReuse(item: WorkItem): boolean {
  if (!mediaUrl(item)) return false
  if (item.kind === 'image' || item.kind === 'video') return true
  return item.mediaKind === 'image' || item.mediaKind === 'video'
}

/** 作品流：三处产物一条流，按作品自己的比例排版。默认 9:16 最密。 */
export default function WorksWall({ onOpenDetail }: { onOpenDetail?: (url: string) => void }) {
  // 筛选跟着会话走：点开一次运行再回来，刚才筛的「工作流」还在（r266）
  const [kind, setKind] = useState<WorksFilter>(() => readWorksFilter(window.sessionStorage))
  // 搜作品（r281）：关键词也记在会话里，回来还在；空词就是没搜
  const [query, setQuery] = useState(() => readWorksQuery(window.sessionStorage))
  // 这一页一共看了多少条（三个来源各有扫描上限）：搜不到时说清「只找了最近这些」
  const [scanned, setScanned] = useState(0)
  const [items, setItems] = useState<WorkItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  // 每一类各几条（r272）：筛到空的一类时，靠 counts.all 才分得清「这一类没有」与「一条都没有」
  const [counts, setCounts] = useState<WorksCounts>(NO_COUNTS)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<WorkItem | null>(null)
  // 哪一条作品正在取回文件：同一条按钮变「加入中…」，别让人连点两次传两份
  const [busy, setBusy] = useState<{ id: string; what: 'ref' | 'save' } | null>(null)
  const [note, setNote] = useState('')
  const [noteError, setNoteError] = useState(false)
  // 自己传过的素材：用来认「这一条已经加过了」，同一条作品不重复占配额
  const libraryRef = useRef<MediaAsset[] | null>(null)
  // 删掉一条作品（r282）：作品流只进不出，失败与不要的成品堆到翻都翻不动。
  // 跟「最近生成」一样要点两下；删的是那条任务的记录与文件，不退积分。
  const [armedDelete, setArmedDelete] = useState('')
  const [deleting, setDeleting] = useState('')

  const showCounts = counts.all > 0 || !loading

  const load = useCallback(async (nextKind: WorksFilter, before = '', append = false, nextQuery = '') => {
    if (append) setMore(true)
    else setLoading(true)
    setError('')
    try {
      const page = await listWorks({ kind: nextKind, before, q: nextQuery })
      setItems((current) => (append ? [...current, ...page.items.filter((item) => !current.some((row) => row.id === item.id))] : page.items))
      setCursor(page.cursor)
      setTotal(page.total)
      setScanned(Number(page.scanned) || 0)
      // 老服务端没有 counts：退回「只知道当前这一类」，空状态就不多说一句别的
      if (page.counts) setCounts(page.counts)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '作品流读取失败')
    } finally {
      setLoading(false)
      setMore(false)
    }
  }, [])

  // 打字时等一下再问（220ms）；切栏目、清空关键词是点击，立刻问（与作品项目页同一套手感）
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(kind, '', false, query) }, query.trim() ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [kind, query, load])

  useEffect(() => { writeWorksFilter(window.sessionStorage, kind) }, [kind])
  useEffect(() => { writeWorksQuery(window.sessionStorage, query) }, [query])

  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview])

  // 去作品出处（那次运行的只读视图 / 那块画布）是「离开作品流」的动作：
  // 只在人明确点了它的按钮时才走，点缩略图不再顺手把人带走（r266）。
  const goDetail = (item: WorkItem) => {
    if (!item.detailUrl) return
    setPreview(null)
    if (onOpenDetail) onOpenDetail(item.detailUrl)
    else window.location.assign(item.detailUrl)
  }

  const open = (item: WorkItem) => {
    if (item.previewUrl) setPreview(item)
    else goDetail(item)
  }

  // 取回这条作品的文件：同一个地址既用来下载，也用来传成参考素材。
  // 自己取字节而不是把地址丢给浏览器，是因为两种来源的文件名和类型都不一样（画布那条只有节点号）。
  const fetchWork = async (item: WorkItem): Promise<{ blob: Blob; type: string }> => {
    const url = mediaUrl(item)
    if (!url) throw new Error('这条作品没有可取的文件')
    const response = await safeFetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('取回这条作品失败（HTTP ' + response.status + '）')
    const blob = await response.blob()
    return { blob, type: blob.type || (workKind(item) === 'video' ? 'video/mp4' : 'image/png') }
  }

  const saveWork = async (item: WorkItem) => {
    if (busy) return
    setBusy({ id: item.id, what: 'save' })
    setNote('')
    setNoteError(false)
    try {
      const { blob, type } = await fetchWork(item)
      const name = refFileName({ id: item.id, kind: workKind(item), prompt: item.title }, type)
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      // 让浏览器先把下载接过去再释放：立刻 revoke 在 Safari 上会把下载掐掉
      window.setTimeout(() => URL.revokeObjectURL(href), 4000)
      setNote('已开始下载「' + name + '」')
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '下载这条作品失败')
      setNoteError(true)
    } finally {
      setBusy(null)
    }
  }

  // 作品流 → 快捷创作：成品不该只停在「看大图」这一层。
  // 以前这一步要人手把图下载下来、再回快捷创作传一遍；现在只做两件事——
  // 取回字节传成参考素材（同一条上传接口，不扣积分、不打上游），把素材号交给快捷创作去挂。
  const reuseWork = async (item: WorkItem) => {
    if (busy) return
    const target = workKind(item)
    setBusy({ id: item.id, what: 'ref' })
    setNote('')
    setNoteError(false)
    try {
      let asset: MediaAsset | null = null
      if (libraryRef.current) {
        const name = refFileName({ id: item.id, kind: target, prompt: item.title }, '')
        asset = libraryRef.current.find((entry) => entry.name === name && entry.kind === target) ?? null
      }
      if (!asset) {
        if (!libraryRef.current) {
          const response = await listMediaAssets(20).catch(() => null)
          libraryRef.current = response?.assets ?? []
          const name = refFileName({ id: item.id, kind: target, prompt: item.title }, '')
          asset = libraryRef.current.find((entry) => entry.name === name && entry.kind === target) ?? null
        }
        if (!asset) {
          const { blob, type } = await fetchWork(item)
          const name = refFileName({ id: item.id, kind: target, prompt: item.title }, type)
          const file = new File([blob], name, { type })
          const meta = await probeMediaFile(file)
          const uploaded = await uploadMediaAsset({ file, ...meta })
          asset = uploaded.asset
          libraryRef.current = [asset, ...(libraryRef.current ?? []).filter((entry) => entry.id !== asset?.id)]
        }
      }
      writeRefHandoff(window.sessionStorage, {
        assetId: asset.id,
        kind: target,
        name: asset.name,
        from: item.source,
        // 带过来的图是 9:16，出图就按 9:16：不然一落地就是 1:1，还得人手改一次比例
        ratio: item.aspect,
      })
      setPreview(null)
      setNote('已把这条作品带到「快捷创作」，接在参考素材里')
      if (onOpenDetail) onOpenDetail(REF_ROUTE)
      // 同页跳转（只是换 hash），不走整页刷新；用 assign 而不是改 location.hash，避免与页面状态机抢写
      else window.location.assign(REF_ROUTE)
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '把这条作品当参考失败')
      setNoteError(true)
    } finally {
      setBusy(null)
    }
  }

  // 删掉一条成品：删的是快捷创作那条生成任务（记录 + 文件），所以它同时从「最近生成」里消失。
  // 删完整页重取一次：被删的那条很可能正是翻页游标，留着旧位置会让「看更早的」落到一个空页上。
  const deleteWork = async (item: WorkItem) => {
    if (busy || deleting) return
    const taskId = item.id.slice('media:'.length)
    if (!taskId) return
    if (armedDelete !== item.id) {
      setArmedDelete(item.id)
      return
    }
    setArmedDelete('')
    setDeleting(item.id)
    setNote('')
    setNoteError(false)
    try {
      const result = await deleteMediaTask(taskId)
      setPreview(null)
      const freed = Math.max(0, Number(result?.freedBytes) || 0)
      setNote(freed ? '已删掉这条作品，释放 ' + mbText(freed) : '已删掉这条作品')
      void load(kind, '', false, query)
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '删掉这条作品失败')
      setNoteError(true)
    } finally {
      setDeleting('')
    }
  }

  // 卡片上是「接着用这条成品」（用作参考 / 下载），浮层里再加一条「去出处」——
  // 有封面的运行卡以前点缩略图就整页跳走，现在跳转是个写着去哪儿的按钮（r266）。
  const actions = (item: WorkItem, options: { detail?: boolean; remove?: boolean } = {}) => {
    const reuse = canReuse(item)
    const detail = options.detail ? workDetailLabel(item) : ''
    // 删只在看大图的浮层里给：卡片上三个按钮已经够挤，删除又是唯一不可逆的动作，
    // 放在「先看清这张、再说删不删」的那一屏最合适。
    const remove = Boolean(options.remove) && canDelete(item)
    if (!reuse && !detail && !remove) return null
    const busyRef = busy?.id === item.id && busy.what === 'ref'
    const busySave = busy?.id === item.id && busy.what === 'save'
    return (
      <div className="works-actions">
        {reuse ? (
          <button
            type="button"
            className="works-action"
            onClick={() => void reuseWork(item)}
            disabled={Boolean(busy)}
            title="把这条成品带进快捷创作，接着改或当首帧出视频"
          >
            {busyRef ? '加入中…' : '用作参考'}
          </button>
        ) : null}
        {reuse ? (
          <button
            type="button"
            className="works-action"
            onClick={() => void saveWork(item)}
            disabled={Boolean(busy)}
            title="存到本机"
          >
            <Download size={12} />
            {busySave ? '下载中…' : '下载'}
          </button>
        ) : null}
        {detail ? (
          <button type="button" className="works-action" onClick={() => goDetail(item)} title="离开作品流，去那一次运行 / 那块画布">
            {detail}
          </button>
        ) : null}
        {remove ? (
          <button
            type="button"
            className={'works-action' + (armedDelete === item.id ? ' is-danger is-armed' : ' is-danger')}
            onClick={() => void deleteWork(item)}
            disabled={Boolean(deleting) || Boolean(busy)}
            title="删掉这条记录与文件（积分不退，删了找不回来）"
            aria-label={armedDelete === item.id ? '再次点击确认删掉' : '删掉这条作品：' + item.title}
          >
            {deleting === item.id ? '删除中…' : armedDelete === item.id ? '确认删掉' : '删掉这条'}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <section className="works" aria-busy={loading}>
      <div className="works-bar">
        {/* 每一栏带条数（r272）：不点进去就知道「视频那栏有没有东西」，不用一栏一栏试 */}
        {FILTERS.map((item) => {
          const zero = showCounts && counts[item.value] === 0
          return (
            <button
              key={item.value}
              type="button"
              className={'works-chip' + (kind === item.value ? ' is-active' : '') + (zero ? ' is-zero' : '')}
              onClick={() => setKind(item.value)}
              aria-pressed={kind === item.value}
              aria-label={showCounts ? item.label + '，' + counts[item.value] + ' 条' : item.label}
            >
              {item.label}
              {showCounts ? <span className="works-chip-count">{counts[item.value]}</span> : null}
            </button>
          )
        })}
        {/* 搜作品（r281）：作品流只进不出，图一多就找不回来。
            搜的是卡片上已经写着的字（提示词标题 / 摘要 / 模型 / 来源）加四个栏目名，
            打完字等 220ms 再问，不打上游、不扣积分。 */}
        <label className="vq-toolbar-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value.slice(0, WORKS_QUERY_MAX))}
            onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery('') } }}
            placeholder="搜提示词、模型或来源"
            aria-label="搜作品"
            autoComplete="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="vq-toolbar-search-clear"
              aria-label="清掉搜索"
              title="清掉搜索（Esc）"
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          ) : null}
        </label>
        <span className="works-count">
          {loading ? '正在读取…' : (query.trim() ? '匹配 ' + total + ' 条' : '共 ' + total + ' 条')}
        </span>
      </div>

      {/* 搜索词是我打的，结果是我要认得出来的：先说清在多少条里找的，再说找到几条。
          「只在最近 N 条里找过」不能省——作品流不是全库检索，写清楚才不会被当成「我明明做过」。 */}
      {query.trim() && !error && (loading || total > 0) ? (
        <p className="works-search-note">
          {loading
            ? '正在找「' + query.trim() + '」…'
            : total
              ? '只在最近 ' + scanned + ' 条里找：图片看最近 400 份、运行看最近 50 次、画布看前 12 块，不是全库检索。'
              : '最近 ' + scanned + ' 条里没有匹配「' + query.trim() + '」的作品。'}
        </p>
      ) : null}

      {error ? <p className="works-error">{error}</p> : null}
      {note ? <p className={'works-note' + (noteError ? ' is-error' : '')}>{note}</p> : null}

      {/* 空状态先说清是哪一种空（r272）：
          「视频这一栏没有」被写成「还没有作品」，等于告诉一个做了 200 张图的人「你什么都没做过」，
          还顺手把人指去重新生成。现在这一栏有别的类，就给一句话 + 一条回「全部」的路。 */}
      {!loading && !items.length && !error ? (
        query.trim() && counts.all === 0 ? (
          <div className="works-empty">
            <strong>没有匹配「{query.trim()}」的作品</strong>
            <p>
              只在最近 {scanned} 条里找过（图片看最近 400 份、运行看最近 50 次、画布看前 12 块）；搜的是提示词、摘要、模型名、来源和栏目名。换个词，或者清掉搜索看全部。
            </p>
            <button type="button" className="vq-button vq-button--ghost works-empty-action" onClick={() => setQuery('')}>
              清掉搜索
            </button>
          </div>
        ) : kind !== 'all' && counts.all > 0 ? (
          <div className="works-empty">
            <strong>
              {query.trim() ? '「' + query.trim() + '」在' + FILTER_NOUN[kind] + '里没有' : FILTER_NOUN[kind] + '这一类还没有作品'}
            </strong>
            <p>
              {query.trim() ? '' : FILTER_HINT[kind]}
              {query.trim() ? '另外 ' : '账号下现在有 '}{counts.all} 条{query.trim() ? '匹配的' : '别的'}作品在别的栏目里，切回「全部」就能看到。
            </p>
            <button type="button" className="vq-button vq-button--ghost works-empty-action" onClick={() => setKind('all')}>
              看全部 {counts.all} 条
            </button>
          </div>
        ) : (
          <div className="works-empty">
            <strong>还没有作品</strong>
            <p>去「快捷创作」生成一张图或一条视频、在工作流里跑一次，或在无限画布上出图出视频——产物都会自动出现在这里。</p>
          </div>
        )
      ) : null}

      <div className="works-grid">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind] || ImageIcon
          const isVideo = item.mediaKind === 'video' || item.kind === 'video'
          const statusLabel = item.kind === 'run' ? runStatusLabel(item.status) : ''
          return (
            <article key={item.id} className={'works-card ' + ratioClass(item.aspect)}>
              <button type="button" className="works-thumb" onClick={() => open(item)} title={item.title}>
                {item.thumbUrl ? (
                  isVideo ? (
                    <video src={item.thumbUrl} muted preload="metadata" playsInline aria-label={item.title} />
                  ) : (
                    <img src={item.thumbUrl} alt={item.title} loading="lazy" />
                  )
                ) : (
                  <span className="works-fallback">
                    <Icon size={18} />
                    {item.nodeCount ? item.nodeCount + ' 个节点' : item.source}
                  </span>
                )}
                <span className="works-tag">
                  <Icon size={11} />
                  {item.source}
                </span>
              </button>
              <div className="works-meta">
                <p className="works-title">{item.title}</p>
                {item.summary ? <p className="works-summary">{item.summary}</p> : null}
                <div className="works-line">
                  <span className="works-time">
                    {stamp(item.at)}
                    {item.model ? ' · ' + item.model : ''}
                    {item.durationMs ? ' · ' + Math.max(1, Math.round(item.durationMs / 1000)) + 's' : ''}
                    {statusLabel ? ' · ' + statusLabel : null}
                  </span>
                  <button type="button" className="works-open" onClick={() => open(item)}>
                    {item.previewUrl ? (isVideo ? '看视频' : '看大图') : item.kind === 'canvas' ? '打开画布' : '打开运行'}
                  </button>
                </div>
                {actions(item, { detail: Boolean(item.previewUrl) })}
              </div>
            </article>
          )
        })}
      </div>

      {loading ? (
        <p className="works-more"><Loader2 size={14} className="vq-spin" /> 正在读取…</p>
      ) : cursor ? (
        <button type="button" className="works-more is-button" disabled={more} onClick={() => void load(kind, cursor, true, query)}>
          {more ? '正在读取…' : '看更早的'}
        </button>
      ) : items.length ? (
        <p className="works-more">已经到底了</p>
      ) : null}

      {/* r262：作品流的「看大图」和快捷创作共用同一个浮层——
          以前这里是自己一套 880px 的弹层，没有卡片底，放大后跟背后的卡片文字叠在一起。 */}
      {preview && preview.previewUrl ? (
        <MediaLightbox
          kind={workKind(preview)}
          src={preview.previewUrl}
          alt={preview.title}
          head={preview.source + ' · ' + stamp(preview.at)}
          note={preview.model || null}
          caption={preview.summary ? preview.title + ' · ' + preview.summary : preview.title}
          actions={actions(preview, { detail: true, remove: true })}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </section>
  )
}
