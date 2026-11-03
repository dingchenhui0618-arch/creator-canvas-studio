import type { Connection, Edge, Node } from '@xyflow/react'
import type { FlowNodeData } from './types'
import type { ApiFlowEdge, ApiFlowNode } from '../api/flows'

export function toFlowNodes(nodes: Node<FlowNodeData>[]): ApiFlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.data.kind,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    data: {
      kind: node.data.kind,
      title: node.data.title,
      description: node.data.description,
      config: node.data.config,
    },
  }))
}

export function toFlowEdges(edges: Edge[]): ApiFlowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }))
}

export function fromFlowNodes(nodes: ApiFlowNode[]): Node<FlowNodeData>[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: { ...node.position },
    data: {
      kind: node.data.kind,
      title: node.data.title,
      description: node.data.description,
      config: { ...node.data.config },
      status: 'idle',
    },
  }))
}

export function fromFlowEdges(edges: ApiFlowEdge[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    label: edge.sourceHandle === 'true' || edge.sourceHandle === 'false' ? edge.sourceHandle : undefined,
  }))
}

/** 从 target 出发能否回到 source——用于阻止形成环。 */
export function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  }
  const stack = [target]
  const seen = new Set<string>()
  while (stack.length) {
    const current = stack.pop() as string
    if (current === source) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) stack.push(next)
  }
  return false
}

/** 连线校验：自环、重复、输入端口单入线、成环。返回 null 表示允许。 */
export function validateConnection(edges: Edge[], connection: Connection): string | null {
  if (!connection.source || !connection.target) return '连线缺少起点或终点'
  if (connection.source === connection.target) return '不能把节点连到自己'
  const targetHandle = connection.targetHandle || 'in'
  if (edges.some((edge) => edge.target === connection.target && (edge.targetHandle || 'in') === targetHandle)) {
    return '这个输入端口已经有入线了；每个输入端口只接一根线'
  }
  if (
    edges.some(
      (edge) =>
        edge.source === connection.source &&
        edge.target === connection.target &&
        (edge.sourceHandle || '') === (connection.sourceHandle || '') &&
        (edge.targetHandle || 'in') === targetHandle,
    )
  ) {
    return '这两个端口已经连过了'
  }
  if (wouldCreateCycle(edges, connection.source, connection.target)) return '这条线会形成环路，换一个下游节点'
  return null
}

export function nodeRuntimeLabel(status?: string): string {
  switch (status) {
    case 'pending':
      return '排队中'
    case 'running':
      return '运行中'
    case 'done':
      return '完成'
    case 'error':
      return '失败'
    case 'skipped':
      return '已跳过'
    case 'unsupported':
      return '不支持'
    default:
      return '待运行'
  }
}
