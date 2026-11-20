// 评审页首屏「读到了没有」（r274 / v0.9.256）。
// 2026-11-20 之前的状态与模板库挤在一个 Promise.all 里：模板库一失手，评审状态一起丢掉，
// 页面接着写「评审模型 未配置」「0 个模板首帧」「模板库还是空的」，还把「开始评审」锁死。
// 这里守两件事：读不到不许说成「没有」，一个接口失手不许连带另一个。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  pickedReadiness,
  reviewReadiness,
  readNotice,
  statusReadOf,
  templateShelf,
  templatesReadOf,
  failureText,
  STATUS_FALLBACK,
} from '../src/domain/review-ready.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'ReviewPage.tsx'), 'utf8')

const OK = { service: true, serviceUrl: 'http://127.0.0.1:6300', model: true, profiles: ['visual-baseline'] }

test('异常取话：Error 用它的 message，字符串去掉空白，取不到才用兜底句', () => {
  assert.equal(failureText(new Error('评审服务暂时连不上'), '兜底'), '评审服务暂时连不上')
  assert.equal(failureText('  模板库没读到  ', '兜底'), '模板库没读到')
  assert.equal(failureText(new Error('   '), '兜底'), '兜底')
  assert.equal(failureText({}, '兜底'), '兜底')
  assert.equal(failureText(undefined, '兜底'), '兜底')
  // 不许出现把对象/空异常写成这两种字
  assert.equal(failureText({ code: 'ECONNRESET' }, '兜底'), '兜底')
  assert.ok(!failureText(new Error(''), '兜底').includes('Error'))
})

test('评审状态：拿不到值是「读失败」，不是「模型没配」', () => {
  const failed = statusReadOf(null)
  assert.equal(failed.state, 'failed')
  assert.equal(failed.message, STATUS_FALLBACK)
  assert.ok(!failed.message.includes('未配置'))
})

test('评审状态：带 reason 一律算读失败，原话优先', () => {
  const failed = statusReadOf(OK, '接口 502')
  assert.equal(failed.state, 'failed')
  assert.equal(failed.message, '接口 502')
})

test('评审状态：正常返回就是读到了，原样带出去', () => {
  const read = statusReadOf(OK)
  assert.equal(read.state, 'ok')
  assert.deepEqual(read.status, OK)
})

test('模板库：没有 items 数组算读失败，不许数成 0 条', () => {
  assert.equal(templatesReadOf({}).state, 'failed')
  assert.equal(templatesReadOf(null).state, 'failed')
  const empty = templatesReadOf({ items: [] })
  assert.equal(empty.state, 'ok')
  assert.equal(empty.count, 0)
  const some = templatesReadOf({ items: [{ id: 'a' }, { id: 'b' }] })
  assert.equal(some.state, 'ok')
  assert.equal(some.count, 2)
})

test('读不到评审状态：胶囊说没读到，按钮照样能点，页尾不猜「平台视觉模型」', () => {
  const ready = reviewReadiness({ read: statusReadOf(null) })
  assert.equal(ready.canRun, true)
  assert.equal(ready.engineLabel, '状态没读到')
  assert.equal(ready.modelLabel, '状态没读到')
  assert.equal(ready.engineTone, 'warn')
  assert.equal(ready.modelTone, 'warn')
  assert.equal(ready.holdReason, '')
  assert.ok(!ready.modelLabel.includes('未配置'), '读不到不能写成未配置')
  assert.ok(!ready.engineNote.includes('平台视觉模型'), '不知道谁出结论就别替它认')
})

test('读到了、模型可用：胶囊说可用，按钮能点，页尾说清是谁出结论', () => {
  const ready = reviewReadiness({ read: statusReadOf(OK) })
  assert.equal(ready.canRun, true)
  assert.equal(ready.engineLabel, '本地服务')
  assert.equal(ready.modelLabel, '可用')
  assert.equal(ready.modelTone, 'pass')
  assert.equal(ready.holdReason, '')
  assert.ok(ready.engineNote.includes('本地评审服务'))
})

test('读到了、模型没配：按钮点不了，但给出的原因是「没配置」，并写在 title 上', () => {
  const ready = reviewReadiness({ read: statusReadOf({ ...OK, model: false }) })
  assert.equal(ready.canRun, false)
  assert.equal(ready.modelLabel, '未配置')
  assert.equal(ready.modelTone, 'fail')
  assert.ok(ready.holdReason.includes('没配置'))
})

test('另一只探针说模型此刻不可用：按钮点不了，胶囊说暂时不可用', () => {
  const ready = reviewReadiness({ read: statusReadOf(OK), modelBlocked: true })
  assert.equal(ready.canRun, false)
  assert.equal(ready.modelLabel, '暂时不可用')
  assert.equal(ready.modelTone, 'fail')
  assert.ok(ready.holdReason.includes('暂时不可用'))
})

test('还没读到（首屏那一两帧）：说读取中，不抢先说未配置，也不锁按钮', () => {
  const ready = reviewReadiness({ read: null })
  assert.equal(ready.canRun, true)
  assert.equal(ready.engineLabel, '读取中')
  assert.equal(ready.modelLabel, '读取中')
  assert.equal(ready.holdReason, '')
})

