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

// ── 编号在框上的落点（v0.9.76）──────────────────────────────────────────────
//
// 为什么要有这一步：两条问题框住的位置几乎重合时（同一块标题、同一行按钮），编号都贴左上角，
// 会叠成一串看不清的数字，等于又回到「说不清哪个是哪个」。
// 规则：先试四个角，第一个不和已放编号打架的角就用它；四个角都被占了，就沿「朝画面中心」的
// 方向每圈错开 20px。全部放不下时宁可叠回左上角，也不隐藏编号。
export type BadgeCorner = 'tl' | 'tr' | 'bl' | 'br'

export type ReviewAnchorBadge = {
  id: string
  index: number
  corner: BadgeCorner
  /** 第几圈偏移（0 = 就贴在框角上） */
  ring: number
  /** 实际位移，单位 px（CSS 直接用；方向朝画面中心，不会挪出画面） */
  dx: number
  dy: number
}

const CORNERS: BadgeCorner[] = ['tl', 'tr', 'bl', 'br']
const CORNER_AT: Record<BadgeCorner, { fx: number; fy: number }> = {
  tl: { fx: 0, fy: 0 },
  tr: { fx: 1, fy: 0 },
  bl: { fx: 0, fy: 1 },
  br: { fx: 1, fy: 1 },
}
/** 两枚编号中心在归一化坐标里至少差这么多，才算不打架（16px 方块 ≈ 画面宽 0.04 / 高 0.02） */
const GAP_X = 0.04
const GAP_Y = 0.022
/** 一圈偏移在归一化坐标里的等效量，和 CSS 的 RING_PX 对齐（546×896 的画面上 20px ≈ 0.037 / 0.022） */
const RING_X = 0.04
const RING_Y = 0.022
const RING_PX = 20
const MAX_RING = 5

type Point = { x: number; y: number }

const tooClose = (a: Point, b: Point) => Math.abs(a.x - b.x) < GAP_X && Math.abs(a.y - b.y) < GAP_Y

export function reviewAnchorBadges(marks: ReviewAnchorMark[] | null | undefined): ReviewAnchorBadge[] {
  const placed: Point[] = []
  const badges: ReviewAnchorBadge[] = []
  ;(marks || []).forEach((mark) => {
    const box = mark.evidence
    // 朝画面中心挪：右下角的框往左上挪，左上角的框往右下挪，编号始终留在画面里
    const inward = {
      x: box.x + box.w / 2 > 0.5 ? -1 : 1,
      y: box.y + box.h / 2 > 0.5 ? -1 : 1,
    }
    let chosen: ReviewAnchorBadge | null = null
    let chosenAt: Point | null = null
    for (let ring = 0; ring <= MAX_RING && !chosen; ring += 1) {
      for (const corner of CORNERS) {
        const at = CORNER_AT[corner]
        const point = { x: box.x + at.fx * box.w + inward.x * RING_X * ring, y: box.y + at.fy * box.h + inward.y * RING_Y * ring }
        if (placed.some((other) => tooClose(point, other))) continue
        // `|| 0` 去掉 -0：ring 0 时不能给 CSS 一个 -0px
        chosen = { id: mark.id, index: mark.index, corner, ring, dx: inward.x * RING_PX * ring || 0, dy: inward.y * RING_PX * ring || 0 }
        chosenAt = point
        break
      }
    }
    // 极端情况（十几个框挤在一处）：编号叠回左上角，仍然显示
    if (!chosen || !chosenAt) {
      const at = CORNER_AT.tl
      chosen = { id: mark.id, index: mark.index, corner: 'tl', ring: 0, dx: 0, dy: 0 }
      chosenAt = { x: box.x + at.fx * box.w, y: box.y + at.fy * box.h }
    }
    placed.push(chosenAt)
    badges.push(chosen)
  })
  return badges
}

/** 框住的宽×高占画面多少（原始百分比，未取整；框越大，位置参照越弱） */
const rawArea = (evidence: ReviewEvidence | null | undefined) => {
  if (!evidence) return 0
  const w = Math.max(0, finite(evidence.w))
  const h = Math.max(0, finite(evidence.h))
  return Math.min(100, w * h * 100)
}

/** 框住画面多大一块（百分比，0.1% 精度） */
export function evidenceAreaPercent(evidence: ReviewEvidence | null | undefined) {
  return Math.round(rawArea(evidence) * 10) / 10
}

/** 面积文案：<0.1% / 3.4% / 12% / 整屏；没有框时给一个短横 */
export function evidenceAreaLabel(evidence: ReviewEvidence | null | undefined) {
  if (!evidence) return '—'
  const area = rawArea(evidence)
  if (area <= 0) return '0%'
  if (area < 0.1) return '<0.1%'
  if (area >= 85) return '整屏'
  if (area < 10) return (Math.round(area * 10) / 10).toFixed(1) + '%'
  return Math.round(area) + '%'
}
