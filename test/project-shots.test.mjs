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
const store = await import('../server/shot-frame-store.mjs')
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

test('记录只留自己账号下的图与真实时间，别的东西一律丢掉', () => {
  const kept = shots.normalizeShotFrames({
    1: { media: mine, at: '2026-11-16T01:00:00.000Z' },
    2: { media: 'https://example.com/a.jpg', at: '2026-11-16T01:00:00.000Z' },
    3: { media: theirs, at: '不是时间' },
    4: { media: 'shotframes/u_a/prj_aaaa1111/1730000000-abcdef12.png', at: '2026-11-20T01:00:00.000Z' },
    5: { media: 'shotframes/u_a/prj_aaaa1111/../../etc/passwd', at: '2026-11-20T01:00:00.000Z' },
    x: { media: mine, at: '2026-11-16T01:00:00.000Z' },
  })
  assert.deepEqual(Object.keys(kept), ['1', '4'], '上传素材与分镜画面库两种都认；外链、坏时间、不认识的镜头号、路径穿越都不算')
  assert.deepEqual(shots.normalizeShotFrames(null), {})
  assert.deepEqual(shots.parseShotMedia('uploads/u_a/a.png'), { kind: 'upload', ownerId: 'u_a', projectId: '', name: 'a.png' })
  assert.deepEqual(shots.parseShotMedia('shotframes/u_a/prj_aaaa1111/1730000000-abcdef12.png'), { kind: 'store', ownerId: 'u_a', projectId: 'prj_aaaa1111', name: '1730000000-abcdef12.png' })
  assert.equal(shots.parseShotMedia('shotframes/u_a/prj_aaaa1111/a.png'), null, '分镜画面库的文件名要按它自己的起名规则')
  assert.equal(shots.parseShotMedia('shotframes/u_a/a.png'), null, '分镜画面库里必须有作品这一段')
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

// ---------- r278：运行画完的图怎么回贴到分镜 ----------

const runOf = (nodes) => ({ id: 'run_test0001', flowId: 'flow_1', nodes })

test('只认按分镜建的出图节点：跳过、失败、别的 id 都不算，镜号必须在分镜范围内', () => {
  const run = runOf([
    { id: 'n_input', kind: 'input', status: 'success', output: { text: '原始素材' } },
    { id: 'n_llm', kind: 'llm', status: 'success', output: { text: '脚本' } },
    { id: 'n_shot_01', kind: 'image', status: 'success', output: { imagePath: 'runs/run_test0001/n_shot_01.png' } },
    // 第 2 镜这次没画成：没有图，不该占着第 2 镜
    { id: 'n_shot_02', kind: 'image', status: 'error', output: null },
    // 第 3 镜上游没跑到
    { id: 'n_shot_03', kind: 'image', status: 'skipped', output: null },
    // 模板只拆出 3 镜，第 4 镜的节点不该往里塞
    { id: 'n_shot_04', kind: 'image', status: 'success', output: { imagePath: 'runs/run_test0001/n_shot_04.png' } },
    // 用户自己拉的出图节点：没有镜号
    { id: 'n_image_7', kind: 'image', status: 'success', output: { imagePath: 'runs/run_test0001/n_image_7.png' } },
    // 出图节点但没有落盘路径（老运行 / 上游只回了地址）
    { id: 'n_shot_05', kind: 'image', status: 'success', output: { imageUrl: '/api/runs/run_test0001/x.png' } },
  ])
  assert.deepEqual(shots.runShotImages(run, 3), [{ shotNo: 1, file: 'n_shot_01.png' }], '只有第 1 镜是对的：第 2/3 镜没画成、第 4 镜超出分镜、第 5 镜没有落盘路径')
  assert.deepEqual(shots.runShotImages(run, 0), [], '没有分镜就一张都不贴')
  assert.deepEqual(shots.runShotImages(null, 5), [])
})

test('同一镜被复制成两个节点时只算第一次，顺序按镜号', () => {
  const run = runOf([
    { id: 'n_shot_02', kind: 'image', status: 'success', output: { imagePath: 'runs/run_test0001/n_shot_02.png' } },
    { id: 'n_shot_01', kind: 'image', status: 'success', output: { imagePath: 'runs/run_test0001/n_shot_01.png' } },
    { id: 'n_shot_02', kind: 'image', status: 'success', output: { imagePath: 'runs/run_test0001/n_shot_02_copy.png' } },
  ])
  assert.deepEqual(shots.runShotImages(run, 3), [
    { shotNo: 1, file: 'n_shot_01.png' },
    { shotNo: 2, file: 'n_shot_02.png' },
  ])
})

test('一次贴多镜：同一次运行再贴不重复占位置，原来有画面的记成「换掉」', async () => {
  const project = await p.createProject({ title: '回贴作品', templateId: template.id }, userA)
  const first = await p.setProjectShotFrames(project.id, [
    { shotNo: 1, media: 'uploads/u_a/run-a-1.png', from: 'run_aaaa1111' },
    { shotNo: 2, media: 'uploads/u_a/run-a-2.png', from: 'run_aaaa1111' },
  ], userA)
  assert.equal(first.status, 200)
  assert.deepEqual(first.applied.map((row) => row.shotNo), [1, 2])
  assert.deepEqual(first.overwritten, [], '这两镜原来是空的，不算换掉')
  assert.deepEqual(first.kept, [])

  const again = await p.setProjectShotFrames(project.id, [
    { shotNo: 1, media: 'uploads/u_a/run-a-1b.png', from: 'run_aaaa1111' },
    { shotNo: 2, media: 'uploads/u_a/run-a-2.png', from: 'run_aaaa1111' },
  ], userA)
  assert.deepEqual(again.kept, [1, 2], '同一次运行画的镜不重复贴：换一份新文件名也不该顶上去')
  assert.deepEqual(again.applied, [])
  assert.equal(again.changed, false)

  const read = await p.getProject(project.id, userA)
  assert.equal(read.shots['1'].media, 'uploads/u_a/run-a-1.png', '记录还是第一次那张')
  assert.equal(read.shots['1'].from, 'run_aaaa1111', '记着这批图是哪次运行画的')

  const second = await p.setProjectShotFrames(project.id, [
    { shotNo: 1, media: 'uploads/u_a/run-b-1.png', from: 'run_bbbb2222' },
  ], userA)
  assert.deepEqual(second.applied.map((row) => row.shotNo), [1])
  assert.deepEqual(second.overwritten, [1], '换了一次运行画的图：要说清第 1 镜原来有画面')
  assert.equal((await p.getProject(project.id, userA)).shots['1'].from, 'run_bbbb2222')
})

test('不是自己的作品贴不进去：批量这条路同样核归属', async () => {
  const project = await p.createProject({ title: '别人的回贴', templateId: template.id }, userA)
  const blocked = await p.setProjectShotFrames(project.id, [
    { shotNo: 1, media: 'uploads/u_b/run-1.png', from: 'run_bbbb2222' },
  ], userB)
  assert.equal(blocked.status, 404, '别人的作品，批量接口也不让写')
  assert.equal(await p.getProject(project.id, userB), null)
})

test('贴回来的记录：from 只认运行号，页面读的形状带上它', () => {
  const kept = shots.normalizeShotFrames({
    1: { media: mine, at: '2026-11-20T10:00:00.000Z', from: 'run_abc12345' },
    2: { media: mine, at: '2026-11-20T10:00:00.000Z', from: '不是运行号' },
    3: { media: mine, at: '2026-11-20T10:00:00.000Z', from: '/etc/passwd' },
  })
  assert.equal(kept['1'].from, 'run_abc12345')
  assert.equal(kept['2'].from, undefined, '不像运行号的一律不记，不拿它当凭证')
  assert.equal(kept['3'].from, undefined)
  const view = shots.shotFramesView(kept)
  assert.equal(view['1'].from, 'run_abc12345')
  assert.equal(view['1'].frameUrl, '/media/' + mine)
  assert.equal(view['2'].from, undefined, '没有 from 的记录不长出这个字段')
})

test('回贴入口在两处都摆得出来：运行记录那一行、分镜列表上面那句提示', () => {
  const routes = fs.readFileSync(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')
  assert.ok(routes.includes('from-run'), '路由按这个形状注册')
  assert.match(routes, /runShotImages\(run, shotCount\)/, '按分镜认镜号')
  assert.ok(routes.includes('projectFlowIds(project).includes('), '只认这条作品自己的工作流')
  assert.ok(routes.includes('planRunAttach(images, project.shots, run.id)'), '回贴前先分堆，重贴不白复制 8 张图')
  assert.ok(routes.includes('saveShotFrame({ userId: user.id, projectId: project.id, buffer })'), '图先存进分镜画面库，运行目录被清也不丢')
  assert.ok(routes.includes('sweepProjectShotFrames('), '换图 / 撤销之后把没人用的那张清掉')
  const page = fs.readFileSync(new URL('../src/pages/ProjectPage.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('attachRunShotFrames(projectId, run.id)'))
  assert.ok(page.includes('vq-run-shots'), '运行记录那一行有入口')
  assert.ok(page.includes('vq-shot-backfeed'), '分镜上面那句提示带着同一个入口')
})

test('回贴前先分堆：已经贴过这次运行的镜不再复制一份', () => {
  const images = [
    { shotNo: 1, file: 'a.png' },
    { shotNo: 2, file: 'b.png' },
    { shotNo: 3, file: 'c.png' },
  ]
  const frames = {
    1: { media: 'uploads/u_a/x.png', at: '2026-11-20T10:00:00.000Z', from: 'run_abc12345' },
    2: { media: 'uploads/u_a/y.png', at: '2026-11-20T10:00:00.000Z' },
  }
  const plan = shots.planRunAttach(images, frames, 'run_abc12345')
  assert.deepEqual(plan.kept, [1], '第 1 镜已经是这次运行画的图了')
  assert.deepEqual(plan.toCopy.map((row) => row.shotNo), [2, 3], '第 2 镜是手贴的、第 3 镜空着，都要复制')
  assert.deepEqual(shots.planRunAttach(images, frames, 'run_other9').toCopy.map((row) => row.shotNo), [1, 2, 3], '换一次运行：原来那几张都要被换掉，所以都得复制')
  assert.deepEqual(shots.planRunAttach(null, null, 'run_abc12345'), { toCopy: [], kept: [] })
})

test('传空是撤销，不是「不是你的图」：以前撤销按钮点了只会弹一句报错', () => {
  assert.equal(shots.shotFrameBlock({ media: '', user: userA, shotNo: 1, shotCount: 3 }), null, '空值 = 这一镜用回原片，放行')
  const badShot = shots.shotFrameBlock({ media: '', user: userA, shotNo: 0, shotCount: 3 })
  assert.equal(badShot.status, 400, '但镜头号还是要对')
  assert.match(badShot.error, /镜头号/)
  const noBoard = shots.shotFrameBlock({ media: '', user: userA, shotNo: 1, shotCount: 0 })
  assert.equal(noBoard.status, 409, '没有分镜就没有「第几镜」，空值也一样')
  assert.match(shots.shotFrameBlock({ media: 'https://example.com/a.png', user: userA, shotNo: 1, shotCount: 3 }).error, /自己账号下的图/)
})
// ---------- r279：分镜画面自己的库（不再吃上传额度） ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const fakePng = (bytes = 64) => Buffer.concat([PNG_SIGNATURE, Buffer.alloc(Math.max(1, bytes))])

test('分镜画面存进自己的目录：路径带账号与作品，字节与类型都记对', async () => {
  const project = await p.createProject({ title: '画面库', templateId: template.id }, userA)
  const saved = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(128) })
  assert.match(saved.media, new RegExp('^shotframes/u_a/' + project.id + '/\\d{10,16}-[0-9a-f]{12}\\.png$'))
  assert.equal(saved.imageUrl, '/media/' + saved.media, '页面直接拿这个地址显示')
  assert.equal(saved.bytes, 128 + PNG_SIGNATURE.length)
  assert.equal(saved.mime, 'image/png')
  const onDisk = path.join(dir, saved.media)
  assert.equal(fs.existsSync(onDisk), true, '文件真的落在这个账号 / 这条作品的目录里')
  assert.equal(fs.statSync(onDisk).size, saved.bytes)
  assert.equal(saved.media.startsWith('uploads/'), false, '不再塞进上传素材：那 20 个位置是用户自己传的图')
  // 这条作品自己的画面：解析出来的路径就在这个目录里
  const target = store.resolveShotFrame(userA.id, project.id, saved.media.split('/').pop())
  assert.equal(target.file, onDisk)
  assert.equal(target.mime, 'image/png')
})

test('只认图片文件头与上限：别的文件、太大的一律收不进来', async () => {
  const project = await p.createProject({ title: '画面库校验', templateId: template.id }, userA)
  await assert.rejects(() => store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: Buffer.from('<html>hi</html>') }), (error) => {
    assert.equal(error.status, 415, '按内容看不是图：扩展名骗不过去')
    return true
  })
  await assert.rejects(() => store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: Buffer.alloc(store.SHOT_FRAME_LIMITS.maxBytes + 1) }), (error) => {
    assert.equal(error.status, 413)
    return true
  })
  await assert.rejects(() => store.saveShotFrame({ userId: 'u_a', projectId: '../etc', buffer: fakePng() }), (error) => {
    assert.equal(error.status, 400, '作品编号不像编号，直接拒：路径里要拼它')
    return true
  })
})

