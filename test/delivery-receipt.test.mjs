import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 收据对账（v0.9.136）：收包人把校验页给的收据发回来，发件人贴进作品页，跟封存包比一遍。
// 这组盯四件事：
//   1) 只认校验页写出来的那几行：引用前缀、全角冒号、CRLF、大小写哈希都要认，别的东西明确拒绝；
//   2) 五种比对结果分得清：对得上 / 对不上 / 对方读不出来 / 哈希对上但结论打架，不把比不了说成对上；
//   3) 结论写回交付记录，包的字节、哈希与交付时间一个字不动；
//   4) 界面那一句话（胶囊与逐项标签）跟状态对得上。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-receipt-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-receipt'

const SHA = '8e0620f1a456' + 'b'.repeat(52)
const ZIP = 'VisionQA-交付封存验收-第-2-版-v2-20261115.zip'
const BYTES = 272155

function receipt(overrides = {}) {
  const lines = [
    'VisionQA 交付包核对 · 交付封存验收 / 第 2 版 v2',
    '包：' + ZIP,
    '结论：都对得上 · 12 个文件都对得上：字节数与 CRC32 都和打包时记下的清单一致。',
    '整包：272,155 B · SHA-256 ' + SHA,
    '时间：2026-11-15 14:03',
  ]
  const merged = { ...overrides }
  if (merged.head !== undefined) lines[0] = merged.head
  if (merged.zip !== undefined) lines[1] = '包：' + merged.zip
  if (merged.conclusion !== undefined) lines[2] = '结论：' + merged.conclusion
  if (merged.bundle !== undefined) lines[3] = '整包：' + merged.bundle
  if (merged.at !== undefined) lines[4] = '时间：' + merged.at
  if (merged.extra) lines.push(merged.extra)
  return lines.join('\n')
}

const delivery = {
  id: '0123456789abcdef',
  version: 2,
  at: '2026-11-15T06:00:00.000Z',
  package: { bytes: BYTES, sha256: SHA, fileName: ZIP, savedAt: '2026-11-15T06:00:00.000Z' },
}

const { parseReceipt, checkReceipt } = await import('../server/receipt-check.mjs')

test('收据解析：引用前缀、CRLF、全角冒号与大写哈希都认', () => {
  const quoted = receipt()
    .split('\n')
    .map((line) => '> ' + line)
    .join('\r\n')
    .replace('包：', '包: ')
  const parsed = parseReceipt(quoted)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.kind, '交付包')
  assert.equal(parsed.title, '交付封存验收 / 第 2 版')
  assert.equal(parsed.version, 2)
  assert.equal(parsed.packageName, ZIP)
  assert.equal(parsed.bytes, BYTES)
  assert.equal(parsed.sha256, SHA)
  assert.equal(parsed.chip, '都对得上')
  assert.match(parsed.summary, /12 个文件都对得上/)
  assert.equal(parsed.at, '2026-11-15 14:03')
  // 哈希大小写不算错：收据上是大写也收成小写
  assert.equal(parseReceipt(receipt({ bundle: '272,155 B · SHA-256 ' + SHA.toUpperCase() })).sha256, SHA)
})

test('收据解析：认不出就明确拒绝，不拿半份数据去比', () => {
  assert.equal(parseReceipt('').ok, false)
  assert.equal(parseReceipt('  \n  ').ok, false)
  const junk = parseReceipt('你好，包我收到了，没问题')
  assert.equal(junk.ok, false)
  assert.match(junk.error, /不像校验页给出的收据/)
  assert.match(junk.error, /结论/)
  const noBundle = parseReceipt(receipt().split('\n').filter((line) => !line.startsWith('整包')).join('\n'))
  assert.equal(noBundle.ok, false)
  assert.match(noBundle.error, /整包/)
  // 整包那一行只有一句话、既没字节也没哈希：也不认
  assert.equal(parseReceipt(receipt({ bundle: '反正不大' })).ok, false)
  // 太长的不收：收据只有五行，八千字已经不是收据了
  assert.match(parseReceipt('x'.repeat(9000)).error, /太长/)
})

test('对账：五项都对上才是 match，并列出逐项结果', () => {
  const check = checkReceipt({ text: receipt(), delivery })
  assert.equal(check.state, 'match')
  assert.equal(check.ok, true)
  assert.equal(check.problems.length, 0)
  assert.deepEqual(
    check.checks.map((item) => [item.k, item.ok]),
    [
      ['version', true],
      ['package', true],
      ['bytes', true],
      ['sha256', true],
      ['verdict', true],
    ],
  )
  assert.equal(check.claimed.version, 2)
  assert.equal(check.claimed.kind, '交付包')
  assert.match(check.summary, /就是这一份/)
})

