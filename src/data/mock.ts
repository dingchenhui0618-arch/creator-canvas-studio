import { FileImage, FileText, Film, Grid2X2, Layers3 } from 'lucide-react'
import type { Edge, Node } from '@xyflow/react'
import type { CanvasNodeData, Page } from '../domain/types'

export const pageLabels: Record<Page, string> = {
  overview: '工作台',
  agents: '智能体',
  'agent-editor': '智能体编辑器',
  canvas: '资产画布',
  assets: '资产库',
  runs: '运行记录',
  settings: '设置',
}

export const initialNodes: Node<CanvasNodeData>[] = [
  {
    id: 'asset-product',
    type: 'asset',
    position: { x: 96, y: 178 },
    data: { kind: 'asset', label: '参考资产', title: '陶瓷杯 · 主图', description: '1 张图片 · 2048 × 2048', status: 'ready', meta: '商品素材', icon: 'image', accent: '#c77d5a' },
  },
  {
    id: 'asset-copy',
    type: 'asset',
    position: { x: 96, y: 396 },
    data: { kind: 'asset', label: '输入文案', title: '品牌卖点与语气', description: '文本 · 342 字', status: 'ready', meta: '品牌资产', icon: 'text', accent: '#7b88b8' },
  },
  {
    id: 'agent-layout',
    type: 'agent',
    position: { x: 430, y: 258 },
    data: { kind: 'agent', label: '创作智能体', title: '商品视觉编辑', description: '整理输入资产，输出详情页视觉方向', status: 'running', meta: 'DSH Adapter · Mock', icon: 'bot', accent: '#6b62d9' },
  },
  {
    id: 'output-board',
    type: 'output',
    position: { x: 788, y: 258 },
    data: { kind: 'output', label: '生成资产', title: '详情页首屏构图', description: '等待智能体完成布局建议', status: 'success', meta: 'PNG · 1:1', icon: 'image', accent: '#d9a952' },
  },
]
export const initialEdges: Edge[] = [
  { id: 'e-product-agent', source: 'asset-product', target: 'agent-layout', animated: true },
  { id: 'e-copy-agent', source: 'asset-copy', target: 'agent-layout', animated: true },
  { id: 'e-agent-output', source: 'agent-layout', target: 'output-board', animated: true },
]
export const assets = [
  { id: 'asset-1', name: '陶瓷杯 · 主图', type: '图片', detail: '2048 × 2048 · 2.4 MB', tone: 'terracotta', icon: FileImage, tag: '商品素材' },
  { id: 'asset-2', name: '品牌卖点与语气', type: '文本', detail: '342 字 · 4 个标签', tone: 'indigo', icon: FileText, tag: '品牌资产' },
  { id: 'asset-3', name: '春日餐桌场景', type: '图片', detail: '1536 × 2048 · 1.8 MB', tone: 'sage', icon: FileImage, tag: '场景参考' },
  { id: 'asset-4', name: '15 秒产品脚本', type: '文本', detail: '短视频 · 8 个镜头', tone: 'gold', icon: Film, tag: '内容脚本' },
  { id: 'asset-5', name: '品牌色板', type: '图片', detail: 'PNG · 6 个色值', tone: 'blue', icon: Layers3, tag: '设计规范' },
  { id: 'asset-6', name: '详情页结构草图', type: '图片', detail: 'Figma 导出 · 6 个区块', tone: 'rose', icon: Grid2X2, tag: '页面结构' },
]
export const agents = [
  { name: '商品视觉编辑', description: '把产品素材整理成详情页视觉方向和首屏构图。', status: '运行中', tone: 'violet', skills: ['图片编辑', '电商场景'], updated: '刚刚' },
  { name: '品牌内容导演', description: '根据品牌语气生成社媒内容、分镜和延展素材。', status: '草稿', tone: 'blue', skills: ['文案', '短视频'], updated: '昨天' },
  { name: '灵感整理助手', description: '从碎片素材中提炼主题，形成可复用的创作资产。', status: '已发布', tone: 'sage', skills: ['资产整理', '提示词'], updated: '10 月 30 日' },
]
export const runs = [
  { name: '商品详情页首屏', agent: '商品视觉编辑', status: '成功', duration: '01:24', time: '刚刚', tone: 'success' },
  { name: '春日上新社媒套图', agent: '品牌内容导演', status: '运行中', duration: '00:38', time: '8 分钟前', tone: 'running' },
  { name: '新品卖点整理', agent: '灵感整理助手', status: '失败', duration: '00:12', time: '昨天', tone: 'error' },
]

export type AssetItem = (typeof assets)[number]
