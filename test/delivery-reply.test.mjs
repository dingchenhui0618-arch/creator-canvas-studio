import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 他回了什么（v0.9.153）。
// r136–r152 把「交出去」这一侧做全了，可收据只给一个结论（对得上 / 对不上 / 看不清）；
// 他真正说的那句「第 3 张背景色偏了」没有地方落。这一组盯五件事：
//   1) 记一段原话只动这一项：包、收据、链接、收件人、那些次数都不动，作品排序照常推进；
//   2) 同一段话再存一次不写盘（字节不变），而且不刷新「他哪天回的」；空串 = 清掉，字段真的消失；
//   3) 归一化：保留换行、空行扔掉、每行空白压成一个、最多 6 行、按字截到 200（emoji 不被劈开）；
//   4) 接口照实回：405 / 400 太长 / 400 不是字符串 / 404 没有这一条；清空也走得通；
//   5) 只在发件人这一侧：回执页拿不到这段话，工作台那一行读得到。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-reply-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-reply'

const SHA = 'cd34ef56ab12' + 'c'.repeat(52)
const ZIP = 'VisionQA-他回了什么-第-3-版-v3-20261115.zip'
const pkg = { bytes: 345678, sha256: SHA, fileName: ZIP, savedAt: '2026-11-15T04:00:00.000Z' }
const ID_WRITE = 'ba12ba12ba121001'
const ID_SAME = 'ba12ba12ba121002'
const ID_CLEAR = 'ba12ba12ba121003'
const ID_ENDPOINT = 'ba12ba12ba121004'
const TOKEN_ENDPOINT = 'c3d4e5f6a7081920'
const AT = '2026-11-15T04:00:00.000Z'

function project(id, title, deliveries, updatedAt = AT) {
  return {
    id,
    ownerId: 'u_a',
    title,
    flowId: 'flow_' + id,
    version: 3,
    versions: [],
    status: 'done',
    deliveries,
    createdAt: '2026-11-12T05:00:00.000Z',
    updatedAt,
  }
}

