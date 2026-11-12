import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 「已看过」：评审给了意见，人看过了、这一版先不改。
// 这一组盯五条口径：看过的不算在待办里、但结论与胶囊不动；记的是「哪一版哪一次评审」；
// 同一版又评出新结论 / 开了新版会自动回到待办；撤销能回来；删作品时便利贴一起撕掉。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-ack-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'

function project(id, ownerId, version, { status = 'active' } = {}) {
  return {
    id,
    ownerId,
    title: '作品 ' + id,
    templateId: '',
    flowId: 'flow_' + id,
    version,
    versions: [],
    status,
    createdAt: at(1, 0),
    updatedAt: at(1, 0),
  }
}

/**
 * prj_see    v2：v1 不通过、v2 需人工确认 → 待办里；这一个用来走「看过了 → 撤销 / 又评了一次」
 * prj_spring v1：不通过 → 待办里；用来走「接口点已看过、再撤销」
 * prj_mismatch v2：预置的已看过记在 v1 上（版次对不上）→ 仍然算没看过
 * prj_oldrev v1：预置的已看过记的是更早那一次评审（时间对不上）→ 仍然算没看过
 * prj_done   v1：已交付，就算有已看过也不该出现在任何一边
 * prj_pass   v1：通过 → 接口应当拒收「已看过」
 * prj_other  u_b 的作品：不进我的队列
 */
const projects = [
  project('prj_see', 'u_a', 2),
  project('prj_spring', 'u_a', 1),
  project('prj_mismatch', 'u_a', 2),
  project('prj_oldrev', 'u_a', 1),
  project('prj_done', 'u_a', 1, { status: 'done' }),
  project('prj_pass', 'u_a', 1),
  project('prj_other', 'u_b', 1),
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

let seq = 0
function review(projectId, version, verdict, createdAt, ownerId = 'u_a') {
  seq += 1
  return {
    id: 'rev_a' + String(seq).padStart(2, '0'),
    ownerId,
    projectId,
    version,
    intent: '第 ' + seq + ' 次评审',
    source: { kind: 'url', label: '第 ' + seq + ' 次', imageUrl: 'https://example.com/' + seq + '.jpg' },
    result: { verdict, summary: '结论 ' + verdict, observations: [] },
    createdAt,
  }
}

fs.writeFileSync(
  path.join(dir, 'reviews.json'),
  JSON.stringify(
    [
      review('prj_see', 1, 'fail', at(10, 9)),
      review('prj_see', 2, 'needs_review', at(12, 10)),
      review('prj_spring', 1, 'fail', at(11, 8)),
      review('prj_mismatch', 1, 'fail', at(9, 3)),
      review('prj_mismatch', 2, 'needs_review', at(12, 1)),
      review('prj_oldrev', 1, 'fail', at(12, 2)),
      review('prj_done', 1, 'fail', at(12, 12)),
      review('prj_pass', 1, 'pass', at(12, 11)),
      review('prj_other', 1, 'fail', at(12, 13), 'u_b'),
    ],
    null,
    2,
  ),
  'utf8',
)

// 预置三条「已看过」：两条故意对不上（版次 / 评审时间），一条挂在已交付的作品上，一条挂在别人账号上
fs.writeFileSync(
  path.join(dir, 'review-acks.json'),
  JSON.stringify(
    [
      { id: 'ack_seed1', projectId: 'prj_mismatch', version: 1, reviewAt: at(9, 3), verdict: 'fail', at: at(12, 2), ownerId: 'u_a' },
      { id: 'ack_seed2', projectId: 'prj_oldrev', version: 1, reviewAt: at(9, 9), verdict: 'fail', at: at(12, 3), ownerId: 'u_a' },
      { id: 'ack_seed3', projectId: 'prj_done', version: 1, reviewAt: at(12, 12), verdict: 'fail', at: at(12, 14), ownerId: 'u_a' },
      { id: 'ack_seed4', projectId: 'prj_other', version: 1, reviewAt: at(12, 13), verdict: 'fail', at: at(12, 15), ownerId: 'u_b' },
    ],
    null,
    2,
  ),
  'utf8',
)

const { reviewQueue, reviewQueueRow } = await import('../server/review-queue.mjs')
const { ackFor, listAcks, ackReview, unackReview, dropAcksForProject } = await import('../server/review-acks.mjs')
const { projectStatus } = await import('../server/project-status.mjs')
const { saveReview } = await import('../server/reviews.mjs')

const me = { id: 'u_a' }
const ids = (rows) => rows.map((row) => row.projectId).sort()

test('看过的不在待办里：items 少一条，seen 多一条，total 只数没看的', async () => {
  const before = await reviewQueue(me, { limit: 20 })
  assert.deepEqual(ids(before.items), ['prj_mismatch', 'prj_oldrev', 'prj_see', 'prj_spring'])
  assert.equal(before.total, 4)
  assert.deepEqual(before.seen, [], '预置的两条是故意对不上的，不算看过')
  assert.equal(before.seenTotal, 0)

  await ackReview({ projectId: 'prj_see', version: 2, reviewAt: at(12, 10), verdict: 'needs_review' }, me)
  const after = await reviewQueue(me, { limit: 20 })
  assert.deepEqual(ids(after.items), ['prj_mismatch', 'prj_oldrev', 'prj_spring'])
  assert.equal(after.total, 3, '总数跟着少一条，界面不会还写 4 条')
  assert.deepEqual(ids(after.seen), ['prj_see'])
  assert.equal(after.seenTotal, 1)
})

test('看过的行还是同一口径：胶囊、结论、次数、评审时间，另加看过时间', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const row = queue.seen.find((item) => item.projectId === 'prj_see')
  assert.equal(row.version, 2)
  assert.equal(row.verdict, 'needs_review')
  assert.equal(row.at, at(12, 10), '评审时间不变：撤销后回的还是同一条')
  assert.equal(row.count, 1)
  assert.deepEqual(row.status, { text: '评审 · 需人工确认', tone: 'warn', verdict: 'needs_review' })
  assert.ok(row.seenAt, '看过时间单独记，界面用它写「什么时候看过」')
})

