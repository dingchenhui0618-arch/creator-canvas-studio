import test from 'node:test'
import assert from 'node:assert/strict'
import { projectDeliverable, deliverableFileName, DELIVERABLE_LIMITS } from '../server/project-deliverable.mjs'

// 交付稿是「把一条作品拿出工作台」的唯一出口：编导要能把它发给剪辑、打印成纸质稿。
// 这一组测试盯住四件容易退化的行为：
//   1) 只写发生过的事（没评审不编结论）；
//   2) 不把分享 token 写进稿子（它等于一把钥匙）；
//   3) 版本口径与作品页一致（版本 0 的历史评审折进 v1）；
//   4) 表格不会因为一个竖线或换行就散架。

const NOW = new Date('2026-11-12T13:40:00.000Z')
const TZ = 480

function fixture(overrides = {}) {
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
      ...overrides.project,
    },
    share: { token: 'tok_secret_abc', createdAt: '2026-11-12T05:00:00.000Z' },
    template: {
      id: 'tpl_a',
      title: '咖啡 3 分钟',
      kind: 'replica',
      contentType: '美食',
      durationSec: 18,
      beats: 2,
      shots: 2,
      hook: '三分钟做一杯手冲',
      hookType: '提问式',
      platformLabel: '抖音',
      structure: [],
      storyboard: [
        { shotNo: 1, startSec: 0, endSec: 3, visual: '近景手部', camera: '俯拍', caption: '三分钟', audio: '环境声', purpose: '钩子', expectedSec: 3.2, fit: 'ok' },
        { shotNo: 2, startSec: 3, endSec: 8, visual: '中景\n拉花', camera: '侧拍', caption: '闷蒸 30 秒', audio: '', purpose: '', expectedSec: 5.6, fit: 'tight' },
      ],
      timing: null,
      cover: '',
      reuseCount: 3,
      ...overrides.template,
    },
    flow: { id: 'flow_2', name: '咖啡 v2', nodes: 6, updatedAt: '2026-11-12T05:00:00.000Z' },
    script: {
      hook: '三分钟做一杯手冲',
      structure: [
        { beat: '开场', startSec: 0, endSec: 3, voiceover: '三分钟做一杯手冲咖啡', onScreen: '00:03', purpose: '抓住', expectedSec: 2.9, fit: 'ok' },
        { beat: '闷蒸', startSec: 3, endSec: 8, voiceover: '先闷蒸三十秒', onScreen: '', purpose: '教学', expectedSec: 7.1, fit: 'tight' },
      ],
      source: 'project',
      updatedAt: '2026-11-12T05:30:00.000Z',
      timing: { estimatedSec: 10, actualSec: 8, durationSec: 18, fit: 'ok', pace: 'normal', rate: 4.2, overSec: 0, tight: 1, loose: 0 },
      ...overrides.script,
    },
    reviews: [{ id: 'rev_1', version: 2, verdict: 'needs_review', summary: '结构清楚', createdAt: '2026-11-12T05:10:00.000Z' }],
    versions: [{ n: 1, flowId: 'flow_1', name: '咖啡 v1', archivedAt: '2026-11-12T04:00:00.000Z', available: true, nodes: 5 }],
    versionCounts: {
      '1': { count: 1, lastVerdict: 'pass', lastAt: '2026-11-12T03:00:00.000Z' },
      '2': { count: 1, lastVerdict: 'needs_review', lastAt: '2026-11-12T05:10:00.000Z' },
    },
    runs: [
      { id: 'run_2', flowId: 'flow_2', flowName: 'v2', status: 'success', startedAt: '2026-11-12T05:20:00.000Z', durationMs: 61400, total: 6, failed: 0, error: '', credits: { cost: 3, refunded: false }, version: 2, available: true },
      { id: 'run_1', flowId: 'flow_1', flowName: 'v1', status: 'failed', startedAt: '2026-11-12T03:20:00.000Z', durationMs: 24000, total: 5, failed: 1, error: '视觉模型超时', credits: { cost: 3, refunded: true }, version: 1, available: true },
    ],
    runTotal: 2,
    runCounts: { '1': 1, '2': 1 },
    ...overrides.top,
  }
}

