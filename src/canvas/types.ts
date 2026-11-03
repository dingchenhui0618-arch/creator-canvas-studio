export type FlowNodeKind = 'input' | 'llm' | 'kb' | 'tool' | 'condition' | 'output'

/** 节点在运行中的状态；idle 表示本轮还没跑。 */
export type RunNodeStatus = 'idle' | 'pending' | 'running' | 'done' | 'error' | 'skipped' | 'unsupported'

/** 所有节点共用一个配置对象，按 kind 读取需要的字段；服务端会按 kind 做白名单归一化。 */
export type NodeConfig = {
  text?: string
  model?: string
  temperature?: number
  systemPrompt?: string
  keyword?: string
  contentType?: string
  limit?: number
  toolName?: string
  expression?: string
  format?: 'markdown' | 'text'
}

export type FlowNodeData = {
  kind: FlowNodeKind
  title: string
  description: string
  config: NodeConfig
  status?: RunNodeStatus
  ms?: number
  output?: string
  error?: string
}
