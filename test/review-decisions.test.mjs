import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 人工复核：模型给结论，人看过证据后拍板「这一版能发 / 不能发」。
// 这一组盯七条口径：拍过板的不在待办里、胶囊与下一步听人的；评审记录一个字不改；
// 再评出新结论拍板自动失效；撤销回到待办；只清自己作品的记录；纸与稿上写清谁拍的板。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-decision-'))
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
 * prj_decide v2：v1 不通过、v2 需人工确认 → 用来走「拍板 → 撤销 / 又评了一次」
 * prj_reject v1：不通过 → 用来走「拍板不通过」
 * prj_pass   v1：通过 → 接口应当拒收拍板（模型说通过的不需要人再确认）
 * prj_done   v1：已交付，就算有拍板也不该出现在任何一边
 * prj_oldrev v1：预置的拍板指向更早那一次评审（时间对不上）→ 仍然算没拍板
 * prj_other  u_b 的作品：不进我的队列
 */
const projects = [
  project('prj_decide', 'u_a', 2),
  project('prj_reject', 'u_a', 1),
  project('prj_pass', 'u_a', 1),
  project('prj_done', 'u_a', 1, { status: 'done' }),
  project('prj_oldrev', 'u_a', 1),
  project('prj_other', 'u_b', 1),
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

let seq = 0
function review(projectId, version, verdict, createdAt, ownerId = 'u_a') {
  seq += 1
  return {
    id: 'rev_d' + String(seq).padStart(2, '0'),
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
      review('prj_decide', 1, 'fail', at(10, 9)),
      review('prj_decide', 2, 'needs_review', at(12, 10)),
      review('prj_reject', 1, 'fail', at(11, 8)),
      review('prj_pass', 1, 'pass', at(12, 11)),
      review('prj_done', 1, 'fail', at(12, 12)),
      review('prj_oldrev', 1, 'fail', at(12, 2)),
      review('prj_other', 1, 'fail', at(12, 13), 'u_b'),
    ],
    null,
    2,
  ),
  'utf8',
)

// 预置三条拍板：一条指向更早那次评审（时间对不上）、一条挂在已交付作品上、一条是别人账号的
fs.writeFileSync(
  path.join(dir, 'review-decisions.json'),
  JSON.stringify(
    [
      { id: 'dec_seed1', projectId: 'prj_oldrev', version: 1, reviewAt: at(9, 9), verdict: 'fail', decision: 'pass', note: '', at: at(12, 3), ownerId: 'u_a' },
      { id: 'dec_seed2', projectId: 'prj_done', version: 1, reviewAt: at(12, 12), verdict: 'fail', decision: 'pass', note: '', at: at(12, 14), ownerId: 'u_a' },
      { id: 'dec_seed3', projectId: 'prj_other', version: 1, reviewAt: at(12, 13), verdict: 'fail', decision: 'reject', note: '', at: at(12, 15), ownerId: 'u_b' },
    ],
    null,
    2,
  ),
  'utf8',
)

const { reviewQueue, reviewQueueRow } = await import('../server/review-queue.mjs')
const { listDecisions, saveDecision, clearDecisions, dropDecisionsForProject } = await import('../server/review-decisions.mjs')
const { projectStatus, decisionFor } = await import('../server/project-status.mjs')
const { saveReview } = await import('../server/reviews.mjs')
const { projectDeliverable } = await import('../server/project-deliverable.mjs')

const me = { id: 'u_a' }
const ids = (rows) => rows.map((row) => row.projectId).sort()
const counts = (projectId, verdict, lastAt) => ({ count: 1, lastVerdict: verdict, lastAt })

test('拍板通过：待办少一条，decided 多一条，总数只数没拍的', async () => {
  const before = await reviewQueue(me, { limit: 20 })
  assert.deepEqual(ids(before.items), ['prj_decide', 'prj_oldrev', 'prj_reject'])
  assert.deepEqual(before.decided, [])

  await saveDecision({ projectId: 'prj_decide', version: 2, reviewAt: at(12, 10), verdict: 'needs_review', decision: 'pass', note: '可以发' }, me)
  const after = await reviewQueue(me, { limit: 20 })
  assert.deepEqual(ids(after.items), ['prj_oldrev', 'prj_reject'])
  assert.equal(after.total, 2, '总数跟着少一条')
  assert.deepEqual(ids(after.decided), ['prj_decide'])
  assert.equal(after.decidedTotal, 1)
  const row = after.decided[0]
  assert.equal(row.decision, 'pass')
  assert.equal(row.note, '可以发')
  assert.equal(row.at, at(12, 10), '评审时间不变：撤销后回的还是同一条')
  assert.equal(row.decidedAt, (await listDecisions(me))[0].at)
})

