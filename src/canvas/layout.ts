import type { Edge, Node } from '@xyflow/react'
import type { FlowNodeData } from './types'

/**
 * 分层自动布局：按最长路径把节点分到不同列，同列纵向居中；列数超过一行放得下的就折到下一排。
 * 只依赖节点与边，不依赖 React Flow 实例，便于测试。
 *
 * 为什么要折行（r255）：一条 6 步的流程原样排成一行约 1684px，而 1440 宽屏下画布只有
 * 810px，fitView 只能缩到 0.44——节点标题 15px 被缩成 9.3px，字看不清，「自动布局」
 * 反而把流程变得没法读。折成每排 3 列后同样的 6 步约 844px 宽，缩放在 0.9 上下，
 * 卡片按原尺寸显示。
 */
export const LAYOUT_COLUMN_GAP = 280
export const LAYOUT_ROW_GAP = 172
/** 折行后两排之间的纵向间距：卡片跑完会贴一张缩略图（最高 128px，连边距约 265px 高），280 压不到上一排 */
export const LAYOUT_BAND_GAP = 280
/** 一排最多几列：3 列 844px 宽，1440 与 1280 的窗口都能按接近原尺寸显示 */
export const LAYOUT_COLUMNS_PER_BAND = 3

export function autoLayout(nodes: Node<FlowNodeData>[], edges: Edge[]): Node<FlowNodeData>[] {
  if (!nodes.length) return nodes
  const layer = new Map<string, number>(nodes.map((node) => [node.id, 0]))

  for (let round = 0; round < nodes.length; round += 1) {
    let changed = false
    for (const edge of edges) {
      if (!layer.has(edge.source) || !layer.has(edge.target)) continue
      const next = Math.max(layer.get(edge.target) ?? 0, (layer.get(edge.source) ?? 0) + 1)
      if (next !== layer.get(edge.target)) {
        layer.set(edge.target, next)
        changed = true
      }
    }
    if (!changed) break
  }

  // 层号可能有空洞（比如中间某个节点被删了），先压成 0、1、2… 的连续列号，
  // 否则折行时会按空洞算出一排空列。
  const layers = Array.from(new Set(nodes.map((node) => layer.get(node.id) ?? 0))).sort((a, b) => a - b)
  const dense = new Map<number, number>()
  layers.forEach((value, index) => dense.set(value, index))

  const columns = new Map<number, Node<FlowNodeData>[]>()
  for (const node of nodes) {
    const index = dense.get(layer.get(node.id) ?? 0) ?? 0
    const bucket = columns.get(index) ?? []
    bucket.push(node)
    columns.set(index, bucket)
  }

  const nextPosition = new Map<string, { x: number; y: number }>()
  for (const [index, bucket] of columns) {
    const band = Math.floor(index / LAYOUT_COLUMNS_PER_BAND)
    const column = index % LAYOUT_COLUMNS_PER_BAND
    bucket.forEach((node, row) => {
      nextPosition.set(node.id, {
        x: 44 + column * LAYOUT_COLUMN_GAP,
        y: 210 + band * LAYOUT_BAND_GAP + (row - (bucket.length - 1) / 2) * LAYOUT_ROW_GAP,
      })
    })
  }

  return nodes.map((node) => ({ ...node, position: nextPosition.get(node.id) ?? node.position }))
}
