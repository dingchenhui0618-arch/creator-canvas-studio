import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, BookOpen, Check, MessageSquareText, Trash2, Wrench } from 'lucide-react'
import {
  AGENT_CATEGORIES,
  createAgent,
  deleteAgent,
  formatRelative,
  listAgents,
  setPendingSelectAgent,
  updateAgent,
} from '../api/agents'
import type { AgentCategory, AgentInput, AgentRecord, AgentsList } from '../api/agents'
import type { Page } from '../domain/types'
import PageHead from '../components/PageHead'
import { Select } from '../components/Select'
import { useModelOptions } from '../components/ModelSwitch'
import { useUiMode } from '../api/app'
import { getPreferences } from '../api/preferences'
import '../styles/agents.css'

type AgentEditorPageProps = {
  onBack: () => void
  onNavigate: (page: Page) => void
  onToast: (message: string) => void
  agent?: { name: string; description: string }
}

type AgentForm = {
  name: string
  category: AgentCategory
  role: string
  systemPrompt: string
  model: string
  temperature: number
  knowledge: string
  tools: string[]
}

const blankForm = (model = ''): AgentForm => ({
  name: '',
  category: '内容复刻',
  role: '',
  systemPrompt: '',
  model,
  temperature: 0.4,
  knowledge: '',
  tools: ['assets-read'],
})

const hydrate = (record: AgentRecord): AgentForm => ({
  name: record.name,
  category: record.category,
  role: record.role,
  systemPrompt: record.systemPrompt,
  model: record.model,
  temperature: record.temperature,
  knowledge: record.knowledge.join('\n'),
  tools: record.tools,
})

