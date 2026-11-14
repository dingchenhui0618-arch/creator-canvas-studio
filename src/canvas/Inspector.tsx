import { Copy, Trash } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Node } from '@xyflow/react'
import {
  CONTENT_TYPE_OPTIONS,
  NODE_META,
  STATUS_TEXT,
  TOOL_OPTIONS,
} from './catalog'
import { useModelOptions } from '../components/ModelSwitch'
import { useUiMode } from '../api/app'
import type { FlowNodeData, NodeConfig } from './types'

type InspectorProps = {
  node: Node<FlowNodeData> | null
  onPatch: (patch: Partial<FlowNodeData>, key: string) => void
  onConfig: (patch: NodeConfig, key: string) => void
  onDuplicate: () => void
  onDelete: () => void
  /** 历史运行只读查看：字段仍可读，但不接受编辑，也不给复制 / 删除入口（v0.9.106） */
  readOnly?: boolean
  /** 这次运行留下了画布快照：参数取当时那一版，不是当前画布（v0.9.107） */
  runSnapshot?: boolean
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="cv-field">
      <span className="cv-field-label">{label}</span>
      {children}
      {hint && <span className="cv-field-hint">{hint}</span>}
    </label>
  )
}

export function Inspector({ node, onPatch, onConfig, onDuplicate, onDelete, readOnly = false, runSnapshot = false }: InspectorProps) {
  // 模型候选来自服务端 /api/models；hook 必须在提前 return 之前调用
  const modelOptions = useModelOptions()
  const { internal } = useUiMode()

  if (!node) {
    return (
      <aside className="cv-inspector cv-inspector--empty" aria-label="节点检查器">
        <span className="cv-kicker">节点检查器</span>
        <div className="cv-inspector-empty">
          <span className="cv-empty-mark" aria-hidden>+</span>
          <p>{readOnly ? '选中画布上的节点，在这里查看它当时的参数与结果。' : '选中画布上的节点，在这里编辑它的参数。'}</p>
          <p className="cv-muted">{readOnly ? (runSnapshot ? '只读查看：参数取这次运行开始时的画布快照，状态与输出也来自这条运行。' : '只读查看：参数取当前画布，状态与输出来自这条运行。') : '连线规则：每个输入端口只接一根线，不能连成环。'}</p>
        </div>
      </aside>
    )
  }

  const meta = NODE_META[node.data.kind]
  const config = node.data.config
  const status = node.data.status ?? 'idle'

  return (
    <aside className="cv-inspector" aria-label="节点检查器">
      <header className="cv-inspector-head">
        <span className="cv-kicker">节点检查器</span>
        <div className="cv-type-row">
          <span className="cv-type-mono">{meta.mono}</span>
          <div>
            <strong>{meta.label}</strong>
            <span>{meta.hint}</span>
          </div>
          <span className="cv-type-status" data-status={status}>{STATUS_TEXT[status] ?? status}</span>
        </div>
      </header>

      <fieldset className="cv-inspector-body" disabled={readOnly}>
        <section className="cv-section">
          <Field label="节点标题">
            <input
              className="cv-input"
              value={node.data.title}
              onChange={(event) => onPatch({ title: event.target.value }, 'title')}
            />
          </Field>
          <Field label="说明">
            <textarea
              className="cv-textarea cv-textarea--short"
              rows={2}
              value={node.data.description}
              onChange={(event) => onPatch({ description: event.target.value }, 'description')}
            />
          </Field>
        </section>

        <section className="cv-section">
          <div className="cv-section-title">参数</div>

          {node.data.kind === 'input' && (
            <Field label="文本内容" hint="送进流程的主体文本；接在 llm 的 prompt 端口。">
              <textarea
                className="cv-textarea"
                rows={6}
                value={config.text ?? ''}
                onChange={(event) => onConfig({ text: event.target.value }, 'text')}
              />
            </Field>
          )}

          {node.data.kind === 'llm' && (
            <>
              <Field label="模型" hint={internal ? '留空时用账号偏好（顶栏选择），再回退服务端默认；首选失败会走 fallback 链。' : '留空时使用你账号的默认模型；首选不可用时会自动切换备用模型。'}>
                <select
                  className="cv-input"
                  value={config.model ?? ''}
                  onChange={(event) => onConfig({ model: event.target.value }, 'model')}
                >
                  <option value="">{internal ? '跟随账号偏好 / 服务端默认' : '跟随账号默认模型'}</option>
                  {modelOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  {config.model && !modelOptions.some((item) => item.id === config.model) ? (
                    <option value={config.model}>自定义模型</option>
                  ) : null}
                </select>
              </Field>
              <Field label="温度">
                <div className="cv-range-row">
                  <input
                    className="cv-range"
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={config.temperature ?? 0.4}
                    onChange={(event) => onConfig({ temperature: Number(event.target.value) }, 'temperature')}
                  />
                  <output className="cv-range-value">{Number(config.temperature ?? 0.4).toFixed(1)}</output>
                </div>
              </Field>
              <Field label="系统提示词">
                <textarea
                  className="cv-textarea"
                  rows={6}
                  value={config.systemPrompt ?? ''}
                  onChange={(event) => onConfig({ systemPrompt: event.target.value }, 'systemPrompt')}
                />
              </Field>
            </>
          )}

          {node.data.kind === 'kb' && (
            <>
              <Field label="关键词" hint="留空时用上游文本的前 60 字做检索词。">
                <input
                  className="cv-input"
                  value={config.keyword ?? ''}
                  placeholder="例如：钩子"
                  onChange={(event) => onConfig({ keyword: event.target.value }, 'keyword')}
                />
              </Field>
              <Field label="内容类型">
                <select
                  className="cv-select"
                  value={config.contentType ?? ''}
                  onChange={(event) => onConfig({ contentType: event.target.value }, 'contentType')}
                >
                  <option value="">全部类型</option>
                  {CONTENT_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label="取几条">
                <input
                  className="cv-input"
                  type="number"
                  min={1}
                  max={8}
                  value={config.limit ?? 3}
                  onChange={(event) => onConfig({ limit: Number(event.target.value) }, 'limit')}
                />
              </Field>
            </>
          )}

          {node.data.kind === 'tool' && (
            <Field label="工具" hint={internal ? '工具在服务端执行，只暴露已注册的三个内置能力。' : '工具由平台执行，只提供已接入的能力。'}>
              <select
                className="cv-select"
                value={config.toolName ?? 'templates.stats'}
                onChange={(event) => onConfig({ toolName: event.target.value }, 'toolName')}
              >
                {TOOL_OPTIONS.map((tool) => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
              </select>
            </Field>
          )}

          {node.data.kind === 'condition' && (
            <Field label="表达式" hint="支持 contains(a, b) / equals(a, b) / startsWith(a, b) / length(upstream) >= 20，变量可用 upstream 与 input。">
              <input
                className="cv-input cv-input--mono"
                value={config.expression ?? ''}
                onChange={(event) => onConfig({ expression: event.target.value }, 'expression')}
              />
            </Field>
          )}

                    {node.data.kind === 'output' && (
            <Field label="汇总格式">
              <select
                className="cv-select"
                value={config.format ?? 'markdown'}
                onChange={(event) => onConfig({ format: event.target.value as 'markdown' | 'text' }, 'format')}
              >
                <option value="markdown">Markdown</option>
                <option value="text">纯文本</option>
              </select>
            </Field>
          )}
        </section>

        <section className="cv-section">
          <div className="cv-section-title">运行</div>
          <div className="cv-meta-row"><span>状态</span><strong>{STATUS_TEXT[status] ?? status}</strong></div>
          <div className="cv-meta-row"><span>耗时</span><strong>{node.data.ms !== undefined ? node.data.ms + ' ms' : '—'}</strong></div>
          <div className="cv-meta-row"><span>节点 ID</span><strong className="cv-mono">{node.id}</strong></div>
          {node.data.error && <p className="cv-node-error">{node.data.error}</p>}
        </section>
      </fieldset>

      {readOnly ? (
        <footer className="cv-inspector-foot cv-inspector-foot--readonly">
          <span>{runSnapshot ? '历史运行 · 画布快照' : '历史运行 · 只读'}</span>
          <span className="cv-mono">不会写回画布</span>
        </footer>
      ) : (
        <footer className="cv-inspector-foot">
          <button className="vq-button vq-button--ghost" type="button" onClick={onDuplicate}><Copy size={13} />复制</button>
          <button className="vq-button vq-button--danger" type="button" onClick={onDelete}><Trash size={13} />删除</button>
        </footer>
      )}
    </aside>
  )
}
