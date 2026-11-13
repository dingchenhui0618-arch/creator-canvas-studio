import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 成本页的数字不是装修：定价、配额、单位经济都从这里出，所以这组测试盯四件事：
//   1) 每次调用都留下一条真事件（token / 张数 / 秒数口径分得清）；
//   2) 金额只由「管理员填的单价 × 真实用量」折算，没填单价就是 0，不编数字；
//   3) 失败事件不折算成本，但次数要看得见；
//   4) 历史回填只补次数、不进金额，并且只跑一次。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-usage-'))
process.env.DATA_DIR = dir

const usage = await import('../server/usage-meter.mjs')
const auth = await import('../server/auth.mjs')
const { config } = await import('../server/config.mjs')

usage.resetUsageMeter()

const HOUR = 3600 * 1000

test('真实调用落事件：token / 张数 / 秒数各有各的口径', () => {
  usage.recordUsage({ kind: 'text', model: 'deepseek-flash', ref: 'agent:1', tokensIn: 1200, tokensOut: 300 })
  usage.recordUsage({ kind: 'vision', model: 'deepseek-flash', projectId: 'prj_1', ref: 'project:prj_1', tokensIn: 4800, tokensOut: 900 })
  usage.recordUsage({ kind: 'judge', model: 'jev-latest', projectId: 'prj_1', ref: 'project:prj_1', tokensKnown: false })
  const events = usage.usageEvents({ limit: 10 })
  assert.equal(events.length, 3)
  const vision = events.find((item) => item.kind === 'vision')
  assert.equal(vision.tokensIn, 4800)
  assert.equal(vision.unit, 'token')
  assert.equal(vision.projectId, 'prj_1')
  const judge = events.find((item) => item.kind === 'judge')
  assert.equal(judge.tokensKnown, false, '上游没给 usage 时要标未知，不能写着 0 token 当成真的')
})

test('出图按张、出视频按秒；失败不记张数也不折算成本', () => {
  usage.recordUsage({ kind: 'image', model: 'image-2-pro', ref: 'vq-1', units: 2 })
  usage.recordUsage({ kind: 'video', model: 'seedance', ref: 'task_1', units: 5 })
  usage.recordUsage({ kind: 'image', model: 'image-2-pro', ref: 'vq-2', ok: false, detail: '失败' })
  const events = usage.usageEvents({ limit: 20 })
  const image = events.filter((item) => item.kind === 'image' && item.ok)
  assert.equal(image[0].units, 2)
  assert.equal(image[0].unit, 'image')
  const video = events.find((item) => item.kind === 'video')
  assert.equal(video.units, 5)
  assert.equal(video.unit, 'second')
  const failed = events.find((item) => item.kind === 'image' && !item.ok)
  assert.equal(failed.units, 0)
})

test('单价没填不折算金额；填了只按单价 × 真实用量算，且回填不计入', () => {
  const before = usage.usageSummary({ days: 7 })
  assert.equal(before.priced, false)
  assert.equal(before.totals.estCostMilli, 0)

  const saved = usage.saveUsagePrices(
    { inPerMillion: 2, outPerMillion: 4, imagePerShot: 0.5, videoPerSecond: 0.2, judgePerCall: 0.1 },
    { by: 'admin@example.com' },
  )
  assert.equal(saved.ok, true)
  assert.equal(saved.updatedBy, 'admin@example.com')

  const summary = usage.usageSummary({ days: 7 })
  assert.equal(summary.priced, true)
  // 窗口里到这步为止的真实事件：
  //   text 1200 in + 300 out；vision 4800 in + 900 out；judge 1 次；image 2 张；video 5 秒；失败 1 条
  const tokensIn = 1200 + 4800
  const tokensOut = 300 + 900
  const expected =
    Math.round(((tokensIn / 1e6) * 2 + (tokensOut / 1e6) * 4) * 1000) +
    Math.round(0.1 * 1000) +
    Math.round(2 * 0.5 * 1000) +
    Math.round(5 * 0.2 * 1000)
  assert.equal(summary.totals.estCostMilli, expected)
  assert.equal(summary.totals.images, 2, '失败的出图不能算成 2 张')
  assert.equal(summary.totals.videoSeconds, 5)
  assert.equal(summary.totals.failedCalls, 1)
  const kinds = summary.byKind.map((item) => item.kind)
  assert.deepEqual(kinds, ['text', 'vision', 'judge', 'image', 'video'])
})

test('单价校验：负数与被篡改的键都不落地', () => {
  const bad = usage.saveUsagePrices({ inPerMillion: -1 }, { by: 'admin@example.com' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /单价/)
  const current = usage.usagePrices().prices
  assert.equal(current.inPerMillion, 2, '被拒的保存不能改掉原值')

  usage.saveUsagePrices({ unknown: 9 }, { by: 'admin@example.com' })
  assert.equal(usage.usagePrices().prices.unknown, undefined)
  const file = path.join(config.dataDir, 'usage-prices.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['currency', 'prices', 'updatedAt', 'updatedBy'])
})

test('按天分桶与窗口外的事件：只统计窗口内的，天数是满窗口', () => {
  const now = Date.now()
  usage.recordUsage({ kind: 'text', model: 'old-model', tokensIn: 1, tokensOut: 1, at: now - 30 * 24 * HOUR })
  const summary = usage.usageSummary({ days: 7, now })
  assert.equal(summary.byDay.length, 7)
  assert.equal(summary.byDay.at(-1).day, new Date(now).toISOString().slice(0, 10))
  const models = summary.byModel.map((item) => item.model)
  assert.ok(!models.includes('old-model'), '30 天前的调用不能算进 7 天窗口')
})

test('历史回填：按积分流水补次数，只跑一次，且不折算金额', () => {
  usage.resetUsageMeter()
  const db = auth.openDb()
  db.prepare(
    'INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('cl_backfill_1', 'u_test', -5, 95, 'review', '旧评审', null, new Date(Date.now() - 2 * HOUR).toISOString())
  db.prepare(
    'INSERT INTO credit_ledger (id, user_id, delta, balance_after, kind, ref, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('cl_backfill_2', 'u_test', 5, 100, 'review-refund', '评审退款', null, new Date(Date.now() - HOUR).toISOString())

  usage.saveUsagePrices({ inPerMillion: 2, outPerMillion: 4, judgePerCall: 0.1, imagePerShot: 1 }, { by: 'admin@example.com' })
  const first = usage.usageSummary({ days: 7 })
  assert.equal(first.backfill.count, 1, '退款流水不能补成一次调用')
  assert.equal(first.totals.calls, 1)
  assert.equal(first.totals.estCostMilli, 0, '回填条目没有 token，不能折算成金额')
  const second = usage.usageSummary({ days: 7 })
  assert.equal(second.totals.calls, 1, '回填只跑一次，重复取汇总不能越补越多')
})
