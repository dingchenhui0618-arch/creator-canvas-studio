import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 不再等这一份的回执（v0.9.158）。
//
// r144–r157 一路在回答「他收到没有、验了没有、要不要换地址、要不要换个渠道问」——
// 每一句都假设「这件事还等着我」。可客户会口头说一声、会当面看一遍、这一版也会直接作废；
// 那时候还在工作台上催，就是催一件已经结束的事。这一组盯六件事：
//   1) 收口只动这一条交付记录上的一个时间：包、收据、回执链接、催过几次都不动；
//   2) 收口之后这一行不再给催收动作（复制提醒 / 换链接 / 再发一次 / 换个渠道问）；
//   3) 清单数字：收口的不算「还没回来」，单算一条；sealed 仍然等于四项之和；
//   4) 按人看：收口的不算欠着，也不被说成「回执都回来了」；
//   5) 收口之后回执真回来了，照常按回执算（收口是「等」的事，不改记录）；
//   6) 点错了能继续等：字段真的消失，回到可催的样子。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-wait-close-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-wait-close'

const AT = (day) => '2026-11-' + String(day).padStart(2, '0') + 'T06:00:00.000Z'
const pkg = { bytes: 234567, sha256: 'ab12cd34ef56' + 'b'.repeat(52), fileName: 'VisionQA-不再等-第-3-版-v3-20261115.zip', savedAt: AT(9) }
const ID_CLOSE = 'aa11aa11aa110001'
const ID_AGAIN = 'aa11aa11aa110002'
const ID_REOPEN = 'aa11aa11aa110003'
const ID_RECEIPT = 'aa11aa11aa110004'
const ID_NOPKG = 'aa11aa11aa110005'

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
    createdAt: AT(8),
    updatedAt: AT(12),
  }
}

const base = { version: 3, at: AT(10), package: pkg, recipient: '王老师 · 内容组' }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    project('prj_close', '要收口的那一份', [{ ...base, id: ID_CLOSE, receiptToken: 'b1c2d3e4f5061728', receiptLinkAt: base.at, reminders: [{ at: AT(11) }] }]),
    project('prj_again', '已经收口过的', [{ ...base, id: ID_AGAIN, waitClosedAt: AT(13) }]),
    project('prj_reopen', '收口之后又改回继续等', [{ ...base, id: ID_REOPEN, waitClosedAt: AT(13), receiptToken: 'c1c2c3c4c5061728', receiptLinkAt: base.at }]),
    project('prj_receipt', '收口之后他还是把收据贴回来了', [
      { ...base, id: ID_RECEIPT, receipt: { state: 'match', at: AT(14), via: 'link', count: 1 } },
    ]),
    project('prj_nopkg', '升级前那一条没有包', [{ version: 2, at: AT(9) }]),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const store = await import('../server/projects.mjs')
const { ledgerRows, deliveryLedger, ledgerPeople } = await import('../server/delivery-ledger.mjs')
const wait = await import('../src/domain/delivery-wait.ts')
const peopleDomain = await import('../src/domain/delivery-people.ts')

