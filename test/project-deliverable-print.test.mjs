import test from 'node:test'
import assert from 'node:assert/strict'
import { projectDeliverable } from '../server/project-deliverable.mjs'
import {
  deliverablePrintHtml,
  printNoticeHtml,
  renderDeliverableBody,
  splitTableRow,
} from '../server/project-deliverable-html.mjs'

// 打印稿是交付稿的第二个出口：编导要把它摊在桌上改，制片要把它发给剪辑。
// 这一组测试盯住四件事：
//   1) 纸上的内容来自同一份 Markdown（不再拼一遍数据，就不会两处各说一套）；
//   2) 表格、列表、粗体、引用都排对了（排错了纸上就是一堆星号和竖线）；
//   3) 所有文本先转义（台词里写着 <script> 也只是字）；
//   4) 纸是一张 A4（@page 尺寸写死，打印对话框里不用再选）。

const NOW = new Date('2026-11-12T13:40:00.000Z')
const TZ = 480

function detail() {
  return {
    project: {
      id: 'prj_a',
      title: '咖啡 3 分钟',
      templateId: 'tpl_a',
      flowId: 'flow_2',
      version: 2,
      versions: [{ n: 1, flowId: 'flow_1', name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z' }],
      status: 'active',
      createdAt: '2026-11-11T02:00:00.000Z',
      updatedAt: '2026-11-12T05:30:00.000Z',
    },
    share: { token: 'tok_secret_abc', createdAt: '2026-11-12T05:00:00.000Z' },
    template: {
      id: 'tpl_a',
      title: '咖啡 3 分钟',
      durationSec: 18,
      beats: 2,
      shots: 2,
      hookType: '提问式',
      platformLabel: '抖音',
      storyboard: [
        { shotNo: 1, startSec: 0, endSec: 3, visual: '近景手部 | 俯拍', camera: '俯拍', caption: '三分钟', audio: '环境声', purpose: '钩子', expectedSec: 3.2, fit: 'ok' },
        { shotNo: 2, startSec: 3, endSec: 8, visual: '中景\n拉花', camera: '侧拍', caption: '闷蒸 30 秒', audio: '', purpose: '', expectedSec: 5.6, fit: 'tight' },
      ],
      reuseCount: 3,
    },
    flow: { id: 'flow_2', name: '咖啡 v2', nodes: 6 },
    script: {
      hook: '三分钟做一杯手冲',
      structure: [
        { beat: '开场', startSec: 0, endSec: 3, voiceover: '三分钟做一杯手冲咖啡', onScreen: '00:03', purpose: '抓住', expectedSec: 2.9, fit: 'ok' },
        { beat: '闷蒸', startSec: 3, endSec: 8, voiceover: '先闷蒸三十秒', onScreen: '', purpose: '教学', expectedSec: 7.1, fit: 'tight' },
      ],
      source: 'project',
      updatedAt: '2026-11-12T05:30:00.000Z',
      timing: { estimatedSec: 10, durationSec: 18, pace: 'normal', rate: 4.2, overSec: 0, tight: 1 },
    },
    reviews: [{ id: 'rev_1', version: 2, verdict: 'needs_review', summary: '结构清楚', createdAt: '2026-11-12T05:10:00.000Z' }],
    versions: [{ n: 1, flowId: 'flow_1', name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', available: true, nodes: 5 }],
    versionCounts: { '2': { count: 1, lastVerdict: 'needs_review', lastAt: '2026-11-12T05:10:00.000Z' } },
    runs: [
      { id: 'run_2', status: 'success', startedAt: '2026-11-12T05:20:00.000Z', durationMs: 61400, total: 6, failed: 0, error: '', credits: { cost: 3 }, version: 2 },
    ],
    runTotal: 1,
    runCounts: { '2': 1 },
  }
}

const REVIEW = {
  id: 'rev_1',
  version: 2,
  createdAt: '2026-11-12T05:10:00.000Z',
  result: {
    verdict: 'needs_review',
    summary: '钩子够快，中段字幕换行太密',
    profile: 'deepseek-flash',
    provider: 'deepseek',
    ms: 43100,
    observations: [{ dimension: '字幕', severity: 'major', statement: '第 2 镜字幕一行 18 个字', confidence: 0.82 }],
    fixes: [{ title: '拆短字幕', detail: '每行不超过 12 个字' }],
    notAssessable: ['音色是否合适'],
    judge: { status: 'ok', evidenceConsistent: 0.9, actionable: 0.95, publishRisk: { score: 2 } },
  },
}

test('抬头三件：标题、引题、事实表', () => {
  const html = renderDeliverableBody('# 咖啡 3 分钟\n\n一条作品的完整稿。\n\n- 作品编号：prj_a\n- 状态：在做（当前第 2 版）\n')
  assert.match(html, /<h1 class="sheet-title">咖啡 3 分钟<\/h1>/)
  assert.match(html, /<p class="lede">一条作品的完整稿。<\/p>/)
  assert.match(html, /<ul class="sheet-facts">/)
  assert.match(html, /<span class="fact-k">作品编号<\/span><span class="fact-v">prj_a<\/span>/)
  // 没有冒号的行整行放进值里，不丢字
  const plain = renderDeliverableBody('# T\n\n- 只有一句话没有冒号\n')
  assert.match(plain, /<span class="fact-v">只有一句话没有冒号<\/span>/)
})

test('表格：表头进 thead、分隔行不出现、\\| 算一格', () => {
  const html = renderDeliverableBody('| 时间 | 口播 |\n| --- | --- |\n| 0-3 秒 | 三分钟 |\n')
  assert.match(html, /<thead><tr><th>时间<\/th><th>口播<\/th><\/tr><\/thead>/)
  assert.match(html, /<tbody><tr><td>0-3 秒<\/td><td>三分钟<\/td><\/tr><\/tbody>/)
  assert.ok(!html.includes('---'), '分隔行不该出现在纸上')
  assert.deepEqual(splitTableRow('| a\\|b | c |'), ['a|b', 'c'])
})

test('转义：标题与台词里写着 <script> 也只是字', () => {
  const html = renderDeliverableBody('# <script>alert(1)</script>\n\n| 画面 |\n| --- |\n| <img onerror=x> |\n')
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('<img'))
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('粗体、引用、有序列表、分隔线', () => {
  const html = renderDeliverableBody('**重要 · 字幕**：太长\n\n> 一句结论\n\n1. 第一条\n2. 第二条\n\n---\n\n尾\n')
  assert.match(html, /<strong>重要 · 字幕<\/strong>/)
  assert.match(html, /<blockquote><p>一句结论<\/p><\/blockquote>/)
  assert.match(html, /<ol><li>第一条<\/li><li>第二条<\/li><\/ol>/)
  assert.match(html, /<hr>/)
})

test('空输入不炸', () => {
  assert.equal(renderDeliverableBody(''), '')
  assert.equal(renderDeliverableBody(null), '')
})

test('整份：一份 Markdown 出两张纸，内容同文', () => {
  const { markdown, fileName } = projectDeliverable(detail(), { review: REVIEW, now: NOW, tzOffsetMinutes: TZ })
  const html = deliverablePrintHtml({ markdown, projectId: 'prj_a', title: '咖啡 3 分钟' })
  // A4 与打印样式：纸张尺寸写死，屏幕上的装饰在纸上隐藏
  assert.match(html, /@page \{ size: A4; margin: 16mm 14mm; \}/)
  assert.match(html, /@media print \{/)
  assert.match(html, /class="bar"/)
  assert.match(html, /data-print/)
  assert.match(html, /<img class="sheet-mark" src="\/brand\/visionqa-lockup.svg"/)
  // 七个小节都排出来了
  for (const title of ['时长对账', '脚本', '分镜', '评审', '版本对照', '运行记录', '交付']) {
    assert.ok(html.includes('>' + title + '</h2>'), '缺少小节：' + title)
  }
  // 没有漏网的 Markdown 记号
  assert.ok(!html.includes('**'), '粗体应该变成 <strong>')
  assert.ok(!/\|\s*---/.test(html), '表格分隔行应该被吃掉')
  assert.ok(!html.includes('tok_secret_abc'), '分享 token 不进稿子，也不进纸')
  // 稿子的文件名与抬头来自同一次组装
  assert.equal(fileName, 'VisionQA-咖啡 3 分钟-20261112.md')
  assert.ok(markdown.includes('咖啡 3 分钟'))
})

test('打不开时给一张纸，不给 JSON', () => {
  const html = printNoticeHtml({
    title: '登录已过期',
    message: '回到作品页再点一次「打印稿」。',
    href: '/#/login',
    label: '去登录',
  })
  assert.match(html, /<h1 class="sheet-title">登录已过期<\/h1>/)
  assert.match(html, /href="\/#\/login"/)
  assert.match(html, />去登录<\/a>/)
  assert.ok(!html.includes('<button'), '通知页没有打印按钮')
})
