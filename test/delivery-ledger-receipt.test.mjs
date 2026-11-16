import test from 'node:test'
import assert from 'node:assert/strict'

// 工作台上的回执（v0.9.139）：交出去的每一条带不带回执、结论是什么，清单顶上按整份数一遍。
// 这组盯五件事：
//   1) 行上只给结论 / 时间 / 谁贴的 / 贴过几次，不把逐项比对与摘要搬上一页几十条的工作台；
//   2) 老记录只有 receipt 没有 receipts 时按一次算，不把一次说成零次；
//   3) 没封过包的交付不参与回执计数：它们不是「还没回来」，是那时候还没有包可验；
//   4) sealed = 对上 + 对不上 + 读不出/打架 + 还没回来，四个数字永远对得上；
//   5) 顶上那句话在「全都还没回」和「混着来」两种情况下都说人话。
// 2026-11-15 追加（v0.9.144）：行上多两件事——差在哪一项、等了几天该不该提一句，
// 以及「催过几次、还能不能催」。这三件都只多几个字，不把 checks 搬上工作台。

const { ledgerRows, deliveryLedger } = await import('../server/delivery-ledger.mjs')
const { ledgerReceiptBadText, ledgerReceiptText, ledgerReceiptTotalsText } = await import('../src/domain/project.ts')
const { deliveryLateText, deliveryWaitLate, deliveryWaitText } = await import('../src/domain/delivery-wait.ts')

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
  // 传一个固定时刻：不然「超过三天」那个数会随当天日期漂，跑一周之后测试自己就红了
  const now = Date.parse('2026-11-15T12:00:00.000Z')
  const ledger = deliveryLedger({ projects }, { now })
  const { receipts } = ledger
  // pendingUnopened（v0.9.145）是 pending 的子集：这几条交付都没带打开记录，所以是 0
  // pendingStuck（v0.9.146）是 pendingUnopened 里又发过两次还是一个样的那些，这里也没有
  // pendingRelinked（v0.9.147）是换过一条新地址、新地址也没人打开的那些，这里同样没有
  // pendingAcked（v0.9.151）是他自己点了「收到了」的那些，这里也没人点过
  // waitClosed（v0.9.158）是发件人自己收口、不再等的那些：从 pending 里挪出去单算，这里也没有
  assert.deepEqual(receipts, {
    sealed: 3,
    matched: 1,
    mismatched: 1,
    unclear: 0,
    pending: 1,
    waitClosed: 0,
    pendingLate: 0,
    pendingUnopened: 0,
    pendingStuck: 0,
    pendingRelinked: 0,
    pendingAcked: 0,
  })
  assert.equal(
    receipts.sealed,
    receipts.matched + receipts.mismatched + receipts.unclear + receipts.pending + receipts.waitClosed,
  )
  const second = deliveryLedger({ projects }, { offset: 2, limit: 1, now })
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

test('差在哪一项：只给项名，不给两边写过的值', () => {
  // 只换过哈希的那张收据：五项里只有 sha256 落了 false
  const row = ledgerRows({ projects }).find((entry) => entry.projectId === 'prj_miss')
  assert.deepEqual(row.receipt.bad, ['sha256'])
  assert.equal(row.receipt.state, 'mismatch')
  // 两边的值不跟着上来：工作台一页几十条，不搬 checks
  assert.equal(JSON.stringify(row).includes('"want"'), false)
  assert.equal(JSON.stringify(row).includes('"got"'), false)

  // 好几项一起不对时按固定顺序列（版次 / 包名 / 字节 / 整包 / 结论），不随收据里怎么排而变
  const multi = ledgerRows({
    projects: [
      {
        id: 'prj_multi',
        title: '差好几项',
        version: 1,
        deliveries: [
          {
            version: 1,
            at: '2026-11-15T08:00:00.000Z',
            id: 'aaaa00000000aa09',
            package: pkg(1),
            receipt: {
              at: '2026-11-15T08:10:00.000Z',
              state: 'mismatch',
              checks: [
                { k: 'verdict', want: '都对得上', got: '有问题', ok: false },
                { k: 'sha256', want: 'a', got: 'b', ok: false },
                { k: 'version', want: 'v1', got: 'v2', ok: false },
              ],
            },
          },
        ],
      },
    ],
  }).find((entry) => entry.projectId === 'prj_multi')
  assert.deepEqual(multi.receipt.bad, ['version', 'sha256', 'verdict'])
  assert.equal(ledgerReceiptBadText(multi.receipt.bad), '版次、整包 SHA-256、对方结论')
  assert.match(ledgerReceiptText(multi.receipt), /^回执 · 对不上 · 差在版次、整包 SHA-256、对方结论 · \d{2}-\d{2} \d{2}:\d{2}$/)
})

