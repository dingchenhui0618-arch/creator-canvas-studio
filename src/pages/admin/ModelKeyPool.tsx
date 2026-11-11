import { useState } from 'react'
import { useApi } from './data'
import { Badge, EmptyState, ErrorBanner, LoadingLine, SourceTag } from './ui'
import { createModelKey, deleteModelKey, testModelKey, updateModelKey, type ModelKey, type ModelKeyList } from '../../api/modelKeys'

const CAPABILITIES = [
  { id: 'text', label: '文本' },
  { id: 'vision', label: '视觉' },
  { id: 'image', label: '出图' },
  { id: 'video', label: '出视频' },
]

const EMPTY_FORM = {
  name: '',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  models: '',
  capabilities: ['text', 'vision'] as string[],
  priority: 100,
  weight: 100,
}

function capabilityLabel(id: string) {
  return CAPABILITIES.find((item) => item.id === id)?.label || id
}

/**
 * 平台 Key 池：管理员在这里增删改，保存即生效，不需要改环境变量或重启。
 * 路由规则：优先级小的先选；同优先级按权重随机；连续失败 3 次冷却 60 秒；
 * 池里没有可用 Key 时回落到环境变量里的旧凭证（升级不打断现有功能）。
 */
export default function ModelKeyPool() {
  const { data, error, loading, reload } = useApi<ModelKeyList>('/api/admin/model-keys')
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState('')
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState('')

  const providers = data?.providers || []
  const currentProvider = providers.find((item) => item.id === form.provider)

  const changeProvider = (id: string) => {
    const preset = providers.find((item) => item.id === id)
    setForm((value) => ({
      ...value,
      provider: id,
      baseUrl: preset?.baseUrl || value.baseUrl,
    }))
  }

  const toggleCapability = (id: string) => {
    setForm((value) => ({
      ...value,
      capabilities: value.capabilities.includes(id)
        ? value.capabilities.filter((item) => item !== id)
        : [...value.capabilities, id],
    }))
  }

  const submit = async () => {
    if (busy) return
    setFormError('')
    setMessage('')
    if (!form.name.trim()) return setFormError('先给这把 Key 起个名字')
    if (!form.apiKey.trim()) return setFormError('粘贴完整 API Key')
    setBusy('create')
    try {
      await createModelKey({
        name: form.name.trim(),
        provider: form.provider,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim(),
        models: form.models.split(/[,，\s]+/).filter(Boolean),
        capabilities: form.capabilities,
        priority: Number(form.priority) || 100,
        weight: Number(form.weight) || 100,
      })
      setForm({ ...EMPTY_FORM, provider: form.provider, baseUrl: form.baseUrl })
      setMessage('已加入 Key 池，下一次模型调用就会用到它')
      reload()
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存失败')
    } finally {
      setBusy('')
    }
  }

  const toggle = async (key: ModelKey) => {
    setBusy(key.id)
    setMessage('')
    try {
      await updateModelKey(key.id, { enabled: !key.enabled })
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '状态修改失败')
    } finally {
      setBusy('')
    }
  }

  const remove = async (key: ModelKey) => {
    setBusy(key.id)
    try {
      await deleteModelKey(key.id)
      setConfirmDelete('')
      setMessage('已删除 ' + key.name)
      reload()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '删除失败')
    } finally {
      setBusy('')
    }
  }

  const runTest = async (key: ModelKey) => {
    setBusy(key.id)
    setTestResult((value) => ({ ...value, [key.id]: '测试中…' }))
    try {
      const result = await testModelKey(key.id)
      setTestResult((value) => ({
        ...value,
        [key.id]: result.ok
          ? '连接正常 · HTTP ' + result.status + ' · ' + result.ms + 'ms' + (result.models.length ? ' · ' + result.models.length + ' 个模型' : '')
          : '连接失败 · ' + (result.error || 'HTTP ' + result.status),
      }))
      reload()
    } catch (cause) {
      setTestResult((value) => ({ ...value, [key.id]: cause instanceof Error ? cause.message : '测试失败' }))
    } finally {
      setBusy('')
    }
  }

  const counts = data?.summary.counts || {}

  return (
    <section className="admin-card admin-block">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">平台 Key 池</p>
          <p className="admin-sub">
            这里是整个平台共用的上游 Key。优先级小的先选，同优先级按权重随机；连续失败 3 次自动冷却 60 秒；
            池里没有可用 Key 时才会回落到环境变量里的旧凭证。保存即生效，不用重启。
          </p>
        </div>
        <SourceTag kind="api" source="GET /api/admin/model-keys" />
      </div>

      {error ? <ErrorBanner message={`GET /api/admin/model-keys：${error}`} onRetry={reload} /> : null}
      {loading && !data ? <LoadingLine label="/api/admin/model-keys" /> : null}

      {data ? (
        <>
          <p className="admin-hint">
            已启用 {data.summary.enabled} / {data.summary.total} 把 · 文本 {counts.text || 0} · 视觉 {counts.vision || 0} · 出图{' '}
            {counts.image || 0} · 视频 {counts.video || 0}
            {data.summary.cooling ? ` · ${data.summary.cooling} 把冷却中` : ''}
            {data.fallback.configured ? ' · 环境变量兜底凭证已配置' : ' · 环境变量兜底未配置'}
          </p>

          <div className="admin-edit-grid">
            <label className="admin-edit-field">
              <span>名称</span>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如 DeepSeek 官方" />
            </label>
            <label className="admin-edit-field">
              <span>渠道</span>
              <select value={form.provider} onChange={(event) => changeProvider(event.target.value)}>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <label className="admin-edit-field admin-edit-field--wide">
              <span>接口地址（baseUrl，不要带 /chat/completions）</span>
              <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder={currentProvider?.baseUrl || 'https://…/v1'} />
            </label>
            <label className="admin-edit-field admin-edit-field--wide">
              <span>API Key（只写一次，保存后只显示末四位）</span>
              <input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder="sk-…" autoComplete="off" />
            </label>
            <label className="admin-edit-field">
              <span>模型（逗号分隔，留空=通用）</span>
              <input value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} placeholder="deepseek-flash, deepseek-v4-pro" />
            </label>
            <div className="admin-edit-field">
              <span>能力</span>
              <div className="admin-key-caps">
                {CAPABILITIES.map((item) => (
                  <label key={item.id} className="admin-key-cap">
                    <input type="checkbox" checked={form.capabilities.includes(item.id)} onChange={() => toggleCapability(item.id)} />
                    {item.label}
                  </label>
                ))}
              </div>
            </div>
            <label className="admin-edit-field">
              <span>优先级（小=先用）</span>
              <input type="number" min={0} max={999} value={form.priority} onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })} />
            </label>
            <label className="admin-edit-field">
              <span>权重（同优先级随机）</span>
              <input type="number" min={1} max={1000} value={form.weight} onChange={(event) => setForm({ ...form, weight: Number(event.target.value) })} />
            </label>
          </div>

          {formError ? <p className="admin-hint" role="alert">{formError}</p> : null}
          {message ? <p className="admin-hint">{message}</p> : null}

          <div className="admin-edit-actions">
            <button type="button" className="admin-btn admin-btn--primary" onClick={submit} disabled={busy === 'create'}>
              {busy === 'create' ? '保存中…' : '加入 Key 池'}
            </button>
          </div>

          {data.items.length === 0 ? (
            <EmptyState title="还没有平台 Key" description="贴一把上游 Key 进来，保存后下一次模型调用就会用到它。" />
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>名称 / 渠道</th>
                    <th>凭证</th>
                    <th>能力</th>
                    <th>模型</th>
                    <th>路由</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((key) => (
                    <tr key={key.id}>
                      <td>
                        <strong>{key.name}</strong>
                        <span className="admin-cell-sub">{key.provider} · {key.baseUrl}</span>
                      </td>
                      <td className="admin-mono">{key.masked}</td>
                      <td>{key.capabilities.map((item) => <Badge key={item} tone="ok">{capabilityLabel(item)}</Badge>)}</td>
                      <td className="admin-mono">{key.models.length ? key.models.join(', ') : '通用'}</td>
                      <td className="admin-mono">P{key.priority} · W{key.weight}</td>
                      <td>
                        {key.enabled ? <Badge tone={key.cooling ? 'warn' : 'ok'}>{key.cooling ? '冷却中' : '启用'}</Badge> : <Badge tone="warn">已停用</Badge>}
                        {testResult[key.id] ? <span className="admin-cell-sub">{testResult[key.id]}</span> : null}
                      </td>
                      <td>
                        <div className="admin-row-actions">
                          <button type="button" className="admin-btn admin-btn--ghost" disabled={busy === key.id} onClick={() => runTest(key)}>测试</button>
                          <button type="button" className="admin-btn admin-btn--ghost" disabled={busy === key.id} onClick={() => toggle(key)}>
                            {key.enabled ? '停用' : '启用'}
                          </button>
                          {confirmDelete === key.id ? (
                            <button type="button" className="admin-btn admin-btn--danger" disabled={busy === key.id} onClick={() => remove(key)}>确认删除</button>
                          ) : (
                            <button type="button" className="admin-btn admin-btn--ghost" onClick={() => setConfirmDelete(key.id)}>删除</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}