test('模板库读不到：开关说没读到、空状态说没读到，都不许说「还是空的」', () => {
  const shelf = templateShelf(templatesReadOf(null, '模板库没读到'))
  assert.equal(shelf.toggle, '模板首帧没读到')
  assert.ok(shelf.emptyNote.length > 0)
  assert.ok(!shelf.emptyNote.includes('还是空的'))
  assert.ok(shelf.emptyNote.includes('不是库空了'))
})

test('模板库真读到空：才说「还是空的」；读到 N 条就数 N', () => {
  const empty = templateShelf(templatesReadOf({ items: [] }))
  assert.ok(empty.emptyNote.includes('还是空的'))
  const some = templateShelf(templatesReadOf({ items: [{}, {}, {}] }))
  assert.equal(some.toggle, '3 个模板首帧')
  assert.equal(some.emptyNote, '')
  // 还没读到时也不写「0 个」
  assert.equal(templateShelf(null).toggle, '模板首帧')
})

test('提醒：只读不到一件就说一件；两件都失手就一句话说完，+ 原始原因留给内部', () => {
  const onlyShelf = readNotice({ status: statusReadOf(OK), templates: templatesReadOf(null, '模板库 502') })
  assert.ok(onlyShelf.text.includes('模板库'))
  assert.ok(!onlyShelf.text.includes('评审服务状态'))
  assert.equal(onlyShelf.detail, '模板库 502')

  const both = readNotice({ status: statusReadOf(null, '健康检查 502'), templates: templatesReadOf(null) })
  assert.ok(both.text.includes('评审服务状态'))
  assert.ok(both.text.includes('模板库'))
  assert.ok(both.detail.includes('健康检查 502'))

  const none = readNotice({ status: statusReadOf(OK), templates: templatesReadOf({ items: [] }) })
  assert.equal(none.text, '')
  assert.equal(none.detail, '')
})

test('评审页真的按这套判据渲染：两条接口分开认，读不到走提醒 + 重新读取', () => {
  // 两条接口不许再挤在同一个 Promise.all 里（那正是「模板库失手 → 模型写成未配置」的来源）
  assert.ok(!page.includes('Promise.all([getReviewStatus()'), '状态与模板库必须分开读')
  assert.ok(page.includes('Promise.allSettled('), '分开读用 allSettled')
  for (const call of ['reviewReadiness(', 'readNotice(', 'templateShelf(', 'statusReadOf(', 'templatesReadOf(']) {
    assert.ok(page.includes(call), '评审页必须走 ' + call)
  }
  assert.ok(page.includes('重新读取'), '读不到要留一条重试')
  assert.ok(page.includes('disabled={running || !readiness.canRun || !pickedState.canRun}'), '按钮能不能点看读到的状态与挑到的画面')
  assert.ok(page.includes('pickedReadiness('), '画面有没有、能不能评，也走同一套判据')
  // 页面里不许再有这两句假话
  assert.ok(!page.includes("templates.length} 个模板首帧"), '模板规则由 domain 给，不在这儿现拼 0')
  assert.ok(!page.includes('status?.model ? (modelBlocked ?'), '胶囊文案由 domain 给')
})
test('挑到的画面是空的：不许说成「画面不在了」，也不许让人点开始评审', () => {
  const empty = pickedReadiness({ label: '脚本模板' })
  assert.equal(empty.canRun, false)
  assert.equal(empty.tone, 'none')
  assert.equal(empty.title, '这一条没有可评的画面')
  assert.ok(!empty.copy.includes('已经不在了'))
  assert.ok(empty.holdReason.includes('空的'))
  // 模板只给了空串（没抽到首帧）也是同一个判据
  assert.equal(pickedReadiness({ media: '', imageUrl: '', preview: '' }).tone, 'none')
})

test('有画面、打得开：什么都不用说，可以评', () => {
  const ready = pickedReadiness({ media: 'media/x.png', preview: '/media/x.png' })
  assert.equal(ready.canRun, true)
  assert.equal(ready.tone, 'ready')
  assert.equal(ready.title, '')
  assert.equal(ready.holdReason, '')
})

test('原图没了但结论还在：说结论与锚点仍然有效；还没评过就说这张图打不开', () => {
  const afterReview = pickedReadiness({ media: 'media/x.png', preview: '/media/x.png', broken: true, hasResult: true })
  assert.equal(afterReview.tone, 'broken')
  assert.equal(afterReview.title, '评审时的画面已经不在了')
  assert.ok(afterReview.copy.includes('锚点仍然有效'))
  assert.equal(afterReview.canRun, true)

  const beforeReview = pickedReadiness({ imageUrl: 'https://example.test/a.jpg', preview: 'https://example.test/a.jpg', broken: true })
  assert.equal(beforeReview.tone, 'broken')
  assert.equal(beforeReview.title, '这张图打不开')
  assert.ok(!beforeReview.copy.includes('锚点'))
})

test('评审页的画面区按这三档渲染，不再用「有没有 preview」当唯一判据', () => {
  assert.ok(page.includes("pickedState.tone === 'ready' ? ("), '画面区按 tone 渲染')
  assert.ok(page.includes('{pickedState.title}') && page.includes('{pickedState.copy}'), '没画面时说的那两行来自 domain')
  assert.ok(!page.includes('{picked.preview && !previewBroken ? ('), '旧的二元判断必须退场')
})
