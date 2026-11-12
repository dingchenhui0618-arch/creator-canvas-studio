// 评审对照纸：把评审给出的证据框排到页面上。
// 这里验的是「纸上框在哪、编号对不对得起来、缺图时怎么写」——版面好看与否由截图验收。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REVIEW_SHEET_LIMITS,
  boxText,
  normalizeBox,
  reviewImageRef,
  reviewSheetBlocks,
  reviewSheetHtml,
  reviewSheetSelection,
} from '../server/project-review-sheet.mjs'
import { packageNote } from '../server/project-set-sheet.mjs'
import { projectDeliverable } from '../server/project-deliverable.mjs'

const project = { id: 'prj_rv', title: '毛衣折叠收纳法', version: 2 }

function record(overrides = {}) {
  return {
    id: 'rev_a',
    version: 2,
    createdAt: '2026-11-12T12:00:00.000Z',
    source: { kind: 'template', label: '毛衣折叠收纳法 · v2', media: 'frames/tpl_rv/frame-01.jpg', imageUrl: '' },
    result: {
      verdict: 'needs_review',
      summary: '首帧里人和毛衣都在，但标题压住折叠起点',
      provider: 'local-model:deepseek-flash',
      model: 'deepseek-flash',
      ms: 37969,
      observations: [
        {
          id: 'obs-1',
          dimension: 'composition',
          severity: 'major',
          statement: '红色标题「毛衣折叠」横跨 x0.14–0.58，压住毛衣上缘折叠起点',
          evidence: { x: 0.13, y: 0.45, w: 0.47, h: 0.12 },
          confidence: 0.85,
        },
        {
          id: 'obs-2',
          dimension: 'spacing',
          severity: 'minor',
          statement: '标题底边与小熊图案上沿重叠',
          evidence: { x: 1.2, y: 0.5, w: 0.2, h: 0.1 },
          confidence: 0.55,
        },
      ],
      fixes: [{ title: '把标题移出折叠区', detail: '下移到 y0.82–0.90 的桌面空区' }],
      notAssessable: ['这是静态单帧，手部动作是否连贯无法判断。'],
      judge: { status: 'ok', evidenceConsistent: 0.92, actionable: 0.96, publishRisk: { score: 2 } },
    },
    ...overrides,
  }
}

test('每版取最近一次：v0 折进 v1，按版本从新到旧，最多三版', () => {
  const records = [
    record({ id: 'old', createdAt: '2026-11-12T10:00:00.000Z' }),
    record({ id: 'new', createdAt: '2026-11-12T12:00:00.000Z' }),
    record({ id: 'v0', version: 0, createdAt: '2026-11-11T12:00:00.000Z' }),
    record({ id: 'v1', version: 1, createdAt: '2026-11-11T13:00:00.000Z' }),
    record({ id: 'v3', version: 3, createdAt: '2026-11-12T13:00:00.000Z' }),
    record({ id: 'v4', version: 4, createdAt: '2026-11-12T14:00:00.000Z' }),
  ]
  const { blocks, total, shown } = reviewSheetBlocks(records)
  assert.equal(total, 4, 'v0 与 v1 是同一版，不能算两版')
  assert.equal(shown, REVIEW_SHEET_LIMITS.blocks)
  assert.deepEqual(blocks.map((block) => block.version), [4, 3, 2], '从新到旧，超出上限的旧版不印')
  assert.equal(blocks[2].id, 'new', '同一版重评多次只印最近那一次')
})

test('挑评审的规则只有一份：摘要和全文都走 reviewSheetSelection', () => {
  const records = [
    { id: 'v2-old', version: 2, createdAt: '2026-11-12T10:00:00.000Z' },
    { id: 'v2-new', version: 2, createdAt: '2026-11-12T12:00:00.000Z' },
    { id: 'v0', version: 0, createdAt: '2026-11-11T10:00:00.000Z' },
    { id: 'v1', version: 1, createdAt: '2026-11-11T12:00:00.000Z' },
    { id: 'v3', version: 3, createdAt: '2026-11-12T13:00:00.000Z' },
    { id: 'v4', version: 4, createdAt: '2026-11-12T14:00:00.000Z' },
  ]
  const { records: selected, total } = reviewSheetSelection(records)
  assert.equal(total, 4, 'v0 与 v1 算同一版')
  assert.deepEqual(selected.map((item) => item.id), ['v4', 'v3', 'v2-new'], '从新到旧、每版最近一次、最多三版')
  assert.deepEqual(reviewSheetSelection([]), { records: [], total: 0 })
})

