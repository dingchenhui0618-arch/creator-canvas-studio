import type { AgentDefinition, AgentTestEvent, Artifact, RunEvent } from '../domain/types'
import type { AdapterCapability, CanvasSnapshot, RunResult, RuntimeAdapter } from './types'

const capabilities: AdapterCapability[] = [
  { id: 'stream', label: '流式运行事件', state: 'ready', detail: '按节点推送 queued / started / completed' },
  { id: 'structured', label: '结构化输出', state: 'ready', detail: 'Artifact 与节点引用保持一致' },
  { id: 'tools', label: '外部工具调用', state: 'planned', detail: '等待 DSH 工具协议' },
  { id: 'live', label: '真实模型连接', state: 'planned', detail: '需要真实 Harness 端点与密钥' },
]

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

let cancelled = false
let sequence = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1)}`

async function runCanvas(snapshot: CanvasSnapshot, onEvent: (event: RunEvent) => void): Promise<RunResult> {
  cancelled = false
  const startedAt = Date.now()
  const runId = nextId('run')
  const emit = (event: Omit<RunEvent, 'id'>) => onEvent({ ...event, id: nextId('event') })
  const ordered = [...snapshot.nodes].sort((a, b) => (a.kind === 'asset' ? -1 : 1) - (b.kind === 'asset' ? -1 : 1))

  emit({ type: 'queued', label: `已排队 · 绑定画布版本 ${snapshot.versionId}`, detail: `${snapshot.nodes.length} 个节点 / ${snapshot.edges.length} 条连接`, progress: 4 })
  await wait(420)
  if (cancelled) throw new Error('cancelled')
  emit({ type: 'started', label: '运行时已开始执行', detail: 'DSH Adapter · 演示模式', progress: 10 })

  const artifacts: Artifact[] = []
  let progress = 12
  for (const node of ordered) {
    if (cancelled) throw new Error('cancelled')
    emit({ type: 'node-started', label: `${node.title} 开始执行`, nodeId: node.id, progress })
    await wait(node.kind === 'agent' ? 900 : 520)
    if (cancelled) throw new Error('cancelled')
    progress = Math.min(92, progress + Math.round(64 / ordered.length))
    if (node.kind === 'output') {
      const artifact: Artifact = { id: nextId('artifact'), name: node.title || '生成资产', kind: 'image', detail: 'PNG · 1:1 · 可被下一轮引用', nodeId: node.id }
      artifacts.push(artifact)
      emit({ type: 'node-completed', label: `${node.title} 已生成资产`, detail: artifact.detail, nodeId: node.id, progress })
    } else {
      emit({ type: 'node-completed', label: `${node.title} 已就绪`, nodeId: node.id, progress })
    }
  }

  emit({ type: 'completed', label: `运行完成 · 生成 ${artifacts.length} 个可引用资产`, detail: '产物已写回画布节点', progress: 100 })
  return { runId, artifacts, durationMs: Date.now() - startedAt }
}

async function testAgent(agent: AgentDefinition, message: string, onEvent: (event: AgentTestEvent) => void): Promise<{ reply: string }> {
  const emit = (kind: AgentTestEvent['kind'], label: string, detail?: string) => onEvent({ id: nextId('step'), kind, label, detail })
  const skills = agent.skills.length ? agent.skills : ['未选择 Skill']
  emit('step', '读取引用资产', '陶瓷杯 · 主图 / 品牌卖点与语气')
  await wait(520)
  emit('step', `匹配 Skill · ${skills.join('、')}`, '按场景顺序执行')
  await wait(480)
  emit('step', '调用运行时适配器', 'DSH Adapter · 演示模式')
  await wait(560)
  const reply = `收到「${message}」。我会先把参考素材里的产品信息和语气整理成三条创作方向，再把最合适的一条拆成 ${agent.outputs.map((item) => item.name).join('、') || '画面描述'}。当前运行在演示适配器上，接入真实 DSH 端点后这里会流式返回执行结果。`
  emit('reply', reply)
  return { reply }
}

export const dshAdapter: RuntimeAdapter = {
  id: 'dsh-adapter',
  label: 'DSH Adapter',
  mode: 'mock',
  capabilities,
  runCanvas,
  testAgent,
  cancel() {
    cancelled = true
  },
}
