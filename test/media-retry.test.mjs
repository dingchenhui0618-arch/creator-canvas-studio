import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { planTaskRetry, retryCredits } from '../src/domain/media-retry.ts'

// 图片：一个模型、两种方式（文生不收素材 / 参考图要一张），比例与时长都给全
const imageModel = {
  id: 'gpt-image-2',
  kind: 'image',
  label: 'GPT Image 2',
  platform: 'GeteAPI',
  verified: true,
  referenceVerified: false,
  modes: [
    { id: 'text2image', label: '文生图', hint: '', minRefs: 0, maxRefs: 0, imageRefs: 0, videoRefs: 0 },
    { id: 'image2image', label: '参考图', hint: '', minRefs: 1, maxRefs: 1, imageRefs: 1, videoRefs: 0 },
  ],
  ratios: ['1:1', '9:16'],
  durations: [],
  resolutions: [],
  credits: 5,
}

const videoModel = {
  id: 'seedance-2.0',
  kind: 'video',
  label: 'Seedance 2.0',
  platform: 'SeeAPI',
  verified: true,
  referenceVerified: false,
  modes: [
    { id: 'text2video', label: '文生视频', hint: '', minRefs: 0, maxRefs: 0, imageRefs: 0, videoRefs: 0 },
    { id: 'image2video', label: '图生视频', hint: '', minRefs: 1, maxRefs: 2, imageRefs: 2, videoRefs: 0 },
  ],
  ratios: ['9:16', '16:9'],
  durations: [4, 8],
  resolutions: ['480p', '720p'],
  credits: 15,
}

const catalog = [imageModel, videoModel]

function task(extra = {}) {
  return {
    id: 'mgen_retry01',
    kind: 'image',
    status: 'failed',
    prompt: '一只橘猫坐在窗台上',
    model: 'gpt-image-2',
    mode: 'text2image',
    ratio: '1:1',
    size: '1024x1024',
    duration: null,
    resolution: '',
    assets: [],
    progress: null,
    createdAt: '2026-11-18T03:00:00.000Z',
    updatedAt: '2026-11-18T03:00:00.000Z',
    finishedAt: '2026-11-18T03:00:05.000Z',
    error: '上游超时',
    file: null,
    downloadUrl: '',
    credits: { cost: 5, balance: 100, refunded: true, refundedAt: null },
    ...extra,
  }
}

const refAsset = {
  id: 'asset_abc123',
  kind: 'image',
  name: '猫.png',
  bytes: 2048,
  width: 640,
  height: 480,
  duration: null,
}

test('照原样再来一次：提示词、模型、方式、比例、时长、清晰度、参考素材全部按那条任务搬', () => {
  const plan = planTaskRetry(
    task({
      model: 'seedance-2.0',
      kind: 'video',
      mode: 'image2video',
      ratio: '16:9',
      duration: 8,
      resolution: '720p',
      assets: [refAsset],
    }),
    catalog,
  )
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.input, {
    prompt: '一只橘猫坐在窗台上',
    modelId: 'seedance-2.0',
    modeId: 'image2video',
    ratio: '16:9',
    duration: 8,
    resolution: '720p',
    assetIds: ['asset_abc123'],
  })
  assert.equal(plan.assets.length, 1)
  assert.equal(plan.assets[0].previewUrl, '/api/media/assets/asset_abc123/file', '托架要能画出缩略图')
  assert.equal(plan.assets[0].kind, 'image')
})

test('模型下线了就说清是哪一条，不偷偷换成别的模型扣积分', () => {
  const plan = planTaskRetry(task({ model: 'gpt-image-1-old' }), catalog)
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /gpt-image-1-old/, '原因里要带模型号，别只说「失败」')
})

test('方式下线落回这个模型的第一个方式；比例 / 时长 / 清晰度不在当前规格也落回第一个', () => {
  const plan = planTaskRetry(
    task({
      model: 'seedance-2.0',
      kind: 'video',
      mode: 'first-frame',
      ratio: '4:5',
      duration: 12,
      resolution: '1080p',
    }),
    catalog,
  )
  assert.equal(plan.ok, true)
  assert.equal(plan.input.modeId, 'text2video')
  assert.equal(plan.input.ratio, '9:16')
  assert.equal(plan.input.duration, 4)
  assert.equal(plan.input.resolution, '480p')
})

test('文生方式不收素材：原任务带过也不发（服务端也会拒）', () => {
  const plan = planTaskRetry(task({ mode: 'text2image', assets: [refAsset] }), catalog)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.input.assetIds, [])
  assert.deepEqual(plan.assets, [], '托架也不该挂上去')
})

test('收素材的方式按上限截：多出来的不带，别把这一请求撑爆', () => {
  const many = [
    refAsset,
    { ...refAsset, id: 'asset_abc124', name: '猫二.png' },
    { ...refAsset, id: 'asset_abc125', name: '猫三.png' },
  ]
  const plan = planTaskRetry(task({ model: 'seedance-2.0', kind: 'video', mode: 'image2video', assets: many }), catalog)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.input.assetIds, ['asset_abc123', 'asset_abc124'])
})

test('按钮上的积分按当前价算；模型不在了就按这条当初花的；都没有才用兜底', () => {
  assert.equal(retryCredits(task(), catalog, 5), 5)
  assert.equal(retryCredits(task({ model: 'retired-model', credits: { cost: 15 } }), catalog, 5), 15)
  assert.equal(retryCredits(task({ model: 'retired-model', credits: { cost: 0 } }), catalog, 5), 5)
})

test('三个入口都接上了再来一次：失败结果卡、最近生成的失败行、成功卡的「再生成一次」', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'AgentsPage.tsx'), 'utf8')
  assert.match(page, /planTaskRetry\(item, catalog\)/, '参数要由 domain 算，别在页面里各写一套')
  assert.match(page, /agx-media-recent-retry/)
  assert.match(page, /agx-media-error-actions/)
  assert.match(page, /再生成一次 · \{retryCredits/, '成功卡的再生成要写清会再扣多少积分')
  assert.match(page, /再来一次 · \{retryCredits/, '失败卡的重试也要写清积分')
  assert.match(page, /setAssets\(plan\.assets\)/, '点重试要先把旧参数填回输入框给人看见')
  assert.ok(!page.includes('清掉结果'), '结果卡上四枚主动作要能一行站下，第五枚只会折行')
  // 提交只有一条路：参数由调用方给死，不读闭包里的 state
  assert.match(page, /const runGeneration = async \(input: MediaRetryInput, priced: number\)/)
  assert.equal((page.match(/generateMediaImage\(payload\)/g) || []).length, 1)
})