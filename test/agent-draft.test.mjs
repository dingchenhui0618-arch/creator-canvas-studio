import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 智能体的结构化出口（2026-11-12）：这条链上出问题的代价最直接——
// 草稿解析不出来，两个出口就是空按钮；从正文里误抓 JSON，气泡里会少一段正文；
// 草稿形状不对，存出来的模板会在模板详情里炸。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-agent-draft-'))
process.env.DATA_DIR = dir
fs.mkdirSync(path.join(dir, 'frames'), { recursive: true })

const draft = await import('../server/agent-draft.mjs')
const templates = await import('../server/templates.mjs')
const canvas = await import('../server/script-draft.mjs')

const FENCE = String.fromCharCode(96, 96, 96)
const block = (body, info = 'draft') => '\n' + FENCE + info + '\n' + body + '\n' + FENCE + '\n'

const sample = {
  title: '咖啡机一分钟出片',
  hook: '别再花三十块买一杯了',
  contentType: '口播',
  structure: [
    { beat: '钩子', voiceover: '别再花三十块买一杯了，这个机器一分钟出片。', onScreen: '一分钟' },
    { beat: '演示', voiceover: '放豆、按键、等一分钟，奶泡自己打。' },
  ],
  storyboard: [
    { shotNo: 1, visual: '手把咖啡杯放下', camera: '近景', caption: '别再花三十块买一杯了' },
    { shotNo: 2, visual: '机器出液', camera: '特写', caption: '一分钟出片' },
  ],
}

test('回复里的草稿块被取出来，正文里不再留 JSON', () => {
  const reply = '先给你一条能直接拍的口播。' + block(JSON.stringify(sample)) + '需要换场景再告诉我。'
  const result = draft.extractDraft(reply)
  assert.ok(result.draft, '草稿解析成功')
  assert.equal(result.draft.title, '咖啡机一分钟出片')
  assert.equal(result.draft.stats.beats, 2)
  assert.equal(result.draft.stats.shots, 2)
  assert.ok(result.draft.stats.voiceoverSec > 0, '口播时长按字数估出来')
  for (const row of result.draft.structure) {
    assert.ok(row.expectedSec > 0, '每段都有「这句要念几秒」')
    assert.ok(row.endSec > row.startSec, '段落有真实起止时间')
  }
  assert.ok(!result.reply.includes(FENCE), '代码块从正文里去掉')
  assert.ok(!result.reply.includes('咖啡机一分钟出片'), 'JSON 内容不会残留在气泡里')
  assert.match(result.reply, /先给你一条能直接拍的口播/)
  assert.match(result.reply, /需要换场景再告诉我/)
})

test('没有草稿块、或 JSON 坏了就当没有：不猜、不截断成坏数据', () => {
  const plain = '这次只讲思路，不给结构。'
  assert.equal(draft.extractDraft(plain).draft, null)
  assert.equal(draft.extractDraft(plain).reply, plain, '没草稿时正文原样返回')

  const broken = '正文' + block('{"title": "缺一半')
  assert.equal(draft.extractDraft(broken).draft, null, '截断的 JSON 不生成草稿')

  const wrongShape = '正文' + block(JSON.stringify({ title: '只有标题' }))
  assert.equal(draft.extractDraft(wrongShape).draft, null, '没有段落也没有分镜，不算草稿')

  const otherJson = '正文' + block(JSON.stringify({ ok: true }), 'json')
  assert.equal(draft.extractDraft(otherJson).draft, null, '普通 JSON 块不会被误当草稿')
})

test('草稿有上限：段落最多 12 段、分镜最多 24 镜', () => {
  const beats = Array.from({ length: 20 }, (_, index) => ({ beat: '第' + (index + 1) + '段', voiceover: '第' + (index + 1) + '句口播' }))
  const shots = Array.from({ length: 30 }, (_, index) => ({ shotNo: index + 1, visual: '画面' + (index + 1), caption: '字幕' + (index + 1) }))
  const result = draft.normalizeDraft({ title: '超长草稿', structure: beats, storyboard: shots })
  assert.equal(result.stats.beats, 12)
  assert.equal(result.stats.shots, 24)
})

test('只有分镜也能用：段落为空时保留分镜，标题与类型有默认值', () => {
  const result = draft.normalizeDraft({ storyboard: [{ visual: '一个空镜', camera: '远景' }] })
  assert.ok(result)
  assert.equal(result.structure.length, 0)
  assert.equal(result.stats.shots, 1)
  assert.equal(result.title, '未命名草稿')
  assert.equal(result.contentType, '脚本')
  assert.ok(result.storyboard[0].endSec > result.storyboard[0].startSec, '没字幕的镜头也给足时长')
})

test('送到画布的提示词用的是这份草稿，不是模板旧词', () => {
  const normalized = draft.normalizeDraft(sample)
  const prompt = canvas.buildReplicatePrompt({ template: {}, script: draft.draftToScript(normalized) })
  assert.match(prompt, /别再花三十块买一杯了/)
  assert.match(prompt, /放豆、按键、等一分钟/)
  assert.match(prompt, /这句要念/)
})

test('存为模板：落成 agent 类型，段落与分镜都在，归属当前账号', async () => {
  const user = { id: 'u_agent', name: 'A' }
  const normalized = draft.normalizeDraft(sample)
  const template = await templates.createTemplateFromDraft({ draft: normalized, agent: { id: 'agt_1', name: '口播脚本与分镜' }, user })
  assert.ok(template)
  assert.equal(template.kind, 'agent')
  assert.equal(template.origin, 'agent')
  assert.equal(template.ownerId, 'u_agent')
  assert.equal(template.agentId, 'agt_1')
  assert.equal(template.title, '咖啡机一分钟出片')
  assert.equal(template.structure.length, 2)
  assert.equal(template.storyboard.length, 2)
  assert.ok(template.timing && template.timing.estimatedSec > 0, '模板带时长对账结果')
  assert.equal(template.platformLabel, '口播脚本与分镜', '平台标签就是智能体名：卡片脚注不再重复两遍')
  assert.equal(template.author, '', '作者只属于原片，智能体草稿不填')

  const list = await templates.listTemplates({}, user)
  assert.ok(list.some((item) => item.id === template.id), '存完立刻能在模板库看到')
  const other = await templates.listTemplates({}, { id: 'u_other', name: 'B' })
  assert.ok(!other.some((item) => item.id === template.id), '别的账号看不到')
})

test('空草稿不落库：宁可报错，也不存一条空模板', async () => {
  assert.equal(await templates.createTemplateFromDraft({ draft: { structure: [], storyboard: [] }, user: { id: 'u_agent' } }), null)
  assert.equal(await templates.createTemplateFromDraft({ draft: null }), null)
})
test('导出 JSON 认内容不认标签：草稿块也能导出，坏块不生成文件', async () => {
  const { extractJsonArtifact } = await import('../server/agentChat.mjs')
  const artifact = extractJsonArtifact('正文\n' + block(JSON.stringify(sample), 'draft'))
  assert.ok(artifact, 'draft 代码块也能被导出工具认出来')
  assert.equal(artifact.name, 'agent-output.json')
  assert.match(artifact.content, /咖啡机一分钟出片/)
  assert.equal(extractJsonArtifact('正文\n' + block('这不是 JSON', 'js')), null)
  assert.equal(extractJsonArtifact('没有代码块'), null)
})
