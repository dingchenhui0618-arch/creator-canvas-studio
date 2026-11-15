import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 催一句（v0.9.144）：收包人一直没贴回执时，发件人在工作台那一行点一下——
// 档案里记下这一次，并把回执链接还回来拼成一段能直接发的话。
// 这组盯六件事：
//   1) 写的是「催过」这件事（次数 + 最近一次时间），不存发出去的原文；
//   2) 包、交付时间、回执一个字不动——催不是改交付；
//   3) 已经贴过回执的不催（那不是「还没回来」），没有回执链接的也不催（没地方贴收据）；
//   4) 最多留 5 条，越界的丢掉最旧的；
//   5) 盘上的坏数据（字符串、空时间）不读成一次催；
//   6) 那段话只写档案里记着的事实：哪一版、哪个包、多少字节、哪天发的、链接在哪。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-remind-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-remind'

const SHA = 'd1e2f3' + 'a'.repeat(58)
const ZIP = 'VisionQA-提醒验收-第-2-版-v2-20261112.zip'
const BYTES = 277725
const TOKEN = '0123456789abcdef'

const pkg = { bytes: BYTES, sha256: SHA, fileName: ZIP, savedAt: '2026-11-12T08:00:00.000Z' }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    {
      id: 'prj_wait',
      ownerId: 'u_a',
      title: '提醒验收',
      flowId: 'flow_a',
      version: 2,
      versions: [],
      status: 'done',
      deliveries: [
        {
          version: 2,
          at: '2026-11-12T08:00:00.000Z',
          id: 'aaaaaaaaaaaaaaaa',
          package: pkg,
          receiptToken: TOKEN,
          reminders: [{ at: '2026-11-14T08:00:00.000Z' }],
        },
      ],
      createdAt: '2026-11-12T05:00:00.000Z',
      updatedAt: '2026-11-12T08:00:00.000Z',
    },
    {
      id: 'prj_done',
      ownerId: 'u_a',
      title: '已经贴过回执',
      flowId: 'flow_b',
      version: 1,
      versions: [],
      status: 'done',
      deliveries: [
        {
          version: 1,
          at: '2026-11-11T08:00:00.000Z',
          id: 'bbbbbbbbbbbbbbbb',
          package: pkg,
          receiptToken: 'fedcba9876543210',
          receipt: { at: '2026-11-11T09:00:00.000Z', state: 'mismatch', via: 'link' },
        },
      ],
      createdAt: '2026-11-11T05:00:00.000Z',
      updatedAt: '2026-11-11T08:00:00.000Z',
    },
    {
      id: 'prj_nolink',
      ownerId: 'u_a',
      title: '回执链接还没生成',
      flowId: 'flow_c',
      version: 1,
      versions: [],
      status: 'done',
      deliveries: [{ version: 1, at: '2026-11-10T08:00:00.000Z', id: 'cccccccccccccccc', package: pkg }],
      createdAt: '2026-11-10T05:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
    },
    {
      id: 'prj_legacy',
      ownerId: 'u_a',
      title: '没有封存包的老记录',
      flowId: 'flow_d',
      version: 1,
      versions: [],
      status: 'done',
      deliveries: [{ version: 1, at: '2026-11-09T08:00:00.000Z' }],
      createdAt: '2026-11-09T05:00:00.000Z',
      updatedAt: '2026-11-09T08:00:00.000Z',
    },
    {
      id: 'prj_dirty',
      ownerId: 'u_a',
      title: '盘上有坏数据',
      flowId: 'flow_e',
      version: 1,
      versions: [],
      status: 'done',
      deliveries: [
        {
          version: 1,
          at: '2026-11-08T08:00:00.000Z',
          id: 'dddddddddddddddd',
          package: pkg,
          receiptToken: TOKEN,
          // 字符串、空时间、坏形状：都不该读成一次「催过」
          reminders: ['2026-11-09T08:00:00.000Z', { at: '' }, { at: 42 }, null, { at: '2026-11-09T09:00:00.000Z' }],
        },
      ],
      createdAt: '2026-11-08T05:00:00.000Z',
      updatedAt: '2026-11-08T08:00:00.000Z',
    },
  ]),
  'utf8',
)

const store = await import('../server/projects.mjs')
const { deliveryReminderText, deliveryWaitDays, deliveryWaitLate, deliveryWaitText } = await import(
  '../src/domain/delivery-wait.ts'
)

const deliveryOf = async (id, deliveryId) => {
  const project = await store.getProject(id)
  return (project?.deliveries || []).find((entry) => entry.id === deliveryId) || null
}