test('看过不等于改过：作品状态胶囊一句都没变', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  const row = queue.seen.find((item) => item.projectId === 'prj_see')
  const project = projects.find((item) => item.id === 'prj_see')
  const status = projectStatus(project, { count: row.count, lastVerdict: row.verdict, lastAt: row.at })
  assert.deepEqual(status, row.status, '胶囊读的还是评审结论，不是「已看过」')
})

test('同一版又评出新结论：它自己回到待办，已看过作废', async () => {
  await saveReview({
    user: me,
    source: { kind: 'url', imageUrl: 'https://example.com/again.jpg' },
    intent: '改完再评一次',
    result: { verdict: 'fail', summary: '还是没过' },
    projectId: 'prj_see',
    version: 2,
  })
  const queue = await reviewQueue(me, { limit: 20 })
  const row = queue.items.find((item) => item.projectId === 'prj_see')
  assert.ok(row, '新的评审就是新的意见，不能因为看过上一次就压住')
  assert.equal(row.verdict, 'fail')
  assert.notEqual(row.at, at(12, 10))
  assert.equal(queue.seen.some((item) => item.projectId === 'prj_see'), false, '旧的那条「已看过」不再算数')
})

test('版次或评审时间对不上就不算看过（预置的那两条）', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.ok(queue.items.some((row) => row.projectId === 'prj_mismatch'), '看过的是 v1，现在 v2 有意见')
  assert.ok(queue.items.some((row) => row.projectId === 'prj_oldrev'), '看过的是更早那一次评审')
})

test('已交付的作品：既不催，也不留在「已看过」里', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.equal(queue.items.some((row) => row.projectId === 'prj_done'), false)
  assert.equal(queue.seen.some((row) => row.projectId === 'prj_done'), false)
})

