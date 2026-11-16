import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 收口之后又回来了（v0.9.160）。
//
// v0.9.158/159 让「不再等这一份」能在工作台上就地做完，可收口之后他真把收据贴回来时，
// 那一行只按回执显示——「你曾经决定不等了」凭空消失，看起来和一条普通回执没有区别。
// 这一组盯四件事：
//   1) 先后判断只认两个时间：回执晚于收口才算「又回来了」，相等 / 缺失 / 早于都不算；
//   2) 行上的短句与解释：收口当天不写「0 天」，解释里两件事都记着，不推断原因、不重算催过的账；
//   3) 清单数字：回来的算在回执那几项里，waitClosedReturned 只是其中几条，不进 sealed 等式；
//   4) 按人看：回来的那条算「回来了」，不再算「还欠着」，也不被写成「不再等」。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-wait-returned-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-wait-returned'

const AT = (day, hour = 6) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const pkg = { bytes: 345678, sha256: 'cd34ef56ab12' + 'c'.repeat(52), fileName: 'VisionQA-收口之后-第-3-版-v3-20261114.zip', savedAt: AT(10) }

const wait = await import('../src/domain/delivery-wait.ts')
const peopleDomain = await import('../src/domain/delivery-people.ts')
const { ledgerRows, deliveryLedger, ledgerPeople } = await import('../server/delivery-ledger.mjs')

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
    updatedAt: AT(15),
  }
}