test('催一次：记下这一次、把链接还回来，包与交付时间一个字不动', async () => {
  const before = await deliveryOf('prj_wait', 'aaaaaaaaaaaaaaaa')
  const saved = await store.saveDeliveryReminder('prj_wait', 'aaaaaaaaaaaaaaaa')
  assert.ok(saved)
  assert.equal(saved.already, false)
  assert.equal(Boolean(saved.missingLink), false)
  assert.equal(saved.token, TOKEN, '回执链接还的是在用的那一枚')
  assert.match(saved.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(saved.count, 2, '原来催过一次，这一次是第二次')

  const after = await deliveryOf('prj_wait', 'aaaaaaaaaaaaaaaa')
  assert.equal(after.reminders.length, 2)
  assert.equal(after.reminders[1].at, saved.at, '最近一次就是刚写的这一次')
  assert.deepEqual(after.package, before.package, '催不改封存的包')
  assert.equal(after.at, before.at, '催不改交付时间')
  assert.equal(after.receipt, undefined, '还没贴过回执，不能凭空写一条')
})

test('催到第六次：只留最近 5 条', async () => {
  for (let round = 0; round < 5; round += 1) {
    const saved = await store.saveDeliveryReminder('prj_wait', 'aaaaaaaaaaaaaaaa')
    assert.ok(saved)
    assert.ok(saved.count <= 5)
  }
  const after = await deliveryOf('prj_wait', 'aaaaaaaaaaaaaaaa')
  assert.equal(after.reminders.length, 5, '留 5 条就够说明催过几次，不无限长')
})

test('已经贴过回执的不催：不写一条新的记录', async () => {
  const before = await deliveryOf('prj_done', 'bbbbbbbbbbbbbbbb')
  const saved = await store.saveDeliveryReminder('prj_done', 'bbbbbbbbbbbbbbbb')
  assert.equal(saved.already, true)
  assert.equal(saved.token, undefined, '已经验完的不把链接再还一遍')
  const after = await deliveryOf('prj_done', 'bbbbbbbbbbbbbbbb')
  assert.equal(after.reminders, undefined, '不该多出一次催')
  assert.deepEqual(after.receipt, before.receipt)
})

test('没有回执链接的不催：没有地方贴收据，催了也没用', async () => {
  const saved = await store.saveDeliveryReminder('prj_nolink', 'cccccccccccccccc')
  assert.equal(saved.missingLink, true)
  const after = await deliveryOf('prj_nolink', 'cccccccccccccccc')
  assert.equal(after.reminders, undefined)
})

test('作品、交付记录不存在，或者这一条没有封存包：什么都不写', async () => {
  assert.equal(await store.saveDeliveryReminder('prj_missing', 'aaaaaaaaaaaaaaaa'), null)
  assert.equal(await store.saveDeliveryReminder('prj_wait', '0000000000000000'), null)
  assert.equal(await store.saveDeliveryReminder('prj_legacy', 'aaaaaaaaaaaaaaaa'), null)
})

test('盘上的坏数据不读成一次催：字符串算时间，空时间与坏形状丢掉', async () => {
  const delivery = await deliveryOf('prj_dirty', 'dddddddddddddddd')
  assert.equal(delivery.reminders.length, 2, '一条字符串时间 + 一条好的对象')
  assert.equal(delivery.reminders[0].at, '2026-11-09T08:00:00.000Z')
  assert.equal(delivery.reminders[1].at, '2026-11-09T09:00:00.000Z')
})

test('提醒那段话：哪一版、哪个包、多少字节、哪天发的、收据贴回哪条链接', () => {
  const link = 'https://visionqa.example.com/#/receipt/' + TOKEN
  const text = deliveryReminderText({
    title: '提醒验收',
    version: 2,
    fileName: ZIP,
    bytes: BYTES,
    at: '2026-11-12T08:00:00.000Z',
    link,
  })
  for (const must of ['提醒验收', '第 v2 版', ZIP, '277,725 B', '校验.html', '收据', link, '拖进去']) {
    assert.equal(text.includes(must), true, '该提到「' + must + '」')
  }
  // 日期按交付时间写月日（只看形状，具体哪一天由时区定）
  assert.match(text, /我 \d{2}-\d{2} 发你的/)
  assert.equal(text.endsWith('我就行。'), true)
  assert.equal(text.length <= 320, true, '发到微信里一段话，不该是一屏')
  assert.equal(/undefined|null|NaN|\[object/.test(text), false)
  // 不承诺、不编原因：只说「哪一项不一样告诉我」，不替发件人答应重发或赔偿
  assert.equal(/重发|赔|保证|一定|已经处理/.test(text), false)
})

test('交付时间没记下 / 没有回执链接时，那段话也不编', () => {
  const noAt = deliveryReminderText({ title: '提醒验收', version: 1, fileName: ZIP, bytes: BYTES, at: '', link: 'https://x/#/receipt/abc' })
  assert.equal(noAt.includes('我上次发你的'), true)
  assert.equal(/我 \d{2}-\d{2} 发你的/.test(noAt), false)

  const noLink = deliveryReminderText({ title: '提醒验收', version: 1, fileName: ZIP, bytes: BYTES, at: '', link: '' })
  assert.equal(noLink.includes('把收据发我就行。'), true)
  assert.equal(noLink.includes('贴回这条链接'), false, '没有链接就别让人去找链接')

  // 什么都缺：仍然说得出是哪一份（作品名 + 版次），不出现空括号
  const bare = deliveryReminderText({ title: '', version: 0, link: '' })
  assert.equal(bare.includes('这份包那份包'), false)
  assert.equal(/（）/.test(bare), false)
  assert.equal(/undefined|null/.test(bare), false)
})

test('天数：当天说今天，之后按整天数，读不出时间就什么都不说', () => {
  const at = '2026-11-12T08:00:00.000Z'
  assert.equal(deliveryWaitDays(at, Date.parse('2026-11-12T23:00:00.000Z')), 0)
  assert.equal(deliveryWaitDays(at, Date.parse('2026-11-13T09:00:00.000Z')), 1)
  assert.equal(deliveryWaitText(at, Date.parse('2026-11-12T23:00:00.000Z')), '今天发出')
  assert.equal(deliveryWaitText(at, Date.parse('2026-11-16T09:00:00.000Z')), '发出 4 天')
  assert.equal(deliveryWaitDays('', Date.now()), null)
  assert.equal(deliveryWaitText('不是时间', Date.now()), '')
  // 时钟往回走（机器时间被调过）不出现负数天
  assert.equal(deliveryWaitDays(at, Date.parse('2026-11-01T00:00:00.000Z')), 0)
  assert.equal(deliveryWaitLate(at, Date.parse('2026-11-14T09:00:00.000Z')), false)
  assert.equal(deliveryWaitLate(at, Date.parse('2026-11-15T09:00:00.000Z')), true, '第三天起算该提一句')
})
