import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorks, runWorkItem } from '../server/works-feed.mjs'

const media = (id, at) => ({ id: 'media:' + id, kind: 'image', at, title: id, source: '快捷创作' })
const run = (id, at) => ({ id: 'run:' + id, kind: 'run', at, title: id, source: '工作流' })
const canvas = (id, at) => ({ id: 'canvas:' + id, kind: 'canvas', at, title: id, source: '无限画布' })

test('三种来源按时间倒序，最新一条在最前', () => {
  const page = mergeWorks({ media: [media('a', 100)], runs: [run('b', 300)], canvases: [canvas('c', 200)] })
  assert.deepEqual(page.items.map((item) => item.id), ['run:b', 'canvas:c', 'media:a'])
  assert.equal(page.total, 3)
  assert.equal(page.cursor, null)
})

test('同一个时间点按 id 倒序，不会因为排序不稳定而抖动', () => {
  const page = mergeWorks({ media: [media('a', 100), media('b', 100)] })
  assert.deepEqual(page.items.map((item) => item.id), ['media:b', 'media:a'])
})

test('kind 只留对应来源，total 按筛选后的算', () => {
  const page = mergeWorks({ media: [media('a', 100)], runs: [run('b', 200)], canvases: [canvas('c', 300)], kind: 'run' })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].id, 'run:b')
  assert.equal(page.total, 1)
})

test('游标翻页不重不漏，同一毫秒也能翻', () => {
  const rows = [media('a', 100), media('b', 100), media('c', 50)]
  const first = mergeWorks({ media: rows, limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), ['media:b', 'media:a'])
  assert.equal(first.cursor, '100:media:a')
  const second = mergeWorks({ media: rows, limit: 2, before: first.cursor })
  assert.deepEqual(second.items.map((item) => item.id), ['media:c'])
  assert.equal(second.cursor, null)
})

test('游标那条不在列表里时报 WORKS_CURSOR，不猜位置', () => {
  assert.equal(mergeWorks({ media: [media('a', 100)], before: '999:media:zzz' }).error, 'WORKS_CURSOR')
})

test('不认识的筛选条件报 WORKS_KIND', () => {
  assert.equal(mergeWorks({ kind: 'video2' }).error, 'WORKS_KIND')
})

test('limit 有上限，传 999 也只回 48 条', () => {
  const rows = Array.from({ length: 60 }, (_, index) => media('m' + index, 1000 - index))
  assert.equal(mergeWorks({ media: rows, limit: 999 }).items.length, 48)
})
// ---------- r266：运行卡把封面同时当预览，跳转不再抢缩略图 ----------

const runWithImage = {
  id: 'run_1',
  flowId: 'flow_1',
  flowName: '爆款复刻',
  status: 'success',
  startedAt: '2026-11-19T02:00:00.000Z',
  finishedAt: '2026-11-19T02:01:00.000Z',
  durationMs: 60_000,
  nodes: [
    { id: 'text', output: { text: '先写一句文案' } },
    {
      id: 'img',
      output: {
        imageUrl: '/api/runs/run_1/assets/img.png',
        ratio: '9:16',
        text: '出图完成：GPT Image 2 · 9:16（1024x1536）· 本次 5 积分\n提示词：窗边的猫',
      },
    },
  ],
}

test('运行卡有封面时，previewUrl 就是那张图（点开看大图，不再整页跳走）', () => {
  const item = runWorkItem(runWithImage)
  assert.equal(item.previewUrl, '/api/runs/run_1/assets/img.png')
  assert.equal(item.thumbUrl, item.previewUrl)
  assert.equal(item.mediaKind, 'image')
  assert.equal(item.aspect, '9:16')
  assert.equal(item.summary, '出图完成：GPT Image 2 · 9:16（1024x1536）· 本次 5 积分 提示词：窗边的猫')
  // 去运行视图这条路还在，只是收进了浮层里的按钮
  assert.equal(item.detailUrl, '#/canvas/flow_1/run/run_1')
})

test('运行卡只有视频产物时，封面与预览都是那段视频', () => {
  const item = runWorkItem({
    id: 'run_2',
    flowId: 'flow_2',
    flowName: '竖屏成片',
    status: 'success',
    nodes: [{ id: 'v', output: { videoUrl: '/api/runs/run_2/assets/v.mp4', ratio: '16:9' } }],
  })
  assert.equal(item.previewUrl, '/api/runs/run_2/assets/v.mp4')
  assert.equal(item.mediaKind, 'video')
  assert.equal(item.aspect, '16:9')
})

test('没有产物的运行没有预览，detailUrl 仍是去运行视图的显式出口', () => {
  const item = runWorkItem({
    id: 'run_3',
    flowId: 'flow_3',
    flowName: '纯文案流程',
    status: 'interrupted',
    nodes: [{ id: 'text', output: { text: '跑到一半被停' } }],
  })
  assert.equal(item.previewUrl, null)
  assert.equal(item.thumbUrl, null)
  assert.equal(item.aspect, 'unknown')
  assert.equal(item.detailUrl, '#/canvas/flow_3/run/run_3')
})

test('还在跑 / 排队中的运行不进作品流（以前会被当成「已停止」）', () => {
  assert.equal(runWorkItem({ id: 'run_4', flowId: 'f', flowName: '跑着呢', status: 'running' }), null)
  assert.equal(runWorkItem({ id: 'run_5', flowId: 'f', flowName: '排队中', status: 'queued' }), null)
  assert.equal(runWorkItem(null), null)
})

// ---------- r272：每一类各几条，先数再筛 ----------

test('counts 先数全部再按筛选切：筛到空的一类时，仍知道别的类有几条', () => {
  const page = mergeWorks({
    media: [media('a', 100), media('b', 90)],
    runs: [run('c', 80)],
    canvases: [canvas('d', 70)],
    kind: 'video',
  })
  assert.equal(page.items.length, 0)
  assert.equal(page.total, 0)
  assert.deepEqual(page.counts, { all: 4, image: 2, video: 0, run: 1, canvas: 1 })
})

test('什么都没做过时 counts 全是 0，空状态才敢说「还没有作品」', () => {
  const page = mergeWorks({})
  assert.deepEqual(page.counts, { all: 0, image: 0, video: 0, run: 0, canvas: 0 })
})

test('counts 不认识的 kind 不计数（也不把 all 撑大）', () => {
  const page = mergeWorks({ media: [media('a', 100), { id: 'x:1', kind: 'weird', at: 50 }] })
  assert.equal(page.counts.all, 2)
  assert.equal(page.counts.image, 1)
  assert.equal(Object.prototype.hasOwnProperty.call(page.counts, 'weird'), false)
})

test('翻页时 counts 仍是全量，不跟着这一页变', () => {
  const rows = [media('a', 100), media('b', 90), media('c', 80)]
  const first = mergeWorks({ media: rows, runs: [run('r', 70)], limit: 2 })
  assert.equal(first.items.length, 2)
  assert.equal(first.counts.all, 4)
})
