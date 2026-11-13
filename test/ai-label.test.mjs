import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_LABEL, AI_LABEL_NOTICE, AI_LABEL_REGULATION, aiLabelFootText, aiLabelMeta, aiLabelMetaTags } from '../server/ai-label.mjs'
import { projectDeliverable } from '../server/project-deliverable.mjs'
import { deliverablePrintHtml, printNoticeHtml } from '../server/project-deliverable-html.mjs'
import { reviewSheetHtml } from '../server/project-review-sheet.mjs'
import { setSheetHtml } from '../server/project-set-sheet.mjs'
import { publicProjectView } from '../server/project-share.mjs'

// AI 生成内容标识（《人工智能生成合成内容标识办法》，2025-09-01 施行）。
// 交付物出了工作台就没有登录态、也没有解释的机会，标识必须跟着产物走。这一组盯住：
//   1) 三个出口（Markdown、三张 A4 纸、只读分享）都有看得见的显式标识；
//   2) 纸张 <head> 里有隐式标识的 meta，机器读得到「谁生成、按哪一版规则标」；
//   3) 出错提示页不是生成内容，不能挂 AI 标识（挂上就是把错误页也说成模型写的）。

const NOTICE_PARTS = ['发布前请人工核对']

function detail() {
  return {
    project: {
      id: 'prj_ai',
      title: '咖啡 3 分钟',
      version: 1,
      status: 'active',
      createdAt: '2026-11-12T02:00:00.000Z',
      updatedAt: '2026-11-12T05:30:00.000Z',
    },
    share: null,
    template: {
      id: 'tpl_ai',
      title: '咖啡 3 分钟',
      durationSec: 18,
      beats: 1,
      shots: 1,
      structure: [{ beat: '开头', startSec: 0, endSec: 6, voiceover: '三分钟做一杯手冲' }],
      storyboard: [{ shotNo: 1, startSec: 0, endSec: 6, visual: '手冲壶注水', caption: '' }],
    },
    flow: null,
    script: null,
    versionCounts: {},
    reviews: [],
    decisions: [],
    deliveries: [],
    runs: [],
  }
}

test('标识措辞只写事实：生成者、法规、人工核对的边界', () => {
  assert.equal(AI_LABEL, 'AI 生成')
  assert.match(AI_LABEL_REGULATION, /2025-09-01/)
  assert.match(AI_LABEL_NOTICE, /VisionQA/)
  for (const part of NOTICE_PARTS) assert.ok(AI_LABEL_NOTICE.includes(part), part)
  // 不声称人工审核过：标识只说明来源，拍板与否在别处写
  assert.ok(!/人工审核(通过|过)/.test(AI_LABEL_NOTICE))
  const meta = aiLabelMeta()
  assert.equal(meta.aiGenerated, true)
  assert.equal(meta.label, AI_LABEL)
  assert.equal(meta.generator, 'VisionQA')
  assert.equal(aiLabelFootText(), 'AI 生成 · VisionQA')
})

test('HTML 隐式标识是四个 meta，页面里拼得出来', () => {
  const tags = aiLabelMetaTags()
  assert.match(tags, /<meta name="ai-generated" content="true">/)
  assert.match(tags, /<meta name="ai-generator" content="VisionQA">/)
  assert.match(tags, /<meta name="ai-label" content="AI 生成">/)
  assert.match(tags, /<meta name="ai-label-version" content="\d+">/)
})

test('Markdown 交付稿：文首一行显式标识，落款也带', () => {
  const { markdown } = projectDeliverable(detail(), { now: new Date('2026-11-12T06:00:00.000Z'), tzOffsetMinutes: 480 })
  assert.ok(markdown.includes('> **AI 生成**'), '文首缺显式标识')
  assert.ok(markdown.includes(AI_LABEL_NOTICE), '缺说明')
  // 标识放在开头：读稿的人第一段就该看到，而不是翻到最后
  const head = markdown.slice(0, 400)
  assert.match(head, /\*\*AI 生成\*\*/)
  assert.match(markdown.slice(-200), /AI 生成 · VisionQA/, '落款缺标识')
  // 原文内容还在：加标识不能把稿子改坏
  assert.ok(markdown.includes('## 脚本') || markdown.includes('# 咖啡 3 分钟'))
})

test('A4 交付稿：品牌行有标识胶囊，head 有 meta，提示页不挂标识', () => {
  const { markdown } = projectDeliverable(detail(), { now: new Date('2026-11-12T06:00:00.000Z'), tzOffsetMinutes: 480 })
  const html = deliverablePrintHtml({ markdown, projectId: 'prj_ai', title: '咖啡 3 分钟' })
  assert.match(html, /class="sheet-ai"/)
  assert.match(html, /<meta name="ai-generated" content="true">/)
  assert.match(html, /<meta name="ai-generator" content="VisionQA">/)
  // 提示纸是「打不开这张稿」，不是生成内容
  const notice = printNoticeHtml({ title: '打不开这张稿', message: '登录过期' })
  assert.ok(!notice.includes('name="ai-generated"'), '错误页不该标 AI 生成')
  assert.ok(!notice.includes('class="sheet-ai"'), '错误页不该有标识胶囊')
})

test('评审对照纸与现场页：都有标识、说明与纸脚落款', () => {
  const project = { id: 'prj_ai', title: '咖啡 3 分钟', version: 1 }
  const review = reviewSheetHtml({ project, records: [], now: new Date('2026-11-12T06:00:00.000Z'), tzOffsetMinutes: 480, projectId: project.id })
  assert.match(review, /class="sheet-ai"/)
  assert.ok(review.includes(AI_LABEL_NOTICE), '评审纸缺说明')
  assert.match(review, /<meta name="ai-generated" content="true">/)
  assert.match(review, /AI 生成 · VisionQA/)

  const sheet = setSheetHtml({ project, script: null, template: detail().template, projectId: project.id, generatedAt: '2026-11-12T06:00:00.000Z' })
  assert.match(sheet, /class="sheet-ai"/)
  assert.ok(sheet.includes(AI_LABEL_NOTICE), '现场页缺说明')
  assert.match(sheet, /<meta name="ai-generated" content="true">/)
  assert.match(sheet, /AI 生成 · VisionQA/)
})

test('只读分享：公开视图带结构化标识，文案与纸张同一句', () => {
  const view = publicProjectView({
    project: { title: '咖啡 3 分钟', version: 1, updatedAt: '2026-11-12T05:30:00.000Z' },
    template: null,
    script: null,
    reviews: { count: 0, lastVerdict: '', lastAt: '' },
    runs: 0,
    token: 'tok_ai_share',
  })
  assert.equal(view.aiLabel.label, AI_LABEL)
  assert.equal(view.aiLabel.notice, AI_LABEL_NOTICE)
  assert.equal(view.aiLabel.aiGenerated, true)
  assert.match(view.aiLabel.regulation, /2025-09-01/)
  // 标识里不能混进分享 token：公开视图的字段都是白名单挑出来的
  assert.ok(!JSON.stringify(view.aiLabel).includes('tok_ai_share'))
})