test('文件名只认服务端起的形状：路径穿越与别的目录都不解析', () => {
  assert.equal(store.resolveShotFrame('u_a', 'prj_aaaa1111', '../../etc/passwd'), null)
  assert.equal(store.resolveShotFrame('u_a', 'prj_aaaa1111', 'x.png'), null, '不是「时间戳-随机串」的名字不认')
  assert.equal(store.resolveShotFrame('u_a', 'prj_aaaa1111', '1730000000-abcdef12.png').file.includes('prj_aaaa1111'), true)
  assert.equal(store.shotFrameFileName('uploads/u_a/a.png', 'u_a', 'prj_aaaa1111'), '', '别的库的路径不是这条作品的画面')
  assert.equal(store.shotFrameFileName('shotframes/u_a/prj_bbbb2222/1730000000-abcdef12.png', 'u_a', 'prj_aaaa1111'), '', '别的作品的画面不认')
})

test('换图 / 撤销之后，没人用的那张从盘上清掉', async () => {
  const project = await p.createProject({ title: '清理', templateId: template.id }, userA)
  const one = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(32) })
  const two = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(48) })
  const swept = await store.sweepProjectShotFrames({ userId: userA.id, projectId: project.id, keep: [two.media] })
  assert.deepEqual(swept, { removed: 1, kept: 1 })
  assert.equal(fs.existsSync(path.join(dir, one.media)), false, '换掉的那张不在盘上了')
  assert.equal(fs.existsSync(path.join(dir, two.media)), true, '还在用的那张不能动')
  const usage = await store.shotFrameUsage(userA.id)
  assert.equal(usage.maxFiles, store.SHOT_FRAME_LIMITS.maxAccountFiles, '用量带着上限，页面据此说实数')
  assert.equal(usage.files >= 1, true)
})

