import { useState } from 'react'
import { request } from '../../api/client'
import { formatDateTime, useApi } from './data'
import { Badge, LoadingLine, SourceTag } from './ui'

/**
 * 联网搜索（r258）：从「系统」页搬到「模型与上游」，跟 Key 池同一页。
 *
 * 默认走 DeepSeek 自己的搜索接口（POST {base}/tools/search）：它跟平台对话**用同一把 Key、同一份余额**，
 * 所以这张卡上没有第二个 Key 输入框——「联网搜索和对话共用一个 Key」就是靠这个做到。
 * 博查 / Tavily / 自建接口还留着，真要换就在这同一张卡里换，不另开一处配置。
 * 没接通时那个开关在快捷创作里是禁用的：对话不会假装搜过，只会如实说「这次没搜成、别编」。
 */
export type SearchChannel = {
  configured: boolean
  provider: string
  providerLabel: string
  endpoint: string
  keyMasked: string
  hasKey: boolean
  enabled: boolean
  source: 'admin' | 'env' | 'none'
  reason: string
  usesPlatformKey: boolean
  platformKey: { available: boolean; masked: string; source: string; name: string; baseUrl: string }
  defaultProvider: string
  updatedAt: string
  updatedBy: string
  canEdit: boolean
  providers: { value: string; label: string }[]
}

type Hit = { title: string; url: string; site: string }

