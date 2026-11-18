import { useCallback, useEffect, useState } from 'react'
import { Clapperboard, Image as ImageIcon, Loader2, Play, Workflow, X } from 'lucide-react'
import { listWorks, type WorkItem } from '../api/works'
import '../styles/works.css'

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'run', label: '工作流' },
  { value: 'canvas', label: '无限画布' },
]

const KIND_ICON = { image: ImageIcon, video: Play, run: Workflow, canvas: Clapperboard }

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

      {!loading && !items.length && !error ? (
        <div className="works-empty">
          <strong>还没有作品</strong>
          <p>去「快捷创作」生成一张图或一条视频，或在工作流里跑一次，产物会自动出现在这里。</p>
        </div>
      ) : null}

      <div className="works-grid">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind] || ImageIcon
          return (
            <article key={item.id} className={'works-card ' + ratioClass(item.aspect)}>
              <button type="button" className="works-thumb" onClick={() => open(item)} title={item.title}>
                {item.thumbUrl ? (
                  item.kind === 'video' ? (
                    <video src={item.thumbUrl} muted preload="metadata" aria-label={item.title} />
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
                <span className="works-time">{stamp(item.at)}</span>
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
            {preview.kind === 'video' ? (
              <video src={preview.previewUrl || undefined} controls autoPlay playsInline />
            ) : (
              <img src={preview.previewUrl || undefined} alt={preview.title} />
            )}
            <p className="works-modal-note">{preview.title} · {stamp(preview.at)}</p>
          </div>
        </div>
      ) : null}
    </section>
  )
}
