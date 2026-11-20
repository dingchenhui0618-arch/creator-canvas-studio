import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, RefreshCw, Trash2, X } from 'lucide-react'

// 回收站（r271 起通用）：删掉的东西先来这里，留 N 天再真清。
// 编导误删一条解析了很久的模板，不该只能再花 10 积分重新拆一遍；
// 作品更贵——脚本、分镜、版本、交付记录都在里面，所以两边共用这一套界面，
// 只有「读什么、恢复什么」由调用方给。

export type TrashEntry = {
  id: string
  title: string
  /** 行上第二行说明：来源 / 版本 / 删于什么时候，由调用方拼好 */
  meta: string
  /** 可选缩略图；没有就画一个垃圾桶图标 */
  thumb?: string
}

export type TrashSource = {
  /** 读回收站：条目 + 保留天数（服务端给，界面不写死） */
  load: () => Promise<{ items: TrashEntry[]; days: number }>
  restore: (id: string) => Promise<void>
  purge: (id: string) => Promise<void>
  kicker: string
  heading: string
  ariaLabel: string
  /** 顶部那段说明，{days} 会被替换成天数 */
  note: string
  emptyText: string
  restoredToast: (title: string) => string
  purgedToast: (title: string) => string
}

export function TrashModal({
  source,
  onClose,
  onToast,
  onRestored,
}: {
  source: TrashSource
  onClose: () => void
  onToast: (message: string) => void
  onRestored: () => void
}) {
  const [items, setItems] = useState<TrashEntry[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [confirmId, setConfirmId] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    source
      .load()
      .then((result) => {
        setItems(result.items || [])
        setDays(result.days || 30)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '读取回收站失败'))
      .finally(() => setLoading(false))
  }, [source])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const restore = (item: TrashEntry) => {
    setBusyId(item.id)
    source
      .restore(item.id)
      .then(() => {
        setItems((current) => current.filter((entry) => entry.id !== item.id))
        onToast(source.restoredToast(item.title))
        onRestored()
      })
      .catch((caught) => onToast(caught instanceof Error ? caught.message : '恢复失败'))
      .finally(() => setBusyId(''))
  }

  const purge = (item: TrashEntry) => {
    setBusyId(item.id)
    source
      .purge(item.id)
      .then(() => {
        setItems((current) => current.filter((entry) => entry.id !== item.id))
        setConfirmId('')
        onToast(source.purgedToast(item.title))
      })
      .catch((caught) => onToast(caught instanceof Error ? caught.message : '删除失败'))
      .finally(() => setBusyId(''))
  }

  return (
    <div className="trash-backdrop" onMouseDown={onClose}>
      <div className="trash-modal" role="dialog" aria-modal="true" aria-label={source.ariaLabel} onMouseDown={(event) => event.stopPropagation()}>
        <header className="trash-head">
          <div>
            <span className="section-kicker">{source.kicker}</span>
            <h2>{source.heading}</h2>
          </div>
          <button className="vq-button vq-button--icon" onClick={onClose} aria-label="关闭回收站"><X size={16} /></button>
        </header>
        <p className="trash-note">{source.note.replace('{days}', String(days))}</p>

        {error && <div className="radar-banner radar-banner--error" style={{ margin: '0 24px 12px' }}>{error}</div>}

        {loading && !items.length ? (
          <div className="trash-empty"><RefreshCw size={16} className="spin" />读取回收站</div>
        ) : items.length ? (
          <div className="trash-list">
            {items.map((item) => (
              <article className="trash-row" key={item.id}>
                <span className="trash-thumb">
                  {item.thumb ? <img src={item.thumb} alt="" loading="lazy" /> : <Trash2 size={16} />}
                </span>
                <div className="trash-copy">
                  <strong>{item.title}</strong>
                  <span>{item.meta}</span>
                </div>
                {confirmId === item.id ? (
                  <div className="trash-actions">
                    <span className="trash-confirm">彻底删除后不能恢复</span>
                    <button className="vq-button vq-button--danger vq-button--sm" disabled={busyId === item.id} onClick={() => purge(item)}>确认删除</button>
                    <button className="vq-button vq-button--ghost vq-button--sm" onClick={() => setConfirmId('')}>取消</button>
                  </div>
                ) : (
                  <div className="trash-actions">
                    <button className="vq-button vq-button--ghost vq-button--sm" disabled={busyId === item.id} onClick={() => restore(item)}>
                      <ArchiveRestore size={13} />恢复
                    </button>
                    <button className="vq-button vq-button--danger vq-button--sm" disabled={busyId === item.id} onClick={() => setConfirmId(item.id)}>
                      <Trash2 size={13} />彻底删除
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="trash-empty"><Trash2 size={18} /><span>{source.emptyText}</span></div>
        )}

        <footer className="trash-foot">
          <button className="vq-button vq-button--ghost" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
