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

// ---------- r281：作品流能搜 ----------

const withModel = (id, at, model, title = id) => ({ id: 'media:' + id, kind: 'image', at, title, model, source: '快捷创作' })

test('搜作品：命中标题，大小写与首尾空白都不敏感', () => {
  const page = mergeWorks({ media: [withModel('a', 100, 'GPT Image 2', '窗边的咖啡杯'), withModel('b', 90, 'GPT Image 2', '橘猫')], q: '  咖啡  ' })
  assert.deepEqual(page.items.map((item) => item.id), ['media:a'])
  assert.equal(page.total, 1)
  assert.equal(page.q, '咖啡')
  assert.equal(page.scanned, 2)
})

test('搜作品：能按模型名搜——搜 seedance 只留视频那条', () => {
  const page = mergeWorks({
    media: [withModel('a', 100, 'GPT Image 2', '一张图'), withModel('b', 90, 'Seedance 2.0', '一条视频')],
    q: 'SEEDANCE',
  })
  assert.deepEqual(page.items.map((item) => item.id), ['media:b'])
})

test('搜作品：能按来源搜——「画布」命中画布卡与画布里的产物，「工作流」命中运行', () => {
  const canvasNode = { id: 'canvas-node:c1:n1', kind: 'image', at: 300, title: '画布里的猫', source: '无限画布' }
  const byCanvas = mergeWorks({ media: [media('a', 100)], runs: [run('r', 200)], canvases: [canvas('c', 50), canvasNode], q: '画布' })
  assert.deepEqual(byCanvas.items.map((item) => item.id), ['canvas-node:c1:n1', 'canvas:c'])
  const byRun = mergeWorks({ media: [media('a', 100)], runs: [run('r', 200)], q: '工作流' })
  assert.deepEqual(byRun.items.map((item) => item.id), ['run:r'])
})

test('搜作品：栏目名也能搜——搜「视频」等于把视频那栏捞出来', () => {
  const none = mergeWorks({ media: [withModel('a', 100, 'GPT Image 2', '一张图')], runs: [run('r', 90)], q: '视频' })
  assert.deepEqual(none.items.map((item) => item.id), [])
  const video = { id: 'media:v', kind: 'video', at: 80, title: '竖屏成片', source: '快捷创作' }
  assert.deepEqual(mergeWorks({ media: [video], q: '视频' }).items.map((item) => item.id), ['media:v'])
})

test('搜作品：counts 按关键词算，先数匹配再切栏目', () => {
  const page = mergeWorks({
    media: [withModel('a', 100, 'GPT Image 2', '猫'), withModel('b', 90, 'GPT Image 2', '狗')],
    runs: [run('r', 80)],
    kind: 'video',
    q: '猫',
  })
  assert.equal(page.items.length, 0)
  assert.deepEqual(page.counts, { all: 1, image: 1, video: 0, run: 0, canvas: 0 })
})

test('搜作品：一条都不匹配时 items 空、total 0，scanned 仍是看了多少条', () => {
  const page = mergeWorks({ media: [media('a', 100), media('b', 90)], runs: [run('r', 80)], q: '不存在的词' })
  assert.deepEqual(page.items, [])
  assert.equal(page.total, 0)
  assert.equal(page.cursor, null)
  assert.equal(page.scanned, 3)
})

test('搜作品：翻页在匹配集里走，游标不重不漏', () => {
  const rows = [
    withModel('a', 100, 'GPT Image 2', '猫一'),
    withModel('b', 90, 'GPT Image 2', '狗'),
    withModel('c', 80, 'GPT Image 2', '猫二'),
    withModel('d', 70, 'GPT Image 2', '猫三'),
  ]
  const first = mergeWorks({ media: rows, q: '猫', limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), ['media:a', 'media:c'])
  const second = mergeWorks({ media: rows, q: '猫', limit: 2, before: first.cursor })
  assert.deepEqual(second.items.map((item) => item.id), ['media:d'])
  assert.equal(second.cursor, null)
})

test('搜作品：关键词截到 40 字，空词与纯空白等于没搜', () => {
  const page = mergeWorks({ media: [media('a', 100)], q: '猫'.repeat(80) })
  assert.equal(page.q.length, 40)
  assert.equal(page.items.length, 0)
  const plain = mergeWorks({ media: [media('a', 100)], q: '   ' })
  assert.equal(plain.q, '')
  assert.equal(plain.total, 1)
})