test('胶囊与下一步听人的：拍板通过写「人工通过」并让去交付', async () => {
  const decision = decisionFor(await listDecisions(me), at(12, 10))
  assert.ok(decision)
  const status = projectStatus(projects[0], counts('prj_decide', 'needs_review', at(12, 10)), decision)
  assert.equal(status.text, '评审 · 人工通过')
  assert.equal(status.tone, 'ok')
  assert.equal(status.verdict, 'needs_review', '模型结论仍在：人这一层不改评审记录')
  assert.equal(status.human, 'pass')
  const noDecision = projectStatus(projects[0], counts('prj_decide', 'needs_review', at(12, 10)))
  assert.equal(noDecision.text, '评审 · 需人工确认', '没有拍板时还是模型那一句')
})

test('拍板不通过：胶囊写「人工不通过」，语气是不通过那一档', async () => {
  await saveDecision({ projectId: 'prj_reject', version: 1, reviewAt: at(11, 8), verdict: 'fail', decision: 'reject', note: '这条不发' }, me)
  const queue = await reviewQueue(me, { limit: 20 })
  const row = queue.decided.find((item) => item.projectId === 'prj_reject')
  assert.ok(row)
  assert.equal(row.decision, 'reject')
  const status = projectStatus(projects[1], counts('prj_reject', 'fail', at(11, 8)), { decision: 'reject' })
  assert.equal(status.text, '评审 · 人工不通过')
  assert.equal(status.tone, 'fail')
})

test('拍板不改评审记录：评审还是 needs_review，条数不变', async () => {
  const { listReviews, getReview } = await import('../server/reviews.mjs')
  const page = await listReviews({ projectId: 'prj_decide', limit: 20 }, me)
  assert.equal(page.total, 2, '两条评审还在')
  assert.equal(page.items[0].verdict, 'needs_review', '列表摘要里的结论没变')
  const full = await getReview(page.items[0].id, me)
  assert.equal(full.result.verdict, 'needs_review', '模型写的结论一个字没改')
})

test('同一版又评出新结论：拍板作废，回到待办', async () => {
  await saveReview({
    user: me,
    source: { kind: 'url', imageUrl: 'https://example.com/again.jpg' },
    intent: '改完再评一次',
    result: { verdict: 'fail', summary: '还是没过' },
    projectId: 'prj_decide',
    version: 2,
  })
  const queue = await reviewQueue(me, { limit: 20 })
  const row = queue.items.find((item) => item.projectId === 'prj_decide')
  assert.ok(row, '新的评审就是新的意见，不能因为拍过上一次就压住')
  assert.equal(row.verdict, 'fail')
  assert.equal(queue.decided.some((item) => item.projectId === 'prj_decide'), false, '旧拍板不再算数')
})

test('评审时间对不上就不算拍过（预置的那条）', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.ok(queue.items.some((row) => row.projectId === 'prj_oldrev'))
})

test('已交付的作品：既不催，也不留在拍板里', async () => {
  const queue = await reviewQueue(me, { limit: 20 })
  assert.equal(queue.items.some((row) => row.projectId === 'prj_done'), false)
  assert.equal(queue.decided.some((row) => row.projectId === 'prj_done'), false)
})

test('账号隔离：别人拍的不算我拍的', async () => {
  assert.equal((await listDecisions(me)).some((entry) => entry.ownerId === 'u_b'), false)
  const other = await reviewQueue({ id: 'u_b' }, { limit: 20 })
  assert.deepEqual(ids(other.decided), ['prj_other'])
  assert.equal(other.items.some((row) => row.projectId === 'prj_other'), false)
})

test('撤销：记录删掉，这条回到待办；再撤销一次是 0', async () => {
  const removed = await clearDecisions('prj_reject', me)
  assert.equal(removed, 1)
  const queue = await reviewQueue(me, { limit: 20 })
  assert.ok(queue.items.some((row) => row.projectId === 'prj_reject'))
  assert.equal(await clearDecisions('prj_reject', me), 0, '再撤销一次不报错')
})

test('同一次评审改判只留一条；不同版本的拍板各留各的', async () => {
  await saveDecision({ projectId: 'prj_reject', version: 1, reviewAt: at(11, 8), verdict: 'fail', decision: 'pass' }, me)
  await saveDecision({ projectId: 'prj_reject', version: 1, reviewAt: at(11, 8), verdict: 'fail', decision: 'reject' }, me)
  const mine = (await listDecisions(me)).filter((entry) => entry.projectId === 'prj_reject')
  assert.equal(mine.length, 1, '同一次评审改判是覆盖，不是堆积')
  assert.equal(mine[0].decision, 'reject')

  await saveDecision({ projectId: 'prj_reject', version: 0, reviewAt: at(9, 1), verdict: 'fail', decision: 'pass' }, me)
  assert.equal((await listDecisions(me)).filter((entry) => entry.projectId === 'prj_reject').length, 2, '别的版本上的拍板不覆盖')
})

test('删掉作品，拍板记录一起清掉', async () => {
  assert.equal((await listDecisions(me)).some((entry) => entry.projectId === 'prj_reject'), true)
  const dropped = await dropDecisionsForProject('prj_reject')
  assert.equal(dropped, 2)
  assert.equal((await listDecisions(me)).some((entry) => entry.projectId === 'prj_reject'), false)
})

