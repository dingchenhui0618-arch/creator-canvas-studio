import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 作品页直接改脚本（P1）：copy-on-write。
// 这一组测试盯住四件事：默认不复制、第一次保存才落副本、按口播重算时长、恢复后回到跟随模板。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-project-script-'))
process.env.DATA_DIR = dir

const script = await import('../server/project-script.mjs')
const projects = await import('../server/projects.mjs')
const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }

const template = {
  id: 'tpl_a',
  title: '咖啡 3 分钟',
  durationSec: 18,
  hook: '模板的钩子',
  updatedAt: '2026-11-01T00:00:00.000Z',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '模板第一句', onScreen: '' },
    { beat: '做法', startSec: 3, endSec: 8, voiceover: '模板第二句', onScreen: '' },
  ],
  timing: { estimatedSec: 6, actualSec: 18, durationSec: 18, fit: 'loose', pace: '快', rate: 6.5625, overSec: 0, tight: 0, loose: 2 },
  analysis: { pacing: '快', reusableRules: [], viralPoints: [], targetAudience: '' },
}

test('归一化：空脚本拒绝，段落名补默认，超长截断', () => {
  assert.equal(script.normalizeProjectScript(null), null)
  assert.equal(script.normalizeProjectScript({ hook: '只有钩子', structure: [] }), null)
  assert.equal(script.normalizeProjectScript({ structure: [{ beat: '', voiceover: '  ', onScreen: '' }] }), null)

  const kept = script.normalizeProjectScript({
    hook: '  新钩子  ',
    structure: [
      { beat: '', voiceover: '第一段口播', onScreen: '' },
      { beat: '收尾', voiceover: '', onScreen: '看评论区' },
    ],
  }, { pace: '中', totalSec: 18 })
  assert.equal(kept.hook, '新钩子')
  assert.equal(kept.structure.length, 2, '有口播或屏幕字的段落都留下')
  assert.equal(kept.structure[0].beat, '第 1 段', '段名空着按序号补')
  assert.equal(kept.structure[1].beat, '收尾')
  assert.ok(kept.updatedAt, '保存时间跟脚本一起落库')

  const crowded = script.normalizeProjectScript({
    structure: Array.from({ length: 16 }, (_, i) => ({ beat: '第' + i + '段', voiceover: '一句话' })),
  })
  assert.equal(crowded.structure.length, script.SCRIPT_MAX_BEATS, '段落数有上限')
})

test('按口播重算「要念几秒」：改长了自己变紧，空口播不硬塞时间', () => {
  const short = script.normalizeProjectScript({
    structure: [{ beat: '开场', startSec: 0, endSec: 1, voiceover: '一句话' }],
  }, { pace: '中', totalSec: 18 })
  const long = script.normalizeProjectScript({
    structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '这句话比刚才那一句长很多很多，念完三秒根本装不下，需要删掉一部分口播' }],
  }, { pace: '中', totalSec: 18 })
  assert.ok(long.structure[0].expectedSec > short.structure[0].expectedSec + 2, '字多了估算跟着涨')
  assert.equal(short.structure[0].fit, 'ok')
  assert.equal(long.structure[0].fit, 'tight', '3 秒装不下就是紧')

  const silent = script.normalizeProjectScript({ structure: [{ beat: '空镜', startSec: 0, endSec: 0, voiceover: '' }] })
  assert.equal(silent.structure[0].expectedSec, 0, '没有台词就没有估算，不编一个数')
})

test('scriptView：自己的脚本优先，没有就回退模板，两边都没有就是空', () => {
  const own = script.scriptView({
    script: { hook: '我的钩子', structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '我的话' }], updatedAt: '2026-11-12T00:00:00.000Z' },
  }, template)
  assert.equal(own.source, 'project')
  assert.equal(own.hook, '我的钩子')
  assert.ok(own.timing.estimatedSec > 0)
  assert.equal(own.timing.pace, 'fast', '语速档沿用模板判断（快）')

  const inherited = script.scriptView({ script: null }, template)
  assert.equal(inherited.source, 'template')
  assert.equal(inherited.hook, '模板的钩子')
  assert.equal(inherited.structure.length, 2)
  assert.equal(inherited.timing.pace, '快', '模板脚本直接沿用模板存的口径')

  assert.equal(script.scriptView({ script: null }, null), null)
})

test('存储：建作品不复制脚本，第一次保存才落副本，恢复后回到跟随模板', async () => {
  const project = await projects.createProject({ title: '脚本副本', templateId: template.id }, userA)
  assert.equal(project.script, null, '建作品时不复制模板脚本')

  const saved = await projects.saveProjectScript(project.id, {
    hook: '我的钩子',
    structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '我的话' }],
    updatedAt: '2026-11-12T00:00:00.000Z',
  }, userA)
  assert.equal(saved.script.hook, '我的钩子')
  assert.equal(saved.script.structure.length, 1)

  // 换一个模块实例读盘，确认真的写进去了（不是只改了内存缓存）
  const fresh = await import('../server/projects.mjs?script-store')
  const reloaded = await fresh.getProject(project.id, userA)
  assert.equal(reloaded.script.hook, '我的钩子')

  assert.equal(await projects.saveProjectScript(project.id, { hook: '别人', structure: [{ beat: 'x' }] }, userB), null, '别人的作品不能改')

  const cleared = await projects.clearProjectScript(project.id, userA)
  assert.equal(cleared.script, null, '恢复后不再有作品自己的脚本')
  assert.equal(await projects.clearProjectScript(project.id, userB), null)
})

test('坏数据不连累作品：存储里的脚本结构坏了就当没有', async () => {
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'))
  const target = list.find((item) => item.templateId === template.id)
  target.script = { hook: '坏的', structure: 'not-an-array' }
  target.title = '坏数据的作品'
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(list, null, 2), 'utf8')

  const fresh = await import('../server/projects.mjs?script-broken')
  const found = await fresh.getProject(target.id, userA)
  assert.equal(found.script, null, '形状不对就回退到模板，不让整条作品读不出来')
  assert.equal(found.title, '坏数据的作品')
})
