import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { assetErrorInfo, listAssetRefs, type AssetRefOption } from '../api/assets'
import '../styles/assets.css'

type AssetRefSelectProps = {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

/**
 * 参考资产选择器（r312）：选项来自 GET /api/assets/refs，只列已经有图的槽位。
 * 画布节点与作品分镜共用同一个下拉，分组顺序固定为产品在前、数字人在后。
 * 没选 = 空串，调用方按「纯按提示词画」处理，价格与默认行为都不变。
 */
export default function AssetRefSelect({ value, onChange, disabled = false }: AssetRefSelectProps) {
  const [refs, setRefs] = useState<AssetRefOption[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    listAssetRefs()
      .then((data) => {
        if (!alive) return
        setRefs(Array.isArray(data.refs) ? data.refs : [])
        setState('ready')
      })
      .catch((caught) => {
        if (!alive) return
        setError(assetErrorInfo(caught).message)
        setState('error')
      })
    return () => {
      alive = false
    }
  }, [attempt])

  const groups = useMemo(
    () => [
      { kind: 'product' as const, label: '产品资产', options: refs.filter((ref) => ref.kind === 'product') },
      { kind: 'avatar' as const, label: '数字人资产', options: refs.filter((ref) => ref.kind === 'avatar') },
    ],
    [refs],
  )
  const known = refs.some((ref) => ref.id === value)

  const retry = () => {
    setState('loading')
    setError('')
    setAttempt((n) => n + 1)
  }

  return (
    <div className="vq-assetref">
      <select
        className="vq-assetref-select"
        aria-label="参考资产"
        value={value}
        disabled={disabled || state !== 'ready'}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">不用资产（纯按提示词画）</option>
        {groups.map((group) =>
          group.options.length ? (
            <optgroup key={group.kind} label={group.label}>
              {group.options.map((ref) => (
                // 选项文字用「名字 · 槽位」：分组标题已经写了产品 / 数字人，
                // 再带上「产品「…」」在 390 的下拉里会被原生控件截成「产品「美式咖…」」。
                // 完整那句（含类型）留在 title 里，悬停仍看得到。
                <option key={ref.id} value={ref.id} title={ref.full || undefined}>
                  {ref.name ? ref.name + ' · ' + ref.label : ref.full}
                </option>
              ))}
            </optgroup>
          ) : null,
        )}
        {/* 资产被删或没图时，配置里的 token 仍在：如实标出来，不悄悄换回空选项。
           只在清单回来后判断，loading 时 refs 还是空的，不能把有效值误标成不可用。 */}
        {state === 'ready' && value && !known ? <option value={value}>原参考资产已不可用</option> : null}
      </select>

      {state === 'loading' ? (
        <span className="vq-assetref-state">
          <Loader2 size={12} className="vq-spin" />
          正在读取参考资产…
        </span>
      ) : null}

      {state === 'error' ? (
        <span className="vq-assetref-state is-error" role="status">
          参考资产没读到：{error}
          <button type="button" className="vq-assetref-retry" onClick={retry}>
            重试
          </button>
        </span>
      ) : null}

      {state === 'ready' && refs.length === 0 ? (
        <span className="vq-assetref-state">
          还没有可用的参考资产，<a href="#/assets">去建资产</a>。
        </span>
      ) : null}
    </div>
  )
}
