import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 工作台的分享汇总：一条作品一行，把「正在分享的那轮 + 停用的各轮」合成一个累计。
// 这一组盯：只列分享过的作品、轮数与累计次数、正在分享优先、删除作品后消失、
// 以及响应里没有 token 与记录键。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-summary-'))
process.env.DATA_DIR = dir

const now = '2026-11-12T12:00:00.000Z'

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      { id: 'prj_a', ownerId: 'u_a', title: '毛衣折叠收纳法', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
      { id: 'prj_b', ownerId: 'u_a', title: '厨房收纳三步法', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
      { id: 'prj_c', ownerId: 'u_a', title: '没分享过的作品', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
      { id: 'prj_d', ownerId: 'u_a', title: '刚开分享还没人看', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
    ],
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const { createProjectShareRouter } = await import('../server/routes/project-share.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { createSharesRouter } = await import('../server/routes/shares.mjs')

const shareRouter = createProjectShareRouter()
const projectsRouter = createProjectsRouter()
const sharesRouter = createSharesRouter()

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const WECHAT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.40'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}
async function call(router, pathname, { method = 'GET', userAgent = '' } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const req = { method, headers: userAgent ? { 'user-agent': userAgent } : {} }
  await router.handle(req, res, url, url.pathname)
  return res
}
const enable = async (id) => JSON.parse((await call(projectsRouter, '/api/projects/' + id + '/share', { method: 'POST' })).body).token
const disable = async (id) => call(projectsRouter, '/api/projects/' + id + '/share', { method: 'DELETE' })
const open = async (token, userAgent) => call(shareRouter, '/api/share/project/' + token, { userAgent })
const summary = async () => {
  const res = await call(sharesRouter, '/api/shares')
  assert.equal(res.status, 200)
  return JSON.parse(res.body)
}
const rowOf = (body, id) => body.items.find((row) => row.projectId === id)

let tokenA1 = ''
let tokenA2 = ''
let tokenB = ''

test('准备数据：A 两轮（一停一在分享）、B 一轮已停、D 刚开没人看、C 没分享', async () => {
  // B：先做，保证 A 的最近打开时间在它之后
  tokenB = await enable('prj_b')
  await open(tokenB, WECHAT)
  await disable('prj_b')

  // A：第一轮电脑打开后停用，第二轮手机打开、保持分享
  tokenA1 = await enable('prj_a')
  await open(tokenA1, WINDOWS)
  await disable('prj_a')
  tokenA2 = await enable('prj_a')
  await open(tokenA2, IPHONE)

  // D：只开分享，没人点开
  await enable('prj_d')

  const body = await summary()
  assert.equal(body.total, 3)
  assert.equal(body.items.length, 3)
  assert.equal(body.opens, 3)
  assert.ok(!rowOf(body, 'prj_c'), '没分享过的作品不该出现')

  const a = rowOf(body, 'prj_a')
  assert.equal(a.live, true)
  assert.equal(a.rounds, 2)
  assert.equal(a.visits.opens, 2)
  assert.equal(a.visits.lastClient, 'mobile')
  assert.ok(a.lastClosedAt)

  const b = rowOf(body, 'prj_b')
  assert.equal(b.live, false)
  assert.equal(b.rounds, 1)
  assert.equal(b.visits.opens, 1)
  assert.equal(b.visits.lastClient, 'wechat')
  assert.ok(b.lastClosedAt)

  const d = rowOf(body, 'prj_d')
  assert.equal(d.live, true)
  assert.equal(d.rounds, 1)
  assert.equal(d.visits.opens, 0)

  // 最近有人打开过的排前面：A 的打开在 B 之后
  assert.ok(Date.parse(a.visits.lastAt) >= Date.parse(b.visits.lastAt))
  assert.equal(body.items[body.items.length - 1].projectId, 'prj_d', '没人打开过的排最后')

  const raw = JSON.stringify(body)
  for (const token of [tokenA1, tokenA2, tokenB]) assert.ok(!raw.includes(token), '响应里不该有 token')
  assert.doesNotMatch(raw, /"key"/)
  assert.ok(!raw.includes('prj_c'))
})

test('删除作品后，它的分享汇总一起消失', async () => {
  const removed = await call(projectsRouter, '/api/projects/prj_b', { method: 'DELETE' })
  assert.equal(removed.status, 200)
  const body = await summary()
  assert.equal(body.total, 2)
  assert.equal(body.opens, 2)
  assert.ok(!rowOf(body, 'prj_b'))
})

test('所有分享都停用之后仍能汇总；全删干净就是空', async () => {
  await disable('prj_a')
  const afterStop = await summary()
  const a = rowOf(afterStop, 'prj_a')
  assert.equal(a.live, false)
  assert.equal(a.rounds, 2)
  assert.equal(a.visits.opens, 2)

  for (const id of ['prj_a', 'prj_c', 'prj_d']) await call(projectsRouter, '/api/projects/' + id, { method: 'DELETE' })
  const empty = await summary()
  assert.deepEqual(empty.items, [])
  assert.equal(empty.total, 0)
  assert.equal(empty.opens, 0)
})
