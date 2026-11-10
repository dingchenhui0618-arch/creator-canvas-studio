import { useState } from 'react'
import { request } from '../../api/client'
import { formatDateTime, formatSeconds, useApi, type TemplateItem, type TemplatesResponse } from './data'
import { AdminHead, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

type EditForm = { title: string; contentType: string; tags: string; sourceUrl: string }

export default function TemplatesSection() {
  const { data, error, loading, reload } = useApi<TemplatesResponse>('/api/templates')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  // 编辑与删除分开：编辑是就地改四个可治理字段，保存走 PATCH，成功后重新请求列表
  const [editing, setEditing] = useState<TemplateItem | null>(null)
  const [form, setForm] = useState<EditForm>({ title: '', contentType: '', tags: '', sourceUrl: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedNote, setSavedNote] = useState('')

  const items = data?.items ?? []
  const keyword = query.trim().toLowerCase()
  const filtered = keyword
    ? items.filter((item) =>
        [item.title, item.contentType, item.platformLabel || '', item.id]
          .join(' ')
          .toLowerCase()
          .includes(keyword),
      )
    : items

  const retryDelete = () => {
    const target = items.find((item) => item.id === pending)
    if (target && !deleting) void remove(target)
  }

  const remove = async (item: TemplateItem) => {
    setDeleting(item.id)
    setActionError('')
    try {
      await request<{ ok: boolean }>(`/api/templates/${item.id}`, { method: 'DELETE' })
      setPending(null)
      reload()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      setDeleting(null)
    }
  }

  const startEdit = (item: TemplateItem) => {
    setEditing(item)
    setSaveError('')
    setSavedNote('')
    setPending(null)
    setForm({
      title: item.title || '',
      contentType: item.contentType || '',
      tags: (item.tags || []).join('，'),
      sourceUrl: item.sourceUrl || '',
    })
  }

  const saveEdit = async () => {
    if (!editing || saving) return
    setSaving(true)
    setSaveError('')
    try {
      const updated = await request<TemplateItem>(`/api/templates/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: form.title,
          contentType: form.contentType,
          tags: form.tags
            .split(/[，,]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
          sourceUrl: form.sourceUrl,
        }),
      })
      setSavedNote('已保存「' + updated.title + '」，列表已重新请求')
      setEditing(null)
      reload()
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <AdminHead
        kicker="ADMIN / TEMPLATES"
        title="模板库管理"
        description="来自 GET /api/templates 的真实条目；支持关键词过滤、就地编辑标题/类型/标签/原链接，以及逐条删除。"
        actions={<RefreshButton onClick={reload} busy={loading} />}
      />

      {error ? <ErrorBanner message={`GET /api/templates：${error}`} onRetry={reload} /> : null}
      {actionError ? <ErrorBanner title="删除失败" message={actionError} onRetry={retryDelete} /> : null}
      {saveError ? <ErrorBanner title="保存失败" message={saveError} onRetry={() => void saveEdit()} /> : null}
      {savedNote ? <p className="admin-hint admin-hint--ok">{savedNote}</p> : null}
      {loading && !data ? <LoadingLine label="/api/templates" /> : null}

      {editing ? (
        <section className="admin-card admin-edit">
          <div className="admin-block-head">
            <div>
              <span className="admin-kicker">EDIT / TEMPLATES</span>
              <h3>编辑「{editing.title}」</h3>
            </div>
            <SourceTag kind="api" source={'PATCH /api/templates/' + editing.id} />
          </div>
          <div className="admin-edit-grid">
            <label className="admin-edit-field">
              <span>标题</span>
              <input
                value={form.title}
                maxLength={120}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              />
            </label>
            <label className="admin-edit-field">
              <span>内容类型</span>
              <input
                value={form.contentType}
                maxLength={40}
                placeholder="例如：工作流 / 口播 / 封面"
                onChange={(event) => setForm((current) => ({ ...current, contentType: event.target.value }))}
              />
            </label>
            <label className="admin-edit-field admin-edit-field--wide">
              <span>标签（逗号分隔，最多 12 个）</span>
              <input
                value={form.tags}
                onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))}
              />
            </label>
            <label className="admin-edit-field admin-edit-field--wide">
              <span>原链接</span>
              <input
                value={form.sourceUrl}
                maxLength={1000}
                placeholder="留空会清空来源链接"
                onChange={(event) => setForm((current) => ({ ...current, sourceUrl: event.target.value }))}
              />
            </label>
          </div>
          <div className="admin-edit-actions">
            <button type="button" className="admin-btn admin-btn--ghost" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              onClick={() => void saveEdit()}
              disabled={saving || !form.title.trim() || !form.contentType.trim()}
            >
              {saving ? '保存中…' : '保存修改'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="admin-card admin-block">
        <div className="admin-toolbar">
          <label className="admin-search">
            <span className="admin-label">关键词</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="标题 / 类型 / 平台 / id"
            />
          </label>
          <div className="admin-toolbar-meta">
            <SourceTag kind="api" source="GET /api/templates" />
            <span className="admin-mono">
              {filtered.length} / {items.length} 条
            </span>
          </div>
        </div>

        {filtered.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table--templates">
              <thead>
                <tr>
                  <th>帧</th>
                  <th>标题</th>
                  <th>类型</th>
                  <th>镜头</th>
                  <th>时长</th>
                  <th>入库</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="admin-thumb">
                        {item.thumb || item.cover ? (
                          <img src={item.thumb || item.cover} alt="" loading="lazy" />
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <strong>{item.title}</strong>
                      <span className="admin-cell-sub admin-mono">{item.id}</span>
                    </td>
                    <td>{item.contentType}</td>
                    <td className="admin-mono">{item.storyboard?.length ?? 0}</td>
                    <td className="admin-mono">{formatSeconds(item.durationSec)}</td>
                    <td className="admin-mono">{formatDateTime(item.createdAt)}</td>
                    <td className="admin-actions-cell">
                      {pending === item.id ? (
                        <span className="admin-confirm">
                          <button
                            type="button"
                            className="admin-btn admin-btn--danger"
                            onClick={() => void remove(item)}
                            disabled={deleting === item.id}
                          >
                            {deleting === item.id ? '删除中…' : '确认删除'}
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--ghost"
                            onClick={() => setPending(null)}
                            disabled={deleting === item.id}
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <span className="admin-row-actions">
                          <button
                            type="button"
                            className="admin-btn admin-btn--ghost admin-btn--icon"
                            onClick={() => startEdit(item)}
                            title="编辑模板"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="admin-btn admin-btn--ghost admin-btn--icon"
                            onClick={() => setPending(item.id)}
                            title="删除模板"
                          >
                            删除
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {!loading && !filtered.length ? (
          <EmptyState
            title={items.length ? '没有匹配的模板' : '模板库为空'}
            description={items.length ? '换一个关键词试试。' : '先到画布或模板库入库一条模板。'}
          />
        ) : null}

        <p className="admin-hint">
          编辑调用 <code>PATCH /api/templates/:id</code>，只改标题 / 类型 / 标签 / 原链接；删除调用{' '}
          <code>DELETE /api/templates/:id</code>，需要二次确认。两者成功后都重新请求列表，不做本地假删除。
        </p>
      </section>
    </>
  )
}