test('对账：哪一项不一样就点哪一项，哈希不同是最要紧的那条', () => {
  const version = checkReceipt({ text: receipt({ head: 'VisionQA 交付包核对 · 交付封存验收 / 第 2 版 v3' }), delivery })
  assert.equal(version.state, 'mismatch')
  assert.match(version.problems.join(' '), /版次对不上：收据是 v3，这一条是 v2/)

  const otherSha = checkReceipt({ text: receipt({ bundle: '272,155 B · SHA-256 ' + 'c'.repeat(64) }), delivery })
  assert.equal(otherSha.state, 'mismatch')
  assert.match(otherSha.problems.join(' '), /哈希对不上/)
  assert.equal(otherSha.checks.find((item) => item.k === 'sha256')?.ok, false)

  const size = checkReceipt({ text: receipt({ bundle: '272,156 B · SHA-256 ' + SHA }), delivery })
  assert.equal(size.state, 'mismatch')
  assert.match(size.problems.join(' '), /字节数对不上：收据写 272,156 B，这一条是 272,155 B/)

  const name = checkReceipt({ text: receipt({ zip: '别人的包.zip' }), delivery })
  assert.equal(name.state, 'mismatch')
  assert.match(name.problems.join(' '), /包名对不上/)
})

test('对账：哈希对得上但收据写着有问题，判 conflict，不硬说对得上', () => {
  const check = checkReceipt({
    text: receipt({ conclusion: '有问题 · 1 个文件对不上。以下是逐条结论。', extra: '对不上的：frames/shot-01.jpg（CRC32 对不上：清单里是 50FE0813）' }),
    delivery,
  })
  assert.equal(check.state, 'conflict')
  assert.match(check.summary, /哈希对得上/)
  assert.match(check.summary, /两份说法打架/)
})

test('对账：对方读不出来判 broken，收据上「没算」不冒充一个哈希', () => {
  const check = checkReceipt({
    text: receipt({ conclusion: '读不出来 · 找不到 zip 的尾记录', bundle: '没算（读不出来，或这个浏览器不给算）' }),
    delivery,
  })
  assert.equal(check.state, 'broken')
  assert.match(check.summary, /收包人那边读不出来/)
  assert.match(check.summary, /重发更稳/)
  assert.equal(check.checks.find((item) => item.k === 'sha256')?.ok, false)
  assert.match(check.problems.join(' '), /没算哈希/)
})

test('存储：收据写回交付记录，包与交付时间一个字不动', async () => {
  fs.writeFileSync(
    path.join(DIR, 'projects.json'),
    JSON.stringify([
      {
        id: 'prj_receipt',
        ownerId: 'u_a',
        title: '交付封存验收 / 第 2 版',
        flowId: 'flow_2',
        version: 2,
        versions: [],
        status: 'done',
        deliveries: [{ version: 2, at: '2026-11-15T06:00:00.000Z', id: delivery.id, package: delivery.package }],
        createdAt: '2026-11-15T05:00:00.000Z',
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
        deliveries: [{ version: 1, at: '2026-11-14T06:00:00.000Z' }],
        createdAt: '2026-11-14T05:00:00.000Z',
        updatedAt: '2026-11-14T06:00:00.000Z',
      },
    ]),
    'utf8',
  )

  const { getProject, saveDeliveryReceipt } = await import('../server/projects.mjs')
  const check = checkReceipt({ text: receipt(), delivery })
  const saved = await saveDeliveryReceipt('prj_receipt', delivery.id, {
    at: '2026-11-15T07:00:00.000Z',
    state: check.state,
    summary: check.summary,
    problems: check.problems,
    checks: check.checks,
    claimed: check.claimed,
  })
  assert.ok(saved)
  assert.equal(saved.delivery.receipt.state, 'match')
  assert.equal(saved.delivery.receipt.at, '2026-11-15T07:00:00.000Z')

  // 重新读一遍：收据在，包与交付时间还是原来那份
  const project = await getProject('prj_receipt')
  const stored = project.deliveries.find((entry) => entry.id === delivery.id)
  assert.equal(stored.receipt.state, 'match')
  assert.equal(stored.receipt.claimed.version, 2)
  assert.equal(stored.receipt.claimed.sha256, SHA)
  assert.deepEqual(stored.package, delivery.package)
  assert.equal(stored.at, '2026-11-15T06:00:00.000Z')

  // 没有封存包的老记录：谈不上对账，返回 null，不硬塞一条
  assert.equal(await saveDeliveryReceipt('prj_legacy', '0123456789abcdef', { at: 'x', state: 'match' }), null)
  assert.equal(await saveDeliveryReceipt('prj_missing', delivery.id, { at: 'x', state: 'match' }), null)
  // 状态不在四种里：当没核对过，不写盘
  assert.equal(await saveDeliveryReceipt('prj_receipt', delivery.id, { at: '2026-11-15T08:00:00.000Z', state: 'fine' }), null)
})

test('界面文案：胶囊一句话按状态分，逐项标签给人看', async () => {
  const domain = await import('../src/domain/project.ts')
  const line = (state) => domain.deliveryReceiptLine({ at: '2026-11-15T07:05:00.000Z', state, summary: '' })
  assert.match(line('match'), /收包人核对过 · 对得上 · 11-15/)
  assert.match(line('mismatch'), /收包人核对过 · 对不上/)
  assert.match(line('broken'), /收包人核对过 · 对方读不出来/)
  assert.match(line('conflict'), /收包人核对过 · 说法打架/)
  assert.equal(domain.deliveryReceiptLine(null), '')
  assert.equal(domain.receiptCheckLabel('sha256'), '整包 SHA-256')
  assert.equal(domain.receiptCheckLabel('verdict'), '对方结论')
  assert.equal(domain.receiptCheckLabel('other'), 'other')
})
