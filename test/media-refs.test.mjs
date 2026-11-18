// 参考素材的挂载规则（r228 / v0.9.212）：出图、出视频两个面板共用一套判断。
//
// 这一轮补的是创作闭环里最常走的一步：出一张图 → 拿它当参考接着改 / 当首帧出视频。
// 以前「最近生成」里只有下载，想复用要人手再传一遍；而且界面只判「这个方式收不收素材」，
// 不分收图还是收视频，视频当参考要等服务端 400 才知道不行。所以规则抽成纯函数并锁住：
//   1. 当前方式收这种素材就原地放；不收就找同一模型下第一个收它的方式，并说清楚换了哪个；
//   2. 放满时报出这个方式的上限，同一模型另有放得下的方式就把名字说出来；
//   3. 一条生成结果当素材时的文件名稳定、可读，重复点不会堆出一串同名副本。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  modeCapacity,
  modeTakes,
  planRefAttach,
  refAttachNote,
  taskFileName,
} from '../src/domain/media-refs.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')

// 与服务端 media-models.mjs 的两组方式一致
const IMAGE_MODES = [
  { id: 'text', label: '文生图', minRefs: 0, maxRefs: 0, imageRefs: 0, videoRefs: 0 },
  { id: 'reference', label: '参考图', minRefs: 1, maxRefs: 1, imageRefs: 1, videoRefs: 0 },
]
const VIDEO_MODES = [
  { id: 'text', label: '文生视频', minRefs: 0, maxRefs: 0, imageRefs: 0, videoRefs: 0 },
  { id: 'first', label: '首帧', minRefs: 1, maxRefs: 1, imageRefs: 1, videoRefs: 0 },
  { id: 'mixed', label: '多模态参考', minRefs: 1, maxRefs: 12, imageRefs: 9, videoRefs: 3 },
]
const mode = (list, id) => list.find((item) => item.id === id)

test('参考素材：文生图不收素材，加图自动切到「参考图」', () => {
  const plan = planRefAttach({
    modes: IMAGE_MODES,
    current: mode(IMAGE_MODES, 'text'),
    kind: 'image',
    count: 0,
    alreadyIn: false,
  })
  assert.deepEqual(plan, { ok: true, modeId: 'reference', modeLabel: '参考图', switched: true })
  assert.equal(refAttachNote(plan), '已加入参考素材，生成方式切成「参考图」')
})

test('参考素材：当前方式就收这种素材时原地放，不换方式', () => {
  const plan = planRefAttach({
    modes: VIDEO_MODES,
    current: mode(VIDEO_MODES, 'mixed'),
    kind: 'image',
    count: 2,
    alreadyIn: false,
  })
  assert.deepEqual(plan, { ok: true, modeId: 'mixed', modeLabel: '多模态参考', switched: false })
  assert.equal(refAttachNote(plan), '已加入参考素材')
})

