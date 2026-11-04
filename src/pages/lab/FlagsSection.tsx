import { useState } from 'react'
import { RotateCcw, ToggleLeft } from 'lucide-react'
import { FLAG_PREFIX, flagKey, readAllLabFlags, readLabFlag, writeLabFlag } from './flags'
import type { LabFlagId } from './flags'

function nowIso(): string {
  return new Date().toISOString()
}

type FlagDefinition = {
  id: LabFlagId
  label: string
  description: string
  impact: string
  target: string
  wired: boolean
}

const FLAGS: FlagDefinition[] = [
  {
    id: 'review-service-first',
    label: '评审优先走插件服务',
    description: '评审请求先探测 VisionQA 插件服务，不可用再回退本地视觉模型。',
    impact:
      '仅记录，尚未接线：客户端没有模块读取这个 key。后端目前固定先探 127.0.0.1:6300 插件服务，失败才走本地模型。',
    target: 'server/review.mjs · serviceHealth() / reviewVisual()',
    wired: false,
  },
  {
    id: 'canvas-auto-save',
    label: '画布自动保存提示',
    description: '画布变更后自动保存，并在顶栏显示保存状态。',
    impact:
      '仅记录，尚未接线：CanvasPage 没有自动保存实现，当前画布状态只存在内存里，切页后会丢失。',
    target: 'src/pages/CanvasPage.tsx',
    wired: false,
  },
  {
    id: 'mock-search-fallback',
    label: '检索失败时回退示例数据',
    description: '爆款雷达检索失败时，是否用本地示例数据兜底，并明确标注「示例」。',
    impact:
      '仅记录，尚未接线：回退逻辑由服务端决定。/api/search 在未配置 Key、配额不足或 Key 被禁用时会自动回退 fixtures，前端只展示 mode/note。',
    target: 'server/index.mjs · /api/search',
    wired: false,
  },
]

export function FlagsSection() {
  const [values, setValues] = useState<Record<LabFlagId, boolean>>(() => readAllLabFlags())
  const [savedAt, setSavedAt] = useState('')
  const [storageError, setStorageError] = useState('')
  const enabledCount = FLAGS.filter((flag) => values[flag.id]).length
  const wiredCount = FLAGS.filter((flag) => flag.wired).length

  const toggle = (id: LabFlagId) => {
    const next = !values[id]
    setValues((current) => ({ ...current, [id]: next }))
    writeLabFlag(id, next)
    const persisted = readLabFlag(id) === next
    setStorageError(persisted ? '' : '浏览器拒绝写入 localStorage，开关只会保留在当前页面内存里。')
    setSavedAt(nowIso())
  }

  const reset = () => {
    const next = { ...values }
    for (const flag of FLAGS) {
      next[flag.id] = false
      writeLabFlag(flag.id, false)
    }
    setValues(next)
    const persisted = FLAGS.every((flag) => readLabFlag(flag.id) === false)
    setStorageError(persisted ? '' : '浏览器拒绝写入 localStorage，开关只会保留在当前页面内存里。')
    setSavedAt(nowIso())
  }

  return (
    <div className="lab-stack">
      <div className="lab-toolbar">
        <div className="lab-toolbar-copy">
          <span className="lab-mono">LOCAL FLAGS · {FLAG_PREFIX}*</span>
          <span className="lab-dim">
            只写入本机 localStorage，刷新后保留；不上报服务端，也不影响其他浏览器或账号。
          </span>
        </div>
        <div className="lab-toolbar-actions">
          <span className="lab-chip lab-chip--warn">仅本浏览器生效</span>
          <button type="button" className="lab-btn" onClick={reset} disabled={!enabledCount}>
            <RotateCcw size={13} />
            全部关闭
          </button>
        </div>
      </div>

      <div className="lab-metrics">
        <div className="lab-metric">
          <span className="lab-metric-label">开关总数</span>
          <strong>{FLAGS.length}</strong>
          <span className="lab-metric-foot">三条均为本地记录</span>
        </div>
        <div className="lab-metric">
          <span className="lab-metric-label">已开启</span>
          <strong>{enabledCount}</strong>
          <span className="lab-metric-foot">点击右侧开关立即写入</span>
        </div>
        <div className="lab-metric">
          <span className="lab-metric-label">已接线</span>
          <strong>{wiredCount}</strong>
          <span className="lab-metric-foot">{wiredCount ? '已有代码读取' : '现有代码尚未读取这些 key'}</span>
        </div>
        <div className="lab-metric">
          <span className="lab-metric-label">最近写入</span>
          <strong className="lab-metric-time">{savedAt ? new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</strong>
          <span className="lab-metric-foot">{savedAt ? '已尝试持久化' : '本次尚未修改'}</span>
        </div>
      </div>

      {storageError && (
        <div className="lab-alert lab-alert--bad">
          <ToggleLeft size={14} />
          <span>{storageError}</span>
        </div>
      )}

      <div className="lab-flags">
        {FLAGS.map((flag, index) => {
          const enabled = values[flag.id]
          return (
            <section className={'lab-flag' + (enabled ? ' is-on' : '')} key={flag.id}>
              <div className="lab-flag-index">{String(index + 1).padStart(2, '0')}</div>
              <div className="lab-flag-main">
                <div className="lab-flag-title">
                  <h3>{flag.label}</h3>
                  <span className={'lab-chip ' + (flag.wired ? 'lab-chip--real' : 'lab-chip--quiet')}>
                    {flag.wired ? '已接线' : '仅记录，尚未接线'}
                  </span>
                </div>
                <p>{flag.description}</p>
                <div className="lab-flag-meta">
                  <span className="lab-mono">{flagKey(flag.id)}</span>
                  <span className="lab-dim">目标代码：{flag.target}</span>
                </div>
                <p className="lab-flag-impact">{flag.impact}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={flag.label + '：' + (enabled ? '已开启' : '已关闭')}
                className={'lab-switch' + (enabled ? ' is-on' : '')}
                onClick={() => toggle(flag.id)}
              >
                <span className="lab-switch-knob" aria-hidden="true" />
              </button>
            </section>
          )
        })}
      </div>

      <p className="lab-footnote">
        <ToggleLeft size={12} />
        <span>
          这三条都是「持久化开关 + 真实影响说明」。在代码真正读取它们之前，页面明确标成「仅记录，尚未接线」，不把开关当成已生效的能力。
        </span>
      </p>
    </div>
  )
}