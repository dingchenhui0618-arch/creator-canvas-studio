import { Fragment, useState } from 'react'
import { useApi } from './data'
import { Badge, EmptyState, ErrorBanner, LoadingLine, SourceTag } from './ui'
import { createModelKey, deleteModelKey, testModelKey, updateModelKey, type ModelKey, type ModelKeyList } from '../../api/modelKeys'

const CAPABILITIES = [
  { id: 'text', label: '文本' },
  { id: 'vision', label: '视觉' },
  { id: 'image', label: '出图' },
  { id: 'video', label: '出视频' },
  { id: 'judge', label: '判断（Jev）' },
]

type Provider = { id: string; label: string; baseUrl: string }

// 新建与编辑共用一份字段：同一个表单组件，避免「新建能填、编辑少了某个字段」这种漂移。
type KeyValues = {
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  models: string
  capabilities: string[]
  priority: number
  weight: number
}

const EMPTY_FORM: KeyValues = {
  name: '',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  models: '',
  capabilities: ['text', 'vision'],
  priority: 100,
  weight: 100,
}

function capabilityLabel(id: string) {
  return CAPABILITIES.find((item) => item.id === id)?.label || id
}

function valuesFromKey(key: ModelKey): KeyValues {
  return {
    name: key.name,
    provider: key.provider,
    baseUrl: key.baseUrl,
    // 编辑时绝不把旧 Key 回填进输入框：列表接口拿不到明文，回填空串表示「不换」。
    apiKey: '',
    models: key.models.join(', '),
    capabilities: [...key.capabilities],
    priority: key.priority,
    weight: key.weight,
  }
}

/**
 * Key 的字段表：新建与编辑共用。
 * 渠道只负责带出接口地址，真实请求仍以管理员填的地址为准（中转 / 自建网关很常见）。
 */
function KeyFieldGrid({
  value,
  onChange,
  providers,
  apiKeyHint,
}: {
  value: KeyValues
  onChange: (next: KeyValues) => void
  providers: Provider[]
  apiKeyHint: string
}) {
  const currentProvider = providers.find((item) => item.id === value.provider)
  const changeProvider = (id: string) => {
    const preset = providers.find((item) => item.id === id)
    onChange({ ...value, provider: id, baseUrl: preset?.baseUrl || value.baseUrl })
  }
  const toggleCapability = (id: string) => {
    onChange({
      ...value,
      capabilities: value.capabilities.includes(id)
        ? value.capabilities.filter((item) => item !== id)
        : [...value.capabilities, id],
    })
  }

  return (
    <div className="admin-edit-grid">
      <label className="admin-edit-field">
        <span>名称</span>
        <input value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} placeholder="例如 DeepSeek 官方" />
      </label>
      <label className="admin-edit-field">
        <span>渠道</span>
        <select value={value.provider} onChange={(event) => changeProvider(event.target.value)}>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </label>
      <label className="admin-edit-field admin-edit-field--wide">
        <span>接口地址（baseUrl，不要带 /chat/completions）</span>
        <input value={value.baseUrl} onChange={(event) => onChange({ ...value, baseUrl: event.target.value })} placeholder={currentProvider?.baseUrl || 'https://…/v1'} />
      </label>
      <label className="admin-edit-field admin-edit-field--wide">
        <span>API Key（{apiKeyHint}）</span>
        <input
          type="password"
          value={value.apiKey}
          onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
          placeholder={value.apiKey ? '' : 'sk-…'}
          autoComplete="off"
        />
      </label>
      <label className="admin-edit-field">
        <span>模型（逗号分隔，留空=通用）</span>
        <input value={value.models} onChange={(event) => onChange({ ...value, models: event.target.value })} placeholder="deepseek-flash, deepseek-v4-pro" />
      </label>
      <div className="admin-edit-field">
        <span>能力</span>
        <div className="admin-key-caps">
          {CAPABILITIES.map((item) => (
            <label key={item.id} className="admin-key-cap">
              <input type="checkbox" checked={value.capabilities.includes(item.id)} onChange={() => toggleCapability(item.id)} />
              {item.label}
            </label>
          ))}
        </div>
        <p className="admin-hint">
          勾了「判断」的 Key 点「测试」会真跑一次判断自检。判断器两种都能用：TypeSafe 官方（走
          /v1/systemone），或任何对话模型（走 /v1/chat/completions，例如 DeepSeek、百炼）。
        </p>
      </div>
      <label className="admin-edit-field">
        <span>优先级（小=先用）</span>
        <input
          type="number"
          min={0}
          max={999}
          value={value.priority}
          onChange={(event) => onChange({ ...value, priority: Number(event.target.value) })}
        />
      </label>
      <label className="admin-edit-field">
        <span>权重（同优先级随机）</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={value.weight}
          onChange={(event) => onChange({ ...value, weight: Number(event.target.value) })}
        />
        <p className="admin-hint">权重只在优先级相同的几把之间生效：同优先级按权重分概率，优先级更小的那一组永远先被选中。</p>
      </label>
    </div>
  )
}

