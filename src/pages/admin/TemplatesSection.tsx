import { useState } from 'react'
import { request } from '../../api/client'
import { useUiMode } from '../../api/app'
import { formatDateTime, formatSeconds, useApi, type TemplateItem, type TemplatesResponse } from './data'
import { AdminHead, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

type EditForm = { title: string; contentType: string; tags: string; sourceUrl: string; shared: boolean }

// 每次保存前的快照：改错了能退回上一版，不用重新解析一次（10 积分）
type TemplateVersion = {
  id: string
  at: string
  byName?: string
  values: { title?: string; contentType?: string; tags?: string[]; sourceUrl?: string }
}

const versionLabel = (version: TemplateVersion) => {
  const values = version.values || {}
  const parts = [values.title, values.contentType].filter(Boolean)
  return parts.length ? parts.join(' · ') : '这一版没有标题与类型'
}

export default function TemplatesSection() {
  const { internal } = useUiMode()
  const { data, error, loading, reload } = useApi<TemplatesResponse>('/api/templates')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  // 编辑与删除分开：编辑是就地改四个可治理字段，保存走 PATCH，成功后重新请求列表
  const [editing, setEditing] = useState<TemplateItem | null>(null)
  const [form, setForm] = useState<EditForm>({ title: '', contentType: '', tags: '', sourceUrl: '', shared: false })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const [versions, setVersions] = useState<TemplateVersion[]>([])
  const [versionsFor, setVersionsFor] = useState('')
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [restoring, setRestoring] = useState('')

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

  const loadVersions = async (item: TemplateItem) => {
    if (versionsFor === item.id) {
      setVersionsFor('')
      return
    }
    setVersionsLoading(true)
    setVersionsFor(item.id)
    try {
      const result = await request<{ versions: TemplateVersion[] }>('/api/templates/' + item.id + '/versions')
      setVersions(result.versions || [])
    } catch (cause) {
      setVersions([])
      setSaveError(cause instanceof Error ? cause.message : '读取历史版本失败')
    } finally {
      setVersionsLoading(false)
    }
  }

  const restoreVersion = async (item: TemplateItem, version: TemplateVersion) => {
    setRestoring(version.id)
    setSaveError('')
    try {
      await request<{ ok: boolean }>('/api/templates/' + item.id + '/versions/' + version.id + '/restore', { method: 'POST' })
      setSavedNote('已回滚到 ' + formatDateTime(version.at) + ' 的那一版，列表已重新请求')
      setVersionsFor('')
      setEditing(null)
      reload()
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : '回滚失败')
    } finally {
      setRestoring('')
    }
  }

  const startEdit = (item: TemplateItem) => {
    setEditing(item)
    setSaveError('')
    setSavedNote('')
    setPending(null)
    setVersionsFor('')
    setVersions([])
    setForm({
      title: item.title || '',
      contentType: item.contentType || '',
      tags: (item.tags || []).join('，'),
      sourceUrl: item.sourceUrl || '',
      shared: Boolean(item.shared),
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
          shared: form.shared,
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
        description={internal ? '来自 GET /api/templates 的真实条目；支持关键词过滤、就地编辑标题/类型/标签/原链接，以及逐条删除。' : '模板库的真实条目；支持关键词过滤、就地编辑标题 / 类型 / 标签 / 原链接，以及逐条删除。'}
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
            <label className="admin-edit-field admin-edit-field--wide admin-edit-check">
              <input
                type="checkbox"
                checked={form.shared}
                onChange={(event) => setForm((current) => ({ ...current, shared: event.target.checked }))}
              />
              <span>公共模板：所有账号都看得见（运营种子内容），关掉后只归管理员账号</span>
            </label>
          </div>
          <div className="admin-edit-actions">
            <button type="button" className="admin-btn admin-btn--ghost" onClick={() => void loadVersions(editing)} disabled={saving || versionsLoading}>
              {versionsFor === editing.id ? '收起历史版本' : '历史版本'}
            </button>
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

          {versionsFor === editing.id ? (
            <div className="admin-versions">
              <p className="admin-hint">
                每次保存前留一版（最多 10 版）。回滚会把当前内容再存成一版，所以回滚本身也能退回。
              </p>
              {versionsLoading ? (
                <LoadingLine label={'GET /api/templates/' + editing.id + '/versions'} />
              ) : versions.length ? (
                <ul className="admin-version-list">
                  {versions.map((version) => (
                    <li key={version.id} className="admin-version-row">
                      <span className="admin-mono">{formatDateTime(version.at)}</span>
                      <span className="admin-version-copy">{versionLabel(version)}</span>
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        onClick={() => void restoreVersion(editing, version)}
                        disabled={Boolean(restoring)}
                      >
                        {restoring === version.id ? '回滚中…' : '回滚到这一版'}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="admin-hint">还没有历史版本：这条模板自创建以来没被改过。</p>
              )}
            </div>
          ) : null}
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
                  <th>范围</th>
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
                    <td>
                      <span className={'admin-scope' + (item.shared ? ' is-public' : '')}>
                        {item.shared ? '公共' : '账号'}
                      </span>
                    </td>
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
          {internal ? (
            <>
              编辑调用 <code>PATCH /api/templates/:id</code>，只改标题 / 类型 / 标签 / 原链接；删除调用{' '}
              <code>DELETE /api/templates/:id</code>，需要二次确认。两者成功后都重新请求列表，不做本地假删除。
            </>
          ) : (
            '编辑只改标题 / 类型 / 标签 / 原链接；删除需要二次确认。保存与删除成功后都会重新拉取列表，不做本地假删除。'
          )}
        </p>
      </section>
    </>
  )
}
