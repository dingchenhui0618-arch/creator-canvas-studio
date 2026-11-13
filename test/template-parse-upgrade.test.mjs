import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 「还没解析 → 去解析 → 原地升级成已解析」是发现页与模板库共用的一条路（v0.9.40）。
// 解析完成后如果另开一条、旧的 saved 条目还留着，库里同一条原片就会占两格：
// 发现页那行的下一步还指回那条没脚本的旧条目，永远停在「还没解析」。
// 这一组测试盯住 createTemplate 的原地升级口径，以及升级后这条能不能开成作品。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-parse-upgrade-'))
process.env.DATA_DIR = dir
fs.mkdirSync(path.join(dir, 'frames'), { recursive: true })
const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-parse-frames-'))
fs.writeFileSync(path.join(frameDir, 'frame-00.jpg'), 'frame')

const older = new Date(Date.now() - 90_000).toISOString()

const savedEntry = (id, patch = {}) => ({
  id,
  kind: 'saved',
  title: '只有链接的一条',
  contentType: '待解析',
  tags: [],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/9001',
  sourceId: 'dy_9001',
  author: '原片作者',
  publishedAt: '2026-11-01',
  stats: { plays: 12000, likes: 900, comments: 30, shares: 12, collects: 400 },
  durationSec: 18,
  hook: '',
  hookType: '',
  structure: [],
  storyboard: [],
  timing: null,
  analysis: { pacing: '', viralPoints: [], reusableRules: [], targetAudience: '' },
  frames: [],
  cover: 'https://example.com/cover.jpg',
  video: { width: 0, height: 0, fps: 0, duration: 18 },
  origin: 'manual',
  reuseCount: 2,
  createdAt: older,
  savedAt: older,
  ...patch,
})

// 我自己存的一条、另一个账号也存了同一条原片、以及一条跟这条无关的模板
fs.writeFileSync(
  path.join(dir, 'templates.json'),
  JSON.stringify([
    savedEntry('tpl_me', { ownerId: 'u_me' }),
    savedEntry('tpl_other', { ownerId: 'u_other', createdAt: new Date(Date.now() - 120_000).toISOString() }),
    { ...savedEntry('tpl_unrelated', { ownerId: 'u_me' }), sourceId: 'dy_7777', sourceUrl: 'https://www.douyin.com/video/7777' },
  ], null, 2),
  'utf8',
)

const templates = await import('../server/templates.mjs')
const { canStartProject, originEntry } = await import('../server/origin-entry.mjs')
const me = { id: 'u_me', name: '我' }
const other = { id: 'u_other', name: '别人' }

const item = {
  id: 'dy_9001',
  platform: 'douyin',
  platformLabel: '抖音',
  title: '检索里的标题',
  author: '原片作者',
  url: 'https://www.douyin.com/video/9001',
  publishedAt: '2026-11-01',
  durationSec: 18,
  stats: { plays: 12000, likes: 900, comments: 30, shares: 12, collects: 400 },
}

const parsed = {
  title: '咖啡机一分钟出片',
  contentType: '口播',
  tags: ['测试', '口播'],
  hook: '一分钟出一杯',
  hookType: '结果前置',
  structure: [{ startSec: 0, endSec: 4, beat: '结果', voiceover: '一分钟，真的只要一分钟', onScreen: '出杯', purpose: '给结果' }],
  storyboard: [{ shotNo: 1, startSec: 0, endSec: 4, frameIndex: 0, visual: '咖啡机出杯特写', camera: '近景', caption: '', audio: '', purpose: '给结果' }],
  timing: { estimatedSec: 3.4, actualSec: 4, durationSec: 18, fit: 'loose', overSec: 0, tight: 0, loose: 1 },
  analysis: { pacing: '快', viralPoints: ['出杯瞬间'], reusableRules: ['先给结果'], targetAudience: '打工人' },
}

const meta = { duration: 18, width: 1080, height: 1920, fps: 30 }
const frames = [{ index: 0, t: 0, file: path.join(frameDir, 'frame-00.jpg'), name: 'frame-00.jpg' }]

test('解析完成把同一 sourceId 的 saved 条目原地升级，不多占一格', async () => {
  const before = await templates.listTemplates({}, me)
  assert.equal(before.filter((entry) => entry.sourceId === 'dy_9001').length, 1)
  const old = before.find((entry) => entry.id === 'tpl_me')

  const created = await templates.createTemplate({ item, meta, analysis: parsed, frames, jobId: 'job_1', user: me })

  assert.equal(created.kind, 'replica')
  assert.equal(created.sourceId, 'dy_9001')
  // 归属、收藏时间、用过几次都带过来：升级不是「换了一条新东西」
  assert.equal(created.ownerId, 'u_me')
  assert.equal(created.createdAt, old.createdAt)
  assert.equal(created.reuseCount, 2)

  const after = await templates.listTemplates({}, me)
  assert.equal(after.filter((entry) => entry.sourceId === 'dy_9001').length, 1, '同一条原片只该留一格')
  assert.equal(await templates.getTemplate('tpl_me', me), null, '旧的 saved 条目要被替换掉')
  assert.ok(after.some((entry) => entry.id === created.id))
  // 原有互动数据与原链接不丢：卡片上的数字不该因为解析一次就归零
  assert.equal(created.stats.likes, 900)
  assert.equal(created.sourceUrl, 'https://www.douyin.com/video/9001')
  assert.equal(created.structure.length, 1)
  assert.equal(created.storyboard.length, 1)
})

test('升级后的这条马上就能开成作品，不再停在「还没解析」', async () => {
  const list = await templates.listTemplates({}, me)
  const upgraded = list.find((entry) => entry.sourceId === 'dy_9001')
  assert.ok(upgraded)

  assert.equal(canStartProject(upgraded), true)
  const entry = originEntry({ template: upgraded, templateId: upgraded.id })
  assert.equal(entry.kind, 'create-work')
  assert.equal(entry.label, '开成作品')
})

test('别人的同源条目不动：解析只升级自己那一格', async () => {
  const theirs = await templates.listTemplates({}, other)
  const kept = theirs.find((entry) => entry.id === 'tpl_other')
  assert.ok(kept, '另一个账号收藏的同一条原片不该被我的解析删掉')
  assert.equal(kept.kind, 'saved')
  assert.equal(canStartProject(kept), false)
})

test('没有可升级的条目时照常新建一条（不退回 null）', async () => {
  const created = await templates.createTemplate({
    item: { ...item, id: 'dy_4242', url: 'https://www.douyin.com/video/4242' },
    meta,
    analysis: parsed,
    frames,
    jobId: 'job_2',
    user: me,
  })
  assert.equal(created.kind, 'replica')
  assert.equal(created.sourceId, 'dy_4242')
  const list = await templates.listTemplates({}, me)
  assert.ok(list.some((entry) => entry.id === created.id))
})
