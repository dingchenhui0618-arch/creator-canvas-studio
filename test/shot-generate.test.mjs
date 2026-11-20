// 分镜逐镜出图（r276 / v0.9.258）。这一组盯的是「花钱那一步不许说错话」：
//   1) 只有点一下才出图，进页面、展开提示词都不许发请求；
//   2) 处理中要能看出进度，不能假装完成；
//   3) 失败要分清「余额不足（去充值）」「上游抖动」「图没取回来」三种，
//      钱退没退按服务端记的账说，不按界面猜；
//   4) 任务号都没回来时不许写「可以重试」——那张图可能已经在画了；
//   5) 比例只挑上游认的，不传一个会被拒的值。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  SHOT_GEN_ATTACH_FAILED,
  SHOT_GEN_WAIT_MS,
  shotGenFailNote,
  shotGenFileName,
  shotGenPriceLabel,
  shotGenRatio,
  shotGenView,
} from '../src/domain/shot-generate.ts'

const task = (patch = {}) => ({
  id: 'task_abc',
  status: 'processing',
  progress: 0,
  error: '',
  file: null,
  downloadUrl: '',
  credits: { cost: 5, balance: 95, refunded: false, refundedAt: null },
  ...patch,
})

test('处理中：给出进度，进度缺失也不假装完成', () => {
  assert.deepEqual(shotGenView(task({ progress: 42 })), { state: 'running', progress: 42, label: '出图中 42%' })
  assert.deepEqual(shotGenView(task({ progress: null })), { state: 'running', progress: 0, label: '正在提交…' })
  // 99 封顶：服务端说 100% 也还没到 succeeded，不能显示成 100% 让人以为好了
  assert.equal(shotGenView(task({ progress: 100 })).progress, 99)
  assert.equal(shotGenView(task({ progress: -3 })).progress, 0)
  assert.equal(shotGenView(task({ progress: 'NaN' })).progress, 0)
})

test('画好了才叫 ready，而且必须带得回下载地址', () => {
  const ready = shotGenView(task({ status: 'succeeded', downloadUrl: '/api/media/tasks/task_abc/file', file: { mime: 'image/webp', bytes: 1024 } }))
  assert.equal(ready.state, 'ready')
  assert.equal(ready.downloadUrl, '/api/media/tasks/task_abc/file')
  assert.equal(ready.mime, 'image/webp')
  // 成功但没地址：说清楚从哪儿去拿，不许说「可以重试」
  const lost = shotGenView(task({ status: 'succeeded', downloadUrl: '' }))
  assert.equal(lost.state, 'failed')
  assert.match(lost.message, /最近生成/)
  assert.doesNotMatch(lost.message, /重试/)
})

test('失败：余额不足叫去充值，别的错误说实际原因', () => {
  const poor = shotGenView(task({ status: 'failed', error: '积分不足：这一下要 5 积分，现在剩 2', credits: { cost: 5, balance: 2, refunded: false, refundedAt: null } }))
  assert.equal(poor.state, 'failed')
  assert.equal(poor.topUp, true)
  assert.equal(poor.refunded, false)
  assert.equal(shotGenFailNote(poor), '余额不够：去「充值」页选一档就能到账，不用重试等它自己好。')

  const up = shotGenView(task({ status: 'failed', error: '上游忙，这一下没出图', credits: { cost: 5, balance: 95, refunded: true, refundedAt: '2026-11-20T05:00:00.000Z' } }))
  assert.equal(up.topUp, false)
  assert.equal(up.refunded, true)
  assert.equal(shotGenFailNote(up), '本次 5 积分已原样退回，没有产生消耗。')

  // 花了钱、没退：不许说「没有消耗」
  const spent = shotGenView(task({ status: 'failed', error: '上游超时', credits: { cost: 5, balance: 95, refunded: false, refundedAt: null } }))
  assert.equal(spent.refunded, false)
  assert.match(shotGenFailNote(spent), /还没退/)
  assert.doesNotMatch(shotGenFailNote(spent), /没有产生消耗/)
})

test('任务号都没回来：先让人去最近生成看，不许叫人直接再点一次', () => {
  for (const empty of [null, undefined, task({ id: '' })]) {
    const view = shotGenView(empty)
    assert.equal(view.state, 'failed')
    assert.match(view.message, /最近生成/)
    assert.match(view.message, /别在这里直接再点一次/)
  }
})

test('失败原因缺失也留一条能查的话（带任务号），不写空串', () => {
  const view = shotGenView(task({ status: 'failed', error: '   ' }))
  assert.equal(view.state, 'failed')
  assert.match(view.message, /task_abc/)
  assert.notEqual(view.message.trim(), '')
})

test('按钮上的价格与余额：够就写价，不够写还差多少，没读到就写读取中', () => {
  assert.equal(shotGenPriceLabel(5, 95), '5 积分')
  assert.equal(shotGenPriceLabel(5, 2), '还差 3 积分')
  assert.equal(shotGenPriceLabel(5, null), '5 积分')
  assert.equal(shotGenPriceLabel(null, 95), '价格读取中')
  assert.equal(shotGenPriceLabel(0, 95), '价格读取中')
})

test('比例只挑上游认的：竖屏优先，模型不认 9:16 就退到它认的，绝不硬传', () => {
  assert.equal(shotGenRatio(['1:1', '9:16', '16:9']), '9:16')
  assert.equal(shotGenRatio(['16:9', '1:1']), '1:1')
  assert.equal(shotGenRatio(['4:3']), '4:3')
  assert.equal(shotGenRatio([]), '9:16')
  assert.equal(shotGenRatio(null), '9:16')
})

test('文件名带镜头号与真实扩展名（给人看的那一份）', () => {
  assert.equal(shotGenFileName(3, 'image/png'), '第03镜.png')
  assert.equal(shotGenFileName(12, 'image/webp'), '第12镜.webp')
  assert.equal(shotGenFileName(7, 'image/jpeg'), '第07镜.jpg')
  assert.equal(shotGenFileName(0), '第01镜.png')
  // 等待上限要比服务端出图超时长：240 秒出图 + 下载，4 分钟整
  assert.ok(SHOT_GEN_WAIT_MS >= 240 * 1000, '等待上限不能短于服务端 240 秒的出图超时')
  assert.match(SHOT_GEN_ATTACH_FAILED, /最近生成/)
  assert.match(SHOT_GEN_ATTACH_FAILED, /贴画面/)
})

test('作品页：出图只挂在点击上，失败行把钱的事写出来，不用自带的确认框', () => {
  const page = readFileSync(new URL('../src/pages/ProjectPage.tsx', import.meta.url), 'utf8')
  // 出图请求只在 generateShotFrame 里发：找一个函数名，确认生成调用不在渲染期
  assert.match(page, /const generateShotFrame = useCallback|const generateShotFrame = async/)
  assert.match(page, /generateMediaImage\(/)
  assert.match(page, /shotGenView\(/)
  assert.match(page, /shotGenFailNote\(/)
  assert.match(page, /setProjectShotFrame\(projectId, shotNo, uploaded\.media\)/)
  // 按钮在分镜那一行里，带价格
  assert.match(page, /出这一镜/)
  assert.match(page, /shotGenPriceLabel\(/)
  // 不许用浏览器原生 confirm 问花钱（页面里没有窗口确认框）
  assert.doesNotMatch(page, /window\.confirm\([^)]*出图/)
})
