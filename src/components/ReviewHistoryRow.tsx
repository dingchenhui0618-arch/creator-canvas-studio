import type { ReviewSummary } from '../api/review'
import { REVIEW_VERDICT_LABEL, reviewTimeLabel, reviewWorkLine } from '../domain/review'
import { Pill } from './ui'

// 评审历史的每一行：结论胶囊 + 标题 + 时间 + 「记在哪条作品的第几版」。
// 左侧「最近评审」与「查看全部」弹层共用这一份，免得两处慢慢长得不一样。

export function ReviewHistoryRow({
  item,
  current = false,
  onOpen,
}: {
  item: ReviewSummary
  /** 正打开着的那条：给个安静的标记，不抢视线 */
  current?: boolean
  onOpen: (id: string) => void
}) {
  return (
    <button
      type="button"
      className={'review-history-item' + (current ? ' is-current' : '')}
      aria-current={current ? 'true' : undefined}
      onClick={() => onOpen(item.id)}
    >
      <Pill tone={item.verdict || 'idle'}>
        {REVIEW_VERDICT_LABEL[item.verdict] || '未记录'}
      </Pill>
      <span className="review-history-title">{item.source.label || item.intent || '未命名评审'}</span>
      <span className="vq-mono review-history-time">{reviewTimeLabel(item.createdAt)}</span>
      <small className={'review-history-where' + (item.project ? '' : ' is-orphan')}>
        {reviewWorkLine(item)}
        {current ? <span className="review-history-flag">正在看</span> : null}
      </small>
    </button>
  )
}
