import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, CircleAlert, Layers3, Plus, Send, Sparkles, Tag, Trash2, Workflow, X } from 'lucide-react'
import type { AgentDefinition, AgentIOField, AgentTestEvent, Page, SkillDefinition, ToolDefinition } from '../domain/types'
import { dshAdapter } from '../runtime/mockAdapter'

const skillCatalog: SkillDefinition[] = [
  { id: 'ecom-visual', name: '电商平台图片基础', category: '图片', description: '按平台规范产出主图、场景图与细节图。', output: '图片 · 1:1 / 3:4' },
  { id: 'layout-edit', name: '排版图片精修', category: '画布', description: '把生成结果整理成可引用的版式画布。', output: '画布 · 节点引用' },
  { id: 'beauty', name: '自然美颜精修', category: '图片', description: '轻量修复人像与产品质感，保留材质细节。', output: '图片 · 原尺寸' },
  { id: 'character', name: '角色设定', category: '文本', description: '统一角色外观、语气与出场方式。', output: '文本 · 结构化设定' },
  { id: 'motion', name: '图片动效', category: '视频', description: '把一张静帧扩写为 3 秒动效。', output: '视频 · 9:16' },
  { id: 'storyboard', name: '短剧策划', category: '文本', description: '拆分镜、台词和节奏。', output: '文本 · 分镜表' },
]

const toolCatalog: ToolDefinition[] = [
  { id: 'assets-read', name: '读取资产库', description: '只读工作区已整理的资产与引用。', adapter: 'DSH Adapter', scope: '只读', state: 'ready' },
  { id: 'canvas-write', name: '写入画布节点', description: '把结果写回画布并建立引用关系。', adapter: 'DSH Adapter', scope: '读写', state: 'ready' },
  { id: 'image-gen', name: '图片生成', description: '调用图像通道生成或编辑图片。', adapter: 'Image Channel', scope: '读写', state: 'planned' },
  { id: 'export-json', name: '导出结构化 JSON', description: '把运行结果导出为可复用配置。', adapter: 'Built-in', scope: '读写', state: 'ready' },
  { id: 'web-read', name: '网页读取', description: '读取公开页面作为创作参考。', adapter: 'Browser', scope: '只读', state: 'planned' },
]

let idSeq = 0
const nextId = (prefix: string) => `${prefix}-${(idSeq += 1)}`

const defaultAgent: AgentDefinition = {
  id: 'agent-visual',
  name: '商品视觉编辑',
  role: '把产品素材整理成详情页视觉方向',
  description: '面向电商运营的视觉编辑智能体：读取商品主图与品牌语气，输出可直接放进画布的首屏构图与延展建议。',
  systemPrompt: '你是一位电商视觉编辑。先阅读引用的商品主图与品牌语气，总结 3 个可执行的视觉方向，再选出最适合春季上新的一条，输出首屏构图说明。\n\n约束：\n- 只使用引用资产中出现的产品信息；\n- 画面描述包含主体、光线、背景与文案位置；\n- 未知信息标记为「待确认」，不要编造卖点。',
  model: 'DSH Adapter · mock',
  temperature: 0.4,
  skills: ['ecom-visual', 'layout-edit'],
  tools: ['assets-read', 'canvas-write', 'export-json'],
  inputs: [
    { id: 'in-1', name: '产品主图', type: 'image', required: true },
    { id: 'in-2', name: '品牌语气', type: 'text', required: true },
  ],
  outputs: [
    { id: 'out-1', name: '首屏构图', type: 'image', required: true },
    { id: 'out-2', name: '视觉方向说明', type: 'text', required: false },
  ],
  status: 'draft',
  version: 'v0.3',
  updatedAt: '刚刚',
  tone: 'violet',
}

type StepId = 'identity' | 'prompt' | 'skills' | 'tools' | 'io'

const steps: { id: StepId; title: string; hint: string }[] = [
  { id: 'identity', title: '基本信息', hint: '名称、角色与语气' },
  { id: 'prompt', title: '系统提示词', hint: '行为边界与输出约束' },
  { id: 'skills', title: '技能', hint: '可复用的场景步骤' },
  { id: 'tools', title: '工具', hint: '适配器暴露的能力' },
  { id: 'io', title: '输入输出', hint: '运行契约' },
]

type AgentEditorPageProps = {
  onBack: () => void
  onNavigate: (page: Page) => void
  onToast: (message: string) => void
  agent?: { name: string; description: string }
}

