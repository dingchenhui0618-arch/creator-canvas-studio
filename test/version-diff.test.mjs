import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canvasDelta,
  canvasDetail,
  canvasFieldDetail,
  canvasText,
  fingerprint,
  reviewChangeOf,
  reviewSideOf,
  scriptDetail,
  scriptText,
  versionChangeText,
  versionBaseChangesOf,
  versionChangesOf,
  versionCompareOf,
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

test('两版对照的画布明细带节点 id：多、少、改都能逐项列出来', () => {
  const before = [node('n1', '输入', { text: '旧' }), node('n2', '配音', { voice: '旧' })]
  const after = [node('n1', '输入', { text: '新' }), node('n3', '出图', { size: '9:16' })]
  const detail = canvasDetail(fingerprint(before), fingerprint(after))
  assert.deepEqual(detail.added, [{ id: 'n3', title: '出图' }])
  assert.deepEqual(detail.removed, [{ id: 'n2', title: '配音' }])
  assert.deepEqual(detail.changed, [{ id: 'n1', title: '输入' }])
  assert.equal(canvasText(canvasDelta(fingerprint(before), fingerprint(after))), '多 1 个（出图）、少 1 个（配音）、改 1 个（输入）')
})

test('两版对照的脚本明细：改过的段带前后口播，钩子单独说', () => {
  const before = script('旧钩子', [['开场', '同一句'], ['闷蒸', '先闷蒸']])
  const after = script('新钩子', [['开场', '同一句'], ['闷蒸', '再闷蒸'], ['收尾', '出杯']])
  const detail = scriptDetail(before, after)
  assert.deepEqual(detail.added, ['收尾'])
  assert.deepEqual(detail.removed, [])
  assert.deepEqual(detail.changed, [{ name: '闷蒸', before: ['先闷蒸'], after: ['再闷蒸'] }])
  assert.equal(detail.hookChanged, true)
  assert.equal(detail.hookBefore, '旧钩子')
  assert.equal(detail.hookAfter, '新钩子')
})

test('任意两版：一句话与明细同源；缺一侧时明细为 null，不冒充没改', () => {
  const nodes = [node('n1', '写一句', { prompt: 'A' })]
  const sameScript = script('钩子', [['开场', '同一句']])
  const same = versionCompareOf({
    baseNodes: nodes,
    targetNodes: nodes,
    baseScript: sameScript,
    targetScript: sameScript,
  })
  assert.equal(same.summary, '画布与脚本都没动')
  assert.deepEqual(same.canvas, { added: [], removed: [], changed: [] })
  assert.deepEqual(same.script.changed, [])

  const missing = versionCompareOf({
    baseNodes: null,
    targetNodes: nodes,
    baseScript: null,
    targetScript: sameScript,
  })
  assert.equal(missing.canvas, null)
  assert.equal(missing.script, null)
  assert.equal(missing.summary, '')
})

test('改过的节点差到参数：类型、文本、温度、提示词各列一项', () => {
  const before = [
    node('n1', '输入', { text: '第一版' }, { type: 'input' }),
    node('n2', '写一句', { model: 'deepseek-flash', temperature: 0.4, systemPrompt: '第一版提示词' }),
  ]
  const after = [
    node('n1', '输入', { text: '第三版' }, { type: 'input' }),
    node('n2', '写一句', { model: 'deepseek-flash', temperature: 0.7, systemPrompt: '第二版提示词' }),
  ]
  const fields = canvasFieldDetail(before, after)
  assert.deepEqual(fields.n1, [{
    key: 'text',
    label: '输入文本',
    before: '第一版',
    after: '第三版',
    truncated: false,
  }])
  assert.deepEqual(fields.n2.map((item) => [item.label, item.before, item.after]), [
    ['温度', '0.4', '0.7'],
    ['提示词', '第一版提示词', '第二版提示词'],
  ])
  // 多 / 少节点没有前后参数可比，不硬凑
  assert.deepEqual(canvasFieldDetail([...before, node('n3', '多', { text: 'x' }, { type: 'input' })], after).n3, undefined)
  // 配置一模一样时不给空明细
  assert.deepEqual(canvasFieldDetail(before, before), {})
})

test('节点类型换了也算一项；很长的提示词只截改动附近，两端各留省略号', () => {
  const longOld = '甲'.repeat(400) + '旧句' + '乙'.repeat(400)
  const longNew = '甲'.repeat(400) + '新句' + '乙'.repeat(400)
  const fields = canvasFieldDetail(
    [node('n1', '旧节点', { text: longOld }, { type: 'input' })],
    [node('n1', '新节点', { text: longNew }, { type: 'llm' })],
  )
  assert.equal(fields.n1[0].key, 'type')
  assert.equal(fields.n1[0].before, '输入')
  assert.equal(fields.n1[0].after, '大模型')
  const prompt = fields.n1.find((item) => item.key === 'text')
  assert.equal(prompt.truncated, true)
  assert.ok(prompt.before.includes('旧句'), '截断后仍要看得到改动的那一段')
  assert.ok(prompt.after.includes('新句'))
  assert.ok(prompt.before.startsWith('…') && prompt.before.endsWith('…'), '两端省略号说明截过')
  assert.ok(prompt.before.length < 500, '不能把 800 字整段塞回弹窗')
})

