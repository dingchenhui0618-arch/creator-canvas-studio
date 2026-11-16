// 模型目录的纯函数测试：不联网、不读 Key 池，只验证两套报价口径与合并规则。
// fixture 取自 2026-11-16 两个上游真实返回的字段与数值（只裁掉无关的 schema / dimensions）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatPriceNumber, getePrice, inferGeteCapability, mergeCatalog, seeapiPrice } from '../server/model-catalog.mjs'

const GETE_LUNA = {
  model_name: 'gpt-5.6-luna',
  vendor_id: 1,
  quota_type: 0,
  model_ratio: 0.25,
  model_price: 0,
  completion_ratio: 8,
  enable_groups: ['default'],
  billing_mode: 'tiered_expr',
}

const GETE_IMAGE_2 = {
  model_name: 'gpt-image-2',
  vendor_id: 1,
  quota_type: 1,
  model_ratio: 0,
  model_price: 0.06,
  completion_ratio: 0,
  enable_groups: ['default', 'image2'],
}

const SEE_IMAGE_25 = {
  code: 'image-2.5',
  modality: 'image',
  pricing_rule: {
    type: 'fixed_per_call_tier',
    currency: 'credits',
    unit: 'credit_units',
    prices: { special: 600000 },
  },
}

const SEE_KLING = {
  code: 'kling-4.0',
  modality: 'video',
  pricing_rule: {
    type: 'output_and_reference_video_duration_resolution_tier',
    currency: 'credits',
    unit: 'credit_units',
    output_per_second_by_resolution: { '720p': { special: 500000 }, '1080p': { special: 750000 } },
    reference_total_per_second_by_resolution: {
      '720p': { numerator: { special: 360000 }, denominator: 1 },
      '1080p': { numerator: { special: 540000 }, denominator: 1 },
    },
  },
}

const SEE_SEEDANCE = {
  code: 'seedance-2.0',
  modality: 'video',
  pricing_rule: {
    type: 'conditional_reference_video',
    currency: 'credits',
    unit: 'credit_units',
    base_pricing_rule: {
      type: 'fixed_by_duration_resolution_tier',
      currency: 'credits',
      unit: 'credit_units',
      prices: {
        '4': { '480p': { special: 1422960 }, '720p': { special: 3060288 } },
      },
    },
    reference_video: { type: 'token_by_video_duration_v2' },
  },
}

const SEE_SEEDREAM = {
  code: 'seedream-5.0-pro',
  modality: 'image',
  pricing_rule: {
    type: 'fixed_by_size_and_reference_count_tier',
    currency: 'credits',
    unit: 'credit_units',
    prices: { '1K': { special: 300000 }, '2K': { special: 600000 }, '4K': { special: 600000 } },
    additional_reference_prices: { special: 20000 },
    included_reference_count: 1,
  },
}

test('GeteAPI 按 token 计费：输入 = 倍率 × 分组 × 2，输出 = 输入 × 补全倍率', () => {
  const price = getePrice(GETE_LUNA, { group: 'default', groupRatio: 0.8 })
  assert.equal(price.kind, 'token')
  assert.equal(price.currency, 'USD')
  assert.equal(price.value, 0.4)
  assert.match(price.text, /输入 \$0\.4 \/ 1M/)
  assert.match(price.text, /输出 \$3\.2 \/ 1M/)
  assert.match(price.note, /分组 default ×0\.8/)
  assert.match(price.note, /补全 8×/)
  assert.match(price.note, /阶梯表达式计费/)
})

test('GeteAPI 按次计费：model_price × 分组倍率，不乘 2', () => {
  const price = getePrice(GETE_IMAGE_2, { group: 'default', groupRatio: 0.8 })
  assert.equal(price.kind, 'call')
  assert.equal(price.value, 0.048)
  assert.equal(price.text, '$0.048 / 次')
  assert.match(price.note, /按次/)
})

test('GeteAPI 分组倍率可替换：claude 分组用 1.0 时结果跟着变', () => {
  const price = getePrice(GETE_LUNA, { group: 'claude', groupRatio: 1 })
  assert.equal(price.value, 0.5)
  assert.match(price.text, /输入 \$0\.5 \/ 1M/)
  assert.match(price.note, /分组 claude ×1/)
})

test('GeteAPI 能力归类：出图 / 视频 / 文本 / 未知', () => {
  assert.equal(inferGeteCapability('gpt-image-2'), 'image')
  assert.equal(inferGeteCapability('grok-video-3'), 'video')
  assert.equal(inferGeteCapability('claude-opus-5'), 'text')
  assert.equal(inferGeteCapability('mystery-model'), 'unknown')
})

test('SeeAPI 按次计费：credit_units 按 1,000,000 = ¥1', () => {
  const price = seeapiPrice(SEE_IMAGE_25.pricing_rule)
  assert.equal(price.kind, 'call')
  assert.equal(price.currency, 'CNY')
  assert.equal(price.value, 0.6)
  assert.equal(price.text, '¥0.6 / 次')
})

