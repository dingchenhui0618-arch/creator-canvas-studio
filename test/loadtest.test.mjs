// 压测脚本的判定与统计：这几条纯函数决定「这次压测算不算过」，所以要有单测。
// 重点不是 percentile 的边界，而是 evaluate：它必须能识别出「闸门放多了」「被拒的原因不对」
// 「进程死了 / 名额没还回来 / 主线程被打死」——否则压测跑完一律显示通过，等于没压。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, memoryPeak, parseArgs, percentile, summarizeStatuses, formatReport } from '../scripts/loadtest.mjs'

function summaryOf(overrides = {}) {
  return {
    arm: 'test',
    kind: 'review',
    n: 10,
    guard: 'on',
    upstreamMs: 4000,
    heapMb: 384,
    requests: { total: 10, accepted: 3, rejected: 7, byStatus: { 200: 3, 503: 7 }, byCode: { SERVER_BUSY: 7 }, durations: [] },
    jobs: [],
    jobsDone: 0,
    upstream: { calls: 3, peakConcurrent: 3, byPath: {} },
    memory: { peakTreeRssMb: 420, minAvailableMb: 500 },
    waterline: { levels: { ok: 20 }, maxActive: 3, limitSeen: [3] },
    health: { count: 20, p50: 3, p95: 12, max: 40, failures: 0 },
    aliveAfter: true,
    drainedActive: 0,
    observedLimit: 3,
    verdict: { ok: true, problems: [] },
    ...overrides,
  }
}

test('percentile 取的是排序后的位置，空数组给 0', () => {
  assert.equal(percentile([], 95), 0)
  assert.equal(percentile([10], 50), 10)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
  assert.equal(percentile([5, 1, 3], 100), 5)
})

test('状态码与拒绝原因分开统计', () => {
  const stats = summarizeStatuses([
    { status: 200 },
    { status: 200 },
    { status: 503, code: 'SERVER_BUSY' },
    { status: 503, code: 'SERVER_BUSY' },
    { status: 503, code: 'MEMORY_PRESSURE' },
    { status: 0, code: 'NETWORK' },
  ])
  assert.deepEqual(stats.byStatus, { '200': 2, '503': 3, 0: 1 })
  assert.deepEqual(stats.byCode, { SERVER_BUSY: 2, MEMORY_PRESSURE: 1, NETWORK: 1 })
})

test('读数缺失是 null，不是 0', () => {
  assert.equal(memoryPeak([{ rss: null }, { rss: undefined }], 'rss'), null)
  assert.equal(memoryPeak([{ rss: 120 }, { rss: null }, { rss: 300 }], 'rss'), 300)
})

test('闸门开着、只放进上限以内、拒绝原因是名额满：通过', () => {
  const verdict = evaluate({ summary: summaryOf(), guard: 'on', n: 10, cap: 3 })
  assert.equal(verdict.ok, true, verdict.problems.join('；'))
})

test('闸门开着却放进来超过上限的活：不通过', () => {
  const summary = summaryOf({ requests: { total: 10, accepted: 4, rejected: 6, byStatus: { 200: 4, 503: 6 }, byCode: { SERVER_BUSY: 6 }, durations: [] } })
  const verdict = evaluate({ summary, guard: 'on', n: 10, cap: 3 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('；'), /超过全站上限/)
})

test('被拒的原因不是名额满 / 水位红线：不通过', () => {
  const summary = summaryOf({ requests: { total: 10, accepted: 3, rejected: 7, byStatus: { 200: 3, 503: 7 }, byCode: { MODEL_UNAVAILABLE: 7 }, durations: [] } })
  const verdict = evaluate({ summary, guard: 'on', n: 10, cap: 3 })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('；'), /MODEL_UNAVAILABLE/)
})

test('闸门关掉时一个请求都不该被拒', () => {
  const ok = summaryOf({ requests: { total: 10, accepted: 10, rejected: 0, byStatus: { 200: 10 }, byCode: {}, durations: [] } })
  assert.equal(evaluate({ summary: ok, guard: 'off', n: 10, cap: 3 }).ok, true)
  const partial = summaryOf({ requests: { total: 10, accepted: 9, rejected: 1, byStatus: { 200: 9, 503: 1 }, byCode: { SERVER_BUSY: 1 }, durations: [] } })
  assert.equal(evaluate({ summary: partial, guard: 'off', n: 10, cap: 3 }).ok, false)
})

