import { useEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronDown } from 'lucide-react'
import { getPreferences, saveModelPreference } from '../api/preferences'
import { useUiMode } from '../api/app'

type ModelEntry = { id: string; label: string; provider: string; kind?: string; ready: boolean }
type Catalog = {
  ok?: boolean
  current?: string
  models?: ModelEntry[]
  configured?: boolean
  source?: string
  hint?: string
}

const STORAGE_KEY = 'vq.model'
const KIND_LABEL: Record<string, string> = { text: '对话', vision: '视觉', both: '通用', multimodal: '通用' }

// 一个进程只打一次 /api/models：顶栏与检查器的模型候选共用同一份
let catalogPromise: Promise<Catalog | null> | null = null
// 最近一次从服务端读到的偏好：给同步的 selectedModel() 兜底
let lastPreferred = ''

function loadCatalog(): Promise<Catalog | null> {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/models')
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
  }
  return catalogPromise
}

/** 检查器里 llm 节点的模型候选：服务端清单，前端不写死任何模型名。 */
export function useModelOptions(): Array<{ id: string; label: string }> {
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([])
  useEffect(() => {
    let alive = true
    loadCatalog().then((json) => {
      if (!alive || !json) return
      setOptions((json.models ?? []).map((item) => ({ id: item.id, label: item.label })))
    })
    return () => {
      alive = false
    }
  }, [])
  return options
}

/** 当前选中的模型（同步读取；异步调用方请用 /api/preferences）。 */
export function selectedModel(): string {
  if (lastPreferred) return lastPreferred
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * 顶栏的模型切换口子。
 * 列表来自服务端 /api/models（读 VISION_MODELS / VISION_MODEL / VISION_FALLBACKS），
 * 选择保存到服务端 /api/preferences（按账号），刷新、换浏览器都还是同一个选择。
 * 前端不硬编码任何模型名——以后往 .env 里加模型，这里自动出现。
 */
export function ModelSwitch() {
  const { internal } = useUiMode()
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [picked, setPicked] = useState(() => selectedModel())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    loadCatalog().then((json) => {
      if (alive && json) setCatalog(json)
    })
    getPreferences()
      .then((prefs) => {
        if (!alive) return
        lastPreferred = prefs.model
        setPicked(prefs.model)
      })
      .catch(() => {
        // 接口不可用（旧版本服务端/网络问题）：退回本机记住的选择，不弹错吓用户
        try {
          if (alive) setPicked(localStorage.getItem(STORAGE_KEY) || '')
        } catch {
          /* 隐私模式下读不到就不预选 */
        }
      })
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
  // 顶栏只露产品口径的名称：id 是给请求用的，不在界面出现上游厂商名
  const activeLabel = active ? models.find((item) => item.id === active)?.label || '已选模型' : ''
  const ready = Boolean(catalog?.configured)

  const choose = (id: string) => {
    if (saving) return
    const previous = picked
    setPicked(id)
    setOpen(false)
    setError('')
    setSaving(true)
    saveModelPreference(id)
      .then((prefs) => {
        lastPreferred = prefs.model
        setPicked(prefs.model)
        try {
          localStorage.setItem(STORAGE_KEY, prefs.model)
        } catch {
          /* 隐私模式下写不进去也不影响服务端偏好 */
        }
      })
      .catch((caught) => {
        // 没保存成功就不要假装切了：恢复原选择并说明原因
        setPicked(previous)
        setError(caught instanceof Error ? caught.message : '模型偏好没有保存成功')
      })
      .finally(() => setSaving(false))
  }

  return (
    <div className="vq-model" ref={boxRef}>
      <button
        type="button"
        className={'vq-model-trigger' + (ready ? '' : ' is-empty')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={ready ? '切换模型' : '还没有可用模型'}
      >
        <Bot size={14} />
        <span className="vq-model-name">{activeLabel || '未配置模型'}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="vq-model-pop" role="listbox" aria-label="模型列表">
          <div className="vq-model-pop-head">
            <span className="vq-mono">{internal ? 'Model' : '模型'}</span>
            <span className="vq-model-source">
              {catalog?.source === 'none'
                ? (internal ? '未接入' : '暂不可用')
                : catalog?.source === 'VISION_MODELS'
                  ? (internal ? '服务端清单' : '平台配置')
                  : catalog?.source === 'VISION_MODEL'
                    ? (internal ? '默认模型' : '默认')
                    : '…'}
            </span>
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
                    disabled={saving}
                  >
                    <span className="vq-model-item-main">
                      <strong>{model.label}</strong>
                      <small>{KIND_LABEL[model.kind || model.provider] || '模型'}</small>
                    </span>
                    {model.id === active && <Check size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {picked && models.length > 0 ? (
            <button type="button" className="vq-model-reset" onClick={() => choose('')} disabled={saving}>
              恢复平台默认
            </button>
          ) : null}

          <p className={'vq-model-hint' + (error ? ' is-error' : '')}>
            {error ||
              (internal
                ? '偏好保存在服务端并按账号生效；智能体对话与画布节点在未单独指定模型时使用它。'
                : '选择后按账号保存，下次打开还是这个模型。')}
          </p>
          {!ready && (
            <p className="vq-model-warn">
              {internal ? '凭证未配置：选中模型也不会真正发起调用。' : '当前暂时无法发起模型调用，请联系平台维护人员。'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
