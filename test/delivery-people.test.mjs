import test from 'node:test'
import assert from 'node:assert/strict'

// 按人看（v0.9.154）。
// 工作台那一列一行一行排下来，问的都是「哪一条还没回来」；交给同一个人三四条时，
// 真正想问的是「王老师那边还欠几份」。这一组盯五件事：
//   1) 同一个人名下几条交付、几条还欠着回执（欠着 = 有包、还没收据；他点了「收到了」的也算欠着）；
//   2) 没有封存包的老交付照样算「几条交付」，但不算「欠着」，也不把一个人说成「回执都回来了」；
//   3) 点一个人落在哪一条：优先他还欠着的那条里最近交付的一条；都回来了落在最近交付的那条；
//   4) 没写收件人的只给一个数，不猜是谁，也不混进任何一个人名下；排序先看欠着几条；
//   5) 这是整份记录的账：分页取第几页都不影响这几个数；
//   6) 欠着几条还不算急：欠着的那几条里最早一条等了几天、这个人名下催过几次（v0.9.155）；
//   7) 同样欠两条，等得久的排前面；时间没记下的老记录不编天数，排在知道的后头。

const { ledgerPeople, deliveryLedger } = await import('../server/delivery-ledger.mjs')
const people = await import('../src/domain/delivery-people.ts')

const AT = (day) => '2026-11-' + String(day).padStart(2, '0') + 'T06:00:00.000Z'
const pkg = { bytes: 123456, sha256: 'a'.repeat(64), fileName: 'x.zip', savedAt: AT(9) }
const receiptMatch = { state: 'match', at: AT(11), via: 'link', count: 1 }

function project(id, title, deliveries, version = 3) {
  return { id, title, version, deliveries, ownerId: 'u_a', createdAt: AT(1), updatedAt: AT(14) }
}

const projects = [
  project('prj_a', '秋季上新的那条片子', [
    // 王老师：一条对上了、一条他说收到了还没验、一条还没回来（最近交的那条）
    { id: 'aaaa000000000001', version: 3, at: AT(10), recipient: '王老师 · 内容组', package: pkg, receipt: receiptMatch },
    { id: 'aaaa000000000002', version: 4, at: AT(12), recipient: '王老师 · 内容组', package: pkg, ack: { at: AT(12) }, reminders: [{ at: AT(13) }, { at: AT(14) }] },
    { id: 'aaaa000000000003', version: 5, at: AT(14), recipient: '王老师 · 内容组', package: pkg },
  ]),
  project('prj_b', '第二支短片', [
    // 李工：一条还欠着（11-11），一条已经对上了（11-13，比欠着的那条更新）
    { id: 'bbbb000000000001', version: 1, at: AT(11), recipient: '李工', package: pkg },
    { id: 'bbbb000000000002', version: 2, at: AT(13), recipient: '李工', package: pkg, receipt: receiptMatch },
  ]),
  project('prj_c', '给赵工的那份', [
    // 赵工：就一条，回执已经回来
    { id: 'cccc000000000001', version: 1, at: AT(7), recipient: '赵工', package: pkg, receipt: receiptMatch },
  ]),
  project('prj_d', '没写收件人的两条', [
    { id: 'dddd000000000001', version: 1, at: AT(9), package: pkg, receipt: receiptMatch },
    { id: 'dddd000000000002', version: 2, at: AT(8) },
  ]),
]

test('同一个人名下：几条交付、几条还欠着（他点了「收到了」的也算欠着）', () => {
  const list = ledgerPeople(
    ledgerPayload().rows,
  )
  const wang = list.find((person) => person.name === '王老师 · 内容组')
  assert.equal(wang.count, 3)
  assert.equal(wang.sealed, 3)
  assert.equal(wang.pending, 2, '对上的那条不再催')
  assert.equal(wang.pendingAcked, 1, '其中一条他自己点了「收到了」')
  const li = list.find((person) => person.name === '李工')
  assert.equal(li.count, 2)
  assert.equal(li.sealed, 2)
  assert.equal(li.pending, 1, '对上的那条不再催')
  const zhao = list.find((person) => person.name === '赵工')
  assert.equal(zhao.pending, 0)
  assert.equal(zhao.sealed, 1)
})

// 这一组用交付流水的同一套行来验：数字必须和界面上真正排出来的行对得上
function ledgerPayload() {
  const ledger = deliveryLedger({ projects })
  return { ledger, rows: ledger.items }
}

