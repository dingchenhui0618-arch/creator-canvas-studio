import { useCallback, useEffect, useRef, useState } from 'react'
import { Clapperboard, Download, Image as ImageIcon, Loader2, Play, Workflow, X } from 'lucide-react'
import { listWorks, type WorkItem } from '../api/works'
import { listMediaAssets, uploadMediaAsset } from '../api/media-gen'
import type { MediaAsset } from '../api/media-gen'
import { probeMediaFile } from '../domain/media-file'
import { writeRefHandoff } from '../domain/media-handoff'
import { refFileName } from '../domain/media-refs'
import type { RefKind } from '../domain/media-refs'
import '../styles/works.css'

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'run', label: '工作流' },
  { value: 'canvas', label: '无限画布' },
]

const KIND_ICON = { image: ImageIcon, video: Play, run: Workflow, canvas: Clapperboard }

const REF_ROUTE = '#/agents'

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

/** 能当参考素材的：有文件，而且确实是图或视频（画布那张「一块画布」的卡片没有文件）。 */
function canReuse(item: WorkItem): boolean {
  if (!mediaUrl(item)) return false
  if (item.kind === 'image' || item.kind === 'video') return true
  return item.mediaKind === 'image' || item.mediaKind === 'video'
}

/** 作品流：三处产物一条流，按作品自己的比例排版。默认 9:16 最密。 */
export default function WorksWall({ onOpenDetail }: { onOpenDetail?: (url: string) => void }) {
  const [kind, setKind] = useState('all')
  const [items, setItems] = useState<WorkItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
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

  const load = useCallback(async (nextKind: string, before = '', append = false) => {
    if (append) setMore(true)
    else setLoading(true)
    setError('')
    try {
      const page = await listWorks({ kind: nextKind, before })
      setItems((current) => (append ? [...current, ...page.items.filter((item) => !current.some((row) => row.id === item.id))] : page.items))
      setCursor(page.cursor)
      setTotal(page.total)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '作品流读取失败')
    } finally {
      setLoading(false)
      setMore(false)
    }
  }, [])

  useEffect(() => { void load(kind) }, [kind, load])

  useEffect(() => {
    if (!preview) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [preview])

  const open = (item: WorkItem) => {
    if (item.previewUrl) setPreview(item)
    else if (item.detailUrl && onOpenDetail) onOpenDetail(item.detailUrl)
  }

  // 取回这条作品的文件：同一个地址既用来下载，也用来传成参考素材。
  // 自己取字节而不是把地址丢给浏览器，是因为两种来源的文件名和类型都不一样（画布那条只有节点号）。
  const fetchWork = async (item: WorkItem): Promise<{ blob: Blob; type: string }> => {
    const url = mediaUrl(item)
    if (!url) throw new Error('这条作品没有可取的文件')
    const response = await fetch(url, { credentials: 'same-origin' })
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

  const actions = (item: WorkItem, inModal = false) => {
    if (!canReuse(item)) return null
    const busyRef = busy?.id === item.id && busy.what === 'ref'
    const busySave = busy?.id === item.id && busy.what === 'save'
    return (
      <div className={'works-actions' + (inModal ? ' is-modal' : '')}>
        <button
          type="button"
          className="works-action"
          onClick={() => void reuseWork(item)}
          disabled={Boolean(busy)}
          title="把这条成品带进快捷创作，接着改或当首帧出视频"
        >
          {busyRef ? '加入中…' : '用作参考'}
        </button>
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
      </div>
    )
  }

  return (
    <section className="works" aria-busy={loading}>
      <div className="works-bar">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={'works-chip' + (kind === item.value ? ' is-active' : '')}
            onClick={() => setKind(item.value)}
            aria-pressed={kind === item.value}
          >
            {item.label}
          </button>
        ))}
        <span className="works-count">{loading ? '正在读取…' : '共 ' + total + ' 条'}</span>
      </div>

      {error ? <p className="works-error">{error}</p> : null}
      {note ? <p className={'works-note' + (noteError ? ' is-error' : '')}>{note}</p> : null}

      {!loading && !items.length && !error ? (
        <div className="works-empty">
          <strong>还没有作品</strong>
          <p>去「快捷创作」生成一张图或一条视频，或在工作流里跑一次，产物会自动出现在这里。</p>
        </div>
      ) : null}

      <div className="works-grid">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind] || ImageIcon
          const isVideo = item.mediaKind === 'video' || item.kind === 'video'
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
                    {item.status && item.kind === 'run' ? ' · ' + (item.status === 'success' ? '跑完了' : item.status === 'error' ? '失败' : '已停止') : ''}
                  </span>
                  <button type="button" className="works-open" onClick={() => open(item)}>
                    {item.previewUrl ? '看大图' : item.kind === 'canvas' ? '打开画布' : '打开运行'}
                  </button>
                </div>
                {actions(item)}
              </div>
            </article>
          )
        })}
      </div>

      {loading ? (
        <p className="works-more"><Loader2 size={14} className="vq-spin" /> 正在读取…</p>
      ) : cursor ? (
        <button type="button" className="works-more is-button" disabled={more} onClick={() => void load(kind, cursor, true)}>
          {more ? '正在读取…' : '看更早的'}
        </button>
      ) : items.length ? (
        <p className="works-more">已经到底了</p>
      ) : null}

      {preview ? (
        <div className="works-modal" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
          <button type="button" className="works-modal-close" onClick={() => setPreview(null)} aria-label="关闭">
            <X size={16} />
          </button>
          <div className="works-modal-body" onClick={(event) => event.stopPropagation()}>
            {(preview.mediaKind === 'video' || preview.kind === 'video') ? (
              <video src={preview.previewUrl || undefined} controls autoPlay playsInline />
            ) : (
              <img src={preview.previewUrl || undefined} alt={preview.title} />
            )}
            <div className="works-modal-bar">
              <p className="works-modal-note">{preview.title} · {stamp(preview.at)}</p>
              {actions(preview, true)}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