const FULL_REVIEW = {
  id: 'rev_1',
  version: 2,
  createdAt: '2026-11-12T05:10:00.000Z',
  result: {
    verdict: 'needs_review',
    summary: '钩子够快，中段字幕换行太密',
    provider: 'deepseek',
    profile: 'deepseek-flash',
    ms: 43100,
    observations: [
      { dimension: '字幕', severity: 'major', statement: '第 2 镜字幕一行 18 个字', confidence: 0.82 },
      { dimension: '钩子', severity: 'minor', statement: '开头 1 秒黑场', confidence: 0.6 },
    ],
    fixes: [{ title: '拆字幕', detail: '第 2 镜字幕拆成两句，每句不超过 12 字' }],
    notAssessable: ['音色是否符合品牌'],
    judge: { status: 'ok', evidenceConsistent: 0.9, actionable: 0.95, publishRisk: { score: 2 } },
  },
}

test('完整稿：脚本、分镜、评审、版本、运行都在，且不写分享 token', () => {
  const { markdown, fileName } = projectDeliverable(fixture(), { review: FULL_REVIEW, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.startsWith('# 咖啡 3 分钟'))
  assert.ok(markdown.includes('- 作品编号：prj_a'))
  assert.ok(markdown.includes('- 状态：已评审（当前第 2 版）'))
  assert.ok(markdown.includes('原片 18 秒 · 2 段 / 2 镜'))
  assert.ok(markdown.includes('| 0–3 秒 | 开场 | 三分钟做一杯手冲咖啡 |'))
  assert.ok(markdown.includes('### 镜头 02 · 3–8 秒'))
  assert.ok(markdown.includes('最新一次（v2）：需人工确认'))
  assert.ok(markdown.includes('1. **重要 · 字幕**：第 2 镜字幕一行 18 个字（依据强度 82%）'))
  assert.ok(markdown.includes('1. 拆字幕：第 2 镜字幕拆成两句'))
  assert.ok(markdown.includes('| v1 | 咖啡 v1 | 5 | 1 次 | 1 次 | 通过 |'))
  assert.ok(markdown.includes('| v2（当前） | 咖啡 v2 | 6 | 1 次 | 1 次 | 需人工确认 |'))
  assert.ok(markdown.includes('| 2026-11-12 13:20 | v2 | 成功 | 6 | 1 分 1 秒 | 3 积分 |'))
  assert.ok(markdown.includes('- 标记交付：还没标记'))
  assert.ok(!markdown.includes('tok_secret_abc'), '分享 token 是一把钥匙，不能写进交付稿')
  assert.ok(!markdown.includes('ownerId'), '归属字段不进稿')
  assert.ok(fileName.startsWith('VisionQA-咖啡 3 分钟-20261112'))
  assert.ok(fileName.endsWith('.md'))
})

test('时间按导出人所在的时区写，不是 UTC', () => {
  const { markdown } = projectDeliverable(fixture(), { review: FULL_REVIEW, now: NOW, tzOffsetMinutes: TZ })
  // 05:10Z 在东八区是 13:10
  assert.ok(markdown.includes('2026-11-12 13:10'))
  // 同一份数据按 UTC 写就是 05:10，说明时区偏移真的用上了
  const utc = projectDeliverable(fixture(), { review: FULL_REVIEW, now: NOW, tzOffsetMinutes: 0 }).markdown
  assert.ok(utc.includes('最新一次（v2）：需人工确认 · 2026-11-12 05:10'))
  assert.ok(utc.includes('导出时间：2026-11-12 13:40'))
})

test('时长对账：口径与页面一致，句子带句号', () => {
  const { markdown } = projectDeliverable(fixture(), { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('台词约需 10 秒，原片 18 秒，按语速档「中」估（4.2 字/秒）。整体时长合理，其中 1 个镜头台词偏多。'))
  assert.ok(markdown.includes('| 3–8 秒 | 闷蒸 | 先闷蒸三十秒 |  | 教学 | 7.1 秒 · 偏多 |'))
})

test('没评审就写没评审，不替模型编一句结论', () => {
  const detail = fixture({ reviews: [], versionCounts: {}, top: { reviews: [], versionCounts: {} } })
  const { markdown } = projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('还没送过评审：在作品页点「用评审看这版」，结论会记到这一版上。'))
  assert.ok(!markdown.includes('### 修正建议'))
  assert.ok(!markdown.includes('通过 ·'), '没有评审时不能出现凭空的时间与结论')
})

test('这一版没评但上一版评过：说清按版本记，不把旧结论算到这一版', () => {
  const detail = fixture()
  detail.reviews = [{ id: 'rev_0', version: 1, verdict: 'pass', summary: '上一版', createdAt: '2026-11-12T03:00:00.000Z' }]
  detail.versionCounts = { '1': { count: 1, lastVerdict: 'pass', lastAt: '2026-11-12T03:00:00.000Z' } }
  const { markdown } = projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('这一版还没送评审。上一版评过，最近结论是「通过」'))
  assert.ok(markdown.includes('评审按版本记，结论不混到这一版。'))
})

