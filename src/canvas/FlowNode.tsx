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
      // 卡片上不露模型标识：选了就写「已选模型」，具体是哪个在检查器里看产品名称
      return (data.config.model ? '已选模型' : '默认模型') + ' · T' + (data.config.temperature ?? 0.4)
    case 'kb':
      return (data.config.contentType || '全部类型') + ' · 取 ' + (data.config.limit ?? 3) + ' 条'
    case 'tool':
      return data.config.toolName ?? '未选工具'
    case 'condition':
      return data.config.expression ?? '未设置表达式'
    case 'image':
      return (data.config.ratio || '9:16') + ' · ' + (data.config.model ? '已选模型' : '默认模型')
    case 'video':
      return (data.config.ratio || '9:16') + ' · ' + (data.config.duration ?? 4) + ' 秒 · ' + (data.config.resolution || '720p')
    case 'review':
      return ({ brand: '品牌一致性', composition: '构图与主体', copy: '文案与卖点', a11y: '可读性与无障碍' } as Record<string, string>)[data.config.profile || 'brand'] || '品牌一致性'
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

      {/* 出图 / 出视频节点跑完就直接把结果贴在卡片上：不用点开抽屉才知道画成了什么样 */}
      {data.imageUrl ? <img className="cv-node-thumb" src={data.imageUrl} alt="出图结果" loading="lazy" /> : null}
      {data.videoUrl ? <video className="cv-node-thumb" src={data.videoUrl} muted playsInline preload="metadata" aria-label="出视频结果" /> : null}

      <div className="cv-node-foot">
        <span className="cv-node-summary" title={summary(data)}>{summary(data)}</span>
        <span className="cv-node-ms">{status === 'running' && data.progress ? data.progress : data.ms !== undefined ? data.ms + 'ms' : '—'}</span>
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
