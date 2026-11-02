import type { AgentDefinition, AgentTestEvent, Artifact, CanvasNodeData, RunEvent } from '../domain/types'

export type CanvasSnapshot = {
  versionId: string
  nodes: { id: string; kind: string; title: string; data: CanvasNodeData }[]
  edges: { id: string; source: string; target: string }[]
}

export type RunResult = {
  runId: string
  artifacts: Artifact[]
  durationMs: number
}

export type AdapterCapability = {
  id: string
  label: string
  state: 'ready' | 'planned'
  detail: string
}

/**
 * 运行时边界：产品域只认这个接口，DeepSeek Harness、直连模型或队列 worker
 * 都作为它的一个实现接入，因此画布与智能体定义不会绑定到某一家运行时。
 */
export type RuntimeAdapter = {
  id: string
  label: string
  mode: 'mock' | 'live'
  capabilities: AdapterCapability[]
  runCanvas(snapshot: CanvasSnapshot, onEvent: (event: RunEvent) => void): Promise<RunResult>
  testAgent(agent: AgentDefinition, message: string, onEvent: (event: AgentTestEvent) => void): Promise<{ reply: string }>
  cancel(): void
}
