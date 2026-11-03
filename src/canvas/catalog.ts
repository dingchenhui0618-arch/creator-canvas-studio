import {
  ArrowUpRight,
  BookOpen,
  Cpu,
  GitBranch,
  ScanEye,
  TextCursorInput,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { FlowNodeKind, NodeConfig } from './types'

export type HandleMeta = { id: string; label: string }

export type NodeMeta = {
  kind: FlowNodeKind
  label: string
  mono: string
  hint: string
  icon: LucideIcon
  targets: HandleMeta[]
  sources: HandleMeta[]
  defaultTitle: string
  defaultDescription: string
  defaultConfig: NodeConfig
}

// 借鉴 Langflow / Dify 的节点分类（输入 / 处理 / 输出），字段结构为自建，未复制其源码。
export const NODE_META: Record<FlowNodeKind, NodeMeta> = {
  input: {
    kind: 'input',
    label: '输入',
    mono: 'INPUT',
    hint: '把文本或素材说明送进流程',
    icon: TextCursorInput,
    targets: [],
    sources: [{ id: 'out', label: 'out' }],
    defaultTitle: '传播素材与目标',
    defaultDescription: '写清这次要处理的文案、画面与目标人群',
    defaultConfig: { text: '春日上新的陶瓷杯主图，想突出手作质感和晨间餐桌氛围，目标人群是 25-35 岁的都市女性。' },
  },
  llm: {
    kind: 'llm',
    label: '大模型',
    mono: 'LLM',
    hint: '调用本地模型，prompt 与 context 分开接入',
    icon: Cpu,
    targets: [
      { id: 'prompt', label: 'prompt · 主体文本' },
      { id: 'context', label: 'context · 知识库上下文' },
    ],
    sources: [{ id: 'out', label: 'out' }],
    defaultTitle: '创作建议生成',
    defaultDescription: '结合上游输入和知识库上下文，生成可执行建议',
    defaultConfig: {
      model: 'gpt-6.1-sol',
      temperature: 0.4,
      systemPrompt: '你是 VisionQA 的内容与视觉编导。结合上游素材与知识库上下文，给出具体、可执行的视觉与文案建议，分条列出，不要空泛。',
    },
  },
  kb: {
    kind: 'kb',
    label: '知识库',
    mono: 'KB',
    hint: '读取模板库，作为下游模型的上下文',
    icon: BookOpen,
    targets: [{ id: 'in', label: 'query · 可选查询来源' }],
    sources: [{ id: 'out', label: 'out' }],
    defaultTitle: '模板库检索',
    defaultDescription: '按关键词与内容类型取模板，做结构参考',
    defaultConfig: { keyword: '', contentType: '', limit: 3 },
  },
  tool: {
    kind: 'tool',
    label: '工具',
    mono: 'TOOL',
    hint: '执行服务端注册的内置工具',
    icon: Wrench,
    targets: [{ id: 'in', label: 'arg · 可选参数' }],
    sources: [{ id: 'out', label: 'out' }],
    defaultTitle: '模板库统计',
    defaultDescription: '验证知识库与运行链路',
    defaultConfig: { toolName: 'templates.stats' },
  },
  condition: {
    kind: 'condition',
    label: '条件',
    mono: 'IF',
    hint: '命中走 true 分支，否则走 false 分支',
    icon: GitBranch,
    targets: [{ id: 'in', label: 'in' }],
    sources: [
      { id: 'true', label: 'true' },
      { id: 'false', label: 'false' },
    ],
    defaultTitle: '条件分支',
    defaultDescription: '用简单表达式判断是否进入下一步',
    defaultConfig: { expression: 'contains(upstream, "杯")' },
  },
  review: {
    kind: 'review',
    label: '视觉评审',
    mono: 'REVIEW',
    hint: '调用 VisionQA 评审服务或本地视觉模型',
    icon: ScanEye,
    targets: [{ id: 'in', label: 'in' }],
    sources: [{ id: 'out', label: 'out' }],
    defaultTitle: '品牌一致性评审',
    defaultDescription: '对一帧画面给出 verdict / 观察 / 修正建议',
    defaultConfig: { profile: 'brand', image: '' },
  },
  output: {
    kind: 'output',
    label: '输出',
    mono: 'OUTPUT',
    hint: '汇总上游文本，形成本次运行的产物',
    icon: ArrowUpRight,
    targets: [{ id: 'in', label: 'in' }],
    sources: [],
    defaultTitle: '流程输出',
    defaultDescription: '按拓扑序汇总最终可交付内容',
    defaultConfig: { format: 'markdown' },
  },
}

export const PALETTE_GROUPS: { label: string; kinds: FlowNodeKind[] }[] = [
  { label: '输入', kinds: ['input', 'kb'] },
  { label: '处理', kinds: ['llm', 'tool', 'condition'] },
  { label: '输出与评审', kinds: ['review', 'output'] },
]

export const MODEL_OPTIONS = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.1-terra', 'tokenrouter-agent/grok-4.6']

export const TOOL_OPTIONS = [
  { id: 'templates.stats', label: '模板库统计' },
  { id: 'templates.search', label: '模板检索' },
  { id: 'clock', label: '当前时间' },
]

export const REVIEW_PROFILE_OPTIONS = [
  { id: 'brand', label: '品牌一致性' },
  { id: 'composition', label: '构图与主体' },
  { id: 'copy', label: '文案与卖点' },
  { id: 'a11y', label: '可读性与无障碍' },
]

export const CONTENT_TYPE_OPTIONS = ['口播干货', '剧情演绎', '种草分享', '混剪卡点']

export const STATUS_TEXT: Record<string, string> = {
  idle: '待运行',
  pending: '排队中',
  running: '运行中',
  done: '完成',
  error: '失败',
  skipped: '已跳过',
  unsupported: '不支持',
}
