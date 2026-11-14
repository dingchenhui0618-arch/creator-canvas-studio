import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 回执流水（v0.9.138）：链接发出去之后，对方可能先贴一张对不上的、换了包再贴一张对得上的。
// 只留最近一次等于把前一次的证据擦掉，所以每次对账都接进一条流水。这组盯五件事：
//   1) 老记录只有 receipt、没有流水时，读出来是一条，不是零条；
//   2) 收包人贴、发件人贴，两条路都往同一条流水里接；
//   3) 越晚的排越后面，receipt 永远等于最后一条；
//   4) 只留最近 5 次，更早的丢掉；
//   5) 没封存包的交付：盘上塞了流水也当没有。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-receipt-history-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-receipt-history'

const SHA = 'd1f2e3a4b5c6' + 'b'.repeat(52)
const TOKEN = 'fedcba9876543210'
const pkg = { bytes: 277725, sha256: SHA, fileName: 'VisionQA-交付封存验收-第-4-版-v4-20261115.zip', savedAt: '2026-11-15T06:00:00.000Z' }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    {
      id: 'prj_hist',
      ownerId: 'u_a',
      title: '交付封存验收',
      flowId: 'flow_a',
      version: 4,
      versions: [],
      status: 'done',
      deliveries: [
        // 老记录（升级前只有 receipt）：读出来该是一条流水
        {
          version: 3,
          at: '2026-11-14T06:00:00.000Z',
          id: 'cccccccccccccccc',
          package: pkg,
          receipt: { at: '2026-11-14T07:00:00.000Z', state: 'match', summary: '都对得上', via: 'you' },
        },
        // 发过链接、还没人贴过
        { version: 4, at: '2026-11-15T06:00:00.000Z', id: 'dddddddddddddddd', package: pkg, receiptToken: TOKEN },
      ],
      createdAt: '2026-11-14T05:00:00.000Z',
      updatedAt: '2026-11-15T06:00:00.000Z',
    },
    {
      id: 'prj_legacy',
      ownerId: 'u_a',
      title: '老记录',
      flowId: 'flow_old',
      version: 1,
      versions: [],
      status: 'done',
      // 没有封存包：盘上被人塞了流水也当没有
      deliveries: [
        {
          version: 1,
          at: '2026-11-13T06:00:00.000Z',
          receipts: [{ at: '2026-11-13T07:00:00.000Z', state: 'match', summary: '都说好' }],
        },
      ],
      createdAt: '2026-11-13T05:00:00.000Z',
      updatedAt: '2026-11-13T06:00:00.000Z',
    },
  ]),
  'utf8',
)

const store = await import('../server/projects.mjs')

test('老记录只有一次结论：读出来是一条流水，不是零条', async () => {
  const project = await store.getProject('prj_hist')
  const old = project.deliveries.find((entry) => entry.version === 3)
  assert.equal(old.receipts.length, 1)
  assert.equal(old.receipts[0].at, old.receipt.at)
  assert.equal(old.receipts[0].state, 'match')
  assert.equal(old.receipts[0].via, 'you')
  // 还没人贴过的那一条：一条流水都不给
  const fresh = project.deliveries.find((entry) => entry.version === 4)
  assert.equal(fresh.receipt, undefined)
  assert.equal(fresh.receipts, undefined)
})

test('每贴一次接一条：越晚越靠后，receipt 永远等于最后一条', async () => {
  const first = await store.saveReceiptByToken(TOKEN, {
    at: '2026-11-15T07:00:00.000Z',
    state: 'mismatch',
    summary: '对不上：版次不一样',
    problems: ['版次对不上：收据是 v3，这一条是 v4'],
    via: 'link',
  })
  assert.equal(first.delivery.receipts.length, 1)
  assert.equal(first.delivery.receipts[0].state, 'mismatch')

  // 换了包之后再贴一次，这一次对得上
  const second = await store.saveDeliveryReceipt('prj_hist', 'dddddddddddddddd', {
    at: '2026-11-15T07:30:00.000Z',
    state: 'match',
    summary: '都对得上',
    via: 'you',
  })
  assert.equal(second.delivery.receipts.length, 2)
  assert.equal(second.delivery.receipts[0].state, 'mismatch')
  assert.equal(second.delivery.receipts[1].state, 'match')
  assert.equal(second.delivery.receipts[0].via, 'link')
  assert.equal(second.delivery.receipts[1].via, 'you')
  assert.equal(second.delivery.receipt.at, second.delivery.receipts[1].at)

  // 从盘上重新读回来也一样，包与交付时间一个字没动
  const project = await store.getProject('prj_hist')
  const stored = project.deliveries.find((entry) => entry.version === 4)
  assert.equal(stored.receipts.length, 2)
  assert.equal(stored.receipt.state, 'match')
  assert.deepEqual(stored.package, pkg)
  assert.equal(stored.at, '2026-11-15T06:00:00.000Z')
  assert.equal(stored.receiptToken, TOKEN)
})

test('只留最近 5 次：再贴就把最早的挤掉', async () => {
  for (let i = 0; i < 4; i += 1) {
    await store.saveReceiptByToken(TOKEN, {
      at: '2026-11-15T08:0' + i + ':00.000Z',
      state: 'match',
      summary: '第 ' + (i + 1) + ' 次补贴',
      via: 'link',
    })
  }
  const project = await store.getProject('prj_hist')
  const stored = project.deliveries.find((entry) => entry.version === 4)
  assert.equal(stored.receipts.length, 5)
  // 最早那条「对不上」被挤掉了，留下的最后一条就是 receipt
  assert.equal(stored.receipts[0].at, '2026-11-15T07:30:00.000Z')
  assert.equal(stored.receipts[4].at, '2026-11-15T08:03:00.000Z')
  assert.equal(stored.receipt.at, stored.receipts[4].at)
  assert.equal(stored.receipt.summary, '第 4 次补贴')
})

test('坏条目当没有，坏输入不写盘', async () => {
  // 认不出的状态、没时间的，一律丢掉，不拿半条记录占一格
  const clean = await store.saveReceiptByToken(TOKEN, {
    at: '2026-11-15T09:00:00.000Z',
    state: 'match',
    summary: '最后一次',
    checks: [{ k: 'version', want: '4', got: '4', ok: true }, { k: 'what', want: 'x', got: 'y', ok: false }],
    via: 'link',
  })
  assert.equal(clean.delivery.receipts.length, 5)
  assert.equal(clean.delivery.receipts[4].checks.length, 1)
  assert.equal(clean.delivery.receipts[4].checks[0].k, 'version')

  assert.equal(await store.saveReceiptByToken(TOKEN, { at: '', state: 'match' }), null)
  assert.equal(await store.saveReceiptByToken(TOKEN, { at: '2026-11-15T09:10:00.000Z', state: 'fine' }), null)
  assert.equal(await store.saveDeliveryReceipt('prj_hist', 'ffffffffffffffff', { at: '2026-11-15T09:20:00.000Z', state: 'match' }), null)
})

test('没封存包的交付：流水读出来也当没有', async () => {
  const project = await store.getProject('prj_legacy')
  assert.equal(project.deliveries[0].receipt, undefined)
  assert.equal(project.deliveries[0].receipts, undefined)
})
