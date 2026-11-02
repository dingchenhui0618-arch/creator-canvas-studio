import type { CSSProperties } from 'react'
import { MoreHorizontal, Sparkles } from 'lucide-react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNodeData } from '../domain/types'
import { NodeIcon, StatusDot } from './ui'

export function CanvasCard({ data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const nodeData = data as CanvasNodeData
  return (
    <div className={`canvas-node canvas-node--${nodeData.kind} ${selected ? 'is-selected' : ''}`} style={{ '--node-accent': nodeData.accent } as CSSProperties}>
      <Handle type="target" position={Position.Left} className="node-handle" />
      <div className="node-topline"><div className="node-label"><span className="node-icon"><NodeIcon icon={nodeData.icon} /></span>{nodeData.label}</div><StatusDot status={nodeData.status} /></div>
      {nodeData.kind === 'asset' && <div className={`node-art node-art--${nodeData.icon === 'text' ? 'text' : nodeData.accent?.replace('#', '')}`}><span>{nodeData.icon === 'text' ? 'Aa' : '杯'}</span></div>}
      {nodeData.kind === 'agent' && <div className="agent-node-mark"><Sparkles size={20} /><span>编排中</span></div>}
      {nodeData.kind === 'output' && <div className="output-node-preview"><div className="preview-bar preview-bar--one" /><div className="preview-bar preview-bar--two" /><div className="preview-copy">A quiet object,<br />a clear story.</div></div>}
      <div className="node-copy"><strong>{nodeData.title}</strong><span>{nodeData.description}</span></div>
      <div className="node-meta"><span>{nodeData.meta}</span><MoreHorizontal size={14} /></div>
      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  )
}