test('参考素材：视频当参考时，收图的首帧要让位给多模态参考', () => {
  const plan = planRefAttach({
    modes: VIDEO_MODES,
    current: mode(VIDEO_MODES, 'first'),
    kind: 'video',
    count: 1,
    alreadyIn: false,
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.ok && plan.modeId, 'mixed')
  assert.equal(plan.ok && plan.switched, true)
})

test('参考素材：模型没有收这种素材的方式就直说，不让服务端去拦', () => {
  const plan = planRefAttach({
    modes: IMAGE_MODES,
    current: mode(IMAGE_MODES, 'text'),
    kind: 'video',
    count: 0,
    alreadyIn: false,
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.ok === false && plan.reason, 'no-mode')
  assert.equal(refAttachNote(plan), '当前模型没有收参考视频的方式')
})

test('参考素材：「参考图」只放 1 张，放满时说清上限，且不给出不存在的方式', () => {
  const plan = planRefAttach({
    modes: IMAGE_MODES,
    current: mode(IMAGE_MODES, 'reference'),
    kind: 'image',
    count: 1,
    alreadyIn: false,
  })
  assert.equal(plan.ok === false && plan.reason, 'full')
  assert.equal(plan.ok === false && plan.capacity, 1)
  assert.equal(plan.ok === false && plan.alternative, null)
  assert.equal(refAttachNote(plan), '「参考图」最多 1 张参考图：先移除一个')
})

test('参考素材：首帧放满时点名多模态参考，别让人一个个试下拉', () => {
  const plan = planRefAttach({
    modes: VIDEO_MODES,
    current: mode(VIDEO_MODES, 'first'),
    kind: 'image',
    count: 1,
    alreadyIn: false,
  })
  assert.equal(plan.ok === false && plan.reason, 'full')
  assert.deepEqual(plan.ok === false && plan.alternative, { id: 'mixed', label: '多模态参考' })
  assert.equal(refAttachNote(plan), '「首帧」最多 1 张参考图：想多放几个，先切到「多模态参考」')
})

test('参考素材：多模态参考的上限按种类算——9 张图、3 段视频', () => {
  assert.equal(modeCapacity(mode(VIDEO_MODES, 'mixed'), 'image'), 9)
  assert.equal(modeCapacity(mode(VIDEO_MODES, 'mixed'), 'video'), 3)
  const images = planRefAttach({
    modes: VIDEO_MODES,
    current: mode(VIDEO_MODES, 'mixed'),
    kind: 'image',
    count: 8,
    alreadyIn: false,
  })
  assert.equal(images.ok, true)
  const videos = planRefAttach({
    modes: VIDEO_MODES,
    current: mode(VIDEO_MODES, 'mixed'),
    kind: 'video',
    count: 3,
    alreadyIn: false,
  })
  assert.equal(videos.ok === false && videos.reason, 'full')
  assert.equal(refAttachNote(videos), '「多模态参考」最多 3 段参考视频：先移除一个')
})

test('参考素材：已经在托架里的素材不重复加', () => {
  const plan = planRefAttach({
    modes: VIDEO_MODES,
    current: mode(VIDEO_MODES, 'mixed'),
    kind: 'image',
    count: 1,
    alreadyIn: true,
  })
  assert.equal(plan.ok === false && plan.reason, 'duplicate')
  assert.equal(refAttachNote(plan), '这个素材已经在参考里了')
})

test('收不收这种素材：按 imageRefs / videoRefs 判，与服务端同一套规则', () => {
  assert.equal(modeTakes(mode(VIDEO_MODES, 'first'), 'image'), true)
  assert.equal(modeTakes(mode(VIDEO_MODES, 'first'), 'video'), false)
  assert.equal(modeTakes(mode(VIDEO_MODES, 'text'), 'image'), false)
  assert.equal(modeTakes(null, 'image'), false)
})

test('结果当素材：文件名带一段提示词和任务号尾巴，扩展名按真实类型', () => {
  assert.equal(
    taskFileName({ id: 'mgen_AbCdEf123456', kind: 'image', prompt: '橘猫在窗台上晒太阳', file: { mime: 'image/png' } }),
    '橘猫在窗台上晒太阳-123456.png',
  )
  assert.equal(
    taskFileName({ id: 'mgen_ZzYyXx987654', kind: 'video', prompt: '雨夜霓虹街道', file: { mime: 'video/mp4' } }),
    '雨夜霓虹街道-987654.mp4',
  )
  // 截断后两端的标点要削掉：种子的提示词以逗号结尾时，名字不能拖一个「，-」
  assert.equal(
    taskFileName({ id: 'mgen_R228ImgSample', kind: 'image', prompt: '橘猫在窗台上晒太阳，逆光，暖色，9:16 竖版', file: { mime: 'image/png' } }),
    '橘猫在窗台上晒太阳，逆光，暖色-Sample.png',
  )
  // 提示词里的斜杠、冒号、空格不能带进文件名；长提示词截断，别把名字撑爆
  assert.equal(
    taskFileName({ id: 'mgen_1234567890ab', kind: 'image', prompt: 'a/b:c 风格 参考图 很长的提示词一句话', file: { mime: 'image/jpeg' } }),
    'a-b-c-风格-参考图-很长的-7890ab.jpg',
  )
})

test('界面：最近生成与结果卡都能「用作参考」，且走同一条上传递交路径', () => {
  // 规则来自 domain，界面不另写一套
  assert.ok(page.includes("from '../domain/media-refs'"))
  // 名字不能以 use 开头，否则 lint 会把它当 Hook（rules-of-hooks 直接判 error）
  assert.ok(page.includes('const addTaskResultAsRef = async (item: MediaTask) =>'))
  assert.equal(page.includes('useTaskAsReference'), false)
  // 取回结果字节 + 读元信息 + 走既有上传接口：不新增接口、不在前端扣积分
  assert.ok(page.includes("await fetch(item.downloadUrl, { credentials: 'same-origin' })"))
  assert.ok(page.includes('await uploadMediaAsset({ file, ...meta })'))
  assert.ok(page.includes('const attachAsset = (asset: MediaAsset)'))
  // 两处入口：最近生成每行一个，结果卡下面一个
  assert.ok(page.includes('agx-media-recent-ref'))
  assert.ok(page.includes('用作参考'))
})
