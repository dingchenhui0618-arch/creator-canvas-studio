import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 自有资产（r311）盯住四件事：
//   1) 提示词是否真的把「保持商品 / 保持这张脸」写死（这是四张图一致性的唯一开关）；
//   2) 归属：别人的资产与别人的素材都必须当不存在，不能靠猜 id 读到；
//   3) 建资产本身不花钱，生成才花钱，而且没有素材图不允许生成；
//   4) 进程重启后卡在 generating 的资产要标中断，不能永远转圈。
//
// 这一组**不调上游**：出图要花钱，真调由用户在自己账号上发起（见 docs 里的真调清单）。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-assets-'))
process.env.DATA_DIR = dir

const { buildAssetPrompt, assetJobPlan, slotsFor } = await import('../server/asset-prompts.mjs')
const onboarding = await import('../server/onboarding.mjs')
const assets = await import('../server/assets.mjs')
const { saveMediaAsset } = await import('../server/media-assets.mjs')

const OWNER = 'usr_assets_test_1'
const OTHER = 'usr_assets_test_2'

// 1×1 的合法 PNG：素材库按文件头认格式，不接受随便几个字节
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function uploadSource(owner = OWNER, name = '商品图') {
  return saveMediaAsset({ userId: owner, buffer: PNG, name, width: 1, height: 1 })
}

test('四个槽位都有提示词，且都写死了「保持主体不变」与「不出现文字」', () => {
  for (const kind of ['product', 'avatar']) {
    const slots = slotsFor(kind)
    assert.equal(slots.length, 4, kind + ' 应该是 4 个槽位')
    for (const item of slots) {
      const prompt = buildAssetPrompt({ kind, slot: item.slot, name: '羊毛开衫', category: '服装' })
      assert.ok(prompt.length > 40, kind + '/' + item.slot + ' 的提示词太短')
      assert.match(prompt, /保持/, kind + '/' + item.slot + ' 必须说明要保持原样')
      assert.match(prompt, /不出现任何文字/, kind + '/' + item.slot + ' 必须禁止模型加字')
      assert.ok(prompt.includes('羊毛开衫'), '主体名称要进提示词，模型才知道这是什么')
    }
  }
})

test('未知槽位不编提示词，商品图用人像提示词也不行', () => {
  assert.equal(buildAssetPrompt({ kind: 'product', slot: 'nope' }), '')
  assert.equal(buildAssetPrompt({ kind: 'video', slot: 'hero' }), '')
  assert.ok(buildAssetPrompt({ kind: 'avatar', slot: 'hero' }) === '')
})

test('一次生成 4 张：商品是方图，人像是竖图', () => {
  const product = assetJobPlan({ kind: 'product', name: '杯子' })
  const avatar = assetJobPlan({ kind: 'avatar', name: '小夏' })
  assert.equal(product.length, 4)
  assert.equal(avatar.length, 4)
  assert.equal(product[0].size, '1024x1024')
  assert.equal(avatar[0].size, '1024x1536')
  assert.deepEqual(product.map((item) => item.slot), ['hero', 'scene', 'detail', 'pack'])
  assert.deepEqual(avatar.map((item) => item.slot), ['front', 'half', 'side', 'action'])
})

test('身份只认三个枚举值，方向最多 20 字，完成是幂等的', () => {
  assert.equal(onboarding.saveIdentity(OWNER, { identity: '乱写' }).identity, '')
  const saved = onboarding.saveIdentity(OWNER, { identity: 'commerce', category: '服装', direction: '一'.repeat(30) })
  assert.equal(saved.identity, 'commerce')
  assert.equal(saved.category, '服装')
  assert.equal(saved.direction.length, 20)
  assert.ok(saved.identityAt)

  const first = onboarding.markComplete(OWNER, { skipAssets: true })
  const second = onboarding.markComplete(OWNER)
  assert.equal(first.doneAt, second.doneAt, '重复完成不能改时间')
  assert.ok(second.skippedAt)

  const view = onboarding.onboardingView(OWNER, { product: 0, avatar: 0 })
  assert.equal(view.done, true)
  assert.equal(view.needs.identity, false)
  assert.equal(view.needs.asset, true, '一件资产都没有时仍要提示建资产')
  assert.equal(onboarding.onboardingView(OWNER, { product: 1, avatar: 0 }).needs.asset, false)

  assert.equal(onboarding.removeOnboarding(OWNER), true)
  assert.equal(onboarding.onboardingView(OWNER).identity, '')
})