test('分镜画面能挂进作品；别的作品的、别人的一律挡住', async () => {
  const project = await p.createProject({ title: '挂画面', templateId: template.id }, userA)
  const other = await p.createProject({ title: '另一条', templateId: template.id }, userA)
  const saved = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(32) })
  assert.equal(shots.shotFrameBlock({ media: saved.media, user: userA, shotNo: 1, shotCount: 3, projectId: project.id }), null, '自己作品的画面可以挂')
  const crossed = shots.shotFrameBlock({ media: saved.media, user: userA, shotNo: 1, shotCount: 3, projectId: other.id })
  assert.equal(crossed.status, 400, '另一条作品不能拿这条作品的画面')
  assert.match(crossed.error, /另一条作品/)
  const foreign = shots.shotFrameBlock({ media: 'shotframes/u_b/prj_aaaa1111/1730000000-abcdef12.png', user: userA, shotNo: 1, shotCount: 3, projectId: project.id })
  assert.equal(foreign.status, 404, '别人账号下的画面按「不在你账号下」回')

  const set = await p.setProjectShotFrames(project.id, [{ shotNo: 1, media: saved.media, from: 'run_cccc3333' }], userA)
  assert.equal(set.status, 200)
  const read = await p.getProject(project.id, userA)
  assert.equal(read.shots['1'].media, saved.media, '分镜画面库的路径也记得进作品')
})

