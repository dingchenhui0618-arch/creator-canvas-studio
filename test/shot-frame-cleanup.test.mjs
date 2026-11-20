import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 工作流画面的「看与清」（r280）：在哪条作品上占了多少、有没有白占的文件、清完分镜回没回到原片。
// 这一组盯住四件事：按作品拆开的数对得上、清空先摘记录再删文件、回收站里的画面不当孤儿、
// 手贴的上传图一张都不动。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-shotclean-'))
process.env.DATA_DIR = dir

const template = {
  id: 'tpl_clean',
  kind: 'replica',
  title: '清理测试片',
  contentType: '口播干货',
  hook: '钩子',
  structure: [{ beat: '开场', startSec: 0, endSec: 2, voiceover: '一句话', onScreen: '', purpose: '抓住' }],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 2, camera: '近景', caption: '', visual: '第一镜', audio: '', purpose: '', frameUrl: '' },
    { shotNo: 2, startSec: 2, endSec: 4, camera: '中景', caption: '', visual: '第二镜', audio: '', purpose: '', frameUrl: '' },
  ],
  analysis: { pacing: '快', viralPoints: [], reusableRules: [], targetAudience: '' },
  frames: [],
  cover: '',
  durationSec: 4,
  ownerId: 'u_a',
  createdAt: '2026-11-01T00:00:00.000Z',
}
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')

const store = await import('../server/shot-frame-store.mjs')
const cleanup = await import('../server/shot-frame-cleanup.mjs')
const p = await import('../server/projects.mjs')

const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const fakePng = (bytes = 64) => Buffer.concat([PNG, Buffer.alloc(bytes)])

async function newProject(title) {
  return p.createProject({ title, templateId: template.id }, userA)
}

test('按作品拆开看占用：一条一条列出来，按字节从大到小', async () => {
  const big = await newProject('占地方的那条')
  const small = await newProject('占得少的那条')
  await store.saveShotFrame({ userId: userA.id, projectId: big.id, buffer: fakePng(512) })
  await store.saveShotFrame({ userId: userA.id, projectId: big.id, buffer: fakePng(256) })
  await store.saveShotFrame({ userId: userA.id, projectId: small.id, buffer: fakePng(16) })

  const breakdown = await store.shotFrameBreakdown(userA.id)
  assert.equal(breakdown.projects.length, 2)
  assert.equal(breakdown.projects[0].projectId, big.id, '占得多的排前面')
  assert.equal(breakdown.projects[0].files, 2)
  assert.ok(breakdown.projects[0].bytes > breakdown.projects[1].bytes)
  assert.ok(breakdown.projects[0].newestAt, '记下最近一张的时间，面板上要显示')

  const usage = await store.shotFrameUsage(userA.id)
  assert.equal(usage.files, breakdown.files, '拆开的合计与总数是同一个数')
  assert.equal(usage.bytes, breakdown.bytes)

  const empty = await store.shotFrameBreakdown(userB.id)
  assert.deepEqual(empty, { projects: [], files: 0, bytes: 0 }, '别人的目录不在这里算')
})

test('清空先摘记录、后删文件：分镜回到原片帧，手贴的图不动', async () => {
  const project = await newProject('清空这条')
  const saved = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(128) })
  const hand = 'uploads/' + userA.id + '/hand-01.png'
  await p.setProjectShotFrames(
    project.id,
    [
      { shotNo: 1, media: hand },
      { shotNo: 2, media: saved.media, from: 'run_abc12345' },
    ],
    userA,
  )
  const before = await p.getProject(project.id, userA)
  assert.equal(Object.keys(before.shots).length, 2)

  const result = await cleanup.clearShotFramesForProject({ user: userA, projectId: project.id })
  assert.equal(result.status, 200)
  assert.equal(result.shotsCleared, 1, '只摘掉分镜画面库那一镜')
  assert.equal(result.removed, 1, '文件也清掉了')
  assert.ok(result.bytes > 0)

  const after = await p.getProject(project.id, userA)
  assert.deepEqual(Object.keys(after.shots), ['1'], '手贴的那一镜还在：那不是工作流的产物，也不是要腾的空间')
  assert.equal(after.shots['1'].media, hand)
  assert.equal(fs.existsSync(path.join(dir, 'shotframes', userA.id, project.id)), false, '目录整个收掉')
})

test('清一条不属于自己的作品：404，且不动任何记录', async () => {
  const project = await newProject('别人的')
  const saved = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(32) })
  await p.setProjectShotFrames(project.id, [{ shotNo: 1, media: saved.media }], userA)
  const result = await cleanup.clearShotFramesForProject({ user: userB, projectId: project.id })
  assert.equal(result.status, 404)
  assert.equal(fs.existsSync(path.join(dir, saved.media)), true, '别人的画面一个字节都不动')
  const still = await p.getProject(project.id, userA)
  assert.equal(Object.keys(still.shots).length, 1)
})

