import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

// 收包人点一下「收到了」（v0.9.151）。
// 从链接发出去到收据贴回来，发件人一直只能靠「打开过几次」猜；这一版让收包人自己说一句。
// 这一组盯五件事：
//   1) 点一下就记一个时间，包 / 地址 / 次数 / 作品排序一个都不动；
//   2) 重复点不写第二遍（字节不变），已经贴过收据的不收；
//   3) 旧地址与不认识的地址照旧分开回（410 / 404），旧地址那一下也记一次点击；
//   4) 工作台那一行：他说收到了，就不再给他换地址 / 再发一遍；
//   5) 那几句话只说发生过的事——不写成「他收到了」，也不把这一下当收据。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-ack-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-ack'

const SHA = 'c1d2e3f4a5b6' + 'a'.repeat(52)
const ZIP = 'VisionQA-收包人说了收到-第-3-版-v3-20261115.zip'
const pkg = { bytes: 126456, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const ID_ACK = 'cd34cd34cd341001'
const ID_ACKED = 'cd34cd34cd341002'
const ID_RECEIPT = 'cd34cd34cd341003'
const ID_RETIRED = 'cd34cd34cd341004'
const ID_BADACK = 'cd34cd34cd341006'
const TOKEN_ACK = 'a0b1c2d3e4f50617'
const TOKEN_ACKED = 'b1c2d3e4f5061728'
const TOKEN_RECEIPT = 'c2d3e4f506172839'
const TOKEN_RETIRED = 'c0ffee00deadbeef'
const TOKEN_BADACK = 'e4f5061728394a5b'

// 旧地址的记号是 token 的 SHA-256 前 16 位（visitKey），不是 token 本身
const RETIRED_KEY = createHash('sha256').update(TOKEN_RETIRED).digest('hex').slice(0, 16)

function project(id, title, deliveries) {
  return {
    id,
    ownerId: 'u_a',
    title,
    flowId: 'flow_' + id,
    version: 3,
    versions: [],
    status: 'done',
    deliveries,
    createdAt: '2026-11-12T05:00:00.000Z',
    updatedAt: '2026-11-14T06:00:00.000Z',
  }
}

const base = { version: 3, at: '2026-11-11T06:00:00.000Z', package: pkg }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 点之前：有包、有地址、还没回执、也没说过收到
    project('prj_ack', '还没说话的那一份', [
      { ...base, id: ID_ACK, receiptToken: TOKEN_ACK, receiptLinkAt: base.at },
    ]),
    // 点过一次的：再点不该写第二遍
    project('prj_acked', '已经说过收到了', [
      {
        ...base,
        id: ID_ACKED,
        receiptToken: TOKEN_ACKED,
        receiptLinkAt: base.at,
        ack: { at: '2026-11-15T04:30:00.000Z' },
      },
    ]),
    // 已经贴过收据的：验都验完了，不再收「收到了」
    project('prj_receipt', '已经贴过收据', [
      {
        ...base,
        id: ID_RECEIPT,
        receiptToken: TOKEN_RECEIPT,
        receiptLinkAt: base.at,
        receipt: { at: '2026-11-14T08:00:00.000Z', state: 'match', summary: '都对得上' },
        receipts: [{ at: '2026-11-14T08:00:00.000Z', state: 'match', summary: '都对得上' }],
      },
    ]),
    // 有人还点着换掉的旧地址
    project('prj_retired', '旧地址还在被点', [
      {
        ...base,
        id: ID_RETIRED,
        receiptToken: TOKEN_ACK,
        receiptLinkAt: base.at,
        retired: [{ key: RETIRED_KEY, at: '2026-11-13T07:00:00.000Z' }],
      },
    ]),
    // 升级前的老记录没有封存包：上面就算写着 ack 也不该读出来
    project('prj_nopkg', '没有包的老交付', [
      { version: 2, at: '2026-11-10T06:00:00.000Z', ack: { at: '2026-11-15T05:00:00.000Z' } },
    ]),
    // 时间坏了：当成没点过，不硬编一个时刻
    project('prj_badack', '时间坏了', [
      {
        ...base,
        id: ID_BADACK,
        receiptToken: TOKEN_BADACK,
        receiptLinkAt: base.at,
        ack: { at: '不是时间' },
      },
    ]),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const store = await import('../server/projects.mjs')
const { ledgerRows, deliveryLedger } = await import('../server/delivery-ledger.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const ackDomain = await import('../src/domain/delivery-ack.ts')

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

function fakeReq(method = 'GET', body = null) {
  const text = body ? JSON.stringify(body) : ''
  return {
    method,
    headers: text ? { 'content-length': String(Buffer.byteLength(text)) } : {},
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text, 'utf8')
    },
  }
}

