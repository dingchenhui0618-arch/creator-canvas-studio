import { Grid2X2 } from 'lucide-react'

export type Page =
  | 'login'
  | 'overview'
  | 'projects'
  | 'agents'
  | 'agent-editor'
  | 'canvas'
  | 'runs'
  | 'settings'
  | 'radar'
  | 'templates'
  | 'review'

/** 面包屑用的页面名。只有真实存在的页面才在这里，删掉的入口不留空标签。 */
export const pageLabels: Record<Page, string> = {
  login: '登录',
  overview: '工作台',
  projects: '作品',
  agents: '智能体',
  'agent-editor': '智能体编辑器',
  canvas: '画布',
  runs: '运行记录',
  settings: '设置',
  radar: '爆款雷达',
  templates: '模板库',
  review: '视觉评审',
}

export type NodeKind = 'asset' | 'agent' | 'output'

export type IconComponent = typeof Grid2X2

export type NodeStatus = 'ready' | 'running' | 'success'

export type CanvasNodeData = {
  kind: NodeKind
  label: string
  title: string
  description: string
  status: NodeStatus
  meta?: string
  icon?: 'image' | 'text' | 'bot'
  accent?: string
  artifactId?: string
}

/** 一次性能力模板：智能体在运行时可调用的固定步骤与输出类型。 */
export type SkillDefinition = {
  id: string
  name: string
  category: '图片' | '视频' | '文本' | '画布'
  description: string
  output: string
}

/** 适配器暴露给智能体的工具。未接入真实服务时只有演示能力。 */
export type ToolDefinition = {
  id: string
  name: string
  description: string
  adapter: string
  scope: '只读' | '读写'
  state: 'ready' | 'planned'
}

export type AgentIOField = {
  id: string
  name: string
  type: 'image' | 'text' | 'json' | 'url'
  required: boolean
}

export type AgentStatus = 'draft' | 'published'

/** 产品域模型：智能体定义与画布、运行、产物解耦。 */
export type AgentDefinition = {
  id: string
  name: string
  role: string
  description: string
  systemPrompt: string
  model: string
  temperature: number
  skills: string[]
  tools: string[]
  inputs: AgentIOField[]
  outputs: AgentIOField[]
  status: AgentStatus
  version: string
  updatedAt: string
  tone: 'violet' | 'blue' | 'sage'
}

export type RunEventType =
  | 'queued'
  | 'started'
  | 'node-started'
  | 'streaming'
  | 'node-completed'
  | 'completed'
  | 'failed'

export type RunEvent = {
  id: string
  type: RunEventType
  label: string
  detail?: string
  nodeId?: string
  progress: number
}

export type Artifact = {
  id: string
  name: string
  kind: 'image' | 'text' | 'json'
  detail: string
  nodeId?: string
}

export type AgentTestEvent = {
  id: string
  kind: 'step' | 'reply' | 'user'
  label: string
  detail?: string
}
