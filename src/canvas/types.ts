export type FlowNodeKind = 'input' | 'llm' | 'kb' | 'tool' | 'condition' | 'image' | 'review' | 'output'

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
  /** 出图节点：提示词留空时自动用上游文本 */
  prompt?: string
  /** 出图节点：1:1 / 9:16 / 16:9（服务端会归一化，非法值按 9:16） */
  ratio?: string
  /** 评审节点：要看的图；留空 = 用上游出图那张 */
  image?: string
  /** 评审节点：评审角度（brand / composition / copy / a11y） */
  profile?: string
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
  /** 出图节点跑完之后的结果地址：节点卡上直接画缩略图 */
  imageUrl?: string
}