test('账号总量封顶：满了明说，不悄悄顶掉别人的画面', async () => {
  const limits = store.SHOT_FRAME_LIMITS
  const before = limits.maxAccountFiles
  const project = await p.createProject({ title: '封顶', templateId: template.id }, userA)
  try {
    const usage = await store.shotFrameUsage(userA.id)
    limits.maxAccountFiles = usage.files
    await assert.rejects(() => store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(16) }), (error) => {
      assert.equal(error.status, 409)
      assert.match(error.message, /上限/)
      return true
    })
  } finally {
    limits.maxAccountFiles = before
  }
})

test('彻底删除作品时画面一起走；回收站里不动', async () => {
  const project = await p.createProject({ title: '删了就走', templateId: template.id }, userA)
  const saved = await store.saveShotFrame({ userId: userA.id, projectId: project.id, buffer: fakePng(32) })
  const onDisk = path.join(dir, saved.media)
  await p.setProjectShotFrames(project.id, [{ shotNo: 1, media: saved.media, from: 'run_dddd4444' }], userA)
  await p.deleteProject(project.id, userA)
  assert.equal(fs.existsSync(onDisk), true, '进回收站不等于删掉：恢复要连画面一起回来')
  await p.purgeProject(project.id, userA)
  assert.equal(fs.existsSync(onDisk), false, '彻底删除之后画面不留')
})

test('读回来的那条路由也接上了：/media/shotframes 按归属给图', () => {
  const media = fs.readFileSync(new URL('../server/routes/media.mjs', import.meta.url), 'utf8')
  assert.ok(media.includes('/media/shotframes'), '登录门与路由前缀都认得这条路径')
  assert.ok(media.includes('resolveShotFrame('), '读图走分镜画面库的解析，不拼路径')
  assert.ok(media.includes("extraPrefixes: ['/media/uploads', '/media/shotframes']"))
})
