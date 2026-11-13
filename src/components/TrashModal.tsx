import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, RefreshCw, Trash2, X } from 'lucide-react'
import { listTemplateTrash, purgeTemplate, restoreTemplate } from '../api/radar'
import type { ReplicaTemplate } from '../domain/radar'

// 回收站：删除的模板留 30 天，可恢复；彻底删除会连同抽帧一起清掉，所以要点两次。
// 编导误删一条解析了很久的模板，不该只能再花 10 积分重新拆一遍。

const pad = (value: number) => String(value).padStart(2, '0')
const DAY_MS = 24 * 60 * 60 * 1000

function deletedLabel(at?: string) {
  if (!at) return '删除时间未知'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '删除时间未知'
  return '删于 ' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function leftDays(at: string | undefined, days: number) {
  if (!at) return days
  const time = Date.parse(at)
  if (Number.isNaN(time)) return days
  const left = Math.ceil((time + days * DAY_MS - Date.now()) / DAY_MS)
  return Math.max(0, left)
}

export function TrashModal({ onClose, onToast, onRestored }: { onClose: () => void; onToast: (message: string) => void; onRestored: () => void }) {
  const [items, setItems] = useState<ReplicaTemplate[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [confirmId, setConfirmId] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    listTemplateTrash()
      .then((result) => {
        setItems(result.items || [])
        setDays(result.days || 30)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '读取回收站失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const restore = (item: ReplicaTemplate) => {
    setBusyId(item.id)
    restoreTemplate(item.id)
      .then(() => {
        setItems((current) => current.filter((entry) => entry.id !== item.id))
        onToast('已恢复「' + item.title + '」，回到模板库')
        onRestored()
      })
      .catch((caught) => onToast(caught instanceof Error ? caught.message : '恢复失败'))
      .finally(() => setBusyId(''))
  }

  const purge = (item: ReplicaTemplate) => {
    setBusyId(item.id)
    purgeTemplate(item.id)
      .then(() => {
        setItems((current) => current.filter((entry) => entry.id !== item.id))
        setConfirmId('')
        onToast('已彻底删除「' + item.title + '」')
      })
      .catch((caught) => onToast(caught instanceof Error ? caught.message : '删除失败'))
      .finally(() => setBusyId(''))
  }

  return (
    <div className="trash-backdrop" onMouseDown={onClose}>
      <div className="trash-modal" role="dialog" aria-modal="true" aria-label="模板回收站" onMouseDown={(event) => event.stopPropagation()}>
        <header className="trash-head">
          <div>
            <span className="section-kicker">模板库 · 回收站</span>
            <h2>删掉的模板还能捡回来</h2>
          </div>
          <button className="vq-button vq-button--icon" onClick={onClose} aria-label="关闭回收站"><X size={16} /></button>
        </header>
        <p className="trash-note">
          删除的模板在这里留 {days} 天，期间可以恢复；过期或彻底删除后，抽出来的帧也会一起清掉，不能撤销。
        </p>

        {error && <div className="radar-banner radar-banner--error" style={{ margin: '0 24px 12px' }}>{error}</div>}

        {loading && !items.length ? (
          <div className="trash-empty"><RefreshCw size={16} className="spin" />读取回收站</div>
        ) : items.length ? (
          <div className="trash-list">
            {items.map((item) => {
              const left = leftDays(item.deletedAt, days)
              return (
                <article className="trash-row" key={item.id}>
                  <span className="trash-thumb">
                    {item.thumb ? <img src={item.thumb} alt="" loading="lazy" /> : <Trash2 size={16} />}
                  </span>
                  <div className="trash-copy">
                    <strong>{item.title || '未命名模板'}</strong>
                    <span>{item.platformLabel || ''}{item.contentType ? ' · ' + item.contentType : ''} · {deletedLabel(item.deletedAt)} · {left} 天后清空</span>
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
              )
            })}
          </div>
        ) : (
          <div className="trash-empty"><Trash2 size={18} /><span>回收站是空的。删掉的模板会先来这里，不会直接消失。</span></div>
        )}

        <footer className="trash-foot">
          <button className="vq-button vq-button--ghost" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  )
}
