import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 分享链接的打开记录：链接发出去之后，分享者自己要知道「对方点开过没有」。
// 这一组盯四件事：打开一次记一次（一分钟内刷新不算新的）、客户端只分四类、
// 记录文件里没有能直接打开作品的 token、公开视图里不出现任何统计。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-visits-'))
process.env.DATA_DIR = dir

const now = '2026-11-12T12:00:00.000Z'
const TOKEN = 'tok_share_1234567890'

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      {
        id: 'prj_p',
        ownerId: 'u_a',
        title: '毛衣折叠收纳法',
        templateId: 'tpl_a',
        flowId: '',
        version: 1,
        versions: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
        shareToken: TOKEN,
        shareCreatedAt: now,
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

const { clientKind, getShareVisits, recordShareOpen, visitKey, OPEN_DEDUPE_MS } = await import('../server/share-visits.mjs')
const { createProjectShareRouter } = await import('../server/routes/project-share.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')

const shareRouter = createProjectShareRouter()
const projectsRouter = createProjectsRouter()
const visitsFile = path.join(dir, 'share-visits.json')

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

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const WECHAT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.40'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

test('客户端只分四类：微信优先于手机，空 UA 归未知', () => {
  assert.equal(clientKind(WECHAT), 'wechat')
  assert.equal(clientKind(IPHONE), 'mobile')
  assert.equal(clientKind(WINDOWS), 'desktop')
  assert.equal(clientKind(''), 'other')
  assert.equal(clientKind('curl/8.0'), 'other')
  // 微信里的 iPhone 也算微信：先判断容器，再判断设备
  assert.equal(clientKind('MicroMessenger/8.0.40 (iPhone; CPU iPhone OS 17_0)'), 'wechat')
})

test('记录键是 token 的哈希前缀：记录文件里没有能打开作品的链接', async () => {
  const key = visitKey(TOKEN)
  assert.match(key, /^[0-9a-f]{16}$/)
  assert.notEqual(key, visitKey('tok_share_0987654321'))
  assert.equal(visitKey('too_short'), '')
  await recordShareOpen(TOKEN, IPHONE, Date.parse(now))
  const raw = fs.readFileSync(visitsFile, 'utf8')
  assert.ok(!raw.includes(TOKEN), '记录文件里不该出现原始 token')
  assert.ok(raw.includes(key))
})

test('一分钟内刷新不算新的：次数只加一次，最近一次时间往前推', async () => {
  const token = 'tok_dedupe_1234567890'
  const t0 = Date.parse('2026-11-12T13:00:00.000Z')
  const first = await recordShareOpen(token, IPHONE, t0)
  assert.equal(first.opens, 1)
  assert.equal(first.firstAt, '2026-11-12T13:00:00.000Z')
  assert.equal(first.lastClient, 'mobile')

  const refreshed = await recordShareOpen(token, IPHONE, t0 + 30_000)
  assert.equal(refreshed.opens, 1, '30 秒后的刷新不该多算一次')
  assert.equal(refreshed.lastAt, '2026-11-12T13:00:30.000Z', '最近一次时间要跟着刷新往前推')
  assert.equal(refreshed.firstAt, first.firstAt)

  const later = await recordShareOpen(token, WECHAT, t0 + OPEN_DEDUPE_MS + 1)
  assert.equal(later.opens, 2)
  assert.equal(later.lastClient, 'wechat')
  assert.deepEqual(await getShareVisits(token), later)
})

test('没打开过的链接是全零，不是 null', async () => {
  const empty = await getShareVisits('tok_never_1234567890')
  assert.deepEqual(empty, { opens: 0, firstAt: '', lastAt: '', lastClient: '' })
})

test('记录只留最近 200 条链接，太早的不再占用文件', async () => {
  const base = Date.parse('2026-11-12T14:00:00.000Z')
  for (let i = 0; i < 205; i += 1) {
    await recordShareOpen('tok_bulk_' + String(i).padStart(10, '0'), WINDOWS, base + i * 1000)
  }
  const all = JSON.parse(fs.readFileSync(visitsFile, 'utf8'))
  assert.equal(Object.keys(all).length, 200)
  assert.equal(all[visitKey('tok_bulk_0000000000')], undefined, '最早的那条该被挤出去')
  assert.ok(all[visitKey('tok_bulk_0000000204')], '最新的那条要留着')
})

test('打开分享页记一次；帧图、坏链接、公开视图都不掺和', async () => {
  const detail = async () => {
    const res = await call(projectsRouter, '/api/projects/prj_p')
    assert.equal(res.status, 200)
    return JSON.parse(res.body)
  }

  // 开分享、还没人点：面板要能说「还没有人打开过」
  const before = await detail()
  assert.equal(before.share.token, TOKEN)
  assert.deepEqual(before.share.visits, { opens: 0, firstAt: '', lastAt: '', lastClient: '' })

  // 甲方用手机点开：公开视图照常给内容，但一个字都不提被统计
  const opened = await call(shareRouter, '/api/share/project/' + TOKEN, { userAgent: IPHONE })
  assert.equal(opened.status, 200)
  assert.match(opened.body, /毛衣折叠收纳法/)
  assert.doesNotMatch(opened.body, /visits|opens|firstAt|lastClient|share-visits/)

  const after = await detail()
  assert.equal(after.share.visits.opens, 1)
  assert.equal(after.share.visits.lastClient, 'mobile')

  // 同一分钟再打开：刷新不算新的
  await call(shareRouter, '/api/share/project/' + TOKEN, { userAgent: IPHONE })
  assert.equal((await detail()).share.visits.opens, 1)

  // 帧图请求不算打开：一次打开会带很多张图
  await call(shareRouter, '/api/share/project/' + TOKEN + '/frame/1', { userAgent: IPHONE })
  assert.equal((await detail()).share.visits.opens, 1)

  // 失效链接不记：打不开的东西不该出现在「打开情况」里
  const bad = await call(shareRouter, '/api/share/project/tok_does_not_exist_123', { userAgent: IPHONE })
  assert.equal(bad.status, 404)
  assert.equal((await detail()).share.visits.opens, 1)
})

test('列表接口不返回打开记录：token 与统计只在作品详情里', async () => {
  const res = await call(projectsRouter, '/api/projects')
  assert.equal(res.status, 200)
  assert.doesNotMatch(res.body, /visits/)
  assert.doesNotMatch(res.body, new RegExp(TOKEN))
})
