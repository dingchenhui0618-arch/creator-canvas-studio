// 回执链接「没读回来」的三种情形（r275 / v0.9.257）。
// 2026-11-20 之前，除了 410（旧地址换成新的）以外，其余失败一律被写成「这条回执链接不在了」，
// 于是断网、服务重启、5xx 都会让收包人回头找发件人要一条新链接——而发件人手上那条一直是好的。
// 这里守两件事：只有服务端明确说没有（404）才叫「不在了」；其它情况都能原地再试一次。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { receiptLinkFail, receiptLinkRead } from '../src/domain/receipt-link-read.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'ReceiptPage.tsx'), 'utf8')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'receipt-page.css'), 'utf8')

const httpError = (status, body = {}, message = 'HTTP ' + status) => Object.assign(new Error(message), { status, body })

test('换掉的旧地址：410 一个人就够，带不带 retiredAt 都算换过', () => {
  const withAt = receiptLinkRead(httpError(410, { code: 'LINK_RETIRED', retiredAt: '2026-11-18T02:00:00.000Z' }))
  assert.equal(withAt.kind, 'retired')
  assert.equal(withAt.retiredAt, '2026-11-18T02:00:00.000Z')
  const bare = receiptLinkRead(httpError(410, {}))
  assert.equal(bare.kind, 'retired')
  assert.equal(bare.retiredAt, '')
  // 有码没状态也认：服务端换过说法时仍按「换成新的」讲，不许掉进「不在了」
  assert.equal(receiptLinkRead(httpError(409, { code: 'LINK_RETIRED' })).kind, 'retired')
})

test('真不在了：只有 404 这么说，且说清「找发件人要新的、包不用重下」', () => {
  const gone = receiptLinkRead(httpError(404, { error: '这条回执链接不在了：找发件人要一条新的' }))
  assert.equal(gone.kind, 'gone')
  assert.equal(gone.title, '这条回执链接不在了')
  assert.match(gone.note, /找发件人要一条新的回执链接/)
  assert.match(gone.note, /包不用重下/)
  // 服务端那句与标题重复，就不再摆第二遍
  assert.equal(gone.detail, '')
})

test('真不在了：服务端给了别的说法就照原话留一行，但只留人话', () => {
  const odd = receiptLinkRead(httpError(404, { error: '这一份交付已经收回' }))
  assert.equal(odd.detail, '这一份交付已经收回')
  // 代理回的裸状态码 / 空串不算「说法」
  assert.equal(receiptLinkRead(httpError(404, { error: 'HTTP 404' })).detail, '')
  assert.equal(receiptLinkRead(httpError(404, {})).detail, '')
})

test('服务临时出错：5xx 是「这一下没打开」，可以再试，不许说成链接没了', () => {
  const broken = receiptLinkRead(httpError(500))
  assert.equal(broken.kind, 'unreadable')
  assert.equal(broken.title, '这一下没打开')
  assert.equal(broken.retry, '再试一次')
  assert.equal(broken.detail, 'HTTP 500')
  assert.match(broken.copy, /服务临时出了错/)
  assert.match(broken.copy, /链接本身没问题/)
  assert.match(broken.note, /手上的包不用重下/)
  // 整段话里一个字都不许让人以为链接废了、要换一条
  const all = broken.title + broken.copy + broken.note + broken.detail
  assert.ok(!all.includes('不在了'))
  assert.ok(!all.includes('失效'))
  assert.ok(!all.includes('换成新'))
})

test('断网：状态 0 按「没连上」讲，细节写「网络没连上」', () => {
  const offline = receiptLinkRead(Object.assign(new Error('连不上服务：检查网络后重试。'), { status: 0, network: true }))
  assert.equal(offline.kind, 'unreadable')
  assert.equal(offline.detail, '网络没连上')
  assert.match(offline.copy, /没连上/)
  // 抛字符串 / 抛 null 也走同一条：认不出来就是没读到
  const thrown = receiptLinkRead('Failed to fetch')
  assert.equal(thrown.kind, 'unreadable')
  assert.equal(thrown.detail, '网络没连上')
  assert.equal(receiptLinkRead(undefined).kind, 'unreadable')
  assert.equal(receiptLinkRead({}).kind, 'unreadable')
})

test('其余状态码（401 / 405 / 400 / 502）都不许冒充「链接不在了」', () => {
  for (const status of [400, 401, 405, 409, 418, 502, 503]) {
    const read = receiptLinkRead(httpError(status, { code: 'SOME_INTERNAL_CODE' }))
    assert.equal(read.kind, 'unreadable', 'HTTP ' + status + ' 应该是没读到')
    assert.equal(read.detail, 'HTTP ' + status)
    assert.ok(!read.detail.includes('SOME_INTERNAL_CODE'))
    assert.ok(!read.title.includes('不在了'))
  }
})

test('整理形状：status 认不出就当 0（网络），码与时刻只收字符串', () => {
  const fail = receiptLinkFail({ status: 'abc', body: { code: 500, retiredAt: 123 }, message: 'x' })
  assert.equal(fail.status, 0)
  assert.equal(fail.code, '')
  assert.equal(fail.retiredAt, '')
  assert.equal(fail.network, true)
  assert.equal(fail.message, 'x')
})

test('页面：三档分开渲染，失败时给「再试一次」，不许再有 missing 这一档', () => {
  assert.match(page, /receiptLinkRead\(/)
  assert.match(page, /fail\?\.kind === 'retired'/)
  assert.match(page, /fail\?\.kind === 'gone'/)
  assert.match(page, /fail\?\.kind === 'unreadable'/)
  assert.match(page, /onClick=\{retry\}/)
  assert.match(page, /\{fail\.retry\}/)
  assert.match(page, /\}, \[token, reload\]\)/)
  assert.ok(!page.includes("status === 'missing'"))
  assert.ok(!page.includes("setStatus('missing')"))
  assert.ok(!page.includes(['const [message, setMessage]'].join('')))
  // 「这一下没打开」用警示色，不用错红色：红色等于告诉收包人这条废了
  assert.match(css, /\.rpage-state\.is-unreadable svg \{ color: var\(--warn\); \}/)
  // 窄屏按钮 44px：手指点得到
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.rpage-button \{ height: 44px; \}/)
})
