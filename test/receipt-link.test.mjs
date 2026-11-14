import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 回执链接（v0.9.137）：收包人不用注册，打开一条地址就能把收据自己贴回来。
// 这组盯五件事：
//   1) token 只认 16 位十六进制，坏的一律当没有，不拿半截字符串去扫；
//   2) 发行与换一条：不换时把在用的那枚还回来，换一条之后旧地址立刻找不到；
//   3) 收包人贴回来的结论写进那一条交付记录，包与交付时间一个字不动；
//   4) 没有封存包的交付发不了链接；
//   5) 界面上那句「谁贴的」按来源分开。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-receipt-link-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-receipt-link'

const SHA = 'c970584a7ffd' + 'a'.repeat(52)
const ZIP = 'VisionQA-交付封存验收-第-2-版-v2-20261115.zip'
const BYTES = 272155
const TOKEN = '0123456789abcdef'

const pkg = { bytes: BYTES, sha256: SHA, fileName: ZIP, savedAt: '2026-11-15T06:00:00.000Z' }

function receipt(overrides = {}) {
  const lines = [
    'VisionQA 交付包核对 · 交付封存验收 / 第 2 版 v2',
    '包：' + ZIP,
    '结论：都对得上 · 12 个文件都对得上',
    '整包：272,155 B · SHA-256 ' + SHA,
    '时间：2026-11-15 14:03',
  ]
  const merged = { ...overrides }
  if (merged.head !== undefined) lines[0] = merged.head
  if (merged.zip !== undefined) lines[1] = '包：' + merged.zip
  if (merged.conclusion !== undefined) lines[2] = '结论：' + merged.conclusion
  if (merged.bundle !== undefined) lines[3] = '整包：' + merged.bundle
  if (merged.at !== undefined) lines[4] = '时间：' + merged.at
  return lines.join('\n')
}

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    {
      id: 'prj_link',
      ownerId: 'u_a',
      title: '交付封存验收',
      flowId: 'flow_a',
      version: 2,
      versions: [],
      status: 'done',
      deliveries: [{ version: 2, at: '2026-11-15T06:00:00.000Z', id: 'aaaaaaaaaaaaaaaa', package: pkg }],
      createdAt: '2026-11-15T05:00:00.000Z',
      updatedAt: '2026-11-15T06:00:00.000Z',
    },
    {
      id: 'prj_token',
      ownerId: 'u_a',
      title: '已经发过链接的作品',
      flowId: 'flow_b',
      version: 2,
      versions: [],
      status: 'done',
      deliveries: [
        { version: 2, at: '2026-11-14T06:00:00.000Z', id: 'bbbbbbbbbbbbbbbb', package: pkg, receiptToken: TOKEN },
      ],
      createdAt: '2026-11-14T05:00:00.000Z',
      updatedAt: '2026-11-14T06:00:00.000Z',
    },
    {
      id: 'prj_legacy',
      ownerId: 'u_a',
      title: '老记录',
      flowId: 'flow_old',
      version: 1,
      versions: [],
      status: 'done',
      // 没有封存包的交付：即使盘上被人塞了一枚 token，读出来也要当没有
      deliveries: [{ version: 1, at: '2026-11-13T06:00:00.000Z', receiptToken: '1111111111111111' }],
      createdAt: '2026-11-13T05:00:00.000Z',
      updatedAt: '2026-11-13T06:00:00.000Z',
    },
  ]),
  'utf8',
)

const store = await import('../server/projects.mjs')
const { checkReceipt } = await import('../server/receipt-check.mjs')

test('回执链接：坏 token 当没有，好 token 只找到那一条', async () => {
  const found = await store.findReceiptLink(TOKEN)
  assert.ok(found)
  assert.equal(found.project.id, 'prj_token')
  assert.equal(found.delivery.id, 'bbbbbbbbbbbbbbbb')
  assert.equal(found.delivery.receiptToken, TOKEN)
  // 包里没有这份东西就不该出现在公开视图里：只给这一条交付与作品标题
  assert.equal(found.delivery.package.sha256, SHA)

  for (const bad of ['', ' ', 'not-a-token', TOKEN.slice(0, 15), TOKEN + 'a', TOKEN.toUpperCase(), '../' + TOKEN]) {
    assert.equal(await store.findReceiptLink(bad), null, '不该认这个 token：' + bad)
  }
  assert.equal(await store.findReceiptLink('fedcba9876543210'), null)
})