test('点一个人落在哪一条：优先欠着的那条里最近交的；都回来了落在最近那条', () => {
  const ledger = deliveryLedger({ projects })
  const wang = ledger.people.find((person) => person.name === '王老师 · 内容组')
  assert.deepEqual(wang.target, { projectId: 'prj_a', deliveryId: 'aaaa000000000003', version: 5 })
  const li = ledger.people.find((person) => person.name === '李工')
  assert.deepEqual(li.target, { projectId: 'prj_b', deliveryId: 'bbbb000000000001', version: 1 }, '落在他还欠着的那条上，不是最新那条')
  const zhao = ledger.people.find((person) => person.name === '赵工')
  assert.equal(zhao.target.projectId, 'prj_c')
  assert.equal(zhao.target.version, 1, '都回来了就落在最近交付的那条')
})

test('排序：先看欠着几条，再看总条数；没写收件人的只给一个数', () => {
  const ledger = deliveryLedger({ projects })
  assert.deepEqual(ledger.people.map((person) => person.name), ['王老师 · 内容组', '李工', '赵工'])
  assert.equal(ledger.unlabeled, 2, '两条没写收件人：一条封过包、一条老交付')
})

test('这是整份记录的账：分页取第几页都不影响这几个数', () => {
  const first = deliveryLedger({ projects }, { limit: 2 })
  const later = deliveryLedger({ projects }, { offset: 4, limit: 2 })
  assert.notDeepEqual(first.items.map((row) => row.projectId + ':' + row.version), later.items.map((row) => row.projectId + ':' + row.version), '两页的行确实不一样')
  assert.deepEqual(first.people, later.people)
  assert.equal(first.unlabeled, later.unlabeled)
})

test('一个人都没写收件人：people 是空数组，全部算进没写的那一个数', () => {
  const ledger = deliveryLedger({ projects: [project('prj_x', '只有老交付', [{ id: 'eeee000000000001', version: 1, at: AT(8) }])] })
  assert.deepEqual(ledger.people, [])
  assert.equal(ledger.unlabeled, 1)
})

test('界面上的说法：欠着几条、都回来了、没有封存包，三种不一样', () => {
  assert.equal(people.personSummary({ count: 3, sealed: 3, pending: 2 }), '3 条 · 2 条还欠着')
  assert.equal(people.personSummary({ count: 3, sealed: 3, pending: 0 }), '3 条 · 回执都回来了')
  assert.equal(people.personSummary({ count: 1, sealed: 0, pending: 0 }), '1 条 · 没有封存包')
  assert.equal(people.personSummary(null), '')
  const title = people.personTitle({ count: 3, sealed: 3, pending: 2, pendingAcked: 1, name: '王老师 · 内容组' })
  assert.match(title, /^王老师 · 内容组：3 条交付，2 条还欠着回执/)
  assert.match(title, /其中 1 条他自己点了「收到了」/)
  assert.match(title, /点一下打开/)
  assert.match(people.personTitle({ count: 1, sealed: 1, pending: 0, name: '赵工' }), /回执都回来了/)
  assert.match(people.personTitle({ count: 2, sealed: 1, pending: 0, name: '李工' }), /其中 1 条封过包/)
  assert.equal(people.personTitle(null), '')
  assert.equal(people.peopleLeadText([{ pending: 2 }, { pending: 1 }, { pending: 0 }]), '按人看：3 个人，其中 2 个还欠着回执')
  assert.equal(people.peopleLeadText([{ pending: 0 }, { pending: 0 }]), '按人看：2 个人，回执都回来了')
  assert.equal(people.peopleLeadText([]), '')
  assert.equal(people.unlabeledText(2), '另有 2 条没写收件人')
  assert.equal(people.unlabeledText(0), '')
  assert.equal(people.personAckedNote({ pendingAcked: 2 }), '其中 2 条他自己点了「收到了」')
  assert.equal(people.personAckedNote({ pendingAcked: 0 }), '')
})
test('等得最久的那一条：只认记着时间的记录，催过几次按人加总', () => {
  const ledger = deliveryLedger({ projects })
  const wang = ledger.people.find((person) => person.name === '王老师 · 内容组')
  assert.equal(wang.oldestPendingAt, AT(12), '欠着的两条是 11-12 和 11-14，最早是 11-12')
  assert.deepEqual(wang.reminded, { count: 2, at: AT(14) }, '催过两次，最近一次 11-14')
  const li = ledger.people.find((person) => person.name === '李工')
  assert.equal(li.oldestPendingAt, AT(11), '李工欠着的那条 11-11 发的')
  assert.equal(li.reminded, null, '没催过就是 null，不写成「催过 0 次」')
  const zhao = ledger.people.find((person) => person.name === '赵工')
  assert.equal(zhao.oldestPendingAt, '', '一条都不欠着就谈不上「等了多久」')
  assert.equal(zhao.reminded, null)
})