test('证据框：压边裁进画面，整块出画面的丢掉，位置写成人能照着找的百分比', () => {
  const box = normalizeBox({ x: -0.2, y: 0.45, w: 0.5, h: 0.2 })
  assert.deepEqual(box, { x: 0, y: 0.45, w: 0.3, h: 0.2 }, '左边出画的框要裁到 0 起')
  assert.equal(normalizeBox({ x: 1.2, y: 0.5, w: 0.2, h: 0.1 }), null, '整块在画面外就不画')
  assert.equal(normalizeBox({ x: 0.1, y: 0.1, w: 0, h: 0 }), null, '没有面积的不算框')
  assert.equal(normalizeBox(null), null)
  assert.equal(boxText({ x: 0.13, y: 0.45, w: 0.47, h: 0.12 }), '框 x 13–60% · y 45–57%')
})

test('评审画面只认自己存下的帧图：带路径的一律不收', () => {
  assert.deepEqual(reviewImageRef({ media: 'frames/tpl_rv/frame-01.jpg' }), { templateId: 'tpl_rv', file: 'frame-01.jpg' })
  assert.equal(reviewImageRef({ media: '/media/frames/tpl_rv/frame-01.jpg' }), null, 'source.media 不带前导斜杠')
  assert.equal(reviewImageRef({ media: 'frames/tpl_rv/../../etc/passwd' }), null)
  assert.equal(reviewImageRef({ media: 'frames/tpl_rv/..' }), null)
  assert.equal(reviewImageRef({ imageUrl: 'https://example.com/a.jpg' }), null)
  assert.equal(reviewImageRef({}), null)
})

test('对照纸：框上的编号就是问题列表的编号，结论与判断层照写', () => {
  const html = reviewSheetHtml({ project, records: [record()], now: new Date('2026-11-12T15:20:00.000Z'), tzOffsetMinutes: 480 })
  assert.match(html, /评审对照 · 毛衣折叠收纳法/)
  assert.match(html, /REVIEW \/ A4/)
  assert.match(html, /v2 · 需人工确认/)
  assert.match(html, /依据 92% · 可执行 96% · 发布风险 2/)
  assert.match(html, /<img src="\/media\/frames\/tpl_rv\/frame-01\.jpg"/, '线上直接走登录态的帧图地址')
  assert.match(html, /data-no="1" style="left:13\.00%;top:45\.00%;width:47\.00%;height:12\.00%"/)
  assert.equal((html.match(/data-no=/g) || []).length, 1, '第二条问题的框贴在画外，纸上只该有一个框')
  assert.match(html, /<span class="rev-sev is-major">重要 · 构图与裁切<\/span>红色标题/, '第 1 条与 1 号框对得上')
  // v0.9.21 起纸脚把两件事分开写：框是谁给的 / 有没有人复核过。没人拍板时后半句才写「不是人工复核」
  assert.match(html, /框是评审当时给出的位置（相对画面比例）/)
  assert.match(html, /不是人工复核/)
  assert.match(html, /2026-11-12 23:20/, '纸脚按东八区写导出时间')
})

test('对照纸：台词、标题里的尖括号只显示成字，不会变成标签', () => {
  const html = reviewSheetHtml({
    project: { ...project, title: '<img src=x onerror=alert(1)>' },
    records: [record({ result: { ...record().result, summary: '<script>alert(1)</script>', observations: [{ dimension: 'color', severity: 'minor', statement: '<b>不要</b>', confidence: 0.5 }] } })],
  })
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /&lt;b&gt;不要&lt;\/b&gt;/)
})

test('对照纸：下进交付包时不带「返回作品」，也没有联网取图的地址', () => {
  const html = reviewSheetHtml({
    project,
    records: [record({ source: { kind: 'template', label: '外部图', media: '', imageUrl: 'https://example.com/x.jpg' } })],
    offline: true,
    imageSrc: () => '',
    projectId: project.id,
  })
  assert.doesNotMatch(html, /返回作品/)
  assert.doesNotMatch(html, /\/brand\/visionqa-lockup\.svg/)
  assert.doesNotMatch(html, /example\.com/, '外部图不写进纸，也不替它下载')
  assert.match(html, /这次评审的画面不在我们的帧图里/)
  assert.match(html, /data-print/)
  assert.doesNotMatch(html, /data-range/)
})