const readJson = () => JSON.parse(fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8'))

test('收口只记一个时间：包、回执链接、催过几次都不动', async () => {
  const before = readJson()[0].deliveries[0]
  const saved = await store.saveDeliveryWaitClose('prj_close', ID_CLOSE, true)
  assert.equal(saved.closed, true)
  assert.equal(saved.changed, true)
  assert.ok(Number.isFinite(Date.parse(saved.at)), '返回的收口时间读得出来')
  const after = readJson()[0].deliveries[0]
  assert.equal(after.waitClosedAt, saved.at)
  assert.deepEqual(after.package, before.package, '包一个字节都没动')
  assert.equal(after.receiptToken, before.receiptToken, '回执链接还是那一条')
  assert.deepEqual(after.reminders, before.reminders, '催过几次不动：收口的是「等」，不是把账擦掉')
  assert.equal(after.receipt, undefined, '本来就没回执，收口也不造一张')
})

test('再收口一次不写盘：收口是一个时刻，不是可以来回刷新的状态', async () => {
  const raw = fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
  const saved = await store.saveDeliveryWaitClose('prj_again', ID_AGAIN, true)
  assert.equal(saved.closed, true)
  assert.equal(saved.unchanged, true)
  assert.equal(saved.at, AT(13))
  assert.equal(fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8'), raw, '字节没变')
})

test('点错了能继续等：字段真的消失，回到可催的样子', async () => {
  const saved = await store.saveDeliveryWaitClose('prj_reopen', ID_REOPEN, false)
  assert.equal(saved.closed, false)
  assert.equal(saved.changed, true)
  const after = readJson()[2].deliveries[0]
  assert.equal('waitClosedAt' in after, false, '不是写成空串，是这一项没了')
  const row = ledgerRows({ projects: readJson() }).find((item) => item.deliveryId === ID_REOPEN)
  assert.equal(row.waitClosed, null)
  assert.equal(row.remindable, true, '还在等的一份照样能催')
})

test('已经有回执的不给收口：等的事已经结束', async () => {
  const saved = await store.saveDeliveryWaitClose('prj_receipt', ID_RECEIPT, true)
  assert.equal(saved.already, true)
  const after = readJson()[3].deliveries[0]
  assert.equal('waitClosedAt' in after, false)
})

test('没有封存包 / 没有这一条：照实退回 null', async () => {
  assert.equal(await store.saveDeliveryWaitClose('prj_nopkg', ID_NOPKG, true), null)
  assert.equal(await store.saveDeliveryWaitClose('prj_close', 'ff00ff00ff000001', true), null)
  assert.equal(await store.saveDeliveryWaitClose('prj_missing', ID_CLOSE, true), null)
})

test('收口之后这一行不再给催收动作，清单上单算一条', () => {
  const rows = ledgerRows({ projects: readJson() })
  const closed = rows.find((row) => row.deliveryId === ID_CLOSE)
  assert.deepEqual(closed.waitClosed, { at: closed.waitClosed.at })
  assert.ok(closed.waitClosed.at, '收口时间读得出来')
  assert.equal(closed.remindable, false, '不催了')
  assert.equal(closed.resendable, false, '不再发一次')
  assert.equal(closed.relinkable, false, '不再换地址')
  assert.equal(closed.relinkCapped, false, '也不劝他换渠道问')
  const again = rows.find((row) => row.deliveryId === ID_AGAIN)
  assert.equal(again.remindable, false, '盘上已经收口的那条同样不给催')

  const ledger = deliveryLedger({ projects: readJson() }, { now: Date.parse(AT(15)) })
  // 四条封过包的：两条收口、一条回执对上、一条已撤销收口（没有包的那条不算封过包）
  assert.equal(ledger.receipts.sealed, 4)
  assert.equal(ledger.receipts.matched, 1, '贴上来的那一张照常算对上')
  assert.equal(ledger.receipts.pending, 1, '真正还在等的只有撤销收口的那一条')
  assert.equal(ledger.receipts.waitClosed, 2, '两条收口了')
  assert.equal(
    ledger.receipts.sealed,
    ledger.receipts.matched + ledger.receipts.mismatched + ledger.receipts.unclear + ledger.receipts.pending + ledger.receipts.waitClosed,
    'sealed 仍然等于这几项之和',
  )
})

test('按人看：收口的不算欠着，也不能被说成「回执都回来了」', () => {
  const rows = ledgerRows({ projects: readJson() })
  // 这几条都写给王老师：两条收口、一条撤销收口、一条收口之后回了、一条... 没有包的不算
  const list = ledgerPeople(rows)
  const wang = list.find((person) => person.name === '王老师 · 内容组')
  assert.ok(wang, '王老师这一堆在')
  assert.equal(wang.count, 4)
  assert.equal(wang.closed, 2, '两条收口了')
  assert.equal(wang.pending, 1, '只把还在等的那一条算成欠着')
  assert.match(peopleDomain.personSummary(wang), /1 条还欠着/)
  assert.match(peopleDomain.personSummary(wang), /2 条不再等/)
  assert.doesNotMatch(peopleDomain.personSummary(wang), /回执都回来了/)
  assert.match(peopleDomain.personTitle(wang), /1 条还欠着回执/)
  assert.doesNotMatch(peopleDomain.personTitle(wang), /他没验/)

  // 全都收口的人：一条不能算「回执都回来了」
  const onlyClosed = ledgerPeople(rows.filter((row) => row.deliveryId === ID_AGAIN || row.deliveryId === ID_CLOSE))
  const group = onlyClosed.find((person) => person.name === '王老师 · 内容组')
  assert.equal(group.pending, 0)
  assert.equal(group.closed, 2)
  assert.doesNotMatch(peopleDomain.personSummary(group), /回执都回来了/)
  assert.match(peopleDomain.personSummary(group), /2 条不再等/)
  assert.match(peopleDomain.personTitle(group), /你已经不再等回执/)
})

test('那一行与清单顶上怎么说：只写「你不再等」，不写「他没验」', () => {
  assert.equal(wait.deliveryWaitClosedLead(), '已不再等回执')
  const hint = wait.deliveryWaitClosedHint('2026-11-16T02:00:00.000Z')
  assert.match(hint, /11-16 你自己把这一份收口了/)
  assert.match(hint, /不再等它的回执/)
  assert.match(hint, /他之后要是把收据贴回来，照样记在这一条上/)
  assert.doesNotMatch(hint, /他没验|没收到|催过/)
  assert.equal(wait.deliveryWaitClosedTotalText(2), '另有 2 次你已经不再等回执了。')
  assert.equal(wait.deliveryWaitClosedTotalText(0), '')
  // 时间读不出来就不编一个日期出来
  assert.match(wait.deliveryWaitClosedHint(''), /^你自己把这一份收口了：/)
})

test('工作台行尾那一枚：收口与继续等，两个入口说同一句话（v0.9.159）', () => {
  // 一枚按钮只有两种状态；两处入口（工作台行尾、作品页档案）共用它，改一处两处一起改
  assert.equal(wait.deliveryWaitToggleLabel(false), '不再等这一份')
  assert.equal(wait.deliveryWaitToggleLabel(true), '继续等')

  const closeHint = wait.deliveryWaitToggleHint(false)
  assert.match(closeHint, /客户口头说过了、当面看过、或者这版本来就作废了/, '先说清什么时候该收口')
  assert.match(closeHint, /只记「你不再等了」/, '收口记的是发件人的决定')
  assert.match(closeHint, /不改包、不改收据，也不动催过几次那些数/, '别让人以为收口会把账擦掉')
  assert.match(closeHint, /照样记在这一条上/, '之后他贴回来照样算')
  assert.doesNotMatch(closeHint, /他没验/, '不替对方记「他没验」')

  const reopenHint = wait.deliveryWaitToggleHint(true)
  assert.match(reopenHint, /撤回收口：这一份回到「还没收到回执」，工作台重新把它算进待办/)
  assert.match(reopenHint, /催过几次、打开过几次都还在/, '撤回也不清账')
})
