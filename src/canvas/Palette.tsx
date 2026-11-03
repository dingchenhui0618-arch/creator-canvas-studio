import { Plus } from 'lucide-react'
import { NODE_META, PALETTE_GROUPS } from './catalog'
import type { FlowNodeKind } from './types'

type PaletteProps = {
  onAdd: (kind: FlowNodeKind) => void
  disabled?: boolean
}

export function Palette({ onAdd, disabled }: PaletteProps) {
  return (
    <aside className="cv-palette" aria-label="节点面板">
      <header className="cv-palette-head">
        <span className="cv-kicker">节点</span>
        <p>拖入画布，或点击添加</p>
      </header>
      <div className="cv-palette-body">
        {PALETTE_GROUPS.map((group) => (
          <section className="cv-palette-group" key={group.label}>
            <div className="cv-palette-label">{group.label}</div>
            {group.kinds.map((kind) => {
              const meta = NODE_META[kind]
              const Icon = meta.icon
              return (
                <button
                  key={kind}
                  type="button"
                  className="cv-palette-item"
                  draggable={!disabled}
                  disabled={disabled}
                  title={meta.hint}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-flow-node', kind)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onAdd(kind)}
                >
                  <span className="cv-palette-icon"><Icon size={14} strokeWidth={1.5} /></span>
                  <span className="cv-palette-copy">
                    <strong>{meta.label}</strong>
                    <span>{meta.mono}</span>
                  </span>
                  <Plus size={13} className="cv-palette-plus" strokeWidth={1.5} />
                </button>
              )
            })}
          </section>
        ))}
      </div>
      <footer className="cv-palette-foot">
        <span>Ctrl+Z 撤销</span>
        <span>Delete 删除</span>
      </footer>
    </aside>
  )
}