test('账号隔离：别人看过的东西不算我看过', async () => {
  const mine = await reviewQueue(me, { limit: 20 })
  assert.equal(mine.seen.some((row) => row.projectId === 'prj_other'), false)
  assert.equal((await listAcks(me)).some((ack) => ack.ownerId === 'u_b'), false)
  const other = await reviewQueue({ id: 'u_b' }, { limit: 20 })
  assert.deepEqual(ids(other.seen), ['prj_other'])
})

test('撤销：它回到待办，「已看过」那条被删掉', async () => {
  await ackReview({ projectId: 'prj_spring', version: 1, reviewAt: at(11, 8), verdict: 'fail' }, me)
  assert.equal((await reviewQueue(me, { limit: 20 })).seen.some((row) => row.projectId === 'prj_spring'), true)
  const removed = await unackReview('prj_spring', me)
  assert.equal(removed, 1)
  const queue = await reviewQueue(me, { limit: 20 })
  assert.ok(queue.items.some((row) => row.projectId === 'prj_spring'))
  assert.equal(queue.seen.some((row) => row.projectId === 'prj_spring'), false)
  assert.equal(await unackReview('prj_spring', me), 0, '再撤销一次是 0，不报错')
})

test('看得见就撤得掉：没有 ownerId 的公共便利贴与管理员也撤得动', async () => {
  // 本地演示（无登录）记下的便利贴没有 ownerId：账号看得见它，以前却撤不掉——
  // 接口返回 200 但 removed 是 0，那一行原地不动，像是按钮坏了（v0.9.28 修）
  await ackReview({ projectId: 'prj_spring', version: 1, reviewAt: at(11, 8), verdict: 'fail' }, null)
  assert.ok((await reviewQueue(me, { limit: 20 })).seen.some((row) => row.projectId === 'prj_spring'), '公共记录看得见')
  assert.equal(await unackReview('prj_spring', me), 1, '看得见的公共记录撤得掉')
  assert.ok((await reviewQueue(me, { limit: 20 })).items.some((row) => row.projectId === 'prj_spring'), '撤完回到待办')

  // 管理员同理：他看得见全部，就撤得掉全部（与拍板记录的撤销同一口径）
  await ackReview({ projectId: 'prj_spring', version: 1, reviewAt: at(11, 8), verdict: 'fail' }, me)
  assert.equal(await unackReview('prj_spring', { id: 'u_admin', kind: 'admin' }), 1)
})

test('同一条作品只留最新一条已看过，不越记越多', async () => {
  await ackReview({ projectId: 'prj_spring', version: 1, reviewAt: at(11, 8), verdict: 'fail' }, me)
  await ackReview({ projectId: 'prj_spring', version: 1, reviewAt: at(11, 8), verdict: 'fail' }, me)
  const mine = (await listAcks(me)).filter((ack) => ack.projectId === 'prj_spring')
  assert.equal(mine.length, 1)
})

test('删掉作品，便利贴一起撕掉', async () => {
  await ackReview({ projectId: 'prj_spring', version: 1, reviewAt: at(11, 8), verdict: 'fail' }, me)
  assert.equal((await listAcks(me)).some((ack) => ack.projectId === 'prj_spring'), true)
  const dropped = await dropAcksForProject('prj_spring')
  assert.equal(dropped, 1)
  assert.equal((await listAcks(me)).some((ack) => ack.projectId === 'prj_spring'), false)
})

