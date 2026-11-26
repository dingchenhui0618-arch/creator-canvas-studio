// 运营位（r320）：能不能看见、先看见哪条、关掉之后怎样，以及「默认内容」这份真源本身站不站得住。
// 只测纯函数与常量：组件那层（缓存、关掉、共享状态）交给 scripts/shot-r320.mjs 真点。
// r320 起内容搬到了服务端（server/promos.mjs），所以这里同时对着两边比：
// 前端的位置白名单、页面白名单必须与服务端一致，少一个就会出现「后台配了但页面不显示」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// config.mjs 在 import 时就读数据目录，所以先给一个临时目录（与其它存储类测试同一套做法）
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-promos-'))
process.env.VQ_KEY_SECRET = 'test-secret-promos'

// 用动态 import：静态 import 会被提升到文件最前，配置还没读环境变量就先加载 config.mjs，
// 数据目录就落到仓库里去了（其它存储类测试同样是动态 import）。
const {
  PROMO_DISMISS_KEY,
  PROMO_MAX_PER_PLACEMENT,
  PROMO_PAGES,
  PROMO_PLACEMENTS,
  PROMO_UNDO_MS,
  activePromos,
  parsePromoCache,
  promoUndoLabel,
  promoVisible,
  promosDirty,
  readDismissedPromos,
  todayKey,
  withoutDismissed,
} = await import('../src/domain/promos.ts')
const {
  DEFAULT_PROMOS,
  PROMO_LIMITS,
  PROMO_PAGES: PROMO_PAGES_SERVER,
  PROMO_PLACEMENTS: SERVER_PLACEMENTS,
  validatePromos,
} = await import('../server/promos.mjs')

const base = { on: '2026-11-26', internal: false, dismissed: [] }

test('默认位置最多两条：运营位不许把首屏铺满', () => {
  assert.equal(PROMO_MAX_PER_PLACEMENT, 2)
  const list = activePromos(DEFAULT_PROMOS, { ...base, placement: 'overview' })
  assert.equal(list.length, 2)
})

test('按 weight 从大到小，同 weight 保持声明顺序', () => {
  const list = activePromos(DEFAULT_PROMOS, { ...base, placement: 'overview' })
  assert.deepEqual(list.map((p) => p.id), ['rooms-beta', 'radar-to-template'])
  // 关掉第一条，第三条补位——说明是「截前两条」而不是「只准备了两条」
  const next = activePromos(DEFAULT_PROMOS, { ...base, placement: 'overview', dismissed: ['rooms-beta'] })
  assert.deepEqual(next.map((p) => p.id), ['radar-to-template', 'review-evidence'])
})

