import test from 'node:test'
import assert from 'node:assert/strict'
import { projectDeliverable, DELIVERABLE_LIMITS } from '../server/project-deliverable.mjs'

// 交付稿要能回答「把这版和上一版一起发我」：每一版写了什么、评过什么、跑过什么。
// 这一组测试盯住四件容易退化的行为：
//   1) 每一版都有自己的明细块，顺序从新到旧；
//   2) 开新版时存的脚本快照真的被用来对比（多段 / 少段 / 改口播 / 换钩子）；
//   3) 没存快照的版本说实话，不拿现在的脚本冒充当时的；
//   4) 版数多时只写最近几版，但表里仍然是全量。

const NOW = new Date('2026-11-12T13:40:00.000Z')
const TZ = 480

const scriptOf = (hook, beats) => ({
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
  updatedAt: '2026-11-12T04:00:00.000Z',
})

const nodesOf = (...titles) => titles.map((title) => ({
  id: 'n_' + title,
  type: 'llm',
  data: { title, config: { systemPrompt: title + ' 的提示词' } },
}))

function fixture({ archived = [], currentScript = null, currentNodeList = nodesOf('复刻脚本'), reviews = [], runCounts = {}, runs = [] } = {}) {
  const entries = archived.map((entry) => ({
    n: entry.n,
    flowId: 'flow_' + entry.n,
    name: entry.name,
    archivedAt: entry.archivedAt,
    available: entry.available !== false,
    nodes: entry.nodes ? entry.nodes.length : 0,
    scriptBeats: entry.script ? entry.script.structure.length : 0,
    scriptSnapshot: entry.script || null,
    nodeList: entry.nodes || null,
  }))
  return {
    project: {
      id: 'prj_v',
      title: '咖啡 3 分钟',
      templateId: 'tpl_a',
      flowId: 'flow_cur',
      // 版本号按「归档几版 + 当前一版」推出来，和存储层同一套规则
      version: entries.length + 1,
      versions: [],
      status: 'active',
      createdAt: '2026-11-11T02:00:00.000Z',
      updatedAt: '2026-11-12T05:30:00.000Z',
    },
    share: null,
    template: {
      id: 'tpl_a', title: '咖啡 3 分钟', kind: 'replica', contentType: '美食', durationSec: 18,
      beats: 2, shots: 0, hook: '三分钟做一杯手冲', hookType: '', platformLabel: '抖音',
      structure: [], storyboard: [], timing: null, cover: '', reuseCount: 0,
    },
    flow: { id: 'flow_cur', name: '咖啡 v' + (entries.length + 1), nodes: currentNodeList.length, updatedAt: '2026-11-12T05:00:00.000Z', nodeList: currentNodeList },
    script: currentScript,
    reviews,
    versions: entries,
    versionCounts: {},
    runs,
    runTotal: runs.length,
    runCounts,
  }
}

const build = (detail) => projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ }).markdown

test('每一版都有自己的明细块，从新到旧，带归档时间、评审与运行', () => {
  const detail = fixture({
    archived: [
      { n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', script: scriptOf('钩子 A', [['开场', '第一版开头']]) },
      { n: 2, name: '咖啡 v2', archivedAt: '2026-11-12T05:00:00.000Z', script: scriptOf('钩子 B', [['开场', '第二版开头']]) },
    ],
    reviews: [
      { id: 'rev_2', version: 2, verdict: 'pass', summary: '字幕压到安全区就行', observations: 1, createdAt: '2026-11-12T04:50:00.000Z' },
      { id: 'rev_1', version: 1, verdict: 'fail', summary: '开头太慢', observations: 3, createdAt: '2026-11-12T03:10:00.000Z' },
    ],
    runCounts: { '1': 1, '2': 2 },
    runs: [
      { id: 'run_2', status: 'success', startedAt: '2026-11-12T04:55:00.000Z', version: 2, total: 2, error: '' },
      { id: 'run_1', status: 'failed', startedAt: '2026-11-12T03:20:00.000Z', version: 1, total: 2, error: '视觉模型超时' },
    ],
  })
  const markdown = build(detail)
  assert.ok(markdown.includes('### v2 · 咖啡 v2'))
  assert.ok(markdown.includes('### v1 · 咖啡 v1'))
  assert.ok(markdown.indexOf('### v2') < markdown.indexOf('### v1'), '从新到旧')
  assert.ok(markdown.includes('- 归档：2026-11-12 13:00'))
  assert.ok(markdown.includes('- 评审：1 次；最近「通过」（2026-11-12 12:50，1 条问题）：字幕压到安全区就行'))
  assert.ok(markdown.includes('- 运行：1 次，这次失败了（最近一次 2026-11-12 11:20 失败：「视觉模型超时」）'))
  assert.ok(markdown.includes('共 3 版，现在是 v3'))
})

test('脚本快照用来对比：多段、少段、改口播、换钩子', () => {
  const detail = fixture({
    archived: [
      { n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', script: scriptOf('旧钩子', [['开场', '一样的一句'], ['闷蒸', '先闷蒸']]) },
      { n: 2, name: '咖啡 v2', archivedAt: '2026-11-12T05:00:00.000Z', script: scriptOf('新钩子', [['开场', '一样的一句'], ['闷蒸', '再闷蒸三十秒'], ['收尾', '一分钟后出杯']]) },
    ],
    // 当前 v3 又删了一段：当前版与上一版同样要有一句交代
    currentScript: scriptOf('新钩子', [['开场', '一样的一句'], ['闷蒸', '再闷蒸三十秒']]),
  })
  const markdown = build(detail)
  assert.ok(markdown.includes('比 v1 多 1 段（收尾）'), '新增段落要点名')
  assert.ok(markdown.includes('1 段口播改过'))
  assert.ok(markdown.includes('钩子换过'))
  assert.ok(markdown.includes('v3 比 v2：'), '当前版相对上一版也要有一句')
})

test('跟上一版完全一样时就说一样，不硬找差异', () => {
  const same = scriptOf('同一个钩子', [['开场', '同一句']])
  const detail = fixture({
    archived: [
      { n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', script: same, nodes: nodesOf('复刻脚本') },
      { n: 2, name: '咖啡 v2', archivedAt: '2026-11-12T05:00:00.000Z', script: same, nodes: nodesOf('复刻脚本') },
    ],
    currentScript: same,
    currentNodeList: nodesOf('复刻脚本'),
  })
  const markdown = build(detail)
  assert.ok(markdown.includes('画布节点没动；脚本跟上一版一样'))
  assert.ok(markdown.includes('- 画布：比 v1 节点没动'))
})

test('没存快照的版本说实话：不拿现在的脚本冒充当时的', () => {
  const detail = fixture({
    archived: [{ n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z' }],
    currentScript: scriptOf('现在的钩子', [['开场', '现在的一句']]),
  })
  const markdown = build(detail)
  assert.ok(markdown.includes('- 脚本：这一版没存快照（开版时还没有快照功能），当时的口播找不回来了'))
  assert.ok(markdown.includes('| v1 | 咖啡 v1 | 0 | 没存快照 |'))
  const block = markdown.slice(markdown.indexOf('### v1'))
  assert.ok(!block.includes('现在的一句'), '历史版本的块里不能出现当前脚本的内容')
})

test('画布对比：多、少、改都点名；画布被删时说明只剩归档', () => {
  const removed = fixture({
    archived: [{ n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', nodes: nodesOf('复刻脚本', '配音') }],
    currentNodeList: nodesOf('复刻脚本', '出图'),
  })
  const markdown = build(removed)
  assert.ok(markdown.includes('画布多 1 个（出图）、少 1 个（配音）') || markdown.includes('画布多 1 个（出图）、少 1 个（配音）、改 1 个（复刻脚本）'))

  const gone = fixture({ archived: [{ n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', available: false }] })
  assert.ok(build(gone).includes('画布已经被删除，只剩这一行归档记录'))
})

test('版数很多时只写最近几版，表里仍然是全量', () => {
  const archived = Array.from({ length: DELIVERABLE_LIMITS.versions + 3 }, (_, index) => ({
    n: index + 1,
    name: '咖啡 v' + (index + 1),
    archivedAt: '2026-11-12T0' + (index % 10) + ':00:00.000Z',
    script: scriptOf('钩子 ' + index, [['开场', '第 ' + index + ' 句']]),
  }))
  const markdown = build(fixture({ archived }))
  const blocks = markdown.split('\n').filter((line) => line.startsWith('### v'))
  assert.equal(blocks.length, DELIVERABLE_LIMITS.versions)
  const rows = markdown.split('\n').filter((line) => /^\| v\d+/.test(line))
  assert.equal(rows.length, archived.length + 1, '表里仍然有全部版本')
})

test('运行明细只留最近几次时，说清楚「1 次失败」不是全部', () => {
  const detail = fixture({
    archived: [{ n: 1, name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z' }],
    runCounts: { '1': 5 },
    runs: [{ id: 'run_1', status: 'failed', startedAt: '2026-11-12T03:20:00.000Z', version: 1, total: 2, error: '节点超时' }],
  })
  assert.ok(build(detail).includes('- 运行：5 次，明细只留最近 1 次（其中 1 次失败（最近一次 2026-11-12 11:20 失败：「节点超时」））'))
})