const base = { version: 3, at: AT, package: pkg }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 还没记：记一段原话
    project('prj_write', '还没记他回了什么', [
      { ...base, id: ID_WRITE, receiptToken: 'd5e6f7a8b9012345', receiptLinkAt: AT, recipient: '王老师 · 内容组' },
    ]),
    // 已经记着同一段话：再存一次不该写盘
    project('prj_same', '记着同一段话', [
      { ...base, id: ID_SAME, reply: { text: '第 3 张背景色偏了', at: '2026-11-15T05:30:00.000Z' } },
    ]),
    // 记过、要清掉
    project('prj_clear', '要清掉的那一条', [
      { ...base, id: ID_CLEAR, reply: { text: '第 5 张再亮一点', at: '2026-11-15T06:00:00.000Z' } },
    ]),
    // 接口那一侧：有包、有回执链接、还没贴过收据
    project('prj_endpoint', '接口那一侧', [
      { ...base, id: ID_ENDPOINT, receiptToken: TOKEN_ENDPOINT, receiptLinkAt: AT },
    ]),
    // 升级前的老交付没有封存包：就算盘上写着回复也不该读出来
    project('prj_nopkg', '没有包的老交付', [
      { version: 2, at: '2026-11-10T06:00:00.000Z', reply: { text: '不该读出来的话', at: AT } },
    ]),
  ]),
  'utf8',
)
fs.writeFileSync(path.join(DIR, 'reviews.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'templates.json'), JSON.stringify([]), 'utf8')
fs.writeFileSync(path.join(DIR, 'flows.json'), JSON.stringify([]), 'utf8')

const store = await import('../server/projects.mjs')
const { ledgerRows } = await import('../server/delivery-ledger.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const replyDomain = await import('../src/domain/delivery-reply.ts')

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

function fakeReq(method = 'GET', body = null) {
  const text = body ? JSON.stringify(body) : ''
  return {
    method,
    headers: text ? { 'content-length': String(Buffer.byteLength(text)) } : {},
    async *[Symbol.asyncIterator]() {
      if (text) yield Buffer.from(text, 'utf8')
    },
  }
}

async function call(router, pathname, { method = 'GET', body = null } = {}) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  await router.handle(fakeReq(method, body), res, url, url.pathname)
  return res
}

function readRaw() {
  return fs.readFileSync(path.join(DIR, 'projects.json'), 'utf8')
}

function readProject(id) {
  return JSON.parse(readRaw()).find((entry) => entry.id === id)
}

test('记一段原话：只动这一项，包、收据、链接、收件人都不动', async () => {
  const before = readProject('prj_write')
  const sameBefore = JSON.stringify(readProject('prj_same'))
  const saved = await store.saveDeliveryReply('prj_write', ID_WRITE, '  第 3 张背景色偏了\n\n  第 5 张再亮一点  ')
  assert.equal(saved.changed, true)
  assert.equal(saved.reply.text, '第 3 张背景色偏了\n第 5 张再亮一点', '空行扔掉、每行首尾去掉、换行留着')
  assert.match(saved.reply.at, /^\d{4}-\d{2}-\d{2}T/, '记下的时间是真的时间')

  const after = readProject('prj_write')
  assert.equal(after.deliveries[0].reply.text, '第 3 张背景色偏了\n第 5 张再亮一点')
  assert.notEqual(after.updatedAt, before.updatedAt, '记的人是发件人：作品排序照常推进')
  assert.deepEqual(after.deliveries[0].package, pkg, '包一个字节都没动')
  assert.equal(after.deliveries[0].receiptToken, 'd5e6f7a8b9012345', '链接没换')
  assert.equal(after.deliveries[0].receipt, undefined, '没有顺手记一张收据')
  assert.equal(after.deliveries[0].ack, undefined, '也不该当成他点过「收到了」')
  assert.equal(after.deliveries[0].recipient, '王老师 · 内容组', '收件人那一行没被顺手改掉')
  assert.equal(JSON.stringify(readProject('prj_same')), sameBefore, '只动这一条交付')
})

test('同一段话再存一次：changed=false，一个字节都不改，时间也不刷新', async () => {
  const before = readRaw()
  const saved = await store.saveDeliveryReply('prj_same', ID_SAME, '第 3 张背景色偏了')
  assert.equal(saved.changed, false, '本来就记着这段话')
  assert.equal(saved.reply.at, '2026-11-15T05:30:00.000Z', '不刷新「他哪天回的」')
  assert.equal(readRaw(), before, '再点一次保存不该写盘')
})

test('清掉：字段真的消失，回到「还没记」', async () => {
  assert.equal(readProject('prj_clear').deliveries[0].reply.text, '第 5 张再亮一点')
  const saved = await store.saveDeliveryReply('prj_clear', ID_CLEAR, '   ')
  assert.equal(saved.changed, true)
  assert.equal(saved.reply, null)
  const after = readProject('prj_clear')
  assert.equal('reply' in after.deliveries[0], false, '清掉不是存一段空字')
  assert.deepEqual(after.deliveries[0].package, pkg, '清回复不动包')
})

test('归一化：换行留着、空行扔掉、最多 6 行、按字截到 200', () => {
  const domain = replyDomain.normalizeReply
  assert.equal(domain(' 第 3 张背景色偏了\n\n第 5 张再亮一点 '), '第 3 张背景色偏了\n第 5 张再亮一点')
  assert.equal(domain('第 3 张\t背景色偏了'), '第 3 张 背景色偏了', '制表符换成空格')
  assert.equal(domain(null), '')
  assert.equal(domain(undefined), '')
  // 最多 6 行：第 7 行起不要了——那不是「回了一句」，是另一份评审
  const many = Array.from({ length: 9 }, (_, index) => '第 ' + (index + 1) + ' 条').join('\n')
  assert.equal(domain(many).split('\n').length, 6)
  // 按码点截：240 个字截成 200，不按 UTF-16 长度切
  assert.equal(Array.from(domain('王'.repeat(240))).length, 200)
  const emoji = domain('😀'.repeat(240))
  assert.equal(Array.from(emoji).length, 200, '按字算，不是按 UTF-16 单元算')
  assert.equal(emoji.includes('\uFFFD'), false, '不能被劈成半个字符')
  // 服务端同一套规则：接口数长度用的是「整理之后、截断之前」的字数
  assert.equal(store.deliveryReplyLength('王'.repeat(201)), 201)
  assert.equal(store.deliveryReplyLength('王'.repeat(200)), 200)
  assert.equal(store.normalizeDeliveryReply('王'.repeat(240)).length, 200)
})

test('读盘：没有封存包的老交付不认这一项', async () => {
  const legacy = (await store.getProject('prj_nopkg')).deliveries[0]
  assert.equal(legacy.reply, undefined, '没有包就没有「他回了什么」可谈')
  const written = (await store.getProject('prj_write')).deliveries[0]
  assert.equal(written.reply.text, '第 3 张背景色偏了\n第 5 张再亮一点')
})

test('接口：记 / 同一段再记一次 / 清空，都用同一条路径', async () => {
  const router = createProjectsRouter()
  const url = '/api/projects/prj_endpoint/delivery-packages/' + ID_ENDPOINT + '/reply'

  const first = await call(router, url, { method: 'POST', body: { reply: '第 3 张背景色偏了' } })
  assert.equal(first.status, 200, '记一段话不该失败：' + first.status + ' ' + first.body)
  const firstBody = JSON.parse(first.body)
  assert.equal(firstBody.ok, true)
  assert.equal(firstBody.changed, true)
  assert.equal(firstBody.reply.text, '第 3 张背景色偏了')
  assert.match(firstBody.reply.at, /^\d{4}-\d{2}-\d{2}T/)

  const again = await call(router, url, { method: 'POST', body: { reply: '第 3 张背景色偏了' } })
  assert.equal(again.status, 200)
  assert.equal(JSON.parse(again.body).changed, false)

  const cleared = await call(router, url, { method: 'POST', body: { reply: '' } })
  assert.equal(cleared.status, 200)
  const clearedBody = JSON.parse(cleared.body)
  assert.deepEqual(clearedBody, { ok: true, changed: true, reply: null })
  assert.equal('reply' in readProject('prj_endpoint').deliveries[0], false)
})

test('接口：方法 / 太长 / 不是字符串 / 没有这一条，各自照实回', async () => {
  const router = createProjectsRouter()
  const url = '/api/projects/prj_endpoint/delivery-packages/' + ID_ENDPOINT + '/reply'

  const get = await call(router, url)
  assert.equal(get.status, 405, '读它不该走这一条')

  const tooLong = await call(router, url, { method: 'POST', body: { reply: '王'.repeat(201) } })
  assert.equal(tooLong.status, 400)
  assert.equal(JSON.parse(tooLong.body).code, 'REPLY_TOO_LONG')

  const notString = await call(router, url, { method: 'POST', body: { reply: 42 } })
  assert.equal(notString.status, 400)
  assert.equal(JSON.parse(notString.body).code, 'REPLY_INVALID')

  const missing = await call(router, '/api/projects/prj_write/delivery-packages/ba12ba12ba129999/reply', {
    method: 'POST',
    body: { reply: '第 3 张背景色偏了' },
  })
  assert.equal(missing.status, 404, '没有这一条交付')
  const noProject = await call(router, '/api/projects/prj_none/delivery-packages/' + ID_WRITE + '/reply', {
    method: 'POST',
    body: { reply: '第 3 张背景色偏了' },
  })
  assert.equal(noProject.status, 404, '没有这条作品')
  // 被拦住的那几次都没写盘
  assert.equal(readProject('prj_endpoint').deliveries[0].reply, undefined)
})

test('回执页拿不到这段话：那是发件人自己记的', async () => {
  const router = createProjectsRouter()
  await call(router, '/api/projects/prj_endpoint/delivery-packages/' + ID_ENDPOINT + '/reply', {
    method: 'POST',
    body: { reply: '第 3 张背景色偏了，别给收包人看' },
  })
  const res = await call(router, '/api/receipts/' + TOKEN_ENDPOINT)
  assert.equal(res.status, 200)
  assert.equal(res.body.includes('别给收包人看'), false, '拿到链接的人看不到发件人这边记了什么')
  const view = JSON.parse(res.body)
  assert.equal(view.project.title, '接口那一侧', '该给的还是给了：这是哪一份')
})

test('工作台那一行读得到：记了的给原文，没记的是 null', async () => {
  const projects = await store.listProjects()
  const rows = ledgerRows({ projects })
  const written = rows.find((row) => row.projectId === 'prj_write')
  assert.equal(written.reply.text, '第 3 张背景色偏了\n第 5 张再亮一点')
  const legacy = rows.find((row) => row.projectId === 'prj_nopkg')
  assert.equal(legacy.reply, null, '没有包的那条什么都不说，不替他说「没问题」')
  // 界面上只放第一行，整段进 title
  assert.equal(replyDomain.replyRowText(written.reply), '他说：第 3 张背景色偏了…')
  assert.match(replyDomain.replyRowTitle(written.reply), /第 5 张再亮一点/)
  assert.match(replyDomain.replyRowTitle(written.reply), /包里没有/)
  assert.equal(replyDomain.replyRowText(null), '')
  assert.match(replyDomain.replySavedAt(written.reply), /^记于 \d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(replyDomain.replySavedAt({ text: '话', at: '' }), '', '时间读不出来就不硬编一个')
})