test('建资产不调上游、不扣积分，只落一份 draft', async () => {
  const source = await uploadSource()
  const asset = await assets.createAsset({
    ownerId: OWNER,
    kind: 'product',
    name: '  羊毛  开衫 ',
    category: '服装',
    sourceAssetIds: [source.id],
  })
  assert.match(asset.id, /^asst_/)
  assert.equal(asset.status, 'draft')
  assert.equal(asset.name, '羊毛 开衫', '名字要压掉多余空白')
  assert.equal(asset.refs.length, 0)
  assert.equal(asset.sources.length, 1)
  assert.equal(asset.sources[0].previewUrl, '/api/media/assets/' + source.id + '/file')
  assert.equal(asset.progress.total, 4)
})

test('没有素材图 / 素材不属于自己 / 名字为空 一律拒绝', async () => {
  await assert.rejects(() => assets.createAsset({ ownerId: OWNER, kind: 'product', name: '空手', sourceAssetIds: [] }), /先上传素材图/)
  await assert.rejects(() => assets.createAsset({ ownerId: OWNER, kind: 'product', name: '  ', sourceAssetIds: ['ast_x'] }), /起个名字/)
  await assert.rejects(() => assets.createAsset({ ownerId: OWNER, kind: 'video', name: 'x', sourceAssetIds: ['ast_x'] }), /只支持/)

  // 别人账号的素材：当成不存在，不是「无权限」
  const others = await uploadSource(OTHER, '别人的图')
  await assert.rejects(
    () => assets.createAsset({ ownerId: OWNER, kind: 'product', name: '偷图', sourceAssetIds: [others.id] }),
    /找不到/,
  )
})

test('归属：列表与读取都只认自己的，别人的 id 当不存在', async () => {
  const source = await uploadSource()
  const mine = await assets.createAsset({ ownerId: OWNER, kind: 'avatar', name: '小夏', sourceAssetIds: [source.id] })
  const list = await assets.listAssets(OWNER)
  assert.ok(list.some((item) => item.id === mine.id))
  const others = await assets.listAssets(OTHER)
  assert.equal(others.some((item) => item.id === mine.id), false, '别人不能看到我的资产')
  assert.equal(await assets.getAsset(OTHER, mine.id), null)
  await assert.rejects(() => assets.updateAsset(OTHER, mine.id, { name: '改' }), /不存在/)
  await assert.rejects(() => assets.deleteAsset(OTHER, mine.id), /不存在/)
})

test('资产图预览：没有生成过就是空的，槽位名不合法也读不到', async () => {
  const source = await uploadSource()
  const asset = await assets.createAsset({ ownerId: OWNER, kind: 'product', name: '还没出图', sourceAssetIds: [source.id] })
  assert.equal(await assets.resolveRefFile(OWNER, asset.id, 'hero'), null)
  assert.equal(await assets.resolveRefFile(OWNER, asset.id, '../meta'), null)
  assert.equal(await assets.resolveRefFile(OWNER, asset.id, 'HERO'), null)
})

test('没有素材图的资产不允许生成（这一步会花钱，必须挡在扣费之前）', async () => {
  const meta = {
    version: 1,
    id: 'asst_' + Date.now().toString(36) + '_abcd',
    ownerId: OWNER,
    kind: 'product',
    name: '无来源',
    category: '',
    status: 'draft',
    progress: { done: 0, total: 4 },
    sources: [],
    refs: [],
    error: '',
    free: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const assetDir = path.join(dir, 'assets', OWNER, meta.id)
  fs.mkdirSync(assetDir, { recursive: true })
  fs.writeFileSync(path.join(assetDir, 'meta.json'), JSON.stringify(meta))
  await assert.rejects(() => assets.startAssetGeneration({ ownerId: OWNER, assetId: meta.id }), /还没有素材图/)
})

test('重启恢复：卡在 generating 的资产要标成中断，不再永远转圈', async () => {
  const source = await uploadSource()
  const asset = await assets.createAsset({ ownerId: OWNER, kind: 'product', name: '卡住的', sourceAssetIds: [source.id] })
  const file = path.join(dir, 'assets', OWNER, asset.id, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
  meta.status = 'generating'
  meta.updatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  fs.writeFileSync(file, JSON.stringify(meta))

  const recovered = await assets.recoverInterruptedAssets({ olderThanMs: 1000 })
  assert.ok(recovered >= 1)
  const after = await assets.getAsset(OWNER, asset.id)
  assert.equal(after.status, 'failed')
  assert.match(after.error, /中断/)
})

test('删账号时把整套资产连图一起删掉', async () => {
  const source = await uploadSource()
  const asset = await assets.createAsset({ ownerId: OWNER, kind: 'product', name: '要删的', sourceAssetIds: [source.id] })
  const removed = await assets.deleteAssetsByOwner(OWNER)
  assert.ok(removed >= 1)
  assert.equal(await assets.getAsset(OWNER, asset.id), null)
  assert.equal(fs.existsSync(path.join(dir, 'assets', OWNER)), false)
})