export default function AgentEditorPage({ onBack, onNavigate, onToast, agent: seed }: AgentEditorPageProps) {
  const [agent, setAgent] = useState<AgentDefinition>(seed ? { ...defaultAgent, name: seed.name, description: seed.description, role: seed.description } : defaultAgent)
  const [step, setStep] = useState<StepId>('identity')
  const [messages, setMessages] = useState<AgentTestEvent[]>([])
  const [draft, setDraft] = useState('帮我用主图做一版春日上新首屏')
  const [busy, setBusy] = useState(false)
  const [savedAt, setSavedAt] = useState('未保存')

  const patch = (value: Partial<AgentDefinition>) => setAgent((current) => ({ ...current, ...value }))

  const checks = useMemo(() => {
    const selectedSkills = skillCatalog.filter((skill) => agent.skills.includes(skill.id))
    return [
      { label: '名称与角色已填写', pass: Boolean(agent.name.trim() && agent.role.trim()) },
      { label: '系统提示词 ≥ 40 字', pass: agent.systemPrompt.trim().length >= 40 },
      { label: '已选择至少 1 个技能', pass: selectedSkills.length > 0 },
      { label: '输出定义包含图片或文本', pass: agent.outputs.length > 0 },
      { label: '输入定义完整', pass: agent.inputs.length > 0 && agent.inputs.every((field) => field.name.trim()) },
    ]
  }, [agent])
  const ready = checks.every((check) => check.pass)
  const selectedSkills = skillCatalog.filter((skill) => agent.skills.includes(skill.id))

  const toggleSkill = (id: string) => {
    patch({ skills: agent.skills.includes(id) ? agent.skills.filter((item) => item !== id) : [...agent.skills, id] })
  }

  const toggleTool = (id: string) => {
    patch({ tools: agent.tools.includes(id) ? agent.tools.filter((item) => item !== id) : [...agent.tools, id] })
  }

  const updateField = (group: 'inputs' | 'outputs', id: string, value: Partial<AgentIOField>) => {
    patch({ [group]: agent[group].map((field) => (field.id === id ? { ...field, ...value } : field)) } as Partial<AgentDefinition>)
  }

  const addField = (group: 'inputs' | 'outputs') => {
    const field: AgentIOField = { id: nextId(group), name: group === 'inputs' ? '新的输入' : '新的输出', type: 'text', required: false }
    patch({ [group]: [...agent[group], field] } as Partial<AgentDefinition>)
  }

  const removeField = (group: 'inputs' | 'outputs', id: string) => {
    patch({ [group]: agent[group].filter((field) => field.id !== id) } as Partial<AgentDefinition>)
  }

  const saveDraft = () => {
    setSavedAt('刚刚')
    onToast('草稿已保存到本地演示状态')
  }

  const publish = () => {
    if (!ready) {
      onToast('还有检查项没有完成，先补齐再发布')
      return
    }
    patch({ status: 'published', version: agent.version.replace(/v(\d+)\.(\d+)/, (_, major, minor) => `v${major}.${Number(minor) + 1}`) })
    onToast('已发布新版本，可以被画布引用')
  }

  const runTest = async () => {
    if (busy || !draft.trim()) return
    setBusy(true)
    const text = draft.trim()
    setMessages((current) => [...current, { id: nextId('user'), kind: 'user', label: text }])
    try {
      await dshAdapter.testAgent(agent, text, (event) => setMessages((current) => [...current, event]))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page page--editor">
      <div className="page-heading page-heading--editor">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" />创作能力 / 智能体编辑器</div>
          <h1>{agent.name || '未命名智能体'}</h1>
          <p>{agent.role || '给这个智能体一个清晰的角色，它才能在画布里稳定复用。'}</p>
        </div>
        <div className="heading-actions">
          <button className="button button--ghost" onClick={onBack}><ArrowLeft size={16} />返回列表</button>
          <button className="button button--ghost" onClick={saveDraft}><Check size={15} />保存草稿</button>
          <button className="button button--primary" onClick={publish} disabled={!ready}>{agent.status === 'published' ? '发布新版本' : '发布版本'}</button>
        </div>
      </div>

      <div className="editor-layout">
        <aside className="editor-steps">
          <div className="editor-steps-head">
            <span className="panel-kicker">配置步骤</span>
            <span className={`agent-status agent-status--${agent.status === 'published' ? 'published' : 'draft'}`}>{agent.status === 'published' ? '已发布' : '草稿'}</span>
          </div>
          <nav aria-label="配置步骤">
            {steps.map((item, index) => {
              const done = item.id === 'identity' ? Boolean(agent.name.trim()) : item.id === 'prompt' ? agent.systemPrompt.trim().length >= 40 : item.id === 'skills' ? selectedSkills.length > 0 : item.id === 'tools' ? agent.tools.length > 0 : agent.inputs.length > 0 && agent.outputs.length > 0
              return (
                <button key={item.id} className={`editor-step ${step === item.id ? 'is-active' : ''} ${done ? 'is-done' : ''}`} onClick={() => setStep(item.id)}>
                  <span className="editor-step-index">{done ? <Check size={11} /> : String(index + 1).padStart(2, '0')}</span>
                  <span><strong>{item.title}</strong><small>{item.hint}</small></span>
                </button>
              )
            })}
          </nav>
          <div className="adapter-card">
            <div className="adapter-card-head"><span className="adapter-mark">D</span><div><strong>DSH Adapter</strong><span>演示模式 · 可替换</span></div></div>
            <p>运行时通过适配器接入，画布与智能体定义不绑定具体实现。</p>
            <span className="connection-state">已连接</span>
          </div>
        </aside>

        <section className="editor-main" aria-label="智能体配置">
          <header className="editor-panel-head">
            <div>
              <span className="panel-kicker">第 {steps.findIndex((item) => item.id === step) + 1} / {steps.length} 步</span>
              <h2>{steps.find((item) => item.id === step)?.title}</h2>
            </div>
            <span className="mono">{agent.version} · 更新于 {savedAt === '未保存' ? agent.updatedAt : savedAt}</span>
          </header>

          {step === 'identity' && (
            <div className="editor-form">
              <label className="field">
                <span>智能体名称</span>
                <input value={agent.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：商品视觉编辑" />
              </label>
              <label className="field">
                <span>一句话角色</span>
                <input value={agent.role} onChange={(event) => patch({ role: event.target.value })} placeholder="它替你做的判断是什么" />
              </label>
              <label className="field">
                <span>详细描述</span>
                <textarea rows={3} value={agent.description} onChange={(event) => patch({ description: event.target.value })} />
              </label>
              <div className="field">
                <span>标识色调</span>
                <div className="tone-row">
                  {(['violet', 'blue', 'sage'] as const).map((tone) => (
                    <button key={tone} className={`tone-swatch tone-swatch--${tone} ${agent.tone === tone ? 'is-active' : ''}`} onClick={() => patch({ tone })} aria-label={`色调 ${tone}`}><Check size={13} /></button>
                  ))}
                </div>
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>运行适配器</span>
                  <button className="select-like is-wide">{agent.model}<ChevronDown size={14} /></button>
                  <small>只有 mock 适配器可用，真实端点接入后替换 </small>
                </label>
                <label className="field">
                  <span>温度</span>
                  <div className="slider-row">
                    <input type="range" min={0} max={1} step={0.1} value={agent.temperature} onChange={(event) => patch({ temperature: Number(event.target.value) })} />
                    <strong className="mono">{agent.temperature.toFixed(1)}</strong>
                  </div>
                  <small>越高越发散，视觉类建议 0.3–0.5</small>
                </label>
              </div>
            </div>
          )}

          {step === 'prompt' && (
            <div className="editor-form">
              <label className="field">
                <span>系统提示词</span>
                <textarea className="prompt-area" rows={12} value={agent.systemPrompt} onChange={(event) => patch({ systemPrompt: event.target.value })} />
                <small>{agent.systemPrompt.trim().length} 字 · 建议写清目标、禁止事项和未知信息的处理方式</small>
              </label>
              <div className="field">
                <span>可插入变量</span>
                <div className="chip-row">
                  {['{{product_image}}', '{{brand_tone}}', '{{canvas_refs}}', '{{last_run}}'].map((token) => (
                    <button key={token} className="chip chip--mono" onClick={() => patch({ systemPrompt: `${agent.systemPrompt}${agent.systemPrompt.endsWith('\n') ? '' : '\n'}${token}` })}>{token}</button>
                  ))}
                </div>
                <small>变量在运行时由适配器注入；当前版本只做演示替换。</small>
              </div>
            </div>
          )}

          {step === 'skills' && (
            <div className="editor-form">
              <div className="field-label">已选 {selectedSkills.length} 个技能</div>
              <div className="skill-grid">
                {skillCatalog.map((skill) => {
                  const active = agent.skills.includes(skill.id)
                  return (
                    <button key={skill.id} className={`skill-option ${active ? 'is-active' : ''}`} onClick={() => toggleSkill(skill.id)}>
                      <div className="skill-option-head"><span className="skill-category">{skill.category}</span>{active && <Check size={14} />}</div>
                      <strong>{skill.name}</strong>
                      <p>{skill.description}</p>
                      <span className="skill-output"><Tag size={11} />{skill.output}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'tools' && (
            <div className="editor-form">
              <div className="field-label">当前工作区可用的工具</div>
              <div className="tool-table">
                {toolCatalog.map((tool) => {
                  const active = agent.tools.includes(tool.id)
                  const planned = tool.state === 'planned'
                  return (
                    <div className={`tool-row-item ${active ? 'is-active' : ''} ${planned ? 'is-planned' : ''}`} key={tool.id}>
                      <div className="tool-row-main">
                        <strong>{tool.name}</strong>
                        <span>{tool.description}</span>
                      </div>
                      <span className="tool-scope">{tool.scope}</span>
                      <span className="tool-adapter">{tool.adapter}</span>
                      {planned ? <span className="tool-planned">待接入</span> : <button className={`switch ${active ? 'is-on' : ''}`} onClick={() => toggleTool(tool.id)} aria-label={`切换 ${tool.name}`}><span /></button>}
                    </div>
                  )
                })}
              </div>
              <p className="form-note"><CircleAlert size={13} />工具权限属于运行时配置，前端只声明意向，不持有密钥。</p>
            </div>
          )}

          {step === 'io' && (
            <div className="editor-form">
              {(['inputs', 'outputs'] as const).map((group) => (
                <div className="io-block" key={group}>
                  <div className="io-block-head">
                    <div><span className="field-label">{group === 'inputs' ? '输入定义' : '输出定义'}</span><small>{group === 'inputs' ? '运行时从画布节点注入' : '运行结束后写回画布'}</small></div>
                    <button className="button button--ghost" onClick={() => addField(group)}><Plus size={14} />添加</button>
                  </div>
                  <div className="io-table">
                    <div className="io-row io-row--head"><span>字段名</span><span>类型</span><span>必填</span><span /></div>
                    {agent[group].map((field) => (
                      <div className="io-row" key={field.id}>
                        <input value={field.name} onChange={(event) => updateField(group, field.id, { name: event.target.value })} />
                        <button className="select-like" onClick={() => updateField(group, field.id, { type: field.type === 'image' ? 'text' : field.type === 'text' ? 'json' : field.type === 'json' ? 'url' : 'image' })}>{field.type}<ChevronDown size={12} /></button>
                        <button className={`switch ${field.required ? 'is-on' : ''}`} onClick={() => updateField(group, field.id, { required: !field.required })} aria-label="切换必填"><span /></button>
                        <button className="icon-button" onClick={() => removeField(group, field.id)} aria-label="删除字段"><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <footer className="editor-main-foot">
            <button className="button button--ghost" onClick={() => setStep(step === 'identity' ? 'identity' : steps[Math.max(0, steps.findIndex((item) => item.id === step) - 1)].id)}>上一步</button>
            <button className="button button--primary" onClick={() => setStep(steps[Math.min(steps.length - 1, steps.findIndex((item) => item.id === step) + 1)].id)}>下一步 <ArrowUpRight size={14} /></button>
          </footer>
        </section>

        <aside className="editor-side">
          <section className="test-panel">
            <div className="test-panel-head">
              <div><span className="panel-kicker">试运行</span><h3>对话中验证</h3></div>
              <span className="run-status run-status--success">MOCK</span>
            </div>
            <div className="test-messages">
              {messages.length === 0 && (
                <div className="test-empty">
                  <Sparkles size={18} />
                  <p>用一句话描述任务，看看它是否按你的方式工作。</p>
                  <div className="suggest-row">
                    {['用主图做一版首屏', '这组素材适合什么语气', '给我三个方向'].map((text) => <button key={text} className="chip" onClick={() => setDraft(text)}>{text}</button>)}
                  </div>
                </div>
              )}
              {messages.map((message) => (
                <div className={`test-message ${message.kind === 'user' ? 'test-message--user' : message.kind === 'reply' ? 'test-message--assistant' : 'test-message--step'}`} key={message.id}>
                  {message.kind === 'step' ? <span className="test-step-dot" /> : null}
                  <div>
                    <p>{message.label}</p>
                    {message.detail && <small>{message.detail}</small>}
                  </div>
                </div>
              ))}
              {busy && <div className="test-message test-message--step"><span className="test-step-dot is-live" /><div><p>运行时执行中…</p></div></div>}
            </div>
            <div className="test-input">
              <textarea rows={2} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="描述一个任务，按 ⌘/Ctrl + Enter 发送" />
              <button className="button button--primary" onClick={runTest} disabled={busy}><Send size={14} />发送</button>
            </div>
          </section>

          <section className="readiness-panel">
            <div className="readiness-head"><span className="panel-kicker">就绪检查</span><strong>{checks.filter((check) => check.pass).length}/{checks.length}</strong></div>
            <div className="readiness-list">
              {checks.map((check) => (
                <div className={`readiness-row ${check.pass ? 'is-pass' : ''}`} key={check.label}>
                  <span className="readiness-mark">{check.pass ? <Check size={11} /> : <X size={11} />}</span>
                  {check.label}
                </div>
              ))}
            </div>
            <button className="button button--ghost is-block" onClick={() => onNavigate('canvas')} disabled={!ready}><Workflow size={15} />放入画布</button>
            <p className="form-note"><Layers3 size={13} />放入画布后，这个版本会作为一个智能体节点出现。</p>
          </section>
        </aside>
      </div>
    </div>
  )
}
