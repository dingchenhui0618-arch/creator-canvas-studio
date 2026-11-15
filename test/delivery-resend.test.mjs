import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 链接没送到：就地把这一份再发一次（v0.9.146）。
// v0.9.145 让那一行说得出「这条链接还没被打开」，这一组盯的是知道之后的下一步：
//   1) 重发只对「确知一次都没被打开」的那几条给，不知道的不盲发；
//   2) 重发记的是另一个数，和催过几次分开——一个问收没收到，一个问验没验；
//   3) 重发到两次还没打开，就明确说「换个方式」，而不是让人无限重复同一个动作；
//   4) 发出去的那段话只说档案里的事实，不替人道歉、不编原因。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-resend-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-resend'

const SHA = 'b1c2d3e4f5a6' + 'b'.repeat(52)
const ZIP = 'VisionQA-重发验收-第-2-版-v2-20261115.zip'
const pkg = { bytes: 272155, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const TOKEN_COLD = '0123456789abcdef'
const TOKEN_AGAIN = 'fedcba9876543210'
const TOKEN_OPENED = '0011223344556677'
const TOKEN_UNKNOWN = '9988776655443322'
const TOKEN_DONE = 'aabbccddeeff0011'

function project(id, title, delivery) {
  return {
    id,
    ownerId: 'u_a',
    title,
    flowId: 'flow_' + id,
    version: 2,
    versions: [],
    status: 'done',
    deliveries: [delivery],
    createdAt: '2026-11-14T05:00:00.000Z',
    updatedAt: '2026-11-14T06:00:00.000Z',
  }
}

const base = { version: 2, at: '2026-11-13T06:00:00.000Z', package: pkg }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 链接发出去了、一次都没被打开：重发与端点都拿它试
    project('prj_cold', '一次都没打开的链接', {
      ...base,
      id: '1111111111110001',
      receiptToken: TOKEN_COLD,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 已经又发过两次，还是没被打开：该换个方式了
    project('prj_again', '又发过一次还是没打开', {
      ...base,
      id: 'ab12ab12ab120002',
      receiptToken: TOKEN_AGAIN,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    // 链接被打开过：不给「再发一次」按钮，那种情况该催他验
    project('prj_opened', '打开过的链接', {
      ...base,
      id: '1111111111110003',
      receiptToken: TOKEN_OPENED,
      receiptLinkAt: '2026-11-13T06:00:00.000Z',
    }),
    // 升级前发的链接：不知道有没有人打开过，不盲发
    project('prj_unknown', '升级前的链接', {
      ...base,
      id: '1111111111110004',
      receiptToken: TOKEN_UNKNOWN,
    }),
    // 还没生成回执链接：没有东西可发
    project('prj_nolink', '还没有回执链接', { ...base, id: '1111111111110005' }),
    // 已经贴过回执：不用再发
    project('prj_done', '已经贴过回执', {
      version: 2,
      at: '2026-11-12T06:00:00.000Z',
      id: '1111111111110006',
      package: pkg,
      receiptToken: TOKEN_DONE,
      receiptLinkAt: '2026-11-12T06:00:00.000Z',
      receipt: { state: 'match', at: '2026-11-13T09:00:00.000Z', via: 'link' },
    }),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const domain = await import('../src/domain/delivery-resend.ts')
const openDomain = await import('../src/domain/delivery-open.ts')
const ledgerModule = await import('../server/delivery-ledger.mjs')
const store = await import('../server/projects.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { createDeliveriesRouter } = await import('../server/routes/deliveries.mjs')

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}

async function call(router, pathname, { method = 'GET' } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const req = { method, headers: {} }
  await router.handle(req, res, url, url.pathname)
  return res
}

const ZERO = { opens: 0, firstAt: '', lastAt: '' }

test('重发几次怎么说：没重发过就不说，重发到两次就劝人换个方式', () => {
  assert.equal(domain.deliveryResendText(null), '')
  assert.equal(domain.deliveryResendText({ count: 0 }), '')
  assert.equal(domain.deliveryResendText({ count: 1 }), '又发过 1 次')
  assert.equal(domain.deliveryResendText({ count: 2 }), '又发过 2 次')
  // 坏数字按 0 算，不把半个数字写上去
  assert.equal(domain.deliveryResendText({ count: -3 }), '')
  assert.equal(domain.deliveryResendText({ count: 'x' }), '')

  // 重发过一次：可以换个方式；到门槛上：同一条再发也没用了
  assert.equal(domain.deliveryResendHint(null), '')
  assert.match(domain.deliveryResendHint({ count: 1 }), /可以换个方式发（邮件 \/ 换个人）$/)
  assert.match(domain.deliveryResendHint({ count: 2 }), /同一条再发也没用了/)
  assert.equal(domain.RESEND_STUCK_MIN, 2)

  assert.equal(domain.deliveryStuckText(0), '')
  assert.equal(domain.deliveryStuckText(1), '其中 1 次链接又发过 2 次还没打开：换个人或换个方式发。')

  // 档案里那一行灰字：打开情况与重发次数合成一句，缺一件就只说另一件
  assert.equal(domain.deliveryOpenWithResend(ZERO, null), '回执链接发出后还没被打开过')
  assert.equal(domain.deliveryOpenWithResend(ZERO, { count: 1 }), '回执链接发出后还没被打开过 · 又发过 1 次')
  assert.equal(domain.deliveryOpenWithResend({ opens: 2, firstAt: '', lastAt: '' }, { count: 1 }), '回执链接打开过 2 次 · 又发过 1 次')
  assert.equal(domain.deliveryOpenWithResend(null, { count: 1 }), '又发过 1 次', '不知道打开过没有，也照实说重发过')
  assert.equal(domain.deliveryOpenWithResend(null, null), '', '什么都不知道就一个字都不写')
})

test('重发的那段话：只说档案里的事实，留一句「打不开就说一声」', () => {
  const link = 'https://visionqa.example.com/#/receipt/' + TOKEN_COLD
  const text = domain.deliveryResendMessage({
    title: '一次都没打开的链接',
    version: 2,
    fileName: ZIP,
    bytes: 272155,
    at: '2026-11-13T06:00:00.000Z',
    link,
  })
  assert.match(text, /^一次都没打开的链接 第 v2 版那份包（VisionQA-重发验收-第-2-版-v2-20261115\.zip，272,155 B）我 11-13 发你的/)
  assert.ok(text.includes(link), '链接要原样带上，收包人不用回去找上一条')
  assert.match(text, /那条回执链接你那边可能没收到，这里再发一次/)
  assert.match(text, /要是这条也打不开，跟我说一声，我换个方式发给你。$/)
  // 不编原因、不替他判断、不道歉、不承诺换包
  assert.doesNotMatch(text, /他看过|已读|抱歉|对不起|赔偿|重发一份新的包/)
  // 没有链接时退化成「把收据发我」，不编一条空地址
  const plain = domain.deliveryResendMessage({ title: 'X', version: 1, link: '' })
  assert.match(plain, /^X 第 v1 版那份包我上次发你的，那条回执链接你那边可能没收到。/)
  assert.doesNotMatch(plain, /#\/receipt\//)

  // 作品页读的是档案里那串时间：空、坏项都不算一次
  assert.equal(domain.deliveryResendBrief(undefined), null)
  assert.equal(domain.deliveryResendBrief([]), null)
  assert.deepEqual(domain.deliveryResendBrief([{ at: '2026-11-14T07:00:00.000Z' }, { at: '' }]), {
    count: 1,
    at: '2026-11-14T07:00:00.000Z',
  })
})

test('再发一次记在档案里：与催过分开，最多留五次', async () => {
  const first = await store.saveDeliveryResend('prj_cold', '1111111111110001')
  assert.equal(first.already, false)
  assert.equal(first.count, 1)
  assert.equal(first.token, TOKEN_COLD, '还是同一条地址，不换 token')
  const row = (await store.getProject('prj_cold')).deliveries[0]
  assert.equal(row.resends.length, 1)
  assert.equal(row.resends[0].at, first.at)
  assert.equal(row.reminders, undefined, '重发不该写进催过的那一栏')
  assert.equal(row.receiptToken, TOKEN_COLD)
  assert.equal(row.package.bytes, 272155, '重发不改包')
  // 只记时间，不存那段话
  const raw = fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
  assert.ok(!raw.includes('打不开'), '档案里不存发出去的那段话')

  const second = await store.saveDeliveryResend('prj_cold', '1111111111110001')
  assert.equal(second.count, 2)
  for (let i = 0; i < 6; i += 1) await store.saveDeliveryResend('prj_cold', '1111111111110001')
  assert.equal((await store.getProject('prj_cold')).deliveries[0].resends.length, 5, '最多留五次，再多也改变不了什么')

  // 三种「记不了」照实退回
  assert.equal((await store.saveDeliveryResend('prj_done', '1111111111110006')).already, true, '已经贴过回执的不再重发')
  assert.equal((await store.saveDeliveryResend('prj_nolink', '1111111111110005')).missingLink, true, '还没有链接就没得发')
  assert.equal(await store.saveDeliveryResend('prj_missing', '1111111111110001'), null)
  assert.equal(await store.saveDeliveryResend('prj_cold', '1111111111119999'), null, '没有封存包的不给重发')
})

test('重发端点：只给登录着的发件人，GET 不行，已经贴过回执的 409', async () => {
  const router = createProjectsRouter()
  const ok = await call(router, '/api/projects/prj_again/delivery-packages/ab12ab12ab120002/resend', { method: 'POST' })
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.count, 3, '档案里原本两次，再加这一次')
  assert.equal(payload.token, TOKEN_AGAIN)

  const get = await call(router, '/api/projects/prj_again/delivery-packages/ab12ab12ab120002/resend')
  assert.equal(get.status, 405)

  const done = await call(router, '/api/projects/prj_done/delivery-packages/1111111111110006/resend', { method: 'POST' })
  assert.equal(done.status, 409)
  assert.equal(JSON.parse(done.body).code, 'RECEIPT_ALREADY')

  const nolink = await call(router, '/api/projects/prj_nolink/delivery-packages/1111111111110005/resend', { method: 'POST' })
  assert.equal(nolink.status, 409)
  assert.equal(JSON.parse(nolink.body).code, 'NO_RECEIPT_LINK')

  const missing = await call(router, '/api/projects/prj_again/delivery-packages/1111111111119999/resend', { method: 'POST' })
  assert.equal(missing.status, 404)
})

test('工作台那一行：确知没被打开过才给「再发一次」，重发到两次就说该换方式了', () => {
  const projects = [
    project('p_cold', '一次都没打开', { ...base, id: '2222222222220001', receiptToken: TOKEN_COLD, receiptLinkAt: base.at }),
    project('p_again', '又发过两次', {
      ...base,
      id: '2222222222220002',
      receiptToken: TOKEN_AGAIN,
      receiptLinkAt: base.at,
      resends: [{ at: '2026-11-14T07:00:00.000Z' }, { at: '2026-11-15T07:00:00.000Z' }],
    }),
    project('p_opened', '打开过', { ...base, id: '2222222222220003', receiptToken: TOKEN_OPENED, receiptLinkAt: base.at }),
    project('p_unknown', '升级前的链接', { ...base, id: 'cd34cd34cd340004', receiptToken: TOKEN_UNKNOWN }),
  ]
  const now = Date.parse('2026-11-16T00:00:00.000Z')
  const seen = {
    'p_cold:2222222222220001': ZERO,
    'p_again:2222222222220002': ZERO,
    'p_opened:2222222222220003': { opens: 3, firstAt: '2026-11-14T07:00:00.000Z', lastAt: '2026-11-15T07:00:00.000Z' },
    'p_unknown:cd34cd34cd340004': ZERO,
  }
  const ledger = ledgerModule.deliveryLedger({ projects, visits: seen }, { offset: 0, limit: 20, now })
  const rows = Object.fromEntries(ledger.items.map((row) => [row.projectId, row]))

  assert.equal(rows.p_cold.resendable, true, '确知一次都没被打开：可以再发一次')
  assert.equal(rows.p_cold.resend, null, '还没重发过')
  assert.equal(rows.p_again.resendable, true, '还是没被打开，按钮仍然在——再发一次是发件人的选择')
  assert.equal(rows.p_again.resend.count, 2)
  assert.equal(domain.deliveryResendText(rows.p_again.resend), '又发过 2 次')
  assert.match(domain.deliveryResendHint(rows.p_again.resend), /换个方式/)
  assert.equal(rows.p_opened.resendable, false, '打开过了：该催他验，不是重发')
  assert.equal(rows.p_unknown.resendable, false, '不知道有没有人打开过：不盲发')
  assert.equal(rows.p_unknown.resend, null)

  // 顶上的数：没被打开过的有几条、其中又发过两次还没打开的有几条
  assert.equal(ledger.receipts.pending, 4)
  assert.equal(rows.p_unknown.visits, null, '升级前发的链接：不知道有没有人打开过，传进来的数也不认')
  assert.equal(ledger.receipts.pendingUnopened, 2, '一条没打开、一条又发过两次；打开过的那条不算，升级前那条不知道也不算')
  assert.equal(ledger.receipts.pendingStuck, 1, '只有又发过两次的那一条到了该换方式的时候')
  assert.equal(domain.deliveryStuckText(ledger.receipts.pendingStuck), '其中 1 次链接又发过 2 次还没打开：换个人或换个方式发。')
  assert.equal(
    ledger.receipts.sealed,
    ledger.receipts.matched + ledger.receipts.mismatched + ledger.receipts.unclear + ledger.receipts.pending,
    'pendingStuck 也是子集，不是第六种结论',
  )
  assert.ok(ledger.receipts.pendingStuck <= ledger.receipts.pendingUnopened)
})

test('接口把这些数交给工作台：不给 token，也不给客户端的分类', async () => {
  const router = createDeliveriesRouter()
  const res = await call(router, '/api/deliveries')
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  const row = payload.items.find((item) => item.projectId === 'prj_cold')
  assert.equal(row.resendable, true)
  assert.equal(row.resend.count, 5, '档案里那五次重发')
  assert.equal(typeof payload.receipts.pendingStuck, 'number')
  assert.equal(res.body.includes(TOKEN_COLD), false, '接口不给 token')
  assert.equal(/lastClient/.test(res.body), false)
  // 打开情况仍然照旧给，两件事互不影响
  assert.equal(row.visits.opens, 0, '这条链接一次都没被打开，所以说得出 0')
  const nolink = payload.items.find((item) => item.projectId === 'prj_nolink')
  assert.equal(nolink.resendable, false, '还没有回执链接：没有可再发的')
  assert.equal(nolink.visits, null, '没有 receiptLinkAt 的项目不给打开情况')
  assert.equal(openDomain.deliveryOpenShort(nolink.visits), '')
})