test('位置分开：模板库的运营位不会跑到工作台', () => {
  const overview = activePromos(DEFAULT_PROMOS, { ...base, placement: 'overview', max: 99 })
  assert.ok(overview.every((p) => p.placement === 'overview'))
  const templates = activePromos(DEFAULT_PROMOS, { ...base, placement: 'templates' })
  assert.deepEqual(templates.map((p) => p.id), ['template-source-footprint'])
  // 没给 placement 时是「全部位置」，只用于后台预览
  assert.ok(activePromos(DEFAULT_PROMOS, { ...base, max: 99 }).length > overview.length)
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
  const promo = { ...DEFAULT_PROMOS[0], from: '2026-11-26', until: '2026-12-01' }
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

// r326：关掉之后能撤销。这两件都是纯函数，不碰 DOM（条子出不出现、点 ✕ 之后是什么样，
// 交给 scripts/shot-r326.mjs 在真页面上点）。
test('撤销条：一条写出标题，多条写条数，空的不出条子', () => {
  assert.equal(promoUndoLabel([]), '')
  assert.equal(promoUndoLabel([{ title: '把几个智能体放进同一个房间' }]), '已关掉「把几个智能体放进同一个房间」')
  // 一条一条关的时候，用户要确认的正是「刚才手滑关掉的是不是这条」，所以一条要写标题
  assert.equal(promoUndoLabel([{ title: 'A' }, { title: 'B' }]), '已关掉 2 条动态')
})

test('撤销：只从「关掉过」里拿掉这几条，其余与顺序不动，也不改传入的数组', () => {
  const before = ['a', 'b', 'c', 'd']
  const next = withoutDismissed(before, ['b', 'd'])
  assert.deepEqual(next, ['a', 'c'])
  assert.deepEqual(before, ['a', 'b', 'c', 'd'], '不能改调用方传进来的那份')
  assert.deepEqual(withoutDismissed(before, ['zzz']), before, '没关过的忽略掉')
  assert.deepEqual(withoutDismissed(before, []), before, '空操作等于原样')
  assert.deepEqual(withoutDismissed(['a', 'a'], ['a']), [], '重复的也一起拿掉')
})

test('撤销窗口：8 秒——够看清关掉的是哪一条，又不至于变成一条赖着不走的条子', () => {
  assert.equal(PROMO_UNDO_MS, 8000)
  assert.ok(PROMO_UNDO_MS >= 5000, '比 5 秒还短，手还没伸回去就没了')
  assert.ok(PROMO_UNDO_MS <= 15000, '超过 15 秒，这条占位的条子就太久了')
})

test('本地缓存的那份内容：形状不对的单条丢掉，整份不崩', () => {
  assert.deepEqual(parsePromoCache(null), [])
  assert.deepEqual(parsePromoCache('{坏'), [])
  assert.deepEqual(parsePromoCache('{"promos":[]}'), [])
  const good = { id: 'a', placement: 'overview', kicker: '新', title: '标题', body: '一句话', cta: '去看看', page: 'radar' }
  assert.deepEqual(parsePromoCache(JSON.stringify([good])), [good])
  // 缺字段 / 位置不认识 / 页面不认识的整条丢掉，剩下的照常渲染
  const bad = [
    { ...good, id: 'no-page', page: 'not-a-page' },
    { ...good, id: 'no-placement', placement: 'somewhere' },
    { id: 'empty', placement: 'overview' },
  ]
  assert.deepEqual(parsePromoCache(JSON.stringify([...bad, good])), [good])
})

test('每条默认运营位都指得出去：page 必填、文案不留空、字数不超上限', () => {
  const ids = new Set()
  for (const promo of DEFAULT_PROMOS) {
    assert.ok(promo.id.length > 0, 'id 不能空')
    assert.ok(!ids.has(promo.id), 'id 重复：' + promo.id)
    ids.add(promo.id)
    for (const field of ['kicker', 'title', 'body', 'cta', 'page']) {
      assert.ok(String(promo[field]).trim().length > 0, promo.id + ' 少了 ' + field)
    }
    assert.ok(promo.body.length <= PROMO_LIMITS.body, promo.id + ' 的 body 太长，卡片里会折成三行：' + promo.body.length)
    assert.ok(promo.title.length <= PROMO_LIMITS.title, promo.id + ' 的标题太长：' + promo.title.length)
    assert.ok(promo.kicker.length <= PROMO_LIMITS.kicker, promo.id + ' 的小标签太长：' + promo.kicker.length)
    assert.ok(promo.cta.length <= PROMO_LIMITS.cta, promo.id + ' 的按钮文字太长：' + promo.cta.length)
  }
  // 默认内容自己必须能通过后台上限校验，否则管理员一进后台就被「第 N 条太长」拦住
  assert.equal(validatePromos(DEFAULT_PROMOS).ok, true)
})

test('每个声明的位置都真的挂在页面上、都有默认内容（配了却看不见就是这一行老出的事）', () => {
  // recharge 这个位置从 r320 起就写在白名单里、后台下拉里也有，
  // 但没有一个页面挂 <PromoSlot placement="recharge">——管理员配好保存、刷新，什么也不会出现，
  // 而且看不出哪里错了。位置是「声明」，挂载点才是「能不能显示」；这条把两者绑在一起。
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(process.cwd(), 'src'))
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  for (const placement of PROMO_PLACEMENTS) {
    assert.ok(
      source.includes('<PromoSlot placement="' + placement + '"'),
      placement + ' 位置只是写在白名单里，没有任何页面挂载：后台配到这一屏的运营位永远不会显示',
    )
    // 生产上后台没存过内容时走的就是默认这份；一个位置没有默认条目 = 那个槽上线就是空的
    assert.ok(
      DEFAULT_PROMOS.some((promo) => promo.placement === placement),
      placement + ' 位置没有默认内容：后台没存过时这个槽是空的，等于没做',
    )
  }
})

// r323：后台「运营位」编辑卡用它标「有未保存的改动」。这份判断错了有两种表现，
// 都比不标更烦：改回原样还一直喊「没保存」，或者明明动了却说没有、刷新一下改动没了。
test('草稿与已保存内容比：改回原样不算改，挪位置/改一个字段/少一条都算改', () => {
  const saved = [
    {
      id: 'a', placement: 'overview', weight: 20, kicker: '新功能', title: '标题',
      body: '说明', cta: '去看看', page: 'rooms', from: '', until: '', internal: false,
    },
    {
      id: 'b', placement: 'recharge', weight: 10, kicker: 'Beta', title: '标题二',
      body: '说明二', cta: '去充值', page: 'recharge', from: '2026-11-01', until: '', internal: true,
    },
  ]
  // 一模一样（含同一个数组引用）就是没改
  assert.equal(promosDirty(saved, saved), false)
  // 保存时会把文本 trim 掉；只多打了空格不算改，不然点了保存还一直喊「有未保存的改动」
  assert.equal(promosDirty([{ ...saved[0], title: ' 标题 ' }, saved[1]], saved), false)
  // 没填的日期：空串与 undefined 等价（接口回空串、新建行给空串）
  assert.equal(promosDirty([{ ...saved[0], from: undefined }, { ...saved[1], until: '' }], saved), false)
  // 顺序就是权重：两条内容都没动，只换个位置也算改
  assert.equal(promosDirty([...saved].reverse(), saved), true)
  // 单个字段：正文、内部口径、权重
  assert.equal(promosDirty([{ ...saved[0], body: '改了说明' }, saved[1]], saved), true)
  assert.equal(promosDirty([{ ...saved[0], internal: true }, saved[1]], saved), true)
  assert.equal(promosDirty([{ ...saved[0], weight: undefined }, saved[1]], saved), true)
  // 删一条 / 加一条
  assert.equal(promosDirty([saved[0]], saved), true)
  assert.equal(promosDirty([...saved, { ...saved[0], id: 'c' }], saved), true)
})

test('前后端两份白名单必须一致：位置与页面（加一个页面忘了同步会在这里红）', () => {
  assert.deepEqual([...PROMO_PLACEMENTS], [...SERVER_PLACEMENTS])
  assert.deepEqual([...PROMO_PAGES].sort(), [...PROMO_PAGES_SERVER].sort())
  const types = fs.readFileSync(path.join(process.cwd(), 'src/domain/types.ts'), 'utf8')
  const union = types.slice(types.indexOf('export type Page ='), types.indexOf('export const pageLabels'))
  const pages = [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1])
  assert.deepEqual([...PROMO_PAGES].sort(), pages.sort())
})