test('SeeAPI 按尺寸计费：同价尺寸合并，参考图另计', () => {
  const price = seeapiPrice(SEE_SEEDREAM.pricing_rule)
  assert.equal(price.kind, 'image')
  assert.equal(price.value, 0.3)
  assert.match(price.text, /¥0\.3 \/ 张（1K）/)
  assert.match(price.text, /¥0\.6 \/ 张（2K \/ 4K）/)
  assert.match(price.note, /含 1 张参考图/)
  assert.match(price.note, /每加一张 ¥0\.02/)
})

test('SeeAPI 按秒计费（输出 + 参考视频）：分辨率逐档列出', () => {
  const price = seeapiPrice(SEE_KLING.pricing_rule)
  assert.equal(price.kind, 'second')
  assert.equal(price.value, 0.5)
  assert.match(price.text, /¥0\.5 \/ 秒（720p）/)
  assert.match(price.text, /¥0\.75 \/ 秒（1080p）/)
  assert.match(price.note, /参考视频另计/)
  assert.match(price.note, /720p ¥0\.36 \/ 秒/)
  assert.match(price.note, /1080p ¥0\.54 \/ 秒/)
})

test('SeeAPI 视频时长阶梯：按最短档折算，并保留整段价与带参考视频的说明', () => {
  const price = seeapiPrice(SEE_SEEDANCE.pricing_rule)
  assert.equal(price.kind, 'second')
  assert.equal(price.value, 0.35574)
  assert.match(price.text, /¥0\.35574 \/ 秒（480p，4 秒档，整段 ¥1\.42296）/)
  assert.match(price.text, /¥0\.76507 \/ 秒（720p，4 秒档，整段 ¥3\.060288）/)
  assert.match(price.note, /按 4 秒档 × 分辨率阶梯/)
  assert.match(price.note, /带参考视频另按 token 计费/)
})

test('金额格式化不会把小额价格抹成 0', () => {
  assert.equal(formatPriceNumber(0.00002), '0.00002')
  assert.equal(formatPriceNumber(0.048), '0.048')
  assert.equal(formatPriceNumber(0.35574), '0.35574')
  assert.equal(formatPriceNumber(3.2), '3.2')
  assert.equal(formatPriceNumber(0), '0')
})

test('SeeAPI 价格字段兼容 special / retail / default，且 special 优先', () => {
  const special = seeapiPrice({
    type: 'fixed_per_call_tier',
    currency: 'credits',
    unit: 'credit_units',
    prices: { special: 1000000, retail: 2000000, default: 3000000 },
  })
  assert.equal(special.value, 1)
  const retail = seeapiPrice({
    type: 'fixed_per_call_tier',
    currency: 'credits',
    unit: 'credit_units',
    prices: { retail: 500000 },
  })
  assert.equal(retail.value, 0.5)
  const fallback = seeapiPrice({
    type: 'fixed_per_call_tier',
    currency: 'credits',
    unit: 'credit_units',
    prices: { default: 250000 },
  })
  assert.equal(fallback.value, 0.25)
})

test('两家平台同一模型：合并成一行，两个来源按固定顺序并排', () => {
  const entries = [
    {
      model: 'gpt-image-2',
      capability: 'image',
      offer: { platform: 'geteapi', platformLabel: 'GeteAPI', price: getePrice(GETE_IMAGE_2), connected: true },
    },
    {
      model: 'GPT-Image-2',
      capability: 'image',
      offer: { platform: 'seeapi', platformLabel: 'SeeAPI / CGCM', price: seeapiPrice(SEE_IMAGE_25.pricing_rule), connected: false },
    },
  ]
  const rows = mergeCatalog(entries, (model, capability) => model.toLowerCase() === 'gpt-image-2' && capability === 'image')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model, 'gpt-image-2')
  assert.equal(rows[0].capability, 'image')
  assert.deepEqual(rows[0].offers.map((offer) => offer.platform), ['geteapi', 'seeapi'])
  assert.equal(rows[0].offers[0].price.currency, 'USD')
  assert.equal(rows[0].offers[1].price.currency, 'CNY')
  assert.equal(rows[0].routable, true)
})

test('同平台重复 offer 只留一条，有价格的优先于未标价', () => {
  const unknown = {
    kind: 'unknown',
    currency: 'USD',
    value: null,
    text: '未标价',
    note: '价目表缺这条',
  }
  const rows = mergeCatalog([
    { model: 'm', capability: 'text', offer: { platform: 'geteapi', platformLabel: 'GeteAPI', price: unknown, connected: false } },
    {
      model: 'm',
      capability: 'text',
      offer: { platform: 'geteapi', platformLabel: 'GeteAPI', price: getePrice(GETE_LUNA), connected: false },
    },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].offers.length, 1)
  assert.equal(rows[0].offers[0].price.kind, 'token')
})

test('视频 / 图片优先于文本：同名模型跨平台能力不一致时取更具体的能力', () => {
  const rows = mergeCatalog([
    {
      model: 'same-name',
      capability: 'text',
      offer: { platform: 'geteapi', platformLabel: 'GeteAPI', price: getePrice(GETE_LUNA), connected: false },
    },
    {
      model: 'same-name',
      capability: 'video',
      offer: { platform: 'seeapi', platformLabel: 'SeeAPI / CGCM', price: seeapiPrice(SEE_KLING.pricing_rule), connected: false },
    },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].capability, 'video')
})