test('实例死掉 / 名额没还回 / 出现 500 / 主线程被打死：都算不通过', () => {
  assert.match(evaluate({ summary: summaryOf({ aliveAfter: false }), guard: 'on', n: 10, cap: 3 }).problems.join('；'), /实例已经不在了/)
  assert.match(evaluate({ summary: summaryOf({ drainedActive: 2 }), guard: 'on', n: 10, cap: 3 }).problems.join('；'), /名额没还回来/)
  const with500 = summaryOf({ requests: { total: 10, accepted: 3, rejected: 7, byStatus: { 200: 2, 500: 1, 503: 7 }, byCode: { SERVER_BUSY: 7 }, durations: [] } })
  assert.match(evaluate({ summary: with500, guard: 'on', n: 10, cap: 3 }).problems.join('；'), /500/)
  assert.match(evaluate({ summary: summaryOf({ health: { count: 20, p50: 3, p95: 900, max: 6200, failures: 0 } }), guard: 'on', n: 10, cap: 3 }).problems.join('；'), /健康探针最慢/)
})

test('排队臂：整批都排到才通过（放行数可以超过同时上限）', () => {
  const base = {
    kind: 'canvas',
    n: 8,
    requests: { total: 8, accepted: 8, rejected: 0, byStatus: { 200: 8 }, byCode: {}, durations: [] },
    upstream: { calls: 8, peakConcurrent: 2, byPath: {} },
    kindLimit: 2,
    queue: { waitMs: 90000, queued: 6, maxWaitMs: 4200, report: { served: 6, timedOut: 0, full: 0 } },
  }
  const ok = evaluate({ summary: summaryOf(base), guard: 'on', n: 8, cap: 2 })
  assert.equal(ok.ok, true, ok.problems.join('；'))
  // 只放进来 6 条：排队这一层没把剩下 2 条接住
  const short = summaryOf({ ...base, requests: { ...base.requests, accepted: 6, rejected: 2, byStatus: { 200: 6, 503: 2 }, byCode: { SERVER_BUSY: 2 } }, upstream: { calls: 6, peakConcurrent: 2, byPath: {} } })
  assert.match(evaluate({ summary: short, guard: 'on', n: 8, cap: 2 }).problems.join('；'), /没排到/)
  // 8 条都 200、但一条都没真排过队：说明这条臂没量到排队（上限没生效或流水线太快）
  const noQueue = summaryOf({ ...base, queue: { waitMs: 90000, queued: 0, maxWaitMs: 0 } })
  assert.match(evaluate({ summary: noQueue, guard: 'on', n: 8, cap: 2 }).problems.join('；'), /真排过队/)
  // 排队臂也要求「上游被调用数 = 放行数」：排到之后再发一次才算
  const doubleCall = summaryOf({ ...base, upstream: { calls: 9, peakConcurrent: 2, byPath: {} } })
  assert.match(evaluate({ summary: doubleCall, guard: 'on', n: 8, cap: 2 }).problems.join('；'), /上游被调用/)
})

test('参数解析：默认值与显式覆盖', () => {
  const defaults = parseArgs(['--kind=review'])
  assert.equal(defaults.kind, 'review')
  const parsed = parseArgs(['--kind=replicate', '--n=8', '--guard=off', '--upstream-ms=9000', '--keep'])
  assert.equal(parsed.kind, 'replicate')
  assert.equal(parsed.n, '8')
  assert.equal(parsed.guard, 'off')
  assert.equal(parsed['upstream-ms'], '9000')
  assert.equal(parsed.keep, 'true')
})

test('报告里把「没量到」写成 —，不写成 0 MB', () => {
  const text = formatReport(summaryOf({ memory: { peakTreeRssMb: null, baselineTreeRssMb: null, peakChildRssMb: null, peakHeapUsedMb: null, heapLimitMb: null, minAvailableMb: null, peakSwapUsedMb: null, totalMb: null } }))
  assert.match(text, /进程树峰值 —/)
  assert.match(text, /判定：通过/)
})