test('接口：通过的作品 / 非法拍板 / 缺作品 id 都拒收，成功的一次由服务端现算版次', async () => {
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

  const pass = await call('POST', '/api/reviews/decision', { projectId: 'prj_pass', decision: 'pass' })
  assert.equal(pass.status, 409, '结论是通过的作品不需要人再确认')
  assert.equal(pass.body.code, 'NO_PENDING_REVIEW')

  const missing = await call('POST', '/api/reviews/decision', { decision: 'pass' })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'PROJECT_REQUIRED')

  const bad = await call('POST', '/api/reviews/decision', { projectId: 'prj_decide', decision: 'maybe' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'DECISION_INVALID')

  // 这个用例没有登录态，归属按「未登录」记：单独一条，不污染上面 u_a 的数据
  const ok = await call('POST', '/api/reviews/decision', { projectId: 'prj_decide', decision: 'reject', note: 'x'.repeat(120) })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.decision.version, 2, '版次由服务端现算（作品现在是第 2 版）')
  assert.equal(ok.body.decision.note.length, 80, '备注截到 80 字')
  assert.notEqual(ok.body.decision.reviewAt, at(12, 10), '评审时间由服务端取最近一次评审，不信客户端')
  assert.ok(Number.isFinite(Date.parse(ok.body.decision.reviewAt)), '是一个真实时间')

  // 没有登录态 = 本地演示：按 canAccess 一律可见，所以这条作品的记录（含 u_a 那条旧的）一起清掉。
  // 与「看得见才撤得掉」同一口径：登录账号只撤得掉自己的与没有归属的老记录。
  const undo = await call('DELETE', '/api/reviews/decision/prj_decide')
  assert.equal(undo.status, 200)
  assert.equal(undo.body.removed, 2)
  assert.equal(undo.body.scope, 'project')
})

test('队列行接口：拍过板的作品仍然拿得到行（能改判），通过 / 已交付的拿不到', async () => {
  const row = await reviewQueueRow('prj_oldrev', me)
  assert.ok(row)
  assert.equal(await reviewQueueRow('prj_pass', me), null)
  assert.equal(await reviewQueueRow('prj_done', me), null)
  assert.equal(await reviewQueueRow('prj_other', { id: 'u_a' }), null, '别人的作品拿不到')
})

test('交付稿：抬头写清谁拍的板，没有拍板也照实写没有', async () => {
  const base = {
    project: { id: 'prj_doc', title: '作品 doc', version: 2, versions: [], status: 'active', flowId: 'flow_doc', createdAt: at(1, 0), updatedAt: at(2, 0) },
    template: null,
    flow: null,
    script: null,
    reviews: [],
    versions: [],
    versionCounts: { '2': { count: 1, lastVerdict: 'needs_review', lastAt: at(12, 10) } },
    runs: [],
    runTotal: 0,
    runCounts: {},
  }
  const decided = projectDeliverable({
    ...base,
    decisions: [{ id: 'dec_x', projectId: 'prj_doc', version: 2, reviewAt: at(12, 10), verdict: 'needs_review', decision: 'pass', note: '可以发', at: at(12, 20) }],
  }, { review: null, tzOffsetMinutes: 480 })
  assert.match(decided.markdown, /人工复核：人工通过/)
  assert.match(decided.markdown, /可以发/)
  assert.match(decided.markdown, /状态：评审 · 人工通过/)

  const open = projectDeliverable({ ...base, decisions: [] }, { review: null, tzOffsetMinutes: 480 })
  assert.match(open.markdown, /人工复核：没有（结论由模型给出，还没人拍板）/)
  assert.match(open.markdown, /状态：评审 · 需人工确认/)
})

test('评审对照纸：有人拍板时纸脚写「这一版人工复核」，没人拍板仍写「不是人工复核」', async () => {
  const { reviewSheetHtml } = await import('../server/project-review-sheet.mjs')
  const records = [{
    id: 'rev_sheet',
    version: 2,
    createdAt: at(12, 10),
    source: { label: '第 1 次' },
    result: { verdict: 'needs_review', summary: '两条问题', observations: [], fixes: [] },
  }]
  const plain = reviewSheetHtml({ project: { title: '作品 doc' }, records, now: new Date(at(12, 21)), tzOffsetMinutes: 480 })
  assert.match(plain, /不是人工复核/)
  const decided = reviewSheetHtml({
    project: { title: '作品 doc' },
    records,
    decisions: [{ id: 'dec_y', projectId: 'prj_doc', version: 2, reviewAt: at(12, 10), verdict: 'needs_review', decision: 'reject', note: '重拍', at: at(12, 20) }],
    now: new Date(at(12, 21)),
    tzOffsetMinutes: 480,
  })
  assert.match(decided, /这一版人工复核：不通过/)
  assert.match(decided, /重拍/)
  assert.equal(/不是人工复核/.test(decided), false, '有人复核过就不能再写「不是人工复核」')
})