test('对照纸：没有评审时照实说，不编一个结论', () => {
  const html = reviewSheetHtml({ project, records: [] })
  assert.match(html, /这一版还没送过评审/)
  assert.doesNotMatch(html, /data-no=/, '没有评审就没有框')
  assert.doesNotMatch(html, /<section class="rev-block">/)
  assert.match(html, /没有可印的评审/)
})

test('交付稿：问题后面带框的百分比，并指向交付包里的对照页', () => {
  const detail = {
    project: { ...project, version: 2, status: 'doing', createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z' },
    template: { id: 'tpl_rv', title: '毛衣折叠收纳法', platformLabel: '抖音', durationSec: 18, beats: 2, shots: 2, storyboard: [] },
    flow: null,
    script: null,
    reviews: [],
    versions: [],
    versionCounts: { 2: { count: 1, lastVerdict: 'needs_review', lastAt: '2026-11-12T12:00:00.000Z' } },
    runs: [],
    runTotal: 0,
    runCounts: {},
    share: null,
  }
  const { markdown } = projectDeliverable(detail, { review: record(), now: new Date('2026-11-12T15:20:00.000Z'), tzOffsetMinutes: 480 })
  assert.match(markdown, /1\. \*\*重要 · 构图与裁切\*\*：红色标题「毛衣折叠」横跨 x0\.14–0\.58，压住毛衣上缘折叠起点（依据强度 85% · 框 x 13–60% · y 45–57%）/)
  assert.match(markdown, /2\. \*\*轻微 · 对齐与间距\*\*/)
  assert.match(markdown, /证据框：1 条问题在画面上框了位置/)
  assert.match(markdown, /评审对照页\.html/)
})

test('分享页的对照纸：回分享页、画面走带 token 的帧图、不印作品内部 id', () => {
  const html = reviewSheetHtml({
    project: { title: '毛衣折叠收纳法', version: 2 },
    records: [record()],
    backHref: '/#/share/project/tok_share_1234567890',
    backLabel: '返回分享页',
    originNote: '来自只读分享链接：链接停用后这个地址会打不开，已经存下来的 PDF 不受影响。',
    imageSrc: () => '/api/share/project/tok_share_1234567890/frame/1',
  })
  assert.match(html, /返回分享页/)
  assert.match(html, /#\/share\/project\/tok_share_1234567890/)
  assert.match(html, /<img src="\/api\/share\/project\/tok_share_1234567890\/frame\/1"/, '画面走分享链接自己的帧图接口')
  assert.doesNotMatch(html, /\/media\/frames/, '分享页拿不到要登录的帧图，纸上不能留着那个地址')
  assert.match(html, /来自只读分享链接/)
  assert.doesNotMatch(html, /作品编号/, '内部作品 id 不跟着分享出去')
  assert.match(html, /data-no="1"/)
})

test('分享页的对照纸：帧图不在分享里时照实写，不替它去别处取图', () => {
  const html = reviewSheetHtml({
    project: { title: '毛衣折叠收纳法' },
    records: [record()],
    imageSrc: () => '',
    missingText: '这次评审评的那张帧图不在这个分享里：分享只给这条作品分镜里的帧。问题与编号仍按原文列出。',
  })
  assert.match(html, /不在这个分享里/)
  assert.doesNotMatch(html, /\/media\/frames/)
  assert.doesNotMatch(html, /data-no=/, '没有画面就不画框：无图的框只会指向空气')
  assert.match(html, /这次的问题带了框的位置，但画面不在这份产物里，框画不出来/)
})

test('交付包的说明：有评审对照页才写这一行', () => {
  const model = { title: '毛衣折叠收纳法', version: 2, id: 'prj_rv', shotTotal: 8, shotsOff: 0 }
  const withSheet = packageNote({ model, frameCount: 2, reviewSheetCount: 1 })
  assert.match(withSheet, /评审对照页\.html/)
  assert.match(withSheet, /（1 版）/)
  const without = packageNote({ model, frameCount: 2 })
  assert.doesNotMatch(without, /评审对照页\.html/)
})