/**
 * 平台 Key 池：管理员在这里增删改，保存即生效，不需要改环境变量或重启。
 * 路由规则：优先级小的先选；同优先级按权重随机；连续失败 3 次冷却 60 秒；
 * 池里没有可用 Key 时回落到环境变量里的旧凭证（升级不打断现有功能）。
 *
 * 「编辑」是行内展开：点哪一行就在那一行下面改，不跳页、不弹窗，改完点保存即 PATCH。
 */
export default function ModelKeyPool() {
  const { data, error, loading, reload } = useApi<ModelKeyList>('/api/admin/model-keys')
  const [form, setForm] = useState<KeyValues>(EMPTY_FORM)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState('')
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState('')
  // 行内编辑：一次只改一把，草稿独立，取消即丢弃。
  const [editingId, setEditingId] = useState('')
  const [draft, setDraft] = useState<KeyValues>(EMPTY_FORM)
  const [editError, setEditError] = useState('')

  const providers = data?.providers || []

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

  const startEdit = (key: ModelKey) => {
    setEditingId(key.id)
    setDraft(valuesFromKey(key))
    setEditError('')
    setMessage('')
    setConfirmDelete('')
  }

  const cancelEdit = () => {
    setEditingId('')
    setEditError('')
  }

  const saveEdit = async (key: ModelKey) => {
    if (busy) return
    setEditError('')
    setMessage('')
    if (!draft.name.trim()) return setEditError('名称不能为空')
    if (draft.apiKey.trim() && draft.apiKey.trim().length < 8) return setEditError('API Key 太短，请粘贴完整 Key')
    setBusy('edit:' + key.id)
    try {
      await updateModelKey(key.id, {
        name: draft.name.trim(),
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        // 留空表示不换 Key，避免把「没改」误当成「清空凭证」
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        models: draft.models.split(/[,，\s]+/).filter(Boolean),
        capabilities: draft.capabilities,
        priority: Number(draft.priority),
        weight: Number(draft.weight),
      })
      setEditingId('')
      setMessage('已保存「' + draft.name.trim() + '」：优先级 P' + (Number(draft.priority) || 100) + ' · 权重 W' + (Number(draft.weight) || 100) + '，下一次调用按新规则选 Key')
      reload()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : '保存失败')
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
      if (editingId === key.id) setEditingId('')
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
      const real = result.mode !== 'credential-probe'
      const note = result.note ? ' · ' + result.note : ''
      // 判断能力不只探凭证：这里带上「真跑一次判断」的结果，通不通、走哪种协议一眼看见
      const judged = result.judge
        ? result.judge.ok
          ? ' · 判断自检通过（' + (result.judge.protocol === 'systemone' ? 'TypeSafe 形态' : '对话形态') + '，风险 ' +
            (result.judge.answers?.publishRisk ?? '—') + '/2）'
          : ' · 判断自检失败：' + (result.judge.error || '未知原因')
        : ''
      setTestResult((value) => ({
        ...value,
        [key.id]: result.ok
          ? (real ? '真实调用通过' : '凭证正常') +
            ' · HTTP ' + result.status + ' · ' + result.ms + 'ms' +
            (real ? (result.reply ? ' · 回复「' + result.reply + '」' : '') : result.models?.length ? ' · ' + result.models.length + ' 个模型' : '') +
            note + judged
          : (real ? '真实调用失败' : '凭证无效') + ' · ' + (result.error || 'HTTP ' + result.status) + note + judged,
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
            一把失败会自动换下一把（一次最多试 3 把），单把 Key 坏掉不会让整次调用失败；
            池里没有可用 Key 时才会回落到环境变量里的旧凭证。新增、编辑、启停、删除都保存即生效，不用重启。
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
            {counts.image || 0} · 视频 {counts.video || 0} · 判断 {counts.judge || 0} · 累计调用 成功{' '}
            {data.summary.usage?.ok || 0} / 失败 {data.summary.usage?.fail || 0}
            {data.summary.cooling ? ` · ${data.summary.cooling} 把冷却中` : ''}
            {data.fallback.configured ? ' · 环境变量兜底凭证已配置' : ' · 环境变量兜底未配置'}
          </p>

          <KeyFieldGrid value={form} onChange={setForm} providers={providers} apiKeyHint="只写一次，保存后只显示末四位" />

          {formError ? <p className="admin-hint" role="alert">{formError}</p> : null}
          {message ? <p className="admin-hint">{message}</p> : null}

          <div className="admin-edit-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={submit} disabled={busy === 'create'}>
              {busy === 'create' ? '保存中…' : '加入 Key 池'}
            </button>
          </div>

          {data.items.length === 0 ? (
            <EmptyState title="还没有平台 Key" description="贴一把上游 Key 进来，保存后下一次模型调用就会用到它。" />
          ) : (
            <div className="admin-table-wrap">
              <table className="admin-table admin-table--keys">
                <thead>
                  <tr>
                    <th>名称 · 渠道 · 凭证</th>
                    <th>能力</th>
                    <th>模型</th>
                    <th>路由</th>
                    <th>调用</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((key) => (
                    <Fragment key={key.id}>
                      <tr>
                        <td>
                          <strong>{key.name}</strong>
                          <span className="admin-cell-sub admin-mono">{key.provider} · {key.masked}</span>
                          <span className="admin-cell-sub admin-mono">{key.baseUrl}</span>
                        </td>
                        <td>{key.capabilities.map((item) => <Badge key={item} tone="ok">{capabilityLabel(item)}</Badge>)}</td>
                        <td className="admin-mono admin-key-model" title={key.models.join(', ')}>
                          {key.models.length === 0
                            ? '通用'
                            : key.models.length > 2
                              ? key.models.slice(0, 2).join(', ') + ' +' + (key.models.length - 2)
                              : key.models.join(', ')}
                        </td>
                        <td className="admin-mono admin-nowrap">P{key.priority} · W{key.weight}</td>
                        <td>
                          <span className="admin-mono admin-nowrap">成功 {key.usage?.ok || 0} · 失败 {key.usage?.fail || 0}</span>
                          {key.usage?.lastError ? (
                            <span className="admin-key-test" title={key.usage.lastError}>
                              最近失败：{key.usage.lastError}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {key.enabled ? (
                            <Badge tone={key.cooling ? 'warn' : 'ok'}>
                              {key.cooling ? `冷却中 ${key.usage?.cooldownSec || 0}s` : '启用'}
                            </Badge>
                          ) : (
                            <Badge tone="warn">已停用</Badge>
                          )}
                          {testResult[key.id] ? (
                            <span className="admin-key-test" title={testResult[key.id]}>
                              {testResult[key.id]}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <div className="admin-row-actions">
                            <button
                              type="button"
                              className="vq-button vq-button--ghost"
                              disabled={busy === key.id || busy === 'edit:' + key.id}
                              onClick={() => (editingId === key.id ? cancelEdit() : startEdit(key))}
                            >
                              {editingId === key.id ? '收起' : '编辑'}
                            </button>
                            <button type="button" className="vq-button vq-button--ghost" disabled={busy === key.id} onClick={() => runTest(key)}>测试</button>
                            <button type="button" className="vq-button vq-button--ghost" disabled={busy === key.id} onClick={() => toggle(key)}>
                              {key.enabled ? '停用' : '启用'}
                            </button>
                            {confirmDelete === key.id ? (
                              <button type="button" className="vq-button vq-button--danger" disabled={busy === key.id} onClick={() => remove(key)}>确认删除</button>
                            ) : (
                              <button type="button" className="vq-button vq-button--ghost" onClick={() => { setConfirmDelete(key.id); setEditingId('') }}>删除</button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {editingId === key.id ? (
                        <tr className="admin-key-editor">
                          <td colSpan={7}>
                            <div className="admin-key-editor-head">
                              <strong>编辑：{key.name}</strong>
                              <span className="admin-hint">
                                当前 P{key.priority} · W{key.weight} · {key.enabled ? '启用中' : '已停用'} · 凭证 {key.masked}
                              </span>
                            </div>
                            <KeyFieldGrid
                              value={draft}
                              onChange={setDraft}
                              providers={providers}
                              apiKeyHint="留空表示不换 Key；换凭证就粘贴新的"
                            />
                            {editError ? <p className="admin-hint" role="alert">{editError}</p> : null}
                            <div className="admin-edit-actions">
                              <button type="button" className="vq-button vq-button--ghost" onClick={cancelEdit} disabled={busy === 'edit:' + key.id}>
                                取消
                              </button>
                              <button type="button" className="vq-button vq-button--primary" onClick={() => saveEdit(key)} disabled={busy === 'edit:' + key.id}>
                                {busy === 'edit:' + key.id ? '保存中…' : '保存修改'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