test('读不出来的那张不列「差在哪一项」——整张收据都没解析成，列出来只会误导', () => {
  const rows = ledgerRows({
    projects: [
      {
        id: 'prj_broken',
        title: '他那边读不出来',
        version: 1,
        deliveries: [
          {
            version: 1,
            at: '2026-11-15T08:00:00.000Z',
            id: 'aaaa00000000aa08',
            package: pkg(1),
            receipt: {
              at: '2026-11-15T08:10:00.000Z',
              state: 'broken',
              checks: [{ k: 'sha256', want: '', got: '', ok: false }],
            },
          },
        ],
      },
    ],
  })
  assert.equal(rows[0].receipt.bad, undefined)
  const line = ledgerReceiptText(rows[0].receipt)
  assert.match(line, /^回执 · 对方读不出来 · \d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(line.includes('差在'), false)
})

test('还没回来：等了几天、催过几次、还能不能催', () => {
  const withLink = [
    {
      id: 'prj_wait',
      title: '还没回来的那条',
      version: 1,
      deliveries: [
        {
          version: 1,
          // 11-12 交的：到 11-16 就是第 4 天
          at: '2026-11-12T08:00:00.000Z',
          id: 'aaaa00000000aa07',
          package: pkg(1),
          receiptToken: '0123456789abcdef',
          reminders: [{ at: '2026-11-15T08:00:00.000Z' }],
        },
      ],
    },
  ]
  const now = Date.parse('2026-11-16T09:00:00.000Z')
  const row = ledgerRows({ projects: withLink })[0]
  assert.equal(deliveryWaitText(row.at, now), '发出 4 天')
  assert.equal(deliveryWaitLate(row.at, now), true)
  assert.deepEqual(row.reminder, { count: 1, at: '2026-11-15T08:00:00.000Z' })
  assert.equal(row.remindable, true, '有包、没回执、链接还在，就能催')

  const ledger = deliveryLedger({ projects: withLink }, { now })
  assert.equal(ledger.receipts.pending, 1)
  assert.equal(ledger.receipts.pendingLate, 1, 'pending 里超过三天的单独数一条，不另算一种结论')
  assert.equal(ledger.receipts.sealed, ledger.receipts.matched + ledger.receipts.mismatched + ledger.receipts.unclear + ledger.receipts.pending)
  assert.equal(deliveryLateText(ledger.receipts.pendingLate), '其中 1 次发出超过 3 天，可以提一句。')
  assert.equal(deliveryLateText(0), '')

  // 同一条，换到交付当天：不是「超过三天」，也不该说「发出 0 天」
  const sameDay = Date.parse('2026-11-12T09:00:00.000Z')
  assert.equal(deliveryWaitText(row.at, sameDay), '今天发出')
  assert.equal(deliveryWaitLate(row.at, sameDay), false)

  // 时间没记下的老记录：说不出天数，也不催
  assert.equal(deliveryWaitText('', sameDay), '')
  assert.equal(deliveryWaitLate('', sameDay), false)
})

test('已经贴过回执、或者链接还没生成的那条，不给「催」这个动作', () => {
  const rows = ledgerRows({
    projects: [
      {
        id: 'prj_done2',
        title: '已经贴过了',
        version: 1,
        deliveries: [
          {
            version: 1,
            at: '2026-11-10T08:00:00.000Z',
            id: 'aaaa00000000aa06',
            package: pkg(1),
            receiptToken: '0123456789abcdef',
            receipt: receipt('match', '2026-11-11T08:00:00.000Z', 'link'),
          },
        ],
      },
      {
        id: 'prj_nolink',
        title: '链接还没生成',
        version: 1,
        deliveries: [{ version: 1, at: '2026-11-10T08:00:00.000Z', id: 'aaaa00000000aa05', package: pkg(1) }],
      },
      {
        id: 'prj_legacy2',
        title: '没有包的老记录',
        version: 1,
        deliveries: [{ version: 1, at: '2026-11-10T08:00:00.000Z' }],
      },
    ],
  })
  const byId = (id) => rows.find((row) => row.projectId === id)
  assert.equal(byId('prj_done2').remindable, false, '已经验完的不催')
  assert.equal(byId('prj_nolink').remindable, false, '没有回执链接就没有地方贴收据，催了也没用')
  assert.equal(byId('prj_legacy2').remindable, false)
  assert.equal(byId('prj_legacy2').reminder, null)
})
