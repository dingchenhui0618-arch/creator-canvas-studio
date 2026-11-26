// 运营位（r319）：能不能看见、先看见哪条、关掉之后怎样。
// 只测纯函数：组件里那层 localStorage 读写不在这里造 DOM，交给 shot 脚本真点。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMOS,
  PROMO_DISMISS_KEY,
  PROMO_MAX_PER_PLACEMENT,
  activePromos,
  promoVisible,
  readDismissedPromos,
  todayKey,
} from '../src/domain/promos.ts'

const base = { on: '2026-11-26', internal: false, dismissed: [] }

test('默认位置最多两条：运营位不许把首屏铺满', () => {
  assert.equal(PROMO_MAX_PER_PLACEMENT, 2)
  const list = activePromos(PROMOS, { ...base, placement: 'overview' })
  assert.equal(list.length, 2)
})

test('按 weight 从大到小，同 weight 保持声明顺序', () => {
  const list = activePromos(PROMOS, { ...base, placement: 'overview' })
  assert.deepEqual(list.map((p) => p.id), ['rooms-beta', 'radar-to-template'])
  // 关掉第一条，第三条补位——说明是「截前两条」而不是「只准备了两条」
  const next = activePromos(PROMOS, { ...base, placement: 'overview', dismissed: ['rooms-beta'] })
  assert.deepEqual(next.map((p) => p.id), ['radar-to-template', 'review-evidence'])
})

test('位置分开：模板库的运营位不会跑到工作台', () => {
  const overview = activePromos(PROMOS, { ...base, placement: 'overview', max: 99 })
  assert.ok(overview.every((p) => p.placement === 'overview'))
  const templates = activePromos(PROMOS, { ...base, placement: 'templates' })
  assert.deepEqual(templates.map((p) => p.id), ['template-source-footprint'])
  // 没给 placement 时是「全部位置」，只用于后台预览
  assert.ok(activePromos(PROMOS, { ...base, max: 99 }).length > overview.length)
})

test('内部口径：internal 的那条只给管理员看', () => {
  const promo = {
    id: 'admin-only',
    placement: 'overview',
    kicker: '内部',
    title: '内部口径',
    body: '只有管理员能看到这条。',
    cta: '去后台',
    page: 'radar',
    internal: true,
  }
  assert.equal(promoVisible(promo, { on: '2026-11-26', internal: false, dismissed: [] }), false)
  assert.equal(promoVisible(promo, { on: '2026-11-26', internal: true, dismissed: [] }), true)
})

test('起止日期按日历日算，两端都含当天', () => {
  const promo = { ...PROMOS[0], from: '2026-11-26', until: '2026-12-01' }
  assert.equal(promoVisible(promo, { on: '2026-11-25', internal: false, dismissed: [] }), false)
  assert.equal(promoVisible(promo, { on: '2026-11-26', internal: false, dismissed: [] }), true)
  assert.equal(promoVisible(promo, { on: '2026-12-01', internal: false, dismissed: [] }), true)
  assert.equal(promoVisible(promo, { on: '2026-12-02', internal: false, dismissed: [] }), false)
})

test('todayKey 用本地日，补零到两位', () => {
  assert.equal(todayKey(new Date(2026, 0, 5)), '2026-01-05')
  assert.equal(todayKey(new Date(2026, 10, 26)), '2026-11-26')
})

test('本地那份关掉的记录：坏数据一律当没关过，不抛错', () => {
  assert.deepEqual(readDismissedPromos(null), [])
  assert.deepEqual(readDismissedPromos(''), [])
  assert.deepEqual(readDismissedPromos('{不是 JSON'), [])
  assert.deepEqual(readDismissedPromos('{"a":1}'), [])
  assert.deepEqual(readDismissedPromos('["rooms-beta",3,null,"","x"]'), ['rooms-beta', 'x'])
  assert.equal(PROMO_DISMISS_KEY, 'vq_promos_dismissed')
})

test('每条运营位都指得出去：page 必填、文案不留空', () => {
  const ids = new Set()
  for (const promo of PROMOS) {
    assert.ok(promo.id.length > 0, 'id 不能空')
    assert.ok(!ids.has(promo.id), 'id 重复：' + promo.id)
    ids.add(promo.id)
    for (const field of ['kicker', 'title', 'body', 'cta', 'page']) {
      assert.ok(String(promo[field]).trim().length > 0, promo.id + ' 少了 ' + field)
    }
    assert.ok(promo.body.length <= 80, promo.id + ' 的 body 太长，卡片里会折成三行：' + promo.body.length)
  }
})
