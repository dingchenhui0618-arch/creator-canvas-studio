import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CSSProperties } from 'react'
import { NODE_META } from './catalog'
import { nodeRuntimeLabel } from './serialize'
import type { FlowNodeData } from './types'

function summary(data: FlowNodeData): string {
  switch (data.kind) {
    case 'input':
      return (data.config.text ?? '').slice(0, 18) || '空输入'
    case 'llm':
      return (data.config.model ?? '未选模型') + ' · T' + (data.config.temperature ?? 0.4)
    case 'kb':
      return (data.config.contentType || '全部类型') + ' · 取 ' + (data.config.limit ?? 3) + ' 条'
    case 'tool':
      return data.config.toolName ?? '未选工具'
    case 'condition':
      return data.config.expression ?? '未设置表达式'
    case 'output':
      return data.config.format === 'text' ? '纯文本' : 'Markdown'
    default:
      return ''
  }
}

export function FlowNodeCard({ data, selected, isConnectable }: NodeProps<Node<FlowNodeData>>) {
  const meta = NODE_META[data.kind]
  const Icon = meta.icon
  const status = data.status ?? 'idle'
  const targetCount = meta.targets.length
  const sourceCount = meta.sources.length

  return (
    <div className={`cv-node ${selected ? 'is-selected' : ''}`} data-status={status}>
      {meta.targets.map((handle, index) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
          className="cv-handle"
          style={{ top: targetCount === 1 ? '50%' : `${38 + index * 28}%` } as CSSProperties}
          title={handle.label}
        />
      ))}

      <div className="cv-node-top">
        <span className="cv-node-type">{meta.mono}</span>
        <span className={`cv-node-state is-${status}`}>
          <span className="cv-dot" data-status={status} />
          {nodeRuntimeLabel(status)}
        </span>
      </div>

      <div className="cv-node-heading">
        <span className="cv-node-icon"><Icon size={14} strokeWidth={1.5} /></span>
        <strong>{data.title}</strong>
      </div>
      <p className="cv-node-desc">{data.description || meta.hint}</p>

      <div className="cv-node-foot">
        <span className="cv-node-summary" title={summary(data)}>{summary(data)}</span>
        <span className="cv-node-ms">{data.ms !== undefined ? data.ms + 'ms' : '—'}</span>
      </div>

      {meta.sources.map((handle, index) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          className="cv-handle"
          style={{ top: sourceCount === 1 ? '50%' : `${38 + index * 24}%` } as CSSProperties}
          title={handle.label}
        />
      ))}
      {data.kind === 'condition' && (
        <span className="cv-handle-tags" aria-hidden>
          <span>true</span>
          <span>false</span>
        </span>
      )}
    </div>
  )
}