test('没人引用的画面：数得出来、清得掉，还被记着的一张都不碰', async () => {
  const project = await newProject('有孤儿的这条')
  const kept = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(64) })
  await p.setProjectShotFrames(project.id, [{ shotNo: 1, media: kept.media }], userA)
  // 前面的用例也留下了没被引用的图（它们只验存，不往作品上挂）：这一条只比对增量
  const before = await cleanup.shotFrameOverview(userA)
  // 贴图时先写文件、后落记录，中间断掉留下的那一张
  const orphanDir = path.join(dir, 'shotframes', userA.id, project.id)
  const orphan = path.join(orphanDir, '1700000000000-abcdef123456.png')
  fs.writeFileSync(orphan, fakePng(2048))

  const overview = await cleanup.shotFrameOverview(userA)
  assert.equal(overview.orphans.files, before.orphans.files + 1, '多出来一张没人引用')
  assert.ok(overview.orphans.bytes >= 2048)

  const cleared = await cleanup.clearOrphanShotFrames(userA)
  assert.ok(cleared.removed >= 1)
  assert.equal(fs.existsSync(orphan), false)
  assert.equal(fs.existsSync(path.join(dir, kept.media)), true, '还在用的那张必须留着')

  const again = await cleanup.shotFrameOverview(userA)
  assert.equal(again.orphans.files, 0, '清完就没有了（被记着的一张都在）')
})

test('回收站里的作品不算孤儿：恢复要连画面一起回来', async () => {
  const project = await newProject('进了回收站的那条')
  const saved = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(96) })
  await p.setProjectShotFrames(project.id, [{ shotNo: 1, media: saved.media }], userA)
  const deleted = await p.deleteProject(project.id, userA)
  assert.ok(deleted?.trash?.id, '删作品是进回收站，不是一删到底')
  const before = await cleanup.shotFrameOverview(userA)

  const overview = await cleanup.shotFrameOverview(userA)
  const row = overview.projects.find((item) => item.projectId === project.id)
  assert.ok(row, '回收站里的作品照样列出来')
  assert.equal(row.inTrash, true, '并标明它在回收站')
  assert.equal(overview.orphans.files, before.orphans.files, '它挂着的画面不是孤儿：回收站里的作品恢复要连画面一起回来')

  const cleared = await cleanup.clearOrphanShotFrames(userA)
  assert.equal(cleared.removed, before.orphans.files, '只清本来就没主的那些，回收站那张不动')
  assert.equal(fs.existsSync(path.join(dir, saved.media)), true)

  const restored = await p.restoreProject(project.id, userA)
  assert.equal(restored.status, 200)
  const back = await p.getProject(project.id, userA)
  assert.equal(back.shots['1'].media, saved.media, '恢复之后画面还在')
})

test('作品已经不在、目录还在：如实写「已删除的作品」，清孤儿时一起收掉', async () => {
  const pid = 'prj_gone12345'
  const folder = path.join(dir, 'shotframes', userA.id, pid)
  fs.mkdirSync(folder, { recursive: true })
  const file = path.join(folder, '1700000000001-0123456789ab.png')
  fs.writeFileSync(file, fakePng(256))

  const overview = await cleanup.shotFrameOverview(userA)
  const row = overview.projects.find((item) => item.projectId === pid)
  assert.ok(row, '盘上有文件就该列出来，不能藏起来')
  assert.equal(row.title, '已删除的作品')

  const cleared = await cleanup.clearOrphanShotFrames(userA)
  assert.ok(cleared.removed >= 1)
  assert.equal(fs.existsSync(folder), false, '空目录也收掉')
})

test('面板与接口对得上：设置页读 /api/storage/shotframes，清理走 POST', () => {
  const route = fs.readFileSync(new URL('../server/routes/storage.mjs', import.meta.url), 'utf8')
  assert.ok(route.includes("pathname === '/api/storage/shotframes'"), '按作品拆开的那条')
  assert.ok(route.includes("pathname === '/api/storage/shotframes/clear'"), '清理那条')
  assert.ok(route.includes("body?.scope === 'unused'") || route.includes("scope === 'unused'"), '清孤儿要显式写 scope')
  assert.ok(route.includes('readBody(req)'), '要清哪一块从请求体里读')
  const api = fs.readFileSync(new URL('../src/api/storage.ts', import.meta.url), 'utf8')
  assert.ok(api.includes("'/api/storage/shotframes'"))
  assert.ok(api.includes("'/api/storage/shotframes/clear'"))
  const page = fs.readFileSync(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('getShotFrames()'), '点「管理」才去读')
  assert.ok(page.includes('vq-shotframes'), '面板有自己的一组样式')
  assert.ok(page.includes('确认清空'), '清空是两步，不是一点就没')
  assert.ok(page.includes('原片帧'), '清完会发生什么要写在页面上')
})

test('到上限那句话指得出下一步：设置页「工作流画面 → 管理」', () => {
  const storeFile = fs.readFileSync(new URL('../server/shot-frame-store.mjs', import.meta.url), 'utf8')
  assert.ok(storeFile.includes('到设置页的「工作流画面」点「管理」'), '409 不是终点，要说清去哪儿腾地方')
  assert.ok(storeFile.includes('清掉不用的作品画面'), '清哪一块也要写出来')
})
