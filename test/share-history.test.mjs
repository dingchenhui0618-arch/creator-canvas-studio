import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 历史链接：停掉分享之后，token 从作品上清掉、地址当场打不开，
// 但「那一轮被打开过几次」不该跟着消失。这一组盯：停用归档、重开换新、
// 历史最多 8 轮、旧链接不再计数，以及接口里不出现 token 与记录键。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-history-'))
process.env.DATA_DIR = dir

const now = '2026-11-12T12:00:00.000Z'

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      {
        id: 'prj_h',
        ownerId: 'u_a',
        title: '毛衣折叠收纳法',
        templateId: '',
        flowId: '',
        version: 0,
        versions: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ],
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify([], null, 2), 'utf8')

const { getShareVisitsByKey, visitKey } = await import('../server/share-visits.mjs')
const { SHARE_HISTORY_LIMIT } = await import('../server/projects.mjs')
const { createProjectShareRouter } = await import('../server/routes/project-share.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

const shareRouter = createProjectShareRouter()
const projectsRouter = createProjectsRouter()

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const WECHAT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.40'

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

const detail = async () => {
  const res = await call(projectsRouter, '/api/projects/prj_h')
  assert.equal(res.status, 200)
  return JSON.parse(res.body)
}
const enable = async () => {
  const res = await call(projectsRouter, '/api/projects/prj_h/share', { method: 'POST' })
  assert.equal(res.status, 200)
  return JSON.parse(res.body).token
}
const disable = async () => {
  const res = await call(projectsRouter, '/api/projects/prj_h/share', { method: 'DELETE' })
  assert.equal(res.status, 200)
  return JSON.parse(res.body)
}

let token1 = ''
let token2 = ''

test('停用之后作品详情留下这一轮的打开记录', async () => {
  token1 = await enable()
  const opened = await call(shareRouter, '/api/share/project/' + token1, { userAgent: IPHONE })
  assert.equal(opened.status, 200)

  const live = await detail()
  assert.equal(live.share.token, token1)
  assert.equal(live.share.visits.opens, 1)
  assert.deepEqual(live.shareHistory, [])

  await disable()
  const after = await detail()
  assert.equal(after.share, null)
  assert.equal(after.shareHistory.length, 1)
  const entry = after.shareHistory[0]
  assert.equal(entry.visits.opens, 1)
  assert.equal(entry.visits.lastClient, 'mobile')
  assert.ok(entry.createdAt)
  assert.ok(entry.closedAt)
  assert.equal('key' in entry, false, '记录键不往接口外给')
  const body = JSON.stringify(after)
  assert.ok(!body.includes(token1), '停用后详情里不该再有旧 token')
  assert.ok(!body.includes(visitKey(token1)), '哈希记录键也不该出现')

  // 停用后地址当场打不开，也不该再记新的打开
  const gone = await call(shareRouter, '/api/share/project/' + token1, { userAgent: IPHONE })
  assert.equal(gone.status, 404)
  assert.equal((await detail()).shareHistory[0].visits.opens, 1)
})

test('重新开启换一条新链接，上一轮留在历史里', async () => {
  token2 = await enable()
  assert.notEqual(token2, token1)
  const live = await detail()
  assert.equal(live.share.token, token2)
  assert.equal(live.shareHistory.length, 1)

  // 新链接被微信点开：当前这一轮计数，历史不受影响
  await call(shareRouter, '/api/share/project/' + token2, { userAgent: WECHAT })
  const after = await detail()
  assert.equal(after.share.visits.opens, 1)
  assert.equal(after.share.visits.lastClient, 'wechat')
  assert.equal(after.shareHistory[0].visits.opens, 1)
})

test('已经开着分享时再开一次：旧链接也进历史，不会丢', async () => {
  const token3 = await enable()
  assert.notEqual(token3, token2)
  const after = await detail()
  assert.equal(after.share.token, token3)
  assert.equal(after.shareHistory.length, 2)
  // 最近停用的那轮排在最前，它的打开记录跟着哈希键对上
  assert.equal(after.shareHistory[0].visits.opens, 1)
  assert.equal(after.shareHistory[0].visits.lastClient, 'wechat')
})

test('历史最多留 8 轮，旧的先被挤掉', async () => {
  assert.equal(SHARE_HISTORY_LIMIT, 8)
  // 当前有 2 条历史 + 1 条在用的链接：再来 8 轮，总数会超上限
  for (let i = 0; i < 8; i += 1) {
    await disable()
    await enable()
  }
  const after = await detail()
  assert.equal(after.shareHistory.length, 8)
  const times = after.shareHistory.map((entry) => Date.parse(entry.closedAt))
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i - 1] >= times[i], '按停用时间倒序')
  }
  for (const entry of after.shareHistory) {
    assert.ok(entry.closedAt)
    assert.equal(typeof entry.visits.opens, 'number')
  }
})

test('停掉的链接不再计数', async () => {
  const active = (await detail()).share.token
  await disable()
  const opened = await call(shareRouter, '/api/share/project/' + active, { userAgent: IPHONE })
  assert.equal(opened.status, 404)
  const after = await detail()
  assert.equal(after.shareHistory[0].visits.opens, 0, '从没被打开过的链接停在 0')
})

test('列表接口不带历史、token 或记录键', async () => {
  const res = await call(projectsRouter, '/api/projects')
  assert.equal(res.status, 200)
  assert.doesNotMatch(res.body, /shareHistory|visits|closedAt/)
  assert.ok(!res.body.includes(token1))
  assert.ok(!res.body.includes(token2))
  assert.ok(!res.body.includes(visitKey(token1)))
})

test('按哈希键读：坏键一律全零', async () => {
  const key = visitKey(token1)
  const visits = await getShareVisitsByKey(key)
  assert.equal(visits.opens, 1)
  assert.equal(visits.lastClient, 'mobile')
  for (const bad of ['', 'not-a-key', key.slice(0, 15), key + 'x', '../../projects.json', null, 42]) {
    assert.deepEqual(await getShareVisitsByKey(bad), { opens: 0, firstAt: '', lastAt: '', lastClient: '' })
  }
})
