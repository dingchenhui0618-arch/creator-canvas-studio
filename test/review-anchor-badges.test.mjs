// 编号落点（v0.9.76）：两块证据几乎重合时，编号不能叠成一串数字。
// 规则是「四角优先、被占了换角、四角都占满再按圈错开」，这几条单测盯住：不重合就不动、
// 重合了会换角、换完还会往画面中心错开、极端情况不丢编号；面积文案单独一组。
import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceAreaLabel, evidenceAreaPercent, reviewAnchorBadges } from '../src/domain/review-anchors.ts'

const mark = (id, x, y, w, h) => ({ id, index: Number(id.replace(/[^0-9]/g, '')), severity: 'minor', statement: id, evidence: { x, y, w, h } })

test('离得远就都贴左上，不乱挪', () => {
  const badges = reviewAnchorBadges([mark('obs-1', 0, 0, 0.1, 0.1), mark('obs-2', 0.8, 0.8, 0.1, 0.1)])
  assert.deepEqual(badges.map((badge) => badge.corner), ['tl', 'tl'])
  assert.deepEqual(badges.map((badge) => [badge.ring, badge.dx, badge.dy]), [[0, 0, 0], [0, 0, 0]])
  assert.deepEqual(badges.map((badge) => badge.id), ['obs-1', 'obs-2'])
  assert.deepEqual(badges.map((badge) => badge.index), [1, 2])
})

test('两块框几乎重合：第二块换到右上角，不再和第一块叠在一起', () => {
  const badges = reviewAnchorBadges([mark('obs-1', 0.1, 0.2, 0.2, 0.1), mark('obs-2', 0.1, 0.2, 0.2, 0.1)])
  assert.deepEqual(badges.map((badge) => badge.corner), ['tl', 'tr'])
  assert.equal(badges[1].ring, 0)
})

test('四块重合就把四个角占满', () => {
  const badges = reviewAnchorBadges([
    mark('obs-1', 0.1, 0.2, 0.2, 0.1),
    mark('obs-2', 0.1, 0.2, 0.2, 0.1),
    mark('obs-3', 0.1, 0.2, 0.2, 0.1),
    mark('obs-4', 0.1, 0.2, 0.2, 0.1),
  ])
  assert.deepEqual(badges.map((badge) => badge.corner), ['tl', 'tr', 'bl', 'br'])
  assert.deepEqual(badges.map((badge) => badge.ring), [0, 0, 0, 0])
})

test('第五块没角可站：沿画面中心方向错开 20px，编号不丢', () => {
  const box = [0.45, 0.45, 0.2, 0.2] // 中心在 (0.55, 0.55)，朝左上错开
  const badges = reviewAnchorBadges([1, 2, 3, 4, 5].map((n) => mark('obs-' + n, ...box)))
  assert.equal(badges.length, 5)
  assert.equal(badges[4].corner, 'tl')
  assert.equal(badges[4].ring, 1)
  assert.deepEqual([badges[4].dx, badges[4].dy], [-20, -20])
  assert.equal(badges[4].index, 5)
})

test('错开方向始终朝画面里：右下角的框往左上挪', () => {
  const badges = reviewAnchorBadges([1, 2, 3, 4, 5].map((n) => mark('obs-' + n, 0.8, 0.8, 0.1, 0.1)))
  assert.equal(badges[4].ring, 1)
  assert.deepEqual([badges[4].dx, badges[4].dy], [-20, -20])
})

test('空输入不炸；没有证据的条目本来就不会传进来', () => {
  assert.deepEqual(reviewAnchorBadges(null), [])
  assert.deepEqual(reviewAnchorBadges([]), [])
})

test('面积按画面占比算，0.1% 精度，整屏单独说', () => {
  assert.equal(evidenceAreaPercent({ x: 0, y: 0, w: 0.2, h: 0.1 }), 2)
  assert.equal(evidenceAreaPercent({ x: 0, y: 0, w: 1, h: 1 }), 100)
  assert.equal(evidenceAreaPercent({ x: 0, y: 0, w: Number.NaN, h: 0.5 }), 0)
  assert.equal(evidenceAreaPercent(null), 0)
  assert.equal(evidenceAreaLabel({ x: 0, y: 0, w: 0.3, h: 0.4 }), '12%')
  assert.equal(evidenceAreaLabel({ x: 0, y: 0, w: 0.2, h: 0.1 }), '2.0%')
  assert.equal(evidenceAreaLabel({ x: 0, y: 0, w: 0.001, h: 0.001 }), '<0.1%')
  assert.equal(evidenceAreaLabel({ x: 0, y: 0, w: 1, h: 1 }), '整屏')
  assert.equal(evidenceAreaLabel(null), '—')
})
