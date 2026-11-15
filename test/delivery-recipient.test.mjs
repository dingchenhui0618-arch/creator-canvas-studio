import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 这一条是给谁的（v0.9.152）。
// r145–r151 一路在判断「他收到没有」，可这些判断都默认「我心里有数是发给谁的」；
// 同时交出去两三份时，工作台那几行只剩版次与天数，分不出哪一条给王老师、哪一条给甲方。
// 这一组盯五件事：
//   1) 写一个称呼只动这一项：包、收据、链接、回执都不动，作品排序照常推进（写的人是发件人）；
//   2) 同一个称呼再存一次不写盘（字节不变），空串 = 清掉，字段真的消失；
//   3) 归一化：去控制字符、空白压一个、按字截到 24（emoji 不被劈开）；
//   4) 接口照实回：405 / 400 太长 / 400 不是字符串 / 404 没有这一条；清空也走得通；
//   5) 称呼只在发件人这一侧：回执页拿不到它，工作台那一行读得到，复制出去的那几段话用它开头。

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-recipient-'))
process.env.DATA_DIR = DIR
process.env.VQ_KEY_SECRET = 'test-secret-delivery-recipient'

const SHA = 'ab12cd34ef56' + 'b'.repeat(52)
const ZIP = 'VisionQA-这一条给谁-第-3-版-v3-20261115.zip'
const pkg = { bytes: 234567, sha256: SHA, fileName: ZIP, savedAt: '2026-11-14T06:00:00.000Z' }
const ID_WRITE = 'ef56ef56ef561001'
const ID_SAME = 'ef56ef56ef561002'
const ID_CLEAR = 'ef56ef56ef561003'
const ID_ENDPOINT = 'ef56ef56ef561004'
const TOKEN_ENDPOINT = 'a1b2c3d4e5f60789'