export default function SearchCard() {
  const status = useApi<{ ok: boolean; search: SearchChannel }>('/api/admin/search')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [probe, setProbe] = useState('短视频 爆款 结构')
  const [hits, setHits] = useState<Hit[]>([])
  // 表单默认值直接从已保存的配置推出来（null = 还没改过），不用 effect 往 state 里灌。
  const saved = status.data?.search
  const [form, setForm] = useState<{ provider: string | null; endpoint: string | null; key: string }>({
    provider: null,
    endpoint: null,
    key: '',
  })
  const provider = form.provider ?? (saved?.provider || saved?.defaultProvider || 'deepseek')
  const endpoint = form.endpoint ?? (saved?.provider === provider ? saved?.endpoint || '' : '')
  const usesPlatformKey = provider === 'deepseek'
  const platformKey = saved?.platformKey

  const saveChannel = async () => {
    setBusy('save')
    setNote('')
    try {
      const result = await request<{ search: SearchChannel; keyKept: boolean }>('/api/admin/search', {
        method: 'PUT',
        body: JSON.stringify({ provider, endpoint: endpoint.trim(), key: form.key }),
      })
      setForm({ provider: null, endpoint: null, key: '' })
      setNote(
        usesPlatformKey
          ? '联网搜索已开通：跟平台对话共用同一把 Key，不用再填第二把。点「试搜一次」确认能搜到东西。'
          : result.keyKept
            ? '搜索服务已保存，Key 沿用之前那条。'
            : '搜索服务已保存。点「试搜一次」确认能搜到东西。',
      )
      status.reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const clearChannel = async () => {
    setBusy('clear')
    setNote('')
    try {
      await request('/api/admin/search', { method: 'DELETE' })
      setHits([])
      setNote('已关掉联网搜索。快捷创作里那个开关会变成禁用，只能发链接让我读。')
      status.reload()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : '关闭失败')
    } finally {
      setBusy('')
    }
  }

  const runProbe = async () => {
    setBusy('probe')
    setNote('')
    try {
      const result = await request<{ ok: boolean; ms: number; query: string; providerLabel: string; note: string; results: Hit[] }>('/api/admin/search/test', {
        method: 'POST',
        body: JSON.stringify({ query: probe.trim() }),
      })
      setHits(result.results || [])
      setNote('搜到了 ' + (result.results || []).length + ' 条（' + result.ms + ' ms，' + (result.providerLabel || '搜索服务') + '）。')
    } catch (cause) {
      setHits([])
      setNote(cause instanceof Error ? cause.message : '试搜失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">联网搜索</p>
          <p className="admin-sub">
            快捷创作里「联网搜索」那个开关靠它。默认走 DeepSeek 搜索：<b>跟平台对话共用同一把 Key、同一份余额</b>，
            这里不用再填第二把。平台先搜一次，再把前 3 条网页读成文字一起问模型；界面上把「搜了什么、读了哪几条」列出来，能点开核对。
          </p>
        </div>
        <div className="admin-alert-actions">
          <SourceTag kind="api" source="GET /api/admin/search" />
          <button
            type="button"
            className="vq-button vq-button--ghost"
            onClick={() => void runProbe()}
            disabled={busy === 'probe' || !saved?.configured || !probe.trim()}
          >
            {busy === 'probe' ? '搜着…' : '试搜一次'}
          </button>
        </div>
      </div>

      {status.loading && !saved ? <LoadingLine label="/api/admin/search" /> : null}

      {saved ? (
        <>
          <div className="admin-alert-facts">
            <span>
              联网搜索 <b>{saved.configured ? '已接通' : '未接通'}</b>
            </span>
            <span>
              通道 <b>{saved.providerLabel || '—'}</b>
            </span>
            <span>
              Key <b>{saved.hasKey ? saved.keyMasked : '未填'}</b>
            </span>
            <span>
              来源 <b>{saved.source === 'admin' ? '本页配置' : saved.source === 'env' ? '服务器环境变量' : '未配置'}</b>
              {saved.updatedAt ? ' · ' + formatDateTime(saved.updatedAt) : ''}
            </span>
          </div>

          <div className="admin-channel">
            <div className="admin-channel-head">
              <div>
                <p className="admin-label">用哪条搜索通道</p>
                <p className="admin-sub">
                  DeepSeek 搜索跟平台对话同一把 Key，按次计费、从同一份余额扣；博查偏中文网页；Tavily 偏英文、有免费额度；
                  通用 JSON 接口给自建搜索用（POST 回 results 数组）。
                </p>
              </div>
              <Badge tone={saved.configured ? 'ok' : 'warn'}>{saved.configured ? '能搜' : '未接通'}</Badge>
            </div>

            {saved.canEdit ? (
              <div className="admin-mail-form">
                <label className="vq-field admin-mail-field">
                  <span>搜索通道</span>
                  <select
                    className="vq-input"
                    value={provider}
                    onChange={(event) => setForm((previous) => ({ ...previous, provider: event.target.value }))}
                    disabled={busy === 'save'}
                  >
                    {(saved.providers || []).map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                {usesPlatformKey ? (
                  <div className="vq-field admin-mail-field admin-mail-field--wide">
                    <span>Key（跟平台对话共用）</span>
                    <p className="admin-hint admin-search-shared">
                      {platformKey?.available
                        ? '用「Key 池」里那把 ' + (platformKey.name || '平台对话') + '：' + platformKey.masked +
                          '（' + (platformKey.source === 'env' ? '环境变量里的对话凭证' : 'Key 池') + '，' + platformKey.baseUrl + '）'
                        : '平台对话的 DeepSeek Key 还没配：先到下面「Key 池」加一把 DeepSeek Key，再回来开通。'}
                    </p>
                  </div>
                ) : (
                  <>
                    <label className="vq-field admin-mail-field">
                      <span>接口地址</span>
                      <input
                        className="vq-input"
                        value={endpoint}
                        onChange={(event) => setForm((previous) => ({ ...previous, endpoint: event.target.value }))}
                        placeholder={provider === 'generic' ? '必填，例如 https://search.example.com/api' : '留空用默认地址'}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy === 'save'}
                      />
                    </label>
                    <label className="vq-field admin-mail-field">
                      <span>API Key</span>
                      <input
                        className="vq-input"
                        type="password"
                        value={form.key}
                        onChange={(event) => setForm((previous) => ({ ...previous, key: event.target.value }))}
                        placeholder={saved.hasKey && saved.provider === provider ? '留空沿用已保存的 Key' : provider === 'generic' ? '自建接口不需要就留空' : '只在服务端保存'}
                        autoComplete="new-password"
                        disabled={busy === 'save'}
                      />
                    </label>
                  </>
                )}
                <label className="vq-field admin-mail-field">
                  <span>试搜问题</span>
                  <input
                    className="vq-input"
                    value={probe}
                    onChange={(event) => setProbe(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy === 'probe'}
                  />
                </label>
                <div className="admin-doc-actions">
                  <button
                    type="button"
                    className="vq-button"
                    onClick={() => void saveChannel()}
                    disabled={busy === 'save' || (usesPlatformKey && !platformKey?.available)}
                  >
                    {busy === 'save'
                      ? '保存中…'
                      : usesPlatformKey
                        ? saved.configured && saved.provider === 'deepseek'
                          ? '保存设置'
                          : '开通联网搜索'
                        : '保存搜索服务'}
                  </button>
                  {saved.source === 'admin' ? (
                    <button type="button" className="vq-button vq-button--ghost" onClick={() => void clearChannel()} disabled={busy === 'clear'}>
                      {busy === 'clear' ? '关闭中…' : '关掉联网搜索'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {hits.length ? (
              <ul className="admin-alert-list">
                {hits.map((row) => (
                  <li key={row.url} className="admin-alert-row">
                    <div className="admin-alert-copy">
                      <strong>{row.title || row.url}</strong>
                      <span className="admin-cell-sub admin-mono">
                        {row.site} · {row.url}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}

            {saved.source === 'env' ? (
              <p className="admin-hint">现在用的是服务器环境变量 VQ_SEARCH_*。在上面保存一条会覆盖它；关掉后台配置后又会回到环境变量。</p>
            ) : null}
            {!saved.configured ? (
              <p className="admin-hint">
                没接通时，快捷创作里的「联网搜索」开关是禁用的：对话不会假装搜过，只会说「这次没搜成、别编」。
                想让它看具体网页，把链接发进来（打开「读链接」）也行。
              </p>
            ) : null}
            <p className="admin-hint">「试搜一次」会真发一次请求：DeepSeek 搜索按次计费，跟对话同一份余额；只列来源，不读网页正文。</p>
            {note ? <p className="admin-hint">{note}</p> : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
