// 无限画布状态条「你现在在哪块画布上」的三条判据（r273 / v0.9.255）。
// 以前读不到画布列表时，这一页会说「暂无已保存的画布」，还把上次打开的那块从本地记忆里抹掉——
// 一次接口抖动被说成「你还没有画布」，画布 iframe 随之退回它自己的默认内容。
// 这里守的是纯判据：读不到就保留记忆、给重试；读到了但上次那块不在了，要明说换了哪块。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  CANVAS_LIST_FALLBACK,
  boardCanvasLabel,
  canvasListRead,
  canvasNotice,
  resolveBoardCanvas,
} from '../src/domain/board-canvas.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OK = { state: 'ok' }
const FAIL = { state: 'failed', message: '无限画布暂时连不上：作品、模板、评审、交付都不受影响；过一会儿刷新再试。' }
const row = (id, name, nodeCount = 3) => ({ id, name, nodeCount, revision: 1, updatedAt: 0 })

test('200 但 ok:false 也算没读到，用服务端那句中文，不套第二层前缀', () => {
  const read = canvasListRead({ ok: false, error: FAIL.message })
  assert.equal(read.state, 'failed')
  assert.equal(read.message, FAIL.message)
})

test('HTTP 抛错：消息照用；消息是空的时候也不许留一句空白', () => {
  assert.equal(canvasListRead(null, new Error('网络断了')).state, 'failed')
  assert.equal(canvasListRead(null, new Error('网络断了')).message, '网络断了')
  assert.equal(canvasListRead(null, new Error('')).message, CANVAS_LIST_FALLBACK)
  assert.equal(canvasListRead(null, undefined).message, CANVAS_LIST_FALLBACK)
})

test('读成功就是 ok：空列表也是 ok（「你还没有画布」只有真的读到了才配说）', () => {
  assert.deepEqual(canvasListRead({ ok: true, canvases: [] }), OK)
  assert.deepEqual(canvasListRead({ ok: true, canvases: [row('vq-a', 'A')] }), OK)
})

test('读不到列表时照上次那块打开，绝不把记忆清空', () => {
  const choice = resolveBoardCanvas({ remembered: 'vq-a', listed: [], read: FAIL })
  assert.equal(choice.canvasId, 'vq-a')
  assert.equal(choice.missing, false)
  assert.equal(choice.stale, false)
})

test('读不到列表但链接点名了画布：按链接那块打开', () => {
  const choice = resolveBoardCanvas({ boardId: 'vq-b', remembered: 'vq-a', listed: [], read: FAIL })
  assert.equal(choice.canvasId, 'vq-b')
})

test('读不到列表也没有记忆：空串，不编一块画布出来', () => {
  assert.equal(resolveBoardCanvas({ remembered: '', listed: [], read: FAIL }).canvasId, '')
})

test('读到了、上次那块还在：原地不动', () => {
  const choice = resolveBoardCanvas({ remembered: 'vq-b', listed: [row('vq-a', 'A'), row('vq-b', 'B')], read: OK })
  assert.deepEqual(choice, { canvasId: 'vq-b', missing: false, stale: false })
})

test('读到了、上次那块没了：落到列表第一块，但标出 stale（不悄悄换画布）', () => {
  const choice = resolveBoardCanvas({ remembered: 'vq-gone', listed: [row('vq-a', 'A')], read: OK })
  assert.deepEqual(choice, { canvasId: 'vq-a', missing: false, stale: true })
})

test('链接点名的那块没了：整页说明（missing），不混成 stale', () => {
  const choice = resolveBoardCanvas({ boardId: 'vq-gone', remembered: '', listed: [row('vq-a', 'A')], read: OK })
  assert.deepEqual(choice, { canvasId: 'vq-a', missing: true, stale: false })
})

test('一块画布都没有、也没有记忆：空串', () => {
  assert.equal(resolveBoardCanvas({ remembered: '', listed: [], read: OK }).canvasId, '')
})

test('状态条提醒：一次只说一句，stale 要说出换成了哪块', () => {
  assert.equal(canvasNotice({ read: FAIL, choice: { stale: false, canvasId: 'vq-a' }, listed: [] }), FAIL.message)
  assert.equal(
    canvasNotice({ read: OK, choice: { stale: true, canvasId: 'vq-a' }, listed: [row('vq-a', '双十一主图')] }),
    '上次那块画布不在了，已先打开「双十一主图」',
  )
  // 换了但没有别的画布可换：不许写「已打开」
  const none = canvasNotice({ read: OK, choice: { stale: true, canvasId: '' }, listed: [] })
  assert.equal(none, '上次那块画布不在了，这个账号下现在没有别的画布')
  assert.ok(!none.includes('已先打开'))
  assert.equal(canvasNotice({ read: OK, choice: { stale: false, canvasId: 'vq-a' }, listed: [row('vq-a', 'A')] }), '')
})

test('选择器上的名字：读不到就不编名字', () => {
  assert.equal(boardCanvasLabel({ read: FAIL, canvases: [], canvasId: 'vq-a' }), '上次那块画布（名字没读到）')
  assert.equal(boardCanvasLabel({ read: FAIL, canvases: [], canvasId: '' }), '画布列表没读到')
  assert.equal(boardCanvasLabel({ read: OK, canvases: [], canvasId: '' }), '暂无已保存的画布')
  assert.equal(boardCanvasLabel({ read: OK, canvases: [row('vq-a', 'A', 7)], canvasId: 'vq-a' }), 'A · 7 节点')
  assert.equal(boardCanvasLabel({ read: OK, canvases: [row('vq-a', 'A')], canvasId: '' }), '未指定（默认画布）')
})

test('画布页真的按这几条判据渲染：读不到时给重试、选择器收起来', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'BoardPage.tsx'), 'utf8')
  assert.match(source, /resolveBoardCanvas\(/, '落点要走 domain/board-canvas 的判据')
  assert.match(source, /canvasListRead\(/, '两种失败都要折成状态')
  assert.match(source, /bd-warn/, '读不到时状态条上要有一条提醒')
  assert.match(source, /disabled=\{listFailed\}/, '读不到列表时选择器不能再装作能挑')
  assert.match(source, /onClick=\{retryList\}/, '读不到要有一条重试的路')
  // 读失败的分支里不许出现「暂无已保存的画布」：那句只配在真的读到空列表时说
  const failedBranch = source.slice(source.indexOf('listFailed ? ('), source.indexOf('<CanvasQueueChip'))
  assert.ok(!failedBranch.includes('暂无已保存的画布'), '读失败时不能写「暂无已保存的画布」')
})