export default function AgentEditorPage({ onBack, onNavigate, onToast, agent: seed }: AgentEditorPageProps) {
  // 生产只讲产品语言：不出现存储文件、接口路径和字段清单，那些留在内部测试环境
  const { internal } = useUiMode()
  const [meta, setMeta] = useState<AgentsList | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [editingId, setEditingId] = useState('')
  const [form, setForm] = useState<AgentForm>(() => blankForm())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [armedDelete, setArmedDelete] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)

  // 从列表或对话进来时，先把外壳滚动容器复位，避免继承上一页的滚动位置。
  useEffect(() => {
    pageRef.current?.scrollIntoView({ block: 'start' })
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoading(true)
      setLoadError('')
      try {
        // 新智能体默认沿用顶栏选择的模型；没选过才用平台默认
        const [data, prefs] = await Promise.all([listAgents(), getPreferences().catch(() => ({ model: '' }))])
        if (!alive) return
        setMeta(data)
        const record: AgentRecord | undefined = seed ? data.items.find((item) => item.name === seed.name) : undefined
        if (record) {
          setEditingId(record.id)
          setForm(hydrate(record))
          return
        }
        const next = blankForm(prefs.model || data.defaultModel)
        if (seed) {
          next.name = seed.name
          next.role = seed.description
        }
        setForm(next)
      } catch (caught) {
        if (!alive) return
        setLoadError(caught instanceof Error ? caught.message : '智能体列表加载失败')
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [seed])

  const patch = useCallback((value: Partial<AgentForm>) => {
    setForm((current) => ({ ...current, ...value }))
  }, [])

  const checks = useMemo(
    () => [
      { label: '名称至少 2 个字', pass: form.name.trim().length >= 2 },
      { label: '一句话职责已填写', pass: form.role.trim().length >= 2 },
      { label: '系统提示词 ≥ 10 字', pass: form.systemPrompt.trim().length >= 10 },
      { label: '系统提示词 ≥ 40 字（建议）', pass: form.systemPrompt.trim().length >= 40 },
      { label: '至少一条知识（建议）', pass: form.knowledge.split('\n').some((line) => line.trim()) },
    ],
    [form.knowledge, form.name, form.role, form.systemPrompt],
  )
  const ready = checks.slice(0, 3).every((check) => check.pass)

  const catalogModels = useModelOptions()
  const modelLabels = useMemo(() => {
    const map = new Map<string, string>()
    catalogModels.forEach((item) => map.set(item.id, item.label))
    return map
  }, [catalogModels])
  const modelOptions = useMemo(() => {
    const values = new Set(meta?.models ?? [])
    if (form.model) values.add(form.model)
    return [
      { value: '', label: '账号默认模型' },
      ...[...values].map((value) => ({ value, label: modelLabels.get(value) || 'VisionQA 模型' })),
    ]
  }, [form.model, meta?.models, modelLabels])

  const toggleTool = useCallback((id: string) => {
    setForm((current) => ({
      ...current,
      tools: current.tools.includes(id) ? current.tools.filter((item) => item !== id) : [...current.tools, id],
    }))
  }, [])

  const save = useCallback(async () => {
    if (saving) return
    if (!ready) {
      setSaveError('名称、一句话职责和系统提示词（≥ 10 字）都需要填写')
      return
    }
    setSaving(true)
    setSaveError('')
    const input: AgentInput = {
      name: form.name.trim(),
      category: form.category,
      role: form.role.trim(),
      systemPrompt: form.systemPrompt.trim(),
      model: form.model,
      temperature: form.temperature,
      knowledge: form.knowledge
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20),
      tools: form.tools,
    }
    try {
      const saved = editingId ? await updateAgent(editingId, input) : await createAgent(input)
      onToast(editingId ? '已更新「' + saved.name + '」' : '已创建「' + saved.name + '」，回到列表即可对话')
      onNavigate('agents')
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [editingId, form, onNavigate, onToast, ready, saving])

  const remove = useCallback(async () => {
    if (!editingId) return
    if (!armedDelete) {
      setArmedDelete(true)
      window.setTimeout(() => setArmedDelete(false), 3200)
      return
    }
    setArmedDelete(false)
    setSaveError('')
    try {
      await deleteAgent(editingId)
      onToast('已删除该智能体')
      onNavigate('agents')
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : '删除失败')
    }
  }, [armedDelete, editingId, onNavigate, onToast])

  const startChat = useCallback(() => {
    if (!editingId) return
    setPendingSelectAgent(editingId)
    onNavigate('agents')
  }, [editingId, onNavigate])

  const knowledgeCount = form.knowledge.split('\n').filter((line) => line.trim()).length
  // 列表里的运行次数与最近运行来自服务端，不再写死成「0 次 / 未运行」
  const currentRecord = useMemo(
    () => (editingId ? meta?.items.find((item) => item.id === editingId) ?? null : null),
    [editingId, meta],
  )
  const toolSummary = useMemo(() => {
    const tools = meta?.tools ?? []
    return {
      ready: tools.filter((tool) => tool.state === 'ready').length,
      planned: tools.filter((tool) => tool.state === 'planned').length,
    }
  }, [meta])

  return (
    <div ref={pageRef} className="page agx-page agx-editor">
      <PageHead
        kicker={
          <button type="button" className="agx-head-back" onClick={onBack}>
            <ArrowLeft size={12} />
            返回智能体
          </button>
        }
        title={editingId ? form.name || '编辑智能体' : '新建智能体'}
        desc={
          internal
            ? '保存即写入 data/agents.json，回到列表就能直接对话。'
            : '保存后回到列表即可直接对话；每次运行都会在「历史 → 运行记录」留档。'
        }
        actions={
          <div className="agx-head-actions">
          {editingId && (
            <button className={'agx-btn ' + (armedDelete ? 'agx-btn--danger' : 'agx-btn--quiet')} onClick={() => void remove()}>
              <Trash2 size={14} />
              {armedDelete ? '确认删除' : '删除'}
            </button>
          )}
          <button className="agx-btn" onClick={onBack}>
            取消
          </button>
            <button className="agx-btn agx-btn--ink" onClick={() => void save()} disabled={saving || !ready}>
              <Check size={14} />
              {saving ? '保存中…' : editingId ? '保存修改' : '创建智能体'}
            </button>
          </div>
        }
      />

      {loadError && (
        <div className="agx-alert">
          <AlertCircle size={14} />
          <span>读取智能体列表失败：{loadError}。你仍然可以尝试保存，失败原因会显示在按钮下方。</span>
        </div>
      )}

      <div className="agx-editor-layout">
        <main className="agx-editor-main" aria-busy={loading}>
          <section className="agx-form-section">
            <header>
              <span className="agx-kicker">01 / 身份</span>
              <h2>它叫什么，负责什么</h2>
            </header>
            <div className="agx-field-grid">
              <label className="agx-field">
                <span>名称</span>
                <input
                  value={form.name}
                  maxLength={40}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="例如：爆款结构复刻"
                />
              </label>
              <label className="agx-field">
                <span>分类</span>
                <Select
                  size="sm"
                  className="vq-select--block"
                  label="分类"
                  value={form.category}
                  options={AGENT_CATEGORIES.map((item) => ({ value: item, label: item }))}
                  onChange={(value) => patch({ category: value as AgentCategory })}
                />
              </label>
            </div>
            <label className="agx-field">
              <span>一句话职责</span>
              <input
                value={form.role}
                maxLength={120}
                onChange={(event) => patch({ role: event.target.value })}
                placeholder="它替你做的判断是什么，例如：把一条爆款拆成可复用的结构骨架"
              />
              <small>会显示在列表卡片上，写清楚产出物，而不是「很懂内容」。</small>
            </label>
          </section>

          <section className="agx-form-section">
            <header>
              <span className="agx-kicker">02 / 行为</span>
              <h2>系统提示词</h2>
              <span className="agx-mono">{form.systemPrompt.trim().length} 字</span>
            </header>
            <label className="agx-field">
              <textarea
                rows={12}
                value={form.systemPrompt}
                onChange={(event) => patch({ systemPrompt: event.target.value })}
                placeholder={'你是一位……\n\n工作方式：\n1. ……\n2. ……\n\n约束：\n- 只使用用户给出的信息，缺什么写「待确认」；\n- 不要编造数据、案例或效果承诺。'}
              />
              <small>
                {internal
                  ? '写清目标、步骤、禁止事项，以及未知信息怎么处理；对话时会作为 system 消息发给模型。'
                  : '写清目标、步骤与禁止事项，以及未知信息怎么处理；保存后每次对话都会带上它。'}
              </small>
            </label>
          </section>

          <section className="agx-form-section">
            <header>
              <span className="agx-kicker">03 / 上下文</span>
              <h2>知识与工具</h2>
            </header>
            <label className="agx-field">
              <span>
                知识
                <b className="agx-mono">{knowledgeCount} 条</b>
              </span>
              <textarea
                rows={6}
                value={form.knowledge}
                onChange={(event) => patch({ knowledge: event.target.value })}
                placeholder={'每行一条，例如：\n镜头切换按 3-4 秒一个节拍。\n评审结论只用 通过 / 待确认 / 问题 三档。'}
              />
              <small>
                {internal
                  ? '每行一条事实或规则，最多 20 条；会拼进 system 消息，优先级高于模型常识。'
                  : '每行一条事实或规则，最多 20 条；会并入每次对话的上下文，优先级高于模型常识。'}
              </small>
            </label>
            <div className="agx-field">
              <span>
                工具
                <b className="agx-mono">
                  {internal
                    ? toolSummary.ready + ' 已接入 · ' + toolSummary.planned + ' 待接入'
                    : toolSummary.ready + ' 项可用 · ' + toolSummary.planned + ' 项即将开放'}
                </b>
              </span>
              <div className="agx-tool-grid">
                {(meta?.tools ?? []).map((tool) => {
                  const active = form.tools.includes(tool.id)
                  return (
                    <button
                      type="button"
                      key={tool.id}
                      className={'agx-tool' + (active ? ' is-active' : '')}
                      onClick={() => toggleTool(tool.id)}
                      aria-pressed={active}
                    >
                      <span className="agx-tool-check">{active && <Check size={10} />}</span>
                      <span>
                        <strong>
                          {tool.label}
                          {internal
                            ? tool.state === 'planned'
                              ? ' · 待接入'
                              : ' · 已接入'
                            : tool.state === 'planned'
                              ? ' · 即将开放'
                              : ' · 可用'}
                        </strong>
                        <span>{tool.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              <small>
                {internal ? '已接入' : '可用'}的工具会在对话前真正执行：把对话里链接的公开网页正文、模板库 / 画布流程的标题带进上下文，或把回复里的
                JSON 整理成可下载文件。{internal ? '待接入的只作能力声明' : '未开放的工具只作能力说明'}，不会假装执行。
              </small>
            </div>
          </section>

          <section className="agx-form-section">
            <header>
              <span className="agx-kicker">04 / 运行</span>
              <h2>模型与参数</h2>
            </header>
            <div className="agx-field-grid">
              <label className="agx-field">
                <span>模型</span>
                <Select
                  size="sm"
                  className="vq-select--block"
                  label="模型"
                  value={form.model}
                  options={modelOptions.map((option) => ({ value: option.value, label: option.label }))}
                  onChange={(value) => patch({ model: value })}
                />
                <small>
                  {loading
                    ? '正在读取可用模型…'
                    : internal
                      ? '来自服务端 VISION_MODEL / VISION_FALLBACKS，失败时会自动降级。'
                      : '由平台统一配置；某个模型不可用时会自动切换到备用模型。'}
                </small>
              </label>
              <label className="agx-field">
                <span>
                  温度
                  <b className="agx-mono">{form.temperature.toFixed(1)}</b>
                </span>
                <div className="agx-slider-row">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={form.temperature}
                    onChange={(event) => patch({ temperature: Number(event.target.value) })}
                  />
                </div>
                <small>结构化评审建议 0.2–0.4，发散创作 0.6–0.8。</small>
              </label>
            </div>
          </section>

          {saveError && (
            <div className="agx-alert" role="alert">
              <AlertCircle size={14} />
              <span>{saveError}</span>
            </div>
          )}

          <footer className="agx-editor-foot">
            {internal ? (
              <span className="agx-mono">
                {editingId ? 'PATCH /api/agents/' + editingId : 'POST /api/agents'}
              </span>
            ) : (
              <span className="agx-mono">{editingId ? '编辑已有智能体' : '新建智能体'}</span>
            )}
            <div>
              <button className="agx-btn" onClick={onBack}>
                取消
              </button>
              <button className="agx-btn agx-btn--ink" onClick={() => void save()} disabled={saving || !ready}>
                <Check size={14} />
                {saving ? '保存中…' : editingId ? '保存修改' : '创建智能体'}
              </button>
            </div>
          </footer>
        </main>

        <aside className="agx-editor-side">
          <section className="agx-side-panel">
            <span className="agx-kicker">列表预览</span>
            <div className="agx-preview">
              <div className="agx-card-top">
                <span className="agx-card-name">{form.name || '未命名智能体'}</span>
                <span className="agx-tag">{form.category}</span>
              </div>
              <p className="agx-card-role">{form.role || '一句话职责会显示在这里。'}</p>
              <div className="agx-card-meta">
                <span>
                  <span>模型</span>
                  <span className="agx-mono">{form.model ? modelLabels.get(form.model) || 'VisionQA 模型' : '账号默认模型'}</span>
                </span>
                <span>
                  <span>最近运行</span>
                  <span className="agx-mono">{formatRelative(currentRecord?.lastRunAt)}</span>
                </span>
                <span>
                  <span>使用次数</span>
                  <span className="agx-mono">{currentRecord?.runCount ?? 0} 次</span>
                </span>
              </div>
            </div>
          </section>

          <section className="agx-side-panel">
            <div className="agx-side-head">
              <span className="agx-kicker">就绪检查</span>
              <strong className="agx-mono">
                {checks.filter((check) => check.pass).length}/{checks.length}
              </strong>
            </div>
            {checks.map((check) => (
              <div className={'agx-check-row' + (check.pass ? ' is-pass' : '')} key={check.label}>
                <span className="agx-check-mark">{check.pass && <Check size={10} />}</span>
                {check.label}
              </div>
            ))}
          </section>

          <section className="agx-side-panel">
            <div className="agx-side-head">
              <span className="agx-kicker">下一步</span>
              <MessageSquareText size={14} />
            </div>
            <p className="agx-side-copy">
              保存后回到列表，选中这个智能体，写清要做的事就能开始。
            </p>
            <button className="agx-btn" onClick={startChat} disabled={!editingId}>
              <MessageSquareText size={14} />
              用它开始对话
            </button>
            {!editingId && <small className="agx-side-note">先保存一次，才能开始对话。</small>}
          </section>

          <section className="agx-side-panel agx-side-panel--quiet">
            <span className="agx-kicker">{internal ? '落盘与接口' : '保存后'}</span>
            {internal ? (
              <>
                <p className="agx-side-copy">
                  存储 <code>data/agents.json</code>（临时文件 + rename 原子写）。字段：名称 / 分类 / 职责 / 系统提示词 / 模型 / 温度 / 知识 / 工具。
                </p>
                <p className="agx-side-note">
                  <BookOpen size={12} /> 知识会进入 system 消息
                  <br />
                  <Wrench size={12} /> 已接入工具会真正读取本地数据
                </p>
              </>
            ) : (
              <>
                <p className="agx-side-copy">
                  保存后，列表卡片与对话会立刻用新的提示词、知识和工具。每次对话都会在「历史 → 运行记录」留一条记录，失败会标出原因并退回积分。
                </p>
                <p className="agx-side-note">
                  <BookOpen size={12} /> 知识会并入本次对话的上下文
                  <br />
                  <Wrench size={12} /> 工具会读取模板库、画布流程与对话里的公开网页
                </p>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}