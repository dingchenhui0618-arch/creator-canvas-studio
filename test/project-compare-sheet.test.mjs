// 两版对照纸（v0.9.121）：纸上写什么、缺数据时不写什么。
// 这一组盯住四件事：
//   1) 评审与交付左右各写各的：交时快照与后来重评分开，不拿最新覆盖历史；
//   2) 工作流逐项列参数、脚本逐段列口播，变了才写，没变不硬编；
//   3) 缺工作流 / 缺脚本 / 没评过 / 没交付时照实说，不拿别的版本顶；
//   4) 所有用户内容先转义再进纸，标题里写 <script> 也只是一行字。
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSheetHtml } from '../server/project-compare-sheet.mjs'

const project = { id: 'prj_cmp', title: '毛衣折叠收纳法' }

const issues = (blocker, major, minor, info = 0) => ({
  blocker,
  major,
  minor,
  info,
  counted: blocker + major + minor + info,
  observations: blocker + major + minor + info,
})

const compare = {
  base: {
    n: 2,
    name: '毛衣折叠收纳法 v2',
    current: false,
    nodes: 4,
    beats: 3,
    canvasAvailable: true,
    scriptAvailable: true,
    review: { count: 2, verdict: 'needs_review', at: '2026-11-15T00:10:00.000Z', issues: issues(0, 1, 0) },
    delivery: {
      at: '2026-11-14T16:44:00.000Z',
      review: { verdict: 'pass', at: '2026-11-14T16:44:00.000Z', issues: issues(0, 1, 0) },
    },
  },
  target: {
    n: 3,
    name: '毛衣折叠收纳法 v3',
    current: true,
    nodes: 4,
    beats: 3,
    canvasAvailable: true,
    scriptAvailable: true,
    review: { count: 1, verdict: 'needs_review', at: '2026-11-15T00:50:00.000Z', issues: issues(1, 0, 0) },
    delivery: null,
  },
  summary: '工作流改 1 个节点；脚本：1 段口播改过；钩子换过',
  canvas: {
    added: [{ id: 'n_image', title: '出图' }],
    removed: [{ id: 'n_old', title: '旧输出' }],
    changed: [{ id: 'n_llm', title: '写一句' }],
    fields: {
      n_llm: [{ key: 'systemPrompt', label: '提示词', before: '第一版提示词', after: '第三版提示词', truncated: false }],
    },
  },
  script: {
    added: ['收尾'],
    removed: ['旧口播'],
    changed: [{ name: '闷蒸', before: ['第一版闷蒸'], after: ['第二版闷蒸'] }],
    hookChanged: true,
    hookBefore: '第一版钩子',
    hookAfter: '第二版钩子',
  },
  reviewChange: { text: '主要多 1 个', tone: 'worse' },
  notes: [],
}

const html = (patch = {}) =>
  compareSheetHtml({ project, compare: { ...compare, ...patch }, now: new Date('2026-11-15T01:00:00.000Z'), tzOffsetMinutes: 480, projectId: project.id })

test('两版对照纸：评审、交付、工作流参数、脚本口播都在，方向是 v2 → v3', () => {
  const out = html()
  assert.match(out, /两版对照 · 毛衣折叠收纳法/)
  assert.match(out, /VERSION DIFF \/ A4/)
  assert.match(out, /v2 → v3/)
  assert.match(out, /4 → 4 节点/)
  assert.match(out, /2 次评审 · 1 主要/)
  assert.match(out, /交付过 · 2026-11-15 00:44/)
  assert.match(out, /交时评审：通过 · 1 主要/)
  assert.match(out, /交付之后又评成「需人工确认」/)
  assert.match(out, /<span class="cmp-tag">变差<\/span>/)
  assert.match(out, /新增节点/)
  assert.match(out, /去掉节点/)
  assert.match(out, /改过节点/)
  assert.match(out, /出图/)
  assert.match(out, /旧输出/)
  assert.match(out, /提示词/)
  assert.match(out, /第一版提示词/)
  assert.match(out, /第三版提示词/)
  assert.match(out, /第一版闷蒸/)
  assert.match(out, /第二版闷蒸/)
  assert.match(out, /第一版钩子/)
  assert.match(out, /第二版钩子/)
  assert.match(out, /主要多 1 个/)
  assert.match(out, /只读对照：不改工作流、不改脚本、不写交付记录、不扣积分/)
  assert.match(out, /data-print/)
  assert.doesNotMatch(out, /undefined/, '没数据的字段不要漏成 undefined')
})

