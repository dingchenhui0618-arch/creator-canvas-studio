import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canvasDelta,
  canvasText,
  fingerprint,
  scriptText,
  versionChangeText,
  versionBaseChangesOf,
  versionChangesOf,
} from '../server/version-diff.mjs'

// 「比上一版改了什么」只有一个实现：交付稿与作品页版本行都读这里。
// 这一组盯住四件容易退化的行为：
//   1) 节点只比类型与配置，位置 / 标题 / 选中态不是改动；
//   2) 脚本按段名对口播，改名不算改口播，重名段落按顺序比；
//   3) 缺一侧（画布被删 / 没存快照）不猜「没改」，能说的那一侧照说；
//   4) 版本表按相邻版次算，当前版也要有。

const node = (id, title, config, extra = {}) => ({
  id,
  type: 'llm',
  position: { x: 0, y: 0 },
  data: { title, config },
  ...extra,
})

const script = (hook, beats) => ({
  hook,
  structure: beats.map(([beat, voiceover], index) => ({
    beat,
    voiceover,
    onScreen: '',
    purpose: '',
    startSec: index * 3,
    endSec: index * 3 + 3,
  })),
  source: 'project',
  updatedAt: '2026-11-14T12:00:00.000Z',
})

test('节点指纹只认类型与配置：移动位置、改标题不算改动', () => {
  const before = [node('n1', '写一句', { prompt: 'A' })]
  const after = [
    { ...node('n1', '写一句（改名）', { prompt: 'A' }), position: { x: 800, y: 600 } },
  ]
  const delta = canvasDelta(fingerprint(before), fingerprint(after))
  assert.deepEqual(delta, { added: [], removed: [], changed: [] })
  assert.equal(canvasText(delta), '节点没动')
})

test('画布比出多、少、改，并点名节点标题', () => {
  const before = [node('n1', '输入', { text: '旧' }), node('n2', '配音', { voice: '旧' })]
  const after = [node('n1', '输入', { text: '新' }), node('n3', '出图', { size: '9:16' })]
  const delta = canvasDelta(fingerprint(before), fingerprint(after))
  assert.deepEqual(delta.added, ['出图'])
  assert.deepEqual(delta.removed, ['配音'])
  assert.deepEqual(delta.changed, ['输入'])
  assert.equal(canvasText(delta), '多 1 个（出图）、少 1 个（配音）、改 1 个（输入）')
})

test('脚本按段名对口播：多段、少段、改词、换钩子都说清楚', () => {
  const before = script('旧钩子', [['开场', '同一句'], ['闷蒸', '先闷蒸']])
  const after = script('新钩子', [['开场', '同一句'], ['闷蒸', '再闷蒸'], ['收尾', '出杯']])
  const text = scriptText(before, after)
  assert.equal(text, '多 1 段（收尾）、1 段口播改过、钩子换过')
})

test('脚本完全一样时不硬找差异；只换钩子也单独说', () => {
  const same = script('同一个钩子', [['开场', '同一句']])
  assert.equal(scriptText(same, same), '跟上一版一样')
  assert.equal(scriptText(same, script('新钩子', [['开场', '同一句']])), '钩子换过')
})

test('版本行的一句话：两侧都能比时一起说，都没动时收成一句', () => {
  const nodes = [node('n1', '写一句', { prompt: 'A' })]
  const sameScript = script('钩子', [['开场', '同一句']])
  const same = versionChangeText({
    prevNodes: nodes,
    nextNodes: nodes,
    prevScript: sameScript,
    nextScript: sameScript,
  })
  assert.equal(same, '画布与脚本都没动')

  const changed = versionChangeText({
    prevNodes: nodes,
    nextNodes: [node('n1', '写一句', { prompt: 'B' })],
    prevScript: sameScript,
    nextScript: script('钩子', [['开场', '改过的一句']]),
  })
  assert.equal(changed, '画布改 1 个（写一句）；脚本：1 段口播改过、钩子没变')
})

test('缺一侧不冒充「没改」：只写能比的那一侧', () => {
  const nodes = [node('n1', '写一句', { prompt: 'A' })]
  const sameScript = script('钩子', [['开场', '同一句']])
  // 上一版画布被删：脚本还能比，画布不猜
  assert.equal(
    versionChangeText({ prevNodes: null, nextNodes: nodes, prevScript: sameScript, nextScript: sameScript }),
    '脚本跟上一版一样',
  )
  // 上一版没存脚本快照：画布还能比
  assert.equal(
    versionChangeText({ prevNodes: nodes, nextNodes: nodes, prevScript: null, nextScript: sameScript }),
    '画布节点没动',
  )
  // 两边都没有可比的数据：返回空串，页面不写「没改」
  assert.equal(
    versionChangeText({ prevNodes: null, nextNodes: nodes, prevScript: null, nextScript: null }),
    '',
  )
})

test('版本表按相邻版次算：v2、v3 各一句，最早一版没有', () => {
  const rows = [
    { n: 1, nodes: [node('n1', '输入', { text: 'v1' })], script: script('钩子 v1', [['开场', '第一版']]) },
    { n: 2, nodes: [node('n1', '输入', { text: 'v2' })], script: script('钩子 v2', [['开场', '第二版']]) },
    { n: 3, nodes: [node('n1', '输入', { text: 'v2' })], script: script('钩子 v2', [['开场', '第二版']]) },
  ]
  const changes = versionChangesOf(rows)
  assert.equal(changes['1'], undefined)
  assert.match(changes['2'], /画布改 1 个（输入）/)
  assert.match(changes['2'], /1 段口播改过/)
  assert.match(changes['3'], /画布与脚本都没动/)
})

test('以旧版为底：改动按底座算，不再拿上一版当基准', () => {
  const rows = [
    { n: 1, nodes: [node('n1', '输入', { text: 'v1' })], script: script('钩子 v1', [['开场', '第一版']]) },
    { n: 2, nodes: [node('n1', '输入', { text: 'v2' })], script: script('钩子 v2', [['开场', '第二版']]) },
    { n: 3, nodes: [node('n1', '输入', { text: 'v2' })], script: script('钩子 v2', [['开场', '第二版']]) },
    { n: 4, nodes: [node('n1', '输入', { text: 'v1' })], script: script('钩子 v1', [['开场', '第一版']]), base: 1 },
  ]
  const bases = versionBaseChangesOf(rows)
  assert.deepEqual(bases['4'], { base: 1, text: '画布与脚本都没动' })
  assert.equal(bases['2'], undefined, '普通版本仍按上一版算')
  assert.equal(bases['3'], undefined, '底座就是上一版时不重复给')
  // 底座那一版不在表里（被删 / 被裁掉）就不写，页面回退到「比上一版」
  assert.equal(versionBaseChangesOf([{ ...rows[3], base: 2 }])['4'], undefined)
})
