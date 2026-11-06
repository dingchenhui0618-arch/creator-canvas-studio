import { useEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronDown } from 'lucide-react'

type ModelEntry = { id: string; label: string; provider: string; ready: boolean }
type Catalog = {
  ok?: boolean
  current?: string
  models?: ModelEntry[]
  configured?: boolean
  source?: string
  hint?: string
}

const STORAGE_KEY = 'vq.model'

/** 当前选中的模型。调用方拿它拼请求参数，切换后立刻生效。 */
export function selectedModel(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * 顶栏的模型切换口子。
 * 列表来自服务端 /api/models（读 VISION_MODELS / VISION_MODEL / VISION_FALLBACKS），
 * 前端不硬编码任何模型名——以后往 .env 里加模型，这里自动出现。
 */
export function ModelSwitch() {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [picked, setPicked] = useState(() => selectedModel())
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (alive && json) setCatalog(json)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const models = catalog?.models ?? []
  const active = picked || catalog?.current || ''
  const ready = Boolean(catalog?.configured)

  const choose = (id: string) => {
    setPicked(id)
    setOpen(false)
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* 隐私模式下写不进去就不持久化，功能不受影响 */
    }
  }

  return (
    <div className="vq-model" ref={boxRef}>
      <button
        type="button"
        className={'vq-model-trigger' + (ready ? '' : ' is-empty')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={ready ? '切换模型' : '还没有配置模型'}
      >
        <Bot size={14} />
        <span className="vq-model-name">{active || '未配置模型'}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="vq-model-pop" role="listbox" aria-label="模型列表">
          <div className="vq-model-pop-head">
            <span className="vq-mono">Model</span>
            <span className="vq-model-source">{catalog?.source === 'none' ? '未接入' : catalog?.source || '…'}</span>
          </div>

          {models.length === 0 ? (
            <p className="vq-model-empty">还没有可选模型。</p>
          ) : (
            <ul className="vq-model-list">
              {models.map((model) => (
                <li key={model.id}>
                  <button
                    type="button"
                    className={'vq-model-item' + (model.id === active ? ' is-active' : '')}
                    onClick={() => choose(model.id)}
                    role="option"
                    aria-selected={model.id === active}
                  >
                    <span className="vq-model-item-main">
                      <strong>{model.label}</strong>
                      <small>{model.provider}</small>
                    </span>
                    {model.id === active && <Check size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="vq-model-hint">{catalog?.hint || '模型清单读取中…'}</p>
          {!ready && <p className="vq-model-warn">凭证未配置：选中模型也不会真正发起调用。</p>}
        </div>
      )}
    </div>
  )
}
