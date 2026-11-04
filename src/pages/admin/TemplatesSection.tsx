import { useState } from 'react'
import { request } from '../../api/client'
import { formatDateTime, formatSeconds, useApi, type TemplateItem, type TemplatesResponse } from './data'
import { AdminHead, EmptyState, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

export default function TemplatesSection() {
  const { data, error, loading, reload } = useApi<TemplatesResponse>('/api/templates')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')

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

  return (
    <>
      <AdminHead
        kicker="ADMIN / TEMPLATES"
        title="模板库管理"
        description="来自 GET /api/templates 的真实条目；支持关键词过滤与逐条删除，删除会直接写服务端。"
        actions={<RefreshButton onClick={reload} busy={loading} />}
      />

      {error ? <ErrorBanner message={`GET /api/templates：${error}`} onRetry={reload} /> : null}
      {actionError ? <ErrorBanner title="删除失败" message={actionError} onRetry={retryDelete} /> : null}
      {loading && !data ? <LoadingLine label="/api/templates" /> : null}

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
                        <button
                          type="button"
                          className="admin-btn admin-btn--ghost admin-btn--icon"
                          onClick={() => setPending(item.id)}
                          title="删除模板"
                        >
                          删除
                        </button>
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
          删除调用 <code>DELETE /api/templates/:id</code>，需要二次确认；成功后重新请求列表，不做本地假删除。
        </p>
      </section>
    </>
  )
}
