import type { Edge, Node } from '@xyflow/react'
import type { FlowNodeData } from './types'

/**
 * 分层自动布局：按最长路径把节点分到不同列，同列纵向居中。
 * 只依赖节点与边，不依赖 React Flow 实例，便于测试。
 */
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

  const columns = new Map<number, Node<FlowNodeData>[]>()
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0
    const bucket = columns.get(index) ?? []
    bucket.push(node)
    columns.set(index, bucket)
  }

  const columnGap = 280
  const rowGap = 172
  const nextPosition = new Map<string, { x: number; y: number }>()
  for (const [index, bucket] of columns) {
    bucket.forEach((node, row) => {
      nextPosition.set(node.id, {
        x: 44 + index * columnGap,
        y: 210 + (row - (bucket.length - 1) / 2) * rowGap,
      })
    })
  }

  return nodes.map((node) => ({ ...node, position: nextPosition.get(node.id) ?? node.position }))
}