test('任意两版对照把参数明细挂在改过的节点上；没有改动时不多带字段', () => {
  const before = [node('n1', '写一句', { temperature: 0.4, systemPrompt: '旧' })]
  const after = [node('n1', '写一句', { temperature: 0.7, systemPrompt: '新' })]
  const changed = versionCompareOf({ baseNodes: before, targetNodes: after, baseScript: null, targetScript: null })
  assert.equal(changed.canvas.fields.n1.length, 2)
  assert.deepEqual(changed.canvas.fields.n1.map((item) => item.label).sort(), ['提示词', '温度'].sort())
  const same = versionCompareOf({ baseNodes: before, targetNodes: before, baseScript: null, targetScript: null })
  assert.equal(same.canvas.fields, undefined)
})

const issuesOf = (patch = {}) => ({
  blocker: 0,
  major: 0,
  minor: 0,
  info: 0,
  counted: 0,
  observations: 0,
  ...patch,
})

const reviewOf = (verdict, issues = null) => ({
  count: 1,
  lastVerdict: verdict,
  lastAt: '2026-11-15T12:00:00.000Z',
  issues,
})

test('两版评审结论变了：通过到需人工确认算变差，反过来算变好', () => {
  const pass = reviewOf('pass', issuesOf({ major: 1, counted: 1, observations: 1 }))
  const needs = reviewOf('needs_review', issuesOf({ blocker: 1, major: 1, counted: 2, observations: 2 }))
  assert.deepEqual(reviewChangeOf(pass, needs), {
    text: '结论从「通过」变成「需人工确认」',
    tone: 'worse',
  })
  assert.deepEqual(reviewChangeOf(needs, pass), {
    text: '结论从「需人工确认」变成「通过」',
    tone: 'better',
  })
})

test('结论没变就比前三档问题数：从重到轻只说第一处变化，信息级不算', () => {
  const before = reviewOf('pass', issuesOf({ blocker: 1, major: 2, counted: 3, observations: 4 }))
  const fewerBlocker = reviewOf('pass', issuesOf({ blocker: 0, major: 2, counted: 2, observations: 2 }))
  assert.deepEqual(reviewChangeOf(before, fewerBlocker), { text: '阻塞少 1 个', tone: 'better' })

  const moreMajor = reviewOf('pass', issuesOf({ blocker: 1, major: 3, counted: 4, observations: 4 }))
  assert.deepEqual(reviewChangeOf(before, moreMajor), { text: '主要多 1 个', tone: 'worse' })

  const infoOnly = reviewOf('pass', issuesOf({ blocker: 1, major: 2, info: 5, counted: 3, observations: 8 }))
  assert.deepEqual(reviewChangeOf(before, infoOnly), {
    text: '结论与前三档问题数都没变',
    tone: 'same',
  })
})

test('没评过、没记结论、没记严重度：如实说不比，不编「没变」', () => {
  const pass = reviewOf('pass', issuesOf({ major: 1, counted: 1, observations: 1 }))
  assert.equal(reviewChangeOf({ count: 0 }, pass).tone, 'unknown')
  assert.match(reviewChangeOf({ count: 0 }, pass).text, /还没评审/)
  assert.equal(reviewChangeOf({ ...pass, lastVerdict: '' }, pass).tone, 'unknown')
  assert.match(reviewChangeOf({ ...pass, lastVerdict: '' }, pass).text, /没记评审结论/)

  const noSeverity = reviewOf('pass', issuesOf({ observations: 2, counted: 0 }))
  assert.equal(reviewChangeOf(pass, noSeverity).tone, 'unknown')
  assert.match(reviewChangeOf(pass, noSeverity).text, /没记严重度/)
})

test('一侧评审概况按同一套数清洗：没评过不冒充 0 个阻塞', () => {
  assert.deepEqual(reviewSideOf({ count: 2, lastVerdict: 'pass', lastAt: 't', issues: { blocker: '1', major: 2, counted: '3' } }), {
    count: 2,
    verdict: 'pass',
    at: 't',
    issues: { blocker: 1, major: 2, minor: 0, info: 0, counted: 3, observations: 0 },
  })
  assert.deepEqual(reviewSideOf({ count: 0, lastVerdict: 'pass', issues: { blocker: 1 } }), {
    count: 0,
    verdict: '',
    at: '',
    issues: { blocker: 1, major: 0, minor: 0, info: 0, counted: 0, observations: 0 },
  })
  assert.deepEqual(reviewSideOf(null), { count: 0, verdict: '', at: '', issues: null })
})