function project(id, title, deliveries, updatedAt = '2026-11-14T06:00:00.000Z') {
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

const base = { version: 3, at: '2026-11-11T06:00:00.000Z', package: pkg }

fs.writeFileSync(
  path.join(DIR, 'projects.json'),
  JSON.stringify([
    // 还没写收件人：写一个称呼
    project('prj_write', '还没写收件人', [{ ...base, id: ID_WRITE, receiptToken: 'b1c2d3e4f5061728', receiptLinkAt: base.at }]),
    // 已经写着同一个称呼：再存一次不该写盘
    project('prj_same', '写着同一个称呼', [{ ...base, id: ID_SAME, recipient: '王老师 · 内容组' }]),
    // 写过、要清掉
    project('prj_clear', '要清掉的那一条', [{ ...base, id: ID_CLEAR, recipient: '李工' }]),
    // 接口那一侧：有包、有回执链接、还没贴过收据
    project('prj_endpoint', '接口那一侧', [
      { ...base, id: ID_ENDPOINT, receiptToken: TOKEN_ENDPOINT, receiptLinkAt: base.at },
    ]),
    // 升级前的老交付没有封存包：就算盘上写着称呼也不该读出来
    project('prj_nopkg', '没有包的老交付', [
      { version: 2, at: '2026-11-10T06:00:00.000Z', recipient: '不该读出来的名字' },
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
const recipientDomain = await import('../src/domain/delivery-recipient.ts')
const askDomain = await import('../src/domain/delivery-ask.ts')
const resendDomain = await import('../src/domain/delivery-resend.ts')
const relinkDomain = await import('../src/domain/delivery-relink.ts')
const waitDomain = await import('../src/domain/delivery-wait.ts')

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

test('写一个称呼：只动这一项，包、收据、链接、回执都不动', async () => {
  const before = readProject('prj_write')
  // 写之前先记下别的项目长什么样：写一个称呼不该顺手改到别处
  const sameBefore = JSON.stringify(readProject('prj_same'))
  const saved = await store.saveDeliveryRecipient('prj_write', ID_WRITE, '  王老师  ·  内容组  ')
  assert.equal(saved.changed, true)
  assert.equal(saved.recipient, '王老师 · 内容组', '空白压成一个、首尾去掉')

  const after = readProject('prj_write')
  assert.equal(after.deliveries[0].recipient, '王老师 · 内容组')
  assert.notEqual(after.updatedAt, before.updatedAt, '写的人是发件人：作品排序照常推进')
  assert.deepEqual(after.deliveries[0].package, pkg, '包一个字节都没动')
  assert.equal(after.deliveries[0].receiptToken, 'b1c2d3e4f5061728', '链接没换')
  assert.equal(after.deliveries[0].receipt, undefined, '没有顺手记一张收据')
  assert.equal(after.deliveries[0].ack, undefined, '也不该当成他点过「收到了」')
  // 别的项目一个字节都没变（这一条以写之前取到的快照为准）
  assert.equal(JSON.stringify(readProject('prj_same')), sameBefore, '只动这一条交付')
})

test('同一个称呼再存一次：changed=false，一个字节都不改', async () => {
  const before = readRaw()
  const saved = await store.saveDeliveryRecipient('prj_same', ID_SAME, '王老师 · 内容组')
  assert.equal(saved.changed, false, '本来就写着这个称呼')
  assert.equal(saved.recipient, '王老师 · 内容组')
  assert.equal(readRaw(), before, '再点一次保存不该写盘')
})

test('清掉：字段真的消失，回到「没写收件人」', async () => {
  assert.equal(readProject('prj_clear').deliveries[0].recipient, '李工')
  const saved = await store.saveDeliveryRecipient('prj_clear', ID_CLEAR, '   ')
  assert.equal(saved.changed, true)
  assert.equal(saved.recipient, '')
  const after = readProject('prj_clear')
  assert.equal('recipient' in after.deliveries[0], false, '空串不留在盘上')
  assert.deepEqual(after.deliveries[0].package, pkg, '清称呼不动包')
})

test('归一化：控制字符换成空格、空白压成一个、按字截到 24', () => {
  assert.equal(recipientDomain.normalizeRecipient(' 王老师\n\t·  内容组 '), '王老师 · 内容组')
  assert.equal(recipientDomain.normalizeRecipient(null), '')
  assert.equal(recipientDomain.normalizeRecipient(undefined), '')
  // 按码点截：30 个「字」截成 24 个，不按 UTF-16 长度切
  assert.equal(recipientDomain.normalizeRecipient('王'.repeat(30)).length, 24)
  const emoji = recipientDomain.normalizeRecipient('😀'.repeat(30))
  assert.equal(Array.from(emoji).length, 24, '按字算，不是按 UTF-16 单元算')
  assert.equal(emoji.includes('\uFFFD'), false, '不能被劈成半个字符')
  // 24 个字够写「王老师 · 内容组 · 甲方市场部」这种称呼，超出的部分截掉
  const long = recipientDomain.normalizeRecipient('王老师 · 内容组 · 甲方市场部 · 秋季campaign')
  assert.equal(Array.from(long).length, 24)
  assert.equal(long.startsWith('王老师 · 内容组'), true)
})

test('读盘：没有封存包的老交付不认这一项', async () => {
  const legacy = (await store.getProject('prj_nopkg')).deliveries[0]
  assert.equal(legacy.recipient, undefined, '没有包就没有「发给谁」可谈')
  const written = (await store.getProject('prj_write')).deliveries[0]
  assert.equal(written.recipient, '王老师 · 内容组')
})

test('接口：写 / 同一个再存一次 / 清空，都用同一条路径', async () => {
  const router = createProjectsRouter()
  const url = '/api/projects/prj_endpoint/delivery-packages/' + ID_ENDPOINT + '/recipient'

  const first = await call(router, url, { method: 'POST', body: { recipient: '李工' } })
  assert.equal(first.status, 200, '写一个称呼不该失败：' + first.status + ' ' + first.body)
  assert.deepEqual(JSON.parse(first.body), { ok: true, changed: true, recipient: '李工' })

  const again = await call(router, url, { method: 'POST', body: { recipient: '李工' } })
  assert.equal(again.status, 200)
  assert.equal(JSON.parse(again.body).changed, false)

  const cleared = await call(router, url, { method: 'POST', body: { recipient: '' } })
  assert.equal(cleared.status, 200)
  assert.deepEqual(JSON.parse(cleared.body), { ok: true, changed: true, recipient: '' })
  assert.equal('recipient' in readProject('prj_endpoint').deliveries[0], false)
})

test('接口：方法 / 太长 / 不是字符串 / 没有这一条，各自照实回', async () => {
  const router = createProjectsRouter()
  const url = '/api/projects/prj_endpoint/delivery-packages/' + ID_ENDPOINT + '/recipient'

  const get = await call(router, url)
  assert.equal(get.status, 405, '读它不该走这一条：')

  const tooLong = await call(router, url, { method: 'POST', body: { recipient: '王'.repeat(25) } })
  assert.equal(tooLong.status, 400)
  assert.equal(JSON.parse(tooLong.body).code, 'RECIPIENT_TOO_LONG')

  const notString = await call(router, url, { method: 'POST', body: { recipient: 42 } })
  assert.equal(notString.status, 400)
  assert.equal(JSON.parse(notString.body).code, 'RECIPIENT_INVALID')

  const missing = await call(router, '/api/projects/prj_write/delivery-packages/ef56ef56ef569999/recipient', {
    method: 'POST',
    body: { recipient: '王老师' },
  })
  assert.equal(missing.status, 404, '没有这一条交付')
  const noProject = await call(router, '/api/projects/prj_none/delivery-packages/ef56ef56ef561001/recipient', {
    method: 'POST',
    body: { recipient: '王老师' },
  })
  assert.equal(noProject.status, 404, '没有这条作品')
  // 被拦住的那几次都没写盘
  assert.equal(readProject('prj_endpoint').deliveries[0].recipient, undefined)
})

test('回执页拿不到称呼：那是发件人自己记的一行字', async () => {
  const router = createProjectsRouter()
  await call(router, '/api/projects/prj_endpoint/delivery-packages/' + ID_ENDPOINT + '/recipient', {
    method: 'POST',
    body: { recipient: '李工' },
  })
  const res = await call(router, '/api/receipts/' + TOKEN_ENDPOINT)
  assert.equal(res.status, 200)
  assert.equal(res.body.includes('李工'), false, '拿到链接的人看不到发件人怎么称呼别人')
  const view = JSON.parse(res.body)
  assert.equal(view.project.title, '接口那一侧', '该给的还是给了：这是哪一份')
})

test('工作台那一行读得到称呼：写了的写「给谁」，没写的什么都不写', async () => {
  const projects = await store.listProjects()
  const rows = ledgerRows({ projects })
  const written = rows.find((row) => row.projectId === 'prj_write')
  assert.equal(written.recipient, '王老师 · 内容组')
  const legacy = rows.find((row) => row.projectId === 'prj_nopkg')
  assert.equal(legacy.recipient, '', '没有包的那条什么也不写，不猜')
  // 界面读它拼成「给王老师」；没写就是空串，调用方不渲染这一段
  assert.equal(recipientDomain.recipientText(written.recipient), '给王老师 · 内容组')
  assert.equal(recipientDomain.recipientText(''), '')
  assert.match(recipientDomain.recipientTitle('王老师'), /包里没有/)
})

test('复制出去的那几段话用它开头；没写就不加称呼', () => {
  const baseInput = {
    title: '秋季上新的那条片子',
    version: 3,
    fileName: ZIP,
    bytes: pkg.bytes,
    at: base.at,
    link: 'https://visionqa.example/#/receipt/' + TOKEN_ENDPOINT,
  }
  const greet = recipientDomain.recipientGreeting('王老师')
  assert.equal(greet, '王老师，')

  const ask = askDomain.deliveryAskMessage({ ...baseInput, recipient: '王老师' })
  assert.equal(ask.startsWith('王老师，'), true, '称呼在前：' + ask.slice(0, 20))
  const askPlain = askDomain.deliveryAskMessage(baseInput)
  assert.equal(askPlain.startsWith('王老师'), false, '没写称呼就不加，也不写「你好」')
  assert.equal(askPlain.startsWith('秋季上新的那条片子'), true)

  const resend = resendDomain.deliveryResendMessage({ ...baseInput, recipient: '王老师' })
  assert.equal(resend.startsWith('王老师，'), true)
  const relink = relinkDomain.deliveryRelinkMessage({ ...baseInput, recipient: '王老师' })
  assert.equal(relink.startsWith('王老师，'), true)
  const remind = waitDomain.deliveryReminderText({ ...baseInput, recipient: '王老师' })
  assert.equal(remind.startsWith('王老师，'), true)
  // 称呼后面那一段还是原来那句话：不因为加了开头就少说「哪一份、哪天发的」
  assert.match(ask, /第 v3 版那份包/)
  assert.match(remind, /还等你验一下/)
  assert.match(resend, /再发一次/)
  assert.match(relink, /换了一条新的/)
})