async function call(router, pathname, { method = 'GET', body = null } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  await router.handle(fakeReq(method, body), res, url, url.pathname)
  return res
}

function readRaw() {
  return fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
}

function readProject(id) {
  return JSON.parse(readRaw()).find((entry) => entry.id === id)
}

test('点一下「收到了」：只记时间，包、地址、作品排序都不动', async () => {
  const router = createProjectsRouter()
  const res = await call(router, '/api/receipts/' + TOKEN_ACK + '/ack', { method: 'POST' })
  assert.equal(res.status, 200, '点一下不该失败：' + res.status + ' ' + res.body)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.repeated, false)
  assert.match(payload.at, /^\d{4}-\d{2}-\d{2}T/, '回的是这一刻：' + payload.at)

  const row = readProject('prj_ack')
  const delivery = row.deliveries[0]
  assert.equal(delivery.ack.at, payload.at)
  assert.equal(row.updatedAt, '2026-11-14T06:00:00.000Z', '点一下的不是发件人：不把作品顶到列表最前')
  assert.equal(delivery.package.sha256, SHA, '包没动')
  assert.equal(delivery.receiptToken, TOKEN_ACK, '地址没换')
  assert.equal(delivery.receipt, undefined, '这一下不是收据')
  assert.equal(delivery.resends, undefined, '不该顺手记一次重发')
  assert.equal(delivery.relinks, undefined, '也不该记一次换链接')
  // 也不产生打开记录：打开次数由 GET 记，这一下是页面上的一个动作
  assert.equal(fs.existsSync(path.join(DIR, 'receipt-visits.json')), false, 'ack 不写打开记录')
})

test('重复点：回同一个时刻，一个字节都不改', async () => {
  const router = createProjectsRouter()
  const before = readRaw()
  const ackedAt = readProject('prj_ack').deliveries[0].ack.at
  const res = await call(router, '/api/receipts/' + TOKEN_ACK + '/ack', { method: 'POST' })
  assert.equal(res.status, 200, '手滑点两次不算错')
  const payload = JSON.parse(res.body)
  assert.equal(payload.repeated, true)
  assert.equal(payload.at, ackedAt, '那一刻只有一次')
  assert.equal(readRaw(), before, '重复点不写盘')
})

test('收包人那一页再打开：还知道自己点过；GET 照旧记一次打开', async () => {
  const router = createProjectsRouter()
  const ackedAt = readProject('prj_ack').deliveries[0].ack.at
  const res = await call(router, '/api/receipts/' + TOKEN_ACK)
  assert.equal(res.status, 200)
  const view = JSON.parse(res.body)
  assert.equal(view.ackAt, ackedAt, '刷新之后不用再点一次')
  assert.equal(view.receipt, null)
  assert.ok(fs.existsSync(path.join(DIR, 'receipt-visits.json')), 'GET 照旧记打开次数')
})

test('已经贴过收据：409，不收这一下，也不写盘', async () => {
  const router = createProjectsRouter()
  const before = readRaw()
  const res = await call(router, '/api/receipts/' + TOKEN_RECEIPT + '/ack', { method: 'POST' })
  assert.equal(res.status, 409, '验都验完了：' + res.status)
  assert.equal(JSON.parse(res.body).code, 'RECEIPT_ALREADY')
  assert.equal(readRaw(), before, '被拦住时不该写盘')
})

test('不认识的地址 404；换掉的旧地址 410，并记一次「旧地址又被点了」', async () => {
  const router = createProjectsRouter()
  const unknown = await call(router, '/api/receipts/0a1b2c3d4e5f6071/ack', { method: 'POST' })
  assert.equal(unknown.status, 404)

  const before = readRaw()
  const beforeRow = JSON.parse(before).find((entry) => entry.id === 'prj_retired')
  const res = await call(router, '/api/receipts/' + TOKEN_RETIRED + '/ack', { method: 'POST' })
  assert.equal(res.status, 410, '旧地址：不是「不在了」，是「换成新的了」')
  const payload = JSON.parse(res.body)
  assert.equal(payload.code, 'LINK_RETIRED')
  assert.equal(payload.retiredAt, '2026-11-13T07:00:00.000Z')
  assert.equal(res.body.includes(TOKEN_ACK), false, '旧地址拿不到新地址')

  const row = readProject('prj_retired')
  assert.equal(row.deliveries[0].retired[0].hits, 1, '这一下也算一次点击')
  assert.equal(row.deliveries[0].ack, undefined, '旧地址点不出「收到了」')
  assert.equal(row.updatedAt, beforeRow.updatedAt, '点旧地址不顶作品排序')
})