test('接口：不是待办里的作品拒收「已看过」，缺作品 id 回 400', async () => {
  const { createReviewRouter } = await import('../server/routes/review.mjs')
  const router = createReviewRouter()
  const call = async (method, pathname, body) => {
    const res = {
      status: 0,
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(chunk) {
        this.body = String(chunk ?? '')
      },
    }
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload) } }
    const url = new URL('http://localhost' + pathname)
    await router.handle(req, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const pass = await call('POST', '/api/reviews/ack', { projectId: 'prj_pass' })
  assert.equal(pass.status, 409, '结论是通过的作品不需要「看过」')
  assert.equal(pass.body.code, 'NO_PENDING_REVIEW')

  const missing = await call('POST', '/api/reviews/ack', {})
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'PROJECT_REQUIRED')

  // 这个用例没有登录态，归属按「未登录」记（公共便利贴）
  const ok = await call('POST', '/api/reviews/ack', { projectId: 'prj_mismatch' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ack.projectId, 'prj_mismatch')
  assert.equal(ok.body.ack.version, 2, '版次由服务端现算，不信客户端传的')

  // 撤销按「看得见就撤得掉」（v0.9.28）：本地演示没有登录态时看得见全部，
  // 这条作品上预置的 u_a 那条也在可见范围内，一起撤掉——这是演示模式，生产有登录门挡在前面。
  const undo = await call('DELETE', '/api/reviews/ack/prj_mismatch')
  assert.equal(undo.status, 200)
  assert.equal(undo.body.removed, 2)
})

test('看过的三样都得对上：作品、版次、评审时间；这一版还没评过就没有东西可对上', async () => {
  const list = await listAcks(me)
  assert.equal(
    ackFor(list, { projectId: 'prj_oldrev', version: 1, reviewAt: at(12, 2) }),
    null,
    '预置的看过记的是更早那一次评审，时间对不上',
  )
  assert.equal(ackFor(list, { projectId: 'prj_see', version: 2, reviewAt: '' }), null, '没有评审时间就不算看过')
  assert.equal(ackFor(list, { projectId: '', version: 1, reviewAt: at(12, 2) }), null, '没有作品就没有「看过」')
  assert.equal(ackFor([], { projectId: 'prj_oldrev', version: 1, reviewAt: at(12, 2) }), null)
})

test('作品详情带「这一版看过了没有」：看过就有、撤销就没了，胶囊一句都不变', async () => {
  const { createProjectsRouter } = await import('../server/routes/projects.mjs')
  const router = createProjectsRouter()
  const get = async (id) => {
    const res = {
      status: 0,
      body: '',
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(chunk) {
        this.body = String(chunk ?? '')
      },
    }
    const url = new URL('http://localhost/api/projects/' + id)
    await router.handle({ method: 'GET', headers: {} }, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const before = await get('prj_oldrev')
  assert.equal(before.status, 200)
  assert.equal(before.body.ack, null, '预置的看过记在更早一次评审上，作品页不该显示「已看过」')

  await ackReview({ projectId: 'prj_oldrev', version: 1, reviewAt: at(12, 2), verdict: 'fail' }, me)
  const after = await get('prj_oldrev')
  assert.deepEqual(Object.keys(after.body.ack).sort(), ['at', 'reviewAt', 'version'])
  assert.equal(after.body.ack.version, 1)
  assert.equal(after.body.ack.reviewAt, at(12, 2), '对上的是当前这一版最近一次评审')
  assert.equal(after.body.project.status, 'active', '看过只是便利贴，作品状态不动')

  await unackReview('prj_oldrev', me)
  assert.equal((await get('prj_oldrev')).body.ack, null, '撤销后作品页马上跟着变')
})

test('队列行接口：pending 的作品拿得到，通过 / 已交付的拿不到', async () => {
  const row = await reviewQueueRow('prj_oldrev', me)
  assert.ok(row)
  assert.equal(row.projectId, 'prj_oldrev')
  assert.equal(await reviewQueueRow('prj_pass', me), null, '通过的不需要动手')
  assert.equal(await reviewQueueRow('prj_done', me), null, '交付了就不再催')
  assert.equal(await reviewQueueRow('prj_nope', me), null, '不存在的作品拿不到')
  assert.equal(await reviewQueueRow('prj_spring', { id: 'u_b' }), null, '别人的作品拿不到')
})
