// 工作流页空状态里的「起手」清单（r249 / v0.9.232）。
// 只负责画：挑哪几条、写什么字都在 src/domain/canvas-start.ts，改了那边单测会跟着报。
// 桌面画布浮层与手机步骤清单共用这一份，两处文案不会走散。
import { ArrowRight } from 'lucide-react'
import {
  canvasStartAction,
  canvasStartMeta,
  type CanvasStartItem,
  type CanvasStartPlan,
} from '../domain/canvas-start'

type CanvasStartProps = {
  plan: CanvasStartPlan
  loading: boolean
  error: string
  /** 正在建的那一条：整组一起禁用，避免连点建出两条 */
  busyId: string
  onPick: (item: CanvasStartItem) => void
  /** 空白流程：打开节点面板，自己拖 */
  onBlank: () => void
  onOpenRadar: () => void
  onOpenTemplates: () => void
}

function StartRow({ item, busyId, onPick }: { item: CanvasStartItem; busyId: string; onPick: (item: CanvasStartItem) => void }) {
  const busy = busyId === item.id
  return (
    <button
      type="button"
      className="cv-start-row"
      onClick={() => onPick(item)}
      disabled={Boolean(busyId)}
      title={busy ? '正在建…' : canvasStartAction(item)}
    >
      <span className="cv-start-title">{item.source === 'project' ? '《' + item.title + '》' : item.title}</span>
      <span className="cv-start-meta">{canvasStartMeta(item)}</span>
      <span className="cv-start-go">
        {busy ? '正在建…' : canvasStartAction(item)}
        <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </span>
    </button>
  )
}

export default function CanvasStart({ plan, loading, error, busyId, onPick, onBlank, onOpenRadar, onOpenTemplates }: CanvasStartProps) {
  return (
    <div className="cv-start">
      <div className="cv-start-head">
        <span className="cv-start-kicker">从你手上的东西起手</span>
        <span className="cv-start-hint">点了就在这张画布上建好，跑完的运行带着结果进「作品」</span>
      </div>

      {loading ? <p className="cv-start-note">正在读你的作品与模板…</p> : null}
      {!loading && error ? (
        <p className="cv-start-note">没读到作品与模板（{error}）：下面照样能用手动起手。</p>
      ) : null}
      {!loading && !error && plan.total === 0 ? (
        <p className="cv-start-note">手上还没有能直接起手的内容：作品会出现在这里，前提是它已经有脚本。</p>
      ) : null}

      {plan.projects.length ? (
        <div className="cv-start-group">
          <span className="cv-start-label">作品</span>
          <div className="cv-start-list">
            {plan.projects.map((item) => <StartRow key={item.id} item={item} busyId={busyId} onPick={onPick} />)}
          </div>
        </div>
      ) : null}

      {plan.templates.length ? (
        <div className="cv-start-group">
          <span className="cv-start-label">来自工作流的模板</span>
          <div className="cv-start-list">
            {plan.templates.map((item) => <StartRow key={item.id} item={item} busyId={busyId} onPick={onPick} />)}
          </div>
        </div>
      ) : null}

      <div className="cv-start-fallback">
        <span className="cv-start-fallback-label">都不是？</span>
        <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onBlank}>
          空白流程，自己拖节点
        </button>
        <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onOpenRadar}>
          去爆款雷达找一条
        </button>
        <button type="button" className="vq-button vq-button--ghost vq-button--sm" onClick={onOpenTemplates}>
          打开模板库
        </button>
      </div>
    </div>
  )
}