test('「收到了」只能用 POST 点：GET 回 405', async () => {
  const router = createProjectsRouter()
  const res = await call(router, '/api/receipts/' + TOKEN_ACKED + '/ack')
  assert.equal(res.status, 405)
})

test('读得进去的那几条：没有包的、时间坏的，都不认这一项', async () => {
  const nopkg = (await store.getProject('prj_nopkg')).deliveries[0]
  assert.equal(nopkg.ack, undefined, '没有封存包就没有这一句可谈')
  const bad = (await store.getProject('prj_badack')).deliveries[0]
  assert.equal(bad.ack, undefined, '时间读不出来就当没点过，不编一个')
  const acked = (await store.getProject('prj_acked')).deliveries[0]
  assert.equal(acked.ack.at, '2026-11-15T04:30:00.000Z')
})

test('工作台那一行：他说收到了，就不再给换地址、也不再给再发一遍', async () => {
  // 合成一条最容易「被劝去换地址」的记录：换过两次、一次都没打开——只差他点过「收到了」
  const projects = [
    {
      ...project('prj_synth', '换过两次但他点了收到', [
        {
          ...base,
          id: 'cd34cd34cd341007',
          receiptToken: TOKEN_ACK,
          receiptLinkAt: base.at,
          resends: [{ at: '2026-11-14T08:00:00.000Z' }, { at: '2026-11-15T08:00:00.000Z' }],
          relinks: [
            { at: '2026-11-13T07:00:00.000Z', resends: 2 },
            { at: '2026-11-14T07:00:00.000Z', resends: 2 },
          ],
          ack: { at: '2026-11-15T04:30:00.000Z' },
        },
      ]),
    },
  ]
  const visits = { ['prj_synth:cd34cd34cd341007']: { opens: 0, firstAt: '', lastAt: '' } }
  const row = ledgerRows({ projects, visits })[0]
  assert.equal(row.ack.at, '2026-11-15T04:30:00.000Z', '这一行带上他点过的那一刻')
  assert.equal(row.relinkable, false, '他都说收到了：不换地址')
  assert.equal(row.resendable, false, '东西到了：不用再发一遍')
  assert.equal(row.relinkCapped, false, '不是「没送到」，也就不算换到头')
  assert.equal(row.remindable, true, '剩下的动作是催他验')

  // 清单顶上那句：「可能没送到」的那一堆里不该再算他
  const ledger = deliveryLedger({ projects, visits }, { now: Date.parse('2026-11-15T12:00:00.000Z') })
  assert.equal(ledger.receipts.pending, 1)
  assert.equal(ledger.receipts.pendingAcked, 1, '他自己说了收到，单独数一条')
  assert.equal(ledger.receipts.pendingUnopened, 0, '不能再算成「可能没送到」')
})

test('那几句话：只说发生过的事，不把这一下说成「他收到了」或验过了', () => {
  assert.equal(ackDomain.deliveryAckLead(null), '')
  assert.equal(ackDomain.deliveryAckLead({ at: '不是时间' }), '')
  const ack = { at: '2026-11-15T04:30:00.000Z' }
  assert.equal(ackDomain.deliveryAckLead(ack), '他点了「收到了」，收据还没贴')
  // 时间按浏览器所在时区写：这里只断言形状，不钉死某一天几点（CI 跑在 UTC 上）
  assert.match(ackDomain.deliveryAckAt(ack), /^\d{2}-\d{2} \d{2}:\d{2}$/, '按本地时区写成 MM-DD HH:MM：' + ackDomain.deliveryAckAt(ack))
  assert.match(ackDomain.deliveryAckText(ack), /^他在回执页点了「收到了」· \d{2}-\d{2} \d{2}:\d{2}$/)
  const hint = ackDomain.deliveryAckHint(ack)
  assert.match(hint, /东西到他手上了/, '说清这意味着什么：' + hint)
  assert.match(hint, /别当没送到/, '别让人再去换地址 / 再发一遍')
  assert.match(hint, /复制提醒/, '下一步是催他验')
  // 不替他下结论：没有「他确认收到了」这种说法
  assert.doesNotMatch(hint, /他确认|他收到了/)
  assert.match(ackDomain.deliveryAckedText(3), /其中 3 次他自己点了「收到了」/)
  assert.equal(ackDomain.deliveryAckedText(0), '')
})