// 路由 / 前端这两处是把 q 接起来的线：漏一处，界面上的搜索框就是个摆设。
test('搜作品：路由把 q 转给 listWorks，前端把 q 放进查询串', async () => {
  const fs = await import('node:fs')
  const route = fs.readFileSync(new URL('../server/routes/works.mjs', import.meta.url), 'utf8')
  assert.match(route, /q: url\.searchParams\.get\('q'\)/)
  const client = fs.readFileSync(new URL('../src/api/works.ts', import.meta.url), 'utf8')
  assert.match(client, /query\.set\('q'/)
})
// ---------- r284：读不到 ≠ 没有 ----------

test('degraded 跟着一页一起回去，读到的来源不留空串', () => {
  const page = mergeWorks({
    media: [media('a', 100)],
    degraded: { canvas: '无限画布暂时连不上', runs: '   ', media: '' },
  })
  assert.deepEqual(page.degraded, { canvas: '无限画布暂时连不上' })
})

test('都读到了就是空的 degraded（界面据此不喊一句话）', () => {
  assert.deepEqual(mergeWorks({ media: [media('a', 100)] }).degraded, {})
  assert.deepEqual(mergeWorks({ degraded: undefined }).degraded, {})
})

test('读不到的那一处不影响别的来源：图还是图，counts 不会把缺口算成 0 条作品', () => {
  const page = mergeWorks({ media: [media('a', 100)], degraded: { canvas: '画布挂了' } })
  assert.equal(page.items.length, 1)
  assert.equal(page.counts.all, 1)
  // 0 是「这一类一条都没有」，界面对照 degraded 才知道它其实是「没读到」
  assert.equal(page.counts.canvas, 0)
  assert.equal(page.degraded.canvas, '画布挂了')
})

test('翻页时 degraded 照旧带着（不能只在第一页说）', () => {
  const rows = [media('a', 100), media('b', 90), media('c', 80)]
  const first = mergeWorks({ media: rows, limit: 2, degraded: { canvas: '画布挂了' } })
  const second = mergeWorks({ media: rows, limit: 2, before: first.cursor, degraded: { canvas: '画布挂了' } })
  assert.equal(second.items.length, 1)
  assert.equal(second.degraded.canvas, '画布挂了')
})

test('超过扫描上限时按 mtime 取最新的，不按目录里碰巧的顺序', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { newestNames } = await import('../server/works-feed.mjs')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vq-works-mtime-'))
  try {
    // 名字按字母排序与时间顺序相反：老的那份叫 z，新的那份叫 a
    const specs = [{ name: 'z.json', at: Date.now() - 3_000_000 }, { name: 'm.json', at: Date.now() - 1_000_000 }, { name: 'a.json', at: Date.now() }]
    for (const spec of specs) {
      const file = path.join(dir, spec.name)
      await fs.promises.writeFile(file, '{}')
      await fs.promises.utimes(file, new Date(spec.at), new Date(spec.at))
    }
    assert.deepEqual(await newestNames(dir, specs.map((spec) => spec.name), 2), ['a.json', 'm.json'])
    // 上限比文件多就是全给
    assert.equal((await newestNames(dir, specs.map((spec) => spec.name), 10)).length, 3)
    // 名字刚好被删掉：排到最后，但不能把清单弄丢
    const kept = await newestNames(dir, ['ghost.json', 'a.json'], 2)
    assert.deepEqual(kept, ['a.json', 'ghost.json'])
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
})

test('作品流接线：三个来源各自回 { items, error }，路由把整页（含 degraded）交出去', async () => {
  const fs = await import('node:fs')
  const feed = fs.readFileSync(new URL('../server/works-feed.mjs', import.meta.url), 'utf8')
  // 每一处读失败只影响自己那一栏
  assert.match(feed, /if \(error\?\.code === 'ENOENT'\) return \{ items: \[\], error: '' \}/)
  assert.match(feed, /error: '工作流的运行记录这次没读出来'/)
  assert.match(feed, /if \(!result\.ok\) return \{ items: \[\], error:/)
  // 三处并行读，一处坏不能把整条流拖成 500
  assert.match(feed, /Promise\.all\(\[mediaItems\(user\.id\), canvasItems\(user\), runItems\(user\)\]\)/)
  const route = fs.readFileSync(new URL('../server/routes/works.mjs', import.meta.url), 'utf8')
  assert.match(route, /sendJson\(res, 200, \{ ok: true, \.\.\.result \}\)/)
})