const RET = 'cc11cc11cc110001'
const EQ = 'cc11cc11cc110002'
const BEFORE = 'cc11cc11cc110003'
const CLOSED = 'cc11cc11cc110004'

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    project('prj_returned', '收口之后他又把收据贴回来了', [
      {
        version: 3,
        at: AT(10),
        package: pkg,
        id: RET,
        recipient: '王老师 · 内容组',
        receiptToken: 'd1d2d3d4d5061728',
        receiptLinkAt: AT(10),
        reminders: [{ at: AT(11) }],
        waitClosedAt: AT(12),
        receipt: { state: 'match', at: AT(14), via: 'link', count: 1 },
      },
    ]),
    project('prj_same', '收口和回执同一刻', [
      {
        version: 1,
        at: AT(10),
        package: pkg,
        id: EQ,
        waitClosedAt: AT(12),
        receipt: { state: 'match', at: AT(12), via: 'link', count: 1 },
      },
    ]),
    project('prj_before', '回执比收口还早', [
      {
        version: 1,
        at: AT(10),
        package: pkg,
        id: BEFORE,
        waitClosedAt: AT(13),
        receipt: { state: 'mismatch', at: AT(11), via: 'you', count: 1, checks: [{ k: 'sha256', ok: false }] },
      },
    ]),
    project('prj_closed', '收口之后一直没回来', [
      { version: 1, at: AT(10), package: pkg, id: CLOSED, waitClosedAt: AT(13) },
    ]),
    project('prj_nopkg', '升级前那一条没有包', [{ version: 2, at: AT(9) }]),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const projects = () => JSON.parse(fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8'))

test('只认先后：回执晚于收口才算「又回来了」（v0.9.160）', () => {
  // 收口 11-12 早上，回执 11-14 早上：两天
  assert.equal(wait.deliveryWaitReturned(AT(14), AT(12)), true)
  assert.equal(wait.deliveryWaitReturnedText(AT(14), AT(12)), '收口 2 天后又回来了')
  // 同一天回来的不写「0 天」
  assert.equal(wait.deliveryWaitReturnedText('2026-11-12T10:00:00.000Z', AT(12)), '收口当天又回来了')
  // 相等不是「之后」：数据里分不清先后，就不编一段先后出来
  assert.equal(wait.deliveryWaitReturned(AT(12), AT(12)), false)
  assert.equal(wait.deliveryWaitReturnedText(AT(12), AT(12)), '')
  // 回执比收口还早：收口是后来才做的决定，不发生「收口之后又回来了」这件事
  assert.equal(wait.deliveryWaitReturned(AT(11), AT(13)), false)
  // 时间读不出来就什么都不说
  assert.equal(wait.deliveryWaitReturned('', AT(12)), false)
  assert.equal(wait.deliveryWaitReturned(AT(14), ''), false)
  assert.equal(wait.deliveryWaitReturnedText('', ''), '')
})

test('那句解释：两件事都记着，不推断原因、不重算催过的账', () => {
  const hint = wait.deliveryWaitReturnedHint(AT(14), AT(12))
  assert.match(hint, /^收口之后又回来了：/, '先说这是哪件事')
  assert.match(hint, /你 11-12 收口了这一份/, '收口那天要写出来')
  assert.match(hint, /11-14 他把收据贴了回来/, '回执哪天回来的也要写出来')
  assert.match(hint, /这一条现在按回执说话/, '回执是更有力的事实')
  assert.match(hint, /收口那件事仍记在档案里/, '收口那件事不因为回执回来而消失')
  assert.match(hint, /不因此推断他为什么回来/, '不猜原因')
  assert.match(hint, /也不重算催过的账/, '催过几次是发生过的事')
  assert.doesNotMatch(hint, /他没验/, '收口记的是你的决定，不是他的评价')
  // 没有「又回来了」这回事时，一句解释也不给
  assert.equal(wait.deliveryWaitReturnedHint(AT(12), AT(12)), '')

  assert.equal(wait.deliveryWaitReturnedTotalText(1), '其中 1 次是收口之后才回来的，按回执算。')
  assert.equal(wait.deliveryWaitReturnedTotalText(0), '')
  assert.equal(wait.deliveryWaitReturnedTotalText(-2), '')
})

test('清单数字：回来的算回执，waitClosedReturned 只是其中几条，不进 sealed 等式', () => {
  const rows = ledgerRows({ projects: projects() })
  const returned = rows.find((row) => row.deliveryId === RET)
  assert.deepEqual(returned.waitClosed, { at: returned.waitClosed.at })
  assert.equal(returned.receipt.state, 'match')
  assert.equal(returned.remindable, false, '有回执就不再催')
  assert.equal(returned.resendable, false, '也不再说「再发一次」')

  const ledger = deliveryLedger({ projects: projects() }, { now: Date.parse(AT(16)) })
  assert.equal(ledger.receipts.sealed, 4, '四条封过包：一条回来了、一条同一刻、一条回执更早、一条还在等')
  assert.equal(ledger.receipts.matched, 2, '回来的那两条按回执对上算')
  assert.equal(ledger.receipts.mismatched, 1)
  assert.equal(ledger.receipts.pending, 0, '没有一条还在等')
  assert.equal(ledger.receipts.waitClosed, 1, '还在收口状态的只有一直没回来的那条')
  assert.equal(ledger.receipts.waitClosedReturned, 1, '收口之后又回来的只有一条')
  assert.equal(
    ledger.receipts.sealed,
    ledger.receipts.matched + ledger.receipts.mismatched + ledger.receipts.unclear + ledger.receipts.pending + ledger.receipts.waitClosed,
    'sealed 仍然等于这几项之和：returned 不进这个等式',
  )
})

test('按人看：回来的那条算回来了，不再算欠着，也不写成「不再等」', () => {
  const rows = ledgerRows({ projects: projects() })
  const person = ledgerPeople(rows).find((item) => item.name === '王老师 · 内容组')
  assert.ok(person, '王老师这一堆在')
  assert.equal(person.count, 1)
  assert.equal(person.sealed, 1)
  assert.equal(person.pending, 0, '回执已经回来了，不再欠着')
  assert.equal(person.closed, 0, '回来的那条不是「还在收口」的那一条')
  assert.match(peopleDomain.personSummary(person), /回执都回来了/)
  assert.doesNotMatch(peopleDomain.personSummary(person), /不再等/)
  assert.doesNotMatch(peopleDomain.personTitle(person), /他没验/)
})
