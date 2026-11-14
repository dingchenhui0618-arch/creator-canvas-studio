import test from 'node:test'
import assert from 'node:assert/strict'

// 工作台上的回执（v0.9.139）：交出去的每一条带不带回执、结论是什么，清单顶上按整份数一遍。
// 这组盯五件事：
//   1) 行上只给结论 / 时间 / 谁贴的 / 贴过几次，不把逐项比对与摘要搬上一页几十条的工作台；
//   2) 老记录只有 receipt 没有 receipts 时按一次算，不把一次说成零次；
//   3) 没封过包的交付不参与回执计数：它们不是「还没回来」，是那时候还没有包可验；
//   4) sealed = 对上 + 对不上 + 读不出/打架 + 还没回来，四个数字永远对得上；
//   5) 顶上那句话在「全都还没回」和「混着来」两种情况下都说人话。

const { ledgerRows, deliveryLedger } = await import('../server/delivery-ledger.mjs')
const { ledgerReceiptText, ledgerReceiptTotalsText } = await import('../src/domain/project.ts')

const SHA = 'a'.repeat(64)

function pkg(version) {
  return { bytes: 1000 + version, sha256: SHA, fileName: 'VisionQA-回执验收-v' + version + '.zip', savedAt: '2026-11-15T08:00:00.000Z' }
}

function receipt(state, at, via) {
  return {
    at,
    state,
    via,
    summary: '摘要不该出现在工作台上',
    problems: ['问题也不该出现'],
    checks: [{ k: 'sha256', want: 'a', got: 'b', ok: false }],
    claimed: { at: '2026-11-15 16:00', kind: '交付包', title: '回执验收', version: 1, bytes: 1001, sha256: SHA, packageName: 'x.zip', chip: '都对得上', summary: 'x' },
  }
}

const projects = [
  {
    id: 'prj_match',
    title: '贴对了的那条',
    version: 2,
    deliveries: [
      {
        version: 2,
        at: '2026-11-15T09:00:00.000Z',
        id: 'aaaa00000000aa01',
        package: pkg(2),
        // 先贴了一张对不上的、又贴了一张对的：流水两条，最新那条是 receipt
        receipts: [receipt('mismatch', '2026-11-15T09:01:00.000Z', 'link'), receipt('match', '2026-11-15T09:02:00.000Z', 'link')],
        receipt: receipt('match', '2026-11-15T09:02:00.000Z', 'link'),
      },
    ],
  },
  {
    id: 'prj_miss',
    title: '贴回来对不上的那条',
    version: 1,
    deliveries: [
      {
        version: 1,
        at: '2026-11-15T08:30:00.000Z',
        id: 'aaaa00000000aa02',
        package: pkg(1),
        // 老记录：只有 receipt，没有 receipts
        receipt: receipt('mismatch', '2026-11-15T08:31:00.000Z', 'you'),
      },
    ],
  },
  {
    id: 'prj_pending',
    title: '还没回来的那条',
    version: 1,
    deliveries: [{ version: 1, at: '2026-11-15T08:00:00.000Z', id: 'aaaa00000000aa03', package: pkg(1) }],
  },
  {
    id: 'prj_legacy',
    title: '升级前交的那条',
    version: 2,
    deliveries: [{ version: 2, at: '2026-11-14T08:00:00.000Z' }],
  },
]

test('行上只留结论、时间、谁贴的与贴过几次', () => {
  const row = ledgerRows({ projects }).find((entry) => entry.projectId === 'prj_match')
  assert.ok(row.receipt, '该带回执')
  assert.deepEqual(Object.keys(row.receipt).sort(), ['at', 'count', 'state', 'via'])
  assert.equal(row.receipt.state, 'match')
  assert.equal(row.receipt.via, 'link')
  assert.equal(row.receipt.count, 2, '流水两条就该说贴过 2 次')
  assert.equal(JSON.stringify(row).includes('摘要不该出现'), false, '摘要不该被搬上工作台')
  assert.equal(JSON.stringify(row).includes('问题也不该出现'), false, '逐项问题不该被搬上工作台')
})

test('老记录只有 receipt 没有 receipts：按一次算', () => {
  const row = ledgerRows({ projects }).find((entry) => entry.projectId === 'prj_miss')
  assert.ok(row.receipt)
  assert.equal(row.receipt.count, 1, '没有流水时说一次，不说零次')
  assert.equal(row.receipt.via, 'you', '发件人替他贴的')
})

test('没封过包的交付不参与回执计数', () => {
  const ledger = deliveryLedger({ projects })
  assert.equal(ledger.total, 4)
  assert.equal(ledger.receipts.sealed, 3, '只有三条封了包')
  const legacy = ledgerRows({ projects }).find((entry) => entry.projectId === 'prj_legacy')
  assert.equal(legacy.receipt, null)
  assert.equal(legacy.package, null)
})

test('四个数字对得上，翻页不改变它们', () => {
  const ledger = deliveryLedger({ projects })
  const { receipts } = ledger
  assert.deepEqual(receipts, { sealed: 3, matched: 1, mismatched: 1, unclear: 0, pending: 1 })
  assert.equal(receipts.sealed, receipts.matched + receipts.mismatched + receipts.unclear + receipts.pending)
  const second = deliveryLedger({ projects }, { offset: 2, limit: 1 })
  assert.equal(second.items.length, 1)
  assert.deepEqual(second.receipts, receipts, '第二页的数字该和第一页一样')
})

test('顶上那句话：全都没回来与混着来各有各的说法', () => {
  assert.equal(ledgerReceiptTotalsText({ sealed: 0, matched: 0, mismatched: 0, unclear: 0, pending: 0 }), '')
  assert.equal(
    ledgerReceiptTotalsText({ sealed: 3, matched: 0, mismatched: 0, unclear: 0, pending: 3 }),
    '封过包的 3 次都还没收到回执。',
  )
  assert.equal(
    ledgerReceiptTotalsText({ sealed: 5, matched: 1, mismatched: 1, unclear: 1, pending: 2 }),
    '封过包的 5 次：1 次回执对得上，1 次对不上，1 次贴回来了，但读不出或说法打架，2 次还没收到回执。',
  )
})

test('一行上的回执只写结论、时间与贴过几次', () => {
  assert.equal(ledgerReceiptText(null), '')
  // 时间按本机时刻写（与作品页那行同一口径），只看形状：哪一天哪一分由时区定
  const line = ledgerReceiptText({ state: 'match', at: '2026-11-15T07:29:37.276Z', via: 'link', count: 1 })
  assert.match(line, /^回执 · 对得上 · \d{2}-\d{2} \d{2}:\d{2}$/)
  assert.match(
    ledgerReceiptText({ state: 'mismatch', at: '2026-11-15T07:29:00.000Z', via: 'link', count: 3 }),
    /^回执 · 对不上 · \d{2}-\d{2} \d{2}:\d{2} · 贴过 3 次$/,
  )
  assert.equal(ledgerReceiptText({ state: 'broken', at: '', via: 'you', count: 1 }), '回执 · 对方读不出来')
})
