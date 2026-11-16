import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 每一镜的画面（v0.9.161）：分镜是模板的，画面是这条作品自己的。
// 这一组盯住四件事：只认自己账号下的上传图、镜头号必须真的存在、传空只撤这一镜、
// 模板文件一个字都不动。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shots-'))
process.env.DATA_DIR = dir

const template = {
  id: 'tpl_shots',
  kind: 'replica',
  title: '三镜测试片',
  contentType: '口播干货',
  hook: '钩子',
  structure: [{ beat: '开场', startSec: 0, endSec: 2, voiceover: '一句话', onScreen: '', purpose: '抓住' }],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 2, camera: '近景', caption: '', visual: '第一镜', audio: '', purpose: '', frameUrl: '/media/frames/tpl_shots/frame-01.jpg' },
    { shotNo: 2, startSec: 2, endSec: 4, camera: '中景', caption: '', visual: '第二镜', audio: '', purpose: '', frameUrl: '/media/frames/tpl_shots/frame-02.jpg' },
    { shotNo: 3, startSec: 4, endSec: 6, camera: '远景', caption: '', visual: '第三镜', audio: '', purpose: '', frameUrl: '' },
  ],
  analysis: { pacing: '快', viralPoints: [], reusableRules: [], targetAudience: '' },
  frames: [],
  cover: '',
  durationSec: 6,
  ownerId: 'u_a',
  createdAt: '2026-11-01T00:00:00.000Z',
}
const templatesFile = path.join(dir, 'templates.json')
fs.writeFileSync(templatesFile, JSON.stringify([template], null, 2), 'utf8')
const templateBefore = fs.readFileSync(templatesFile, 'utf8')

const shots = await import('../server/project-shots.mjs')
const p = await import('../server/projects.mjs')

const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }
const mine = 'uploads/u_a/shot-01.jpg'
const theirs = 'uploads/u_b/shot-01.jpg'

test('镜头号只认正整数：第 0 镜、第 1.5 镜、文字都不认', () => {
  assert.equal(shots.normalizeShotNo(1), 1)
  assert.equal(shots.normalizeShotNo('3'), 3)
  assert.equal(shots.normalizeShotNo(0), 0)
  assert.equal(shots.normalizeShotNo(-2), 0)
  assert.equal(shots.normalizeShotNo(1.5), 0)
  assert.equal(shots.normalizeShotNo('第二镜'), 0)
  assert.equal(shots.normalizeShotNo(shots.MAX_SHOT_FRAMES + 1), 0)
})

test('记录只留 uploads/ 下的图与真实时间，别的东西一律丢掉', () => {
  const kept = shots.normalizeShotFrames({
    1: { media: mine, at: '2026-11-16T01:00:00.000Z' },
    2: { media: 'https://example.com/a.jpg', at: '2026-11-16T01:00:00.000Z' },
    3: { media: theirs, at: '不是时间' },
    x: { media: mine, at: '2026-11-16T01:00:00.000Z' },
  })
  assert.deepEqual(Object.keys(kept), ['1'], '只留下第 1 镜：外链、坏时间、不认识的镜头号都不算')
  assert.deepEqual(shots.normalizeShotFrames(null), {})
})

test('挂之前先核：没有分镜、越界、别人的图都挡住', () => {
  const noStoryboard = shots.shotFrameBlock({ media: mine, user: userA, shotNo: 1, shotCount: 0 })
  assert.equal(noStoryboard.status, 409)
  assert.match(noStoryboard.error, /还没有分镜/)

  const outOfRange = shots.shotFrameBlock({ media: mine, user: userA, shotNo: 4, shotCount: 3 })
  assert.equal(outOfRange.status, 400)
  assert.match(outOfRange.error, /只有 3 镜/)

  const foreign = shots.shotFrameBlock({ media: theirs, user: userA, shotNo: 1, shotCount: 3 })
  assert.equal(foreign.status, 404, '不是自己的图按「不在你账号下」回，与评审入口同一句话术')
  assert.match(foreign.error, /不在你的账号下/)

  assert.equal(shots.shotFrameBlock({ media: mine, user: userA, shotNo: 1, shotCount: 3 }), null)
  assert.equal(shots.shotFrameBlock({ media: theirs, user: { id: 'u_admin', kind: 'admin' }, shotNo: 1, shotCount: 3, admin: true }), null, '管理员可以替人贴')
})

test('贴上去能读回来，传空只撤这一镜；模板文件一个字不动', async () => {
  const project = await p.createProject({ title: '三镜作品', templateId: template.id }, userA)
  const first = await p.setProjectShotFrame(project.id, 1, mine, userA)
  assert.equal(first.status, 200)
  assert.equal(first.changed, true)
  assert.deepEqual(Object.keys(first.shots), ['1'])

  const second = await p.setProjectShotFrame(project.id, 2, mine, userA)
  assert.deepEqual(Object.keys(second.shots).sort(), ['1', '2'])

  const again = await p.setProjectShotFrame(project.id, 1, mine, userA)
  assert.equal(again.changed, false, '同一张图再贴一次不写盘')

  const read = await p.getProject(project.id, userA)
  assert.equal(read.shots['1'].media, mine)
  assert.equal(read.shots['2'].media, mine)

  const cleared = await p.setProjectShotFrame(project.id, 1, '', userA)
  assert.deepEqual(Object.keys(cleared.shots), ['2'], '传空只撤第 1 镜')
  assert.equal((await p.getProject(project.id, userA)).shots['1'], undefined)

  assert.equal(fs.readFileSync(templatesFile, 'utf8'), templateBefore, '模板文件不该被改')
})

test('别人看不到这条作品的画面，也贴不进去', async () => {
  const project = await p.createProject({ title: '别人的作品', templateId: template.id }, userA)
  await p.setProjectShotFrame(project.id, 1, mine, userA)
  assert.equal(await p.getProject(project.id, userB), null)
  const blocked = await p.setProjectShotFrame(project.id, 1, theirs, userB)
  assert.equal(blocked.status, 404)
})

test('页面读的形状：没贴过的镜留着，说清「原片帧」', () => {
  const rows = shots.shotFrameRows(template.storyboard, {
    1: { media: mine, at: '2026-11-16T01:00:00.000Z' },
  })
  assert.equal(rows.length, 3)
  assert.equal(rows[0].own, true)
  assert.equal(rows[0].media, mine)
  assert.equal(rows[1].own, false)
  assert.equal(rows[1].frameUrl, '/media/frames/tpl_shots/frame-02.jpg', '没贴过的镜仍给原片帧做对照')
  assert.equal(rows[2].frameUrl, '', '原片就没有帧的镜如实空着')
})