test('版本划分之前的历史评审与运行折进 v1', () => {
  const detail = fixture()
  detail.project.version = 1
  detail.project.versions = []
  detail.versions = []
  detail.versionCounts = { '0': { count: 2, lastVerdict: 'pass', lastAt: '2026-11-11T03:00:00.000Z' } }
  detail.runCounts = { '0': 3 }
  detail.runs = []
  const { markdown } = projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('| v1（当前） | 咖啡 v2 | 6 | 2 次 | 3 次 | 通过 |'))
})

test('运行很多时只列最近几次，并写明一共跑过多少次', () => {
  const detail = fixture()
  detail.runs = Array.from({ length: DELIVERABLE_LIMITS.runs + 4 }, (_, index) => ({
    id: 'run_' + index,
    flowId: 'flow_2',
    status: index % 3 === 0 ? 'failed' : 'success',
    startedAt: new Date(Date.parse('2026-11-12T05:00:00.000Z') - index * 600000).toISOString(),
    durationMs: 12000 + index,
    total: 6,
    failed: index % 3 === 0 ? 1 : 0,
    error: index % 3 === 0 ? '节点超时' : '',
    credits: { cost: 3, refunded: false },
    version: 2,
    available: true,
  }))
  detail.runTotal = detail.runs.length
  const { markdown } = projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('共 12 次运行，这里列最新 ' + DELIVERABLE_LIMITS.runs + ' 次。'))
  const rows = markdown.split('\n').filter((line) => line.startsWith('| 2026-11-12'))
  assert.ok(rows.length >= DELIVERABLE_LIMITS.runs)
  assert.ok(markdown.includes('### 失败原因'))
})

test('脚本空着、模板没有分镜时给一句实话，不摆空表格', () => {
  const detail = fixture({ script: null, template: { storyboard: [], shots: 0 }, top: { script: null } })
  detail.template.storyboard = []
  const { markdown } = projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('还没写脚本：去模板库套一条已解析的模板'))
  assert.ok(markdown.includes('模板没有分镜表'))
  assert.ok(!markdown.includes('| 时间 | 段落 | 口播'))
})

test('竖线、换行与多行画面不会把表格和列表拆坏', () => {
  const detail = fixture()
  detail.script.structure[0].voiceover = '左边 | 右边'
  detail.template.storyboard[0].visual = '近景\n手部\n倒水'
  const { markdown } = projectDeliverable(detail, { review: null, now: NOW, tzOffsetMinutes: TZ })
  assert.ok(markdown.includes('左边 \\| 右边'), '单元格里的竖线要转义')
  assert.ok(markdown.includes('- 画面：近景 手部 倒水'), '列表行里的换行要压成空格')
  const scriptRows = markdown.split('\n').filter((line) => line.startsWith('| 0–3 秒'))
  assert.equal(scriptRows.length, 1)
})

test('文件名去掉非法字符，标题空时用「未命名作品」', () => {
  assert.equal(deliverableFileName({ title: 'a/b:c*?"<>|d' }, NOW, TZ), 'VisionQA-a-b-c------d-20261112.md')
  assert.equal(deliverableFileName({ title: '   ' }, NOW, TZ), 'VisionQA-未命名作品-20261112.md')
})