test('两版对照纸：交时评审三种状态分开写，不拿最新一评冒充', () => {
  const legacy = html({
    base: { ...compare.base, delivery: { at: '2026-11-14T16:44:00.000Z' } },
  })
  assert.match(legacy, /交时评审：没记（升级前的交付记录）/)

  const notReviewed = html({
    base: { ...compare.base, delivery: { at: '2026-11-14T16:44:00.000Z', review: null } },
  })
  assert.match(notReviewed, /交时评审：还没评过/)

  const newer = html({
    base: {
      ...compare.base,
      review: { count: 3, verdict: 'fail', at: '2026-11-15T00:00:00.000Z', issues: issues(2, 0, 0) },
      delivery: { at: '2026-11-14T16:44:00.000Z', review: { verdict: 'pass', at: '2026-11-14T16:44:00.000Z', issues: issues(0, 1, 0) } },
    },
  })
  assert.match(newer, /交时评审：通过 · 1 主要/)
  assert.match(newer, /交付之后又评成「不通过」/)
  assert.doesNotMatch(newer, /交时评审：不通过/, '交时快照不能被最近一评覆盖')
})

test('两版对照纸：缺工作流 / 缺脚本 / 没评过 / 没交付时照实说', () => {
  const out = html({
    canvas: null,
    script: null,
    base: {
      ...compare.base,
      review: { count: 0, verdict: '', at: '', issues: null },
      delivery: null,
    },
    target: {
      ...compare.target,
      review: { count: 0, verdict: '', at: '', issues: null },
      delivery: null,
    },
    reviewChange: { text: '有一版还没评审，结论与问题数不比', tone: 'unknown' },
    notes: ['有一版的工作流已被删除：工作流这一侧不比，脚本仍按快照比。'],
  })
  assert.match(out, /有一侧工作流读不到：工作流这一侧不比/)
  assert.match(out, /有一侧脚本没存快照：脚本这一侧不比/)
  assert.match(out, /还没评过/)
  assert.match(out, /没交付/)
  assert.match(out, /看不出来/)
  assert.match(out, /这张纸没比的部分/)
  assert.match(out, /工作流已被删除/)
  assert.doesNotMatch(out, /节点没动/, '缺工作流不能说「没动」')
  assert.doesNotMatch(out, /口播与钩子都没动/, '缺脚本不能说「没动」')
})

test('两版对照纸：用户内容先转义，标题与参数里写标签也只显示成字', () => {
  const out = compareSheetHtml({
    project: { id: 'prj_cmp', title: '<img src=x onerror=alert(1)>' },
    compare: {
      ...compare,
      canvas: {
        ...compare.canvas,
        changed: [{ id: 'n_llm', title: '<b>写一句</b>' }],
        fields: {
          n_llm: [{ key: 'systemPrompt', label: '提示词', before: '<script>alert(1)</script>', after: '&lt;ok&gt;', truncated: false }],
        },
      },
      summary: '<script>alert(2)</script>',
    },
    now: new Date('2026-11-15T01:00:00.000Z'),
    tzOffsetMinutes: 480,
    projectId: 'prj_cmp',
  })
  assert.ok(!out.includes('<img src=x onerror=alert(1)>'))
  assert.ok(!out.includes('<script>alert(1)</script>'))
  assert.ok(!out.includes('<script>alert(2)</script>'))
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(out, /&lt;b&gt;写一句&lt;\/b&gt;/)
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(out, /&amp;lt;ok&amp;gt;/)
  assert.match(out, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
})

test('两版对照纸：没交付不写交付后漂移；两边都没评过时不编「没变」', () => {
  const out = html({
    base: { ...compare.base, delivery: null, review: { count: 0, verdict: '', at: '', issues: null } },
    target: { ...compare.target, delivery: null, review: { count: 0, verdict: '', at: '', issues: null } },
    reviewChange: { text: '有一版还没评审，结论与问题数不比', tone: 'unknown' },
  })
  assert.doesNotMatch(out, /交付之后/)
  assert.doesNotMatch(out, /后来重评/)
  assert.match(out, /有一版还没评审/)
})