test('发行：缺的补一枚，在用的一枚不换；换一条之后旧地址找不到', async () => {
  const first = await store.issueDeliveryReceiptToken('prj_link', 'aaaaaaaaaaaaaaaa')
  assert.ok(first)
  assert.match(first.token, /^[0-9a-f]{16}$/)
  assert.equal(first.rotated, false)

  // 再发行一次：还回同一枚，不把已经发出去的地址作废
  const again = await store.issueDeliveryReceiptToken('prj_link', 'aaaaaaaaaaaaaaaa')
  assert.equal(again.token, first.token)
  assert.equal(again.rotated, false)

  // 换一条：新 token 不一样，旧的那枚立刻找不到
  const rotated = await store.issueDeliveryReceiptToken('prj_link', 'aaaaaaaaaaaaaaaa', null, { rotate: true })
  assert.ok(rotated)
  assert.notEqual(rotated.token, first.token)
  assert.equal(rotated.rotated, true)
  assert.equal(await store.findReceiptLink(first.token), null)
  assert.ok(await store.findReceiptLink(rotated.token))

  // 没有封存包 / 作品不存在：发不了链接
  const legacy = await store.issueDeliveryReceiptToken('prj_legacy', 'aaaaaaaaaaaaaaaa')
  assert.equal(legacy, null)
  assert.equal(await store.issueDeliveryReceiptToken('prj_missing', 'aaaaaaaaaaaaaaaa'), null)
  assert.equal(await store.issueDeliveryReceiptToken('prj_link', 'fedcba9876543210'), null)
})

test('收包人自己贴回来：结论写进那一条交付记录，包与交付时间不动', async () => {
  const found = await store.findReceiptLink(TOKEN)
  const check = checkReceipt({ text: receipt(), delivery: found.delivery })
  assert.equal(check.state, 'match')

  const saved = await store.saveReceiptByToken(TOKEN, {
    at: '2026-11-15T07:10:00.000Z',
    state: check.state,
    summary: check.summary,
    problems: check.problems,
    checks: check.checks,
    claimed: check.claimed,
    via: 'link',
  })
  assert.ok(saved)
  assert.equal(saved.delivery.receipt.state, 'match')
  assert.equal(saved.delivery.receipt.via, 'link')
  assert.equal(saved.delivery.receipt.at, '2026-11-15T07:10:00.000Z')

  // 重新读一遍：收据在，包、交付时间与 token 都没被改写
  const project = await store.getProject('prj_token')
  const stored = project.deliveries.find((entry) => entry.id === 'bbbbbbbbbbbbbbbb')
  assert.equal(stored.receipt.state, 'match')
  assert.equal(stored.receipt.claimed.sha256, SHA)
  assert.equal(stored.receipt.checks.length, 5)
  assert.deepEqual(stored.package, pkg)
  assert.equal(stored.at, '2026-11-14T06:00:00.000Z')
  assert.equal(stored.receiptToken, TOKEN)

  // 对不上的也照记（不因为难看就丢掉），但状态如实写
  const bad = checkReceipt({ text: receipt({ bundle: '272,155 B · SHA-256 ' + SHA.slice(0, 63) + 'f' }), delivery: found.delivery })
  assert.equal(bad.state, 'mismatch')
  const second = await store.saveReceiptByToken(TOKEN, {
    at: '2026-11-15T07:20:00.000Z',
    state: bad.state,
    summary: bad.summary,
    problems: bad.problems,
    checks: bad.checks,
    claimed: bad.claimed,
    via: 'link',
  })
  assert.equal(second.delivery.receipt.state, 'mismatch')
  assert.match(second.delivery.receipt.problems[0], /第 64 位/)

  // 坏输入不写盘
  assert.equal(await store.saveReceiptByToken('fedcba9876543210', { at: 'x', state: 'match' }), null)
  assert.equal(await store.saveReceiptByToken(TOKEN, { at: 'x', state: 'fine' }), null)
  assert.equal(await store.saveReceiptByToken(TOKEN, { at: '', state: 'match' }), null)
})

test('没封存包的交付：token 读出来也当没有，贴不进去', async () => {
  const project = await store.getProject('prj_legacy')
  assert.equal(project.deliveries[0].receiptToken, undefined)
  assert.equal(await store.findReceiptLink('1111111111111111'), null)
  assert.equal(await store.saveReceiptByToken('1111111111111111', { at: 'x', state: 'match' }), null)
})

test('界面文案：谁贴的说人话', async () => {
  const domain = await import('../src/domain/project.ts')
  assert.equal(domain.receiptViaText('link'), '收包人自己从回执链接贴回来的')
  assert.equal(domain.receiptViaText('you'), '你替收包人贴进来的')
  // 老记录没有这一项：按发件人贴的讲，不编一个「对方自己贴的」
  assert.equal(domain.receiptViaText(undefined), '你替收包人贴进来的')
})
