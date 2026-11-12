import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 作品列表卡片上的分享状态：列表接口给每一项挂一条摘要（还在不在分享、几轮、打开过几次），
// 但不给 token、记录键与每轮明细。这一组盯的就是「卡片看得到、凭证不出门」这条线。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-project-badge-'))
process.env.DATA_DIR = dir

const now = '2026-11-12T12:00:00.000Z'

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      { id: 'prj_a', ownerId: 'u_a', title: '毛衣折叠收纳法', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
      { id: 'prj_b', ownerId: 'u_a', title: '厨房收纳三步法', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
      { id: 'prj_c', ownerId: 'u_a', title: '没分享过的作品', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: now, updatedAt: now },
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
const { visitKey } = await import('../server/share-visits.mjs')

const shareRouter = createProjectShareRouter()
const projectsRouter = createProjectsRouter()

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
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
const disable = (id) => call(projectsRouter, '/api/projects/' + id + '/share', { method: 'DELETE' })
const open = (token, userAgent) => call(shareRouter, '/api/share/project/' + token, { userAgent })
const list = async () => {
  const res = await call(projectsRouter, '/api/projects')
  assert.equal(res.status, 200)
  return { body: JSON.parse(res.body), raw: res.body }
}
const badgeOf = (body, id) => body.items.find((item) => item.id === id).share

test('正在分享的作品：卡片上挂一条摘要，含轮数与打开次数', async () => {
  const token = await enable('prj_a')
  await open(token, IPHONE)

  const { body, raw } = await list()
  const a = badgeOf(body, 'prj_a')
  assert.equal(a.live, true)
  assert.equal(a.rounds, 1)
  assert.equal(a.opens, 1)
  assert.equal(a.lastClient, 'mobile')
  assert.ok(a.lastAt)

  // 没分享过的作品：不留一个空对象，卡片上就不该有这枚胶囊
  assert.equal(badgeOf(body, 'prj_c'), null)

  // 凭证不出门：token、记录键、每轮明细都不在列表响应里
  assert.ok(!raw.includes(token))
  assert.ok(!raw.includes(visitKey(token)))
  assert.doesNotMatch(raw, /"key"|shareHistory|visits|closedAt/)
})

test('停掉分享后，卡片状态变成已停用，次数与轮数照样在', async () => {
  await disable('prj_a')
  const { body } = await list()
  const a = badgeOf(body, 'prj_a')
  assert.equal(a.live, false)
  assert.equal(a.rounds, 1)
  assert.equal(a.opens, 1)
})

test('再开一轮就是第二轮：累计次数相加，最近一次取最新那条', async () => {
  const token = await enable('prj_a')
  await open(token, WINDOWS)
  const { body } = await list()
  const a = badgeOf(body, 'prj_a')
  assert.equal(a.live, true)
  assert.equal(a.rounds, 2)
  assert.equal(a.opens, 2)
  assert.equal(a.lastClient, 'desktop')
})

test('删除作品后，列表里没有它，也没有它的分享摘要', async () => {
  const removed = await call(projectsRouter, '/api/projects/prj_a', { method: 'DELETE' })
  assert.equal(removed.status, 200)
  const { body } = await list()
  assert.equal(body.items.some((item) => item.id === 'prj_a'), false)
  for (const item of body.items) assert.equal(item.share, null)
})
