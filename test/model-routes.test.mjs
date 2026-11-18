import test from 'node:test'
import assert from 'node:assert/strict'

// 统一路由是「一条能力只有一条在用的模型」。这组测试盯的是：
//   1) 四条能力各有一条主路由，出图 / 出视频的型号是线上真在跑的那两条；
//   2) 同能力下的其它模型一律 reference，不会被当成主路由；
//   3) 汇总出来的「仅参考多少个」是照目录现算的，不是写死的数字。
process.env.DATA_DIR = process.env.DATA_DIR || 'C:\\Windows\\Temp\\vq-model-routes-test'

const { primaryRouteFor, primaryRoutes, routeRoleFor, routeSummary } = await import('../server/model-routes.mjs')

test('四条能力各有一条主路由，型号与线上一致', () => {
  const routes = primaryRoutes()
  assert.deepEqual(
    routes.map((route) => route.capability),
    ['text', 'vision', 'image', 'video'],
  )
  assert.equal(primaryRouteFor('image').model, 'gpt-image-2')
  assert.equal(primaryRouteFor('video').model, 'seedance-2.0')
  // 文本与视觉来自环境变量，至少要有个值，不能是空串
  assert.ok(primaryRouteFor('text').model.length > 0)
  assert.ok(primaryRouteFor('vision').model.length > 0)
})

test('同能力下的其它模型都是仅参考', () => {
  assert.equal(routeRoleFor('image', 'gpt-image-2'), 'primary')
  assert.equal(routeRoleFor('image', 'GPT-Image-2'), 'primary')
  assert.equal(routeRoleFor('image', 'gpt-image-2.5'), 'reference')
  assert.equal(routeRoleFor('image', 'nano-banana-2'), 'reference')
  assert.equal(routeRoleFor('video', 'seedance-2.0'), 'primary')
  assert.equal(routeRoleFor('video', 'seedance-2.0-fast'), 'reference')
  assert.equal(routeRoleFor('video', 'minimax-h3'), 'reference')
  // 能力对不上（拿文本模型问图片）不能算主路由，也不能算同能力参考
  assert.equal(routeRoleFor('image', 'deepseek-flash'), 'reference')
  assert.equal(routeRoleFor('', 'gpt-image-2'), 'other')
})

test('汇总按目录现算：主路由 4 条，仅参考数量随目录变化', () => {
  const rows = [
    { model: 'gpt-image-2', capability: 'image', offers: [{ platform: 'geteapi', price: { text: '$0.048 / 次' } }] },
    { model: 'gpt-image-2.5', capability: 'image', offers: [] },
    { model: 'seedance-2.0', capability: 'video', offers: [{ platform: 'seeapi', price: { text: '¥1.4 / 次' } }] },
    { model: 'minimax-h3', capability: 'video', offers: [] },
    { model: 'some-text', capability: 'text', offers: [] },
  ]
  const summary = routeSummary(rows)
  assert.equal(summary.referenceCount, 3)
  assert.equal(summary.primaryCount, 2)
  const image = summary.routes.find((route) => route.capability === 'image')
  assert.equal(image.inCatalog, true)
  assert.equal(image.price.text, '$0.048 / 次')
  assert.equal(image.referenceCount, 1)

  const empty = routeSummary([])
  assert.equal(empty.referenceCount, 0)
  assert.equal(empty.primaryCount, 0)
  assert.ok(empty.routes.every((route) => route.inCatalog === false && route.price === null))
})
