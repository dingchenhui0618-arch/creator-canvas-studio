// 评审证据锚点的编号映射（v0.9.75）。
//
// 为什么单独抽出来：图上的框和右侧的问题行必须用同一个序号，否则「问题 03」在图上是第几个框
// 全靠猜；没有证据的问题不画框，但列表序号不能跳（跳号就会和模型给的顺序错位）。
// 纯函数，编号规则有单测，UI 只负责画。
export type ReviewEvidence = { x: number; y: number; w: number; h: number }

export type ReviewAnchorMark = {
  id: string
  /** 与右侧问题列表一致的序号（从 1 开始） */
  index: number
  severity: string
  evidence: ReviewEvidence
  statement: string
}

type ObservationLike = {
  id?: string
  severity?: string
  statement?: string
  evidence?: Partial<ReviewEvidence> | null
}

const finite = (value: unknown) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export function reviewAnchorMarks(observations: ObservationLike[] | null | undefined): ReviewAnchorMark[] {
  const marks: ReviewAnchorMark[] = []
  ;(observations || []).forEach((item, position) => {
    if (!item?.id) return
    const evidence = item.evidence
    if (!evidence) return
    const box: ReviewEvidence = { x: finite(evidence.x), y: finite(evidence.y), w: finite(evidence.w), h: finite(evidence.h) }
    // 宽高都是 0 的框框不出任何区域：模型偶尔只给一个原点
    if (box.w <= 0 && box.h <= 0) return
    marks.push({
      id: item.id,
      index: position + 1,
      severity: item.severity || 'minor',
      evidence: box,
      statement: String(item.statement || ''),
    })
  })
  return marks
}

/** 序号统一两位：01、02…（图上与列表用同一串字符，不用两边各写一遍格式） */
export function anchorNumber(index: number) {
  const value = Math.max(0, Math.round(Number(index) || 0))
  return String(value).padStart(2, '0')
}
