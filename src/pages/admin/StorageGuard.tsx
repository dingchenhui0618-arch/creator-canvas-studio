import { useCallback, useEffect, useState } from 'react'
import { Check, Eraser, HardDrive, Trash2 } from 'lucide-react'
import {
  cleanOrphanFrames,
  clearStorageLimit,
  formatSize,
  getAdminStorage,
  saveStorageLimit,
  setStorageLimit,
  type AdminStorage,
  type StorageAccountRow,
} from '../../api/storage'
import { formatDateTime } from './data'
import { Badge, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

// 素材占用上限（v0.9.68）：只回答「谁的帧图占了多少盘、到多少就不让再复刻」。
// 三个刻意的决定：
//   1. 默认 0（不限）：数字是运营决定，没定之前不设死；
//   2. 只算自己的模板：公共示例（运营种子内容）不记在任何账号头上；
//   3. 到顶在任务入口拦：一次复刻要多少兆事先不知道，估个数会拦错，
//      所以口径是「已经到顶就不再接新的」——那一单不扣积分、也不碰来源链接。

const num = (raw: string): number | null => {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

function limitLabel(row: StorageAccountRow): string {
  if (row.overridden) return '单独 ' + (row.limitMb || '不限')
  return row.limitMb > 0 ? '默认 ' + row.limitMb + ' MB' : '默认不限'
}

export default function StorageGuard() {
  const [view, setView] = useState<AdminStorage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState('')
  const [rowDraft, setRowDraft] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    getAdminStorage()
      .then((data) => {
        setView(data)
        setDraft(String(data.limits.defaultMb))
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : '素材占用读取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const run = async (action: () => Promise<AdminStorage>, done: string) => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const next = await action()
      setView(next)
      setDraft(String(next.limits.defaultMb))
      setRowDraft({})
      setNote(done)
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const saveDefault = () => {
    const value = num(draft)
    if (value === null) {
      setNote('默认上限写 0（不限）或一个整数 MB，例如 500')
      return
    }
    void run(
      () => saveStorageLimit(value),
      value ? '默认上限已设为 ' + value + ' MB，下一次复刻就按它拦' : '已取消默认上限：所有账号回到「不限」',
    )
  }

  const saveRow = (row: StorageAccountRow) => {
    const raw = rowDraft[row.userId] === undefined ? String(row.limitMb) : rowDraft[row.userId]
    const value = num(raw)
    if (value === null) {
      setNote('单独上限写 0（不限）或一个整数 MB')
      return
    }
    void run(() => setStorageLimit(row.userId, value), '已把 ' + row.email + ' 的素材上限设为 ' + (value ? value + ' MB' : '不限'))
  }

  const clearRow = (row: StorageAccountRow) => {
    void run(() => clearStorageLimit(row.userId), '已恢复 ' + row.email + ' 的默认上限')
  }

  const clean = () => {
    void run(
      async () => {
        const result = await cleanOrphanFrames()
        setNote(
          result.dirs
            ? '已清理 ' + result.dirs + ' 个孤立目录，释放 ' + formatSize(result.bytes)
            : '没有可清理的孤立目录：每个帧图目录都还有模板指向它',
        )
        return result
      },
      '',
    )
  }

  const rows = view?.accounts ?? []
  const limited = Boolean(view && view.limits.defaultMb > 0)

  return (
    <section className="admin-card admin-block admin-block--storage">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">素材占用上限</p>
          <p className="admin-sub">
            帧图按模板归属算在创建人名下，公共示例不记在任何账号头上。到顶之后「一键复刻」在扣费前返回 429：
            那一单不扣积分、也不碰来源链接。0 表示不限，也是现在的默认值。
          </p>
        </div>
        <div className="admin-row-actions">
          <Badge tone={limited ? 'ok' : 'neutral'}>{view ? (limited ? '默认 ' + view.limits.defaultMb + ' MB' : '不限') : '读取中'}</Badge>
          <SourceTag kind="api" source="GET /api/admin/storage" />
          <RefreshButton onClick={load} busy={loading} />
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading && !view ? <LoadingLine label="素材占用上限" /> : null}

      {view ? (
        <>
          <div className="admin-quota-form">
            <label className="vq-field">
              <span>默认上限（MB，0 = 不限）</span>
              <input
                className="vq-input"
                value={draft}
                inputMode="numeric"
                onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
                placeholder="0"
              />
            </label>
            <button type="button" className="vq-button vq-button--primary" onClick={saveDefault} disabled={busy}>
              <Check size={14} />
              {busy ? '保存中…' : '保存默认上限'}
            </button>
            <span className="admin-cell-note">
              帧图合计 {formatSize(view.frames.bytes)} · {view.frames.dirs} 个模板目录
              {view.shared.bytes ? ' · 公共示例 ' + formatSize(view.shared.bytes) : ''}
              {view.limits.updatedAt ? ' · 最近修改 ' + formatDateTime(view.limits.updatedAt) : ''}
            </span>
          </div>

          {rows.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th style={{ textAlign: 'right' }}>模板</th>
                    <th style={{ textAlign: 'right' }}>素材占用</th>
                    <th>上限</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.userId}>
                      <td>
                        <strong>{row.email}</strong>
                        <span className="admin-cell-note">
                          {row.name || '—'} · {row.kind === 'admin' ? '管理员' : '账号'}
                          {row.active ? '' : ' · 已停用'}
                        </span>
                      </td>
                      <td className="admin-mono num-col">{row.templates}</td>
                      <td className="admin-mono num-col">
                        {formatSize(row.bytes)}
                        {row.over ? <span className="admin-cell-note">已到顶，复刻会被拒</span> : null}
                      </td>
                      <td>
                        <span className={row.unlimited ? 'admin-cell-note' : ''}>{limitLabel(row)}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div className="admin-row-actions admin-row-actions--end">
                          <input
                            className="vq-input admin-quota-input"
                            value={rowDraft[row.userId] === undefined ? String(row.limitMb) : rowDraft[row.userId]}
                            inputMode="numeric"
                            aria-label={'给 ' + row.email + ' 设置素材上限（MB）'}
                            onChange={(event) => setRowDraft({ ...rowDraft, [row.userId]: event.target.value.replace(/[^0-9]/g, '') })}
                          />
                          <button type="button" className="vq-button vq-button--ghost" onClick={() => saveRow(row)} disabled={busy}>
                            保存
                          </button>
                          {row.overridden ? (
                            <button type="button" className="vq-button vq-button--ghost" onClick={() => clearRow(row)} disabled={busy}>
                              <Trash2 size={14} />
                              恢复默认
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="还没有账号建过模板" description="有人复刻一条之后，这里会按归属列出他的帧图占用。" />
          )}

          <div className="admin-storage-orphans">
            <div>
              <strong>
                <HardDrive size={14} /> 孤立帧图
              </strong>
              <span className="admin-cell-note">
                {view.orphans.count
                  ? view.orphans.count + ' 个目录、' + formatSize(view.orphans.bytes) + ' 不属于任何模板（模板记录已删，图还占着盘）'
                  : '没有任何孤立目录：每个帧图目录都还有模板指向它'}
              </span>
            </div>
            <button type="button" className="vq-button vq-button--ghost" onClick={clean} disabled={busy || !view.orphans.count}>
              <Eraser size={14} />
              清理孤立目录
            </button>
          </div>

          <p className="admin-hint">
            统计时间 {formatDateTime(view.checkedAt)}；只算帧图（DATA_DIR/frames），不含日志与备份。
            清理只删「没有任何模板指向」的目录，回收站里的模板仍然算占用，彻底删除之后才会变成孤立目录。
          </p>
        </>
      ) : null}

      {note ? <p className="admin-cell-note" role="status">{note}</p> : null}
    </section>
  )
}