test('同样欠着一条：等得久的排前面，时间没记下的老记录排在知道的后头', () => {
  const pkgOnly = { bytes: 1024, sha256: 'b'.repeat(64), fileName: 'y.zip', savedAt: AT(2) }
  const projectsTie = [
    // 昨天刚发的那份：同样欠一条，但不该排在「拖了八天」的前面
    project('prj_fresh', '昨天刚发的那份', [{ id: '3333000000000001', version: 1, at: AT(15), recipient: 'B · 乙方', package: pkgOnly }]),
    project('prj_late', '拖了八天的那份', [{ id: '4444000000000001', version: 1, at: AT(2), recipient: 'A · 甲方', package: pkgOnly }]),
    // 升级前的老记录：没有时间，没人知道等了多久
    project('prj_old', '老记录没记时间', [{ id: '5555000000000001', version: 1, at: '', recipient: 'C · 丙方', package: pkgOnly }]),
  ]
  const ledger = deliveryLedger({ projects: projectsTie })
  assert.deepEqual(ledger.people.map((person) => person.name), ['A · 甲方', 'B · 乙方', 'C · 丙方'])
  const old = ledger.people.find((person) => person.name === 'C · 丙方')
  assert.equal(old.oldestPendingAt, '', '时间没记下就是空串，不拿今天冒充')
  assert.equal(old.pending, 1, '没有时间照样算欠着一条')
})

test('这一枚按钮上那句「等了多久」：欠着几条都不影响，只看最早一条', () => {
  const now = Date.parse(AT(16))
  assert.equal(people.personWaitText({ pending: 2, oldestPendingAt: AT(12) }, now), '最早一条 4 天没回')
  assert.equal(people.personWaitText({ pending: 1, oldestPendingAt: AT(16) }, now), '最早一条今天发出')
  assert.equal(people.personWaitText({ pending: 1, oldestPendingAt: '' }, now), '', '时间没记下就什么都不说')
  assert.equal(people.personWaitText({ pending: 0, oldestPendingAt: AT(12) }, now), '', '不欠着就不说「等了」')
  assert.equal(people.personWaitText(null, now), '')
  assert.equal(people.personNaggedText({ pending: 1, reminded: { count: 2, at: AT(14) } }), '催过 2 次，最近 11-14')
  assert.equal(people.personNaggedText({ pending: 1, reminded: null }), '还没催过')
  assert.equal(people.personNaggedText({ pending: 0, reminded: { count: 2, at: AT(14) } }), '', '都回来了就不用再说催过几次')
})

test('title 说清最早一条哪天发的、催过几次、点下去落在哪', () => {
  const now = Date.parse(AT(16))
  const title = people.personTitle(
    { name: '王老师 · 内容组', count: 3, sealed: 3, pending: 2, pendingAcked: 1, oldestPendingAt: AT(12), reminded: { count: 2, at: AT(14) } },
    now,
  )
  assert.match(title, /最早的一条是 11-12 发出的，已经 4 天没回/)
  assert.match(title, /催过 2 次，最近 11-14/)
  assert.match(title, /点一下打开/)
  const quiet = people.personTitle({ name: '赵工', count: 1, sealed: 1, pending: 1, oldestPendingAt: AT(16) }, now)
  assert.match(quiet, /最早的一条是今天发出的/)
  assert.match(quiet, /还没催过/)
  const unknown = people.personTitle({ name: '李工', count: 1, sealed: 1, pending: 1, oldestPendingAt: '', reminded: null }, now)
  assert.doesNotMatch(unknown, /没回|今天发出/, '时间没记下就不编天数')
})

test('顶上那句：最久的等了几天；今天刚发的不算「等了」，一条都不欠着就不加这一句', () => {
  const now = Date.parse(AT(16))
  assert.equal(
    people.peopleLeadText([{ pending: 2, oldestPendingAt: AT(12) }, { pending: 1, oldestPendingAt: AT(11) }, { pending: 0 }], now),
    '按人看：3 个人，其中 2 个还欠着回执；最久的等了 5 天',
  )
  assert.equal(people.peopleLeadText([{ pending: 1, oldestPendingAt: AT(16) }], now), '按人看：1 个人，其中 1 个还欠着回执')
  assert.equal(people.peopleLeadText([{ pending: 1, oldestPendingAt: '' }], now), '按人看：1 个人，其中 1 个还欠着回执')
})

test('分页不影响「等得最久」与「催过几次」这两个数', () => {
  const first = deliveryLedger({ projects }, { limit: 2 })
  const later = deliveryLedger({ projects }, { offset: 4, limit: 2 })
  assert.deepEqual(first.people, later.people)
})
