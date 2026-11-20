// 作品流的筛选记忆与运行状态文案（r266）。
// 两件事都在 src/domain/works-view.ts：存坏的值不能污染界面，不认识的状态不能被猜成「已停止」。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readWorksFilter,
  readWorksQuery,
  runStatusLabel,
  workDetailLabel,
  worksChipCount,
  worksEmptyKind,
  worksKindGap,
  worksKindSource,
  worksSourceGaps,
  WORKS_QUERY_MAX,
  writeWorksFilter,
  writeWorksQuery,
} from '../src/domain/works-view.ts'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    size: () => map.size,
    raw: () => Object.fromEntries(map),
  }
}

test('没存过筛选时是「全部」', () => {
  assert.equal(readWorksFilter(memoryStorage()), 'all')
})

test('存过的筛选取回来还是它', () => {
  for (const kind of ['image', 'video', 'run', 'canvas']) {
    const storage = memoryStorage()
    writeWorksFilter(storage, kind)
    assert.equal(readWorksFilter(storage), kind)
  }
})

test('选回「全部」时把键删掉，不留下一个写着 all 的旧值', () => {
  const storage = memoryStorage()
  writeWorksFilter(storage, 'run')
  writeWorksFilter(storage, 'all')
  assert.equal(storage.size(), 0)
  assert.equal(readWorksFilter(storage), 'all')
})

test('存进去的值不认识（旧版本 / 手改）就退回「全部」，不崩', () => {
  assert.equal(readWorksFilter(memoryStorage({ 'vq.works.filter.v2': 'video2' })), 'all')
  assert.equal(readWorksFilter(memoryStorage({ 'vq.works.filter.v2': '../etc' })), 'all')
})

test('浏览器不给用 sessionStorage 时读出「全部」，写入不抛错', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(readWorksFilter(broken), 'all')
  assert.doesNotThrow(() => writeWorksFilter(broken, 'video'))
  assert.equal(readWorksFilter(null), 'all')
  assert.doesNotThrow(() => writeWorksFilter(null, 'video'))
})

test('搜作品的关键词跟着会话走：存了能取回，首尾空白去掉', () => {
  const storage = memoryStorage()
  writeWorksQuery(storage, '  咖啡  ')
  assert.equal(readWorksQuery(storage), '咖啡')
})

test('关键词清空时把键删掉，不在会话里留一个空字符串', () => {
  const storage = memoryStorage()
  writeWorksQuery(storage, '猫')
  writeWorksQuery(storage, '   ')
  assert.equal(storage.size(), 0)
  assert.equal(readWorksQuery(storage), '')
})

test('关键词存太长时截到上限；读回手改的脏值也不超过上限', () => {
  const storage = memoryStorage()
  writeWorksQuery(storage, '猫'.repeat(WORKS_QUERY_MAX + 20))
  assert.equal(readWorksQuery(storage).length, WORKS_QUERY_MAX)
  assert.equal(readWorksQuery(memoryStorage({ 'vq.works.query.v1': '狗'.repeat(200) })).length, WORKS_QUERY_MAX)
})

test('浏览器不给用 sessionStorage 时关键词读成空，写入不抛错', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(readWorksQuery(broken), '')
  assert.doesNotThrow(() => writeWorksQuery(broken, '猫'))
  assert.equal(readWorksQuery(null), '')
  assert.doesNotThrow(() => writeWorksQuery(null, '猫'))
})

test('运行状态说人话：四种终态各有说法，不认识的不猜', () => {
  assert.equal(runStatusLabel('success'), '跑完了')
  assert.equal(runStatusLabel('error'), '失败')
  assert.equal(runStatusLabel('interrupted'), '已停止')
  assert.equal(runStatusLabel('running'), '还在跑')
  assert.equal(runStatusLabel('queued'), '排队中')
  assert.equal(runStatusLabel(''), '')
  assert.equal(runStatusLabel(undefined), '')
  assert.equal(runStatusLabel('weird'), '')
})
test('「去出处」那条按钮写明去哪儿：运行 / 画布 / 画布里出的图，别的没有', () => {
  assert.equal(workDetailLabel({ kind: 'run' }), '打开这次运行')
  assert.equal(workDetailLabel({ kind: 'canvas' }), '打开画布')
  // 画布里生成的那张图：kind 是 image，但带着 canvasId——回它所在的画布
  assert.equal(workDetailLabel({ kind: 'image', canvasId: 'cv_1' }), '打开画布')
  assert.equal(workDetailLabel({ kind: 'image' }), '')
  assert.equal(workDetailLabel({ kind: 'video' }), '')
  assert.equal(workDetailLabel({}), '')
})

// ---------- r284：读不到 ≠ 没有 ----------
//
// 画布服务挂掉那一刻，界面以前把「读不到」画成「无限画布这一类还没有作品」，
// 还附一句「在无限画布上出过图或视频就会进这里」——等于告诉一个真做过画布的人他从来没做过。
// 现在服务端把「哪一处没读到」带上来，界面照这三条规则画。

const NO_COUNTS = { all: 0, image: 0, video: 0, run: 0, canvas: 0 }
const CANVAS_DOWN = { canvas: '无限画布暂时连不上：作品、模板、评审、交付都不受影响；过一会儿刷新再试。' }

test('栏目对应哪个来源：图片与视频同属快捷创作，工作流是运行记录，画布是另一个应用', () => {
  assert.equal(worksKindSource('image'), 'media')
  assert.equal(worksKindSource('video'), 'media')
  assert.equal(worksKindSource('run'), 'runs')
  assert.equal(worksKindSource('canvas'), 'canvas')
  // 「全部」不是某个来源：它横跨三处
  assert.equal(worksKindSource('all'), '')
})

test('没读到的来源原样说出那句话；读到的来源一个字都不加', () => {
  assert.equal(worksKindGap('canvas', CANVAS_DOWN), CANVAS_DOWN.canvas)
  assert.equal(worksKindGap('canvas', {}), '')
  assert.equal(worksKindGap('canvas', undefined), '')
  // 图片读不到时，视频那一栏也读不到——它们同属一个来源
  assert.equal(worksKindGap('video', { media: '快捷创作的作品这次没读出来' }), '快捷创作的作品这次没读出来')
})

test('缺口按固定顺序列出来：快捷创作 → 工作流 → 无限画布', () => {
  const gaps = worksSourceGaps({ canvas: '画布挂了', media: '图片没读出来', runs: '运行没读出来' })
  assert.deepEqual(gaps.map((gap) => gap.source), ['media', 'runs', 'canvas'])
  assert.deepEqual(gaps.map((gap) => gap.label), ['快捷创作', '工作流', '无限画布'])
  assert.deepEqual(worksSourceGaps({}), [])
  assert.deepEqual(worksSourceGaps(undefined), [])
  // 空字符串 / 空白不算「没读到」：服务端回来一个空串不该让界面喊一句没内容的话
  assert.deepEqual(worksSourceGaps({ canvas: '   ' }), [])
})

test('读不到的那一栏写「—」而不是 0：0 会被读成「这一类是空的」', () => {
  assert.equal(worksChipCount('canvas', 0, CANVAS_DOWN, true), '—')
  assert.equal(worksChipCount('canvas', 0, {}, true), '0')
  // 「全部」漏了一处就不写死数：不是总数
  assert.equal(worksChipCount('all', 7, CANVAS_DOWN, true), '—')
  assert.equal(worksChipCount('all', 7, {}, true), '7')
  // 还没读回来（首屏）时先不显示数字
  assert.equal(worksChipCount('all', 0, {}, false), '')
  assert.equal(worksChipCount('canvas', 0, CANVAS_DOWN, false), '')
})

test('空状态分三种：没读到 / 这一类真没有 / 一条都没有', () => {
  // 画布读不到，别的来源也一条没有：不能说「还没有作品」
  assert.equal(worksEmptyKind('all', NO_COUNTS, CANVAS_DOWN), 'unreadable')
  assert.equal(worksEmptyKind('all', NO_COUNTS, {}), 'empty')
  // 停在「无限画布」这一栏而画布没连上：给「没读到」，不是「这一类还没有作品」
  assert.equal(worksEmptyKind('canvas', { ...NO_COUNTS, all: 3, image: 3 }, CANVAS_DOWN), 'unreadable')
  // 画布读到了、就是空的：这一类真没有，别的栏目有东西
  assert.equal(worksEmptyKind('canvas', { ...NO_COUNTS, all: 3, image: 3 }, {}), 'filtered')
  // 这一栏有东西时不走空状态（防御：别把有内容的一栏画成没读到）
  assert.equal(worksEmptyKind('image', { ...NO_COUNTS, all: 2, image: 2 }, { media: 'x' }), 'filtered')
})

test('作品流接线：服务端把 degraded 带到界面，界面按它画「—」与「没读到」', async () => {
  const fs = await import('node:fs')
  const read = (name) => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8')
  const feed = read('server/works-feed.mjs')
  assert.match(feed, /degraded = \{\}/, 'mergeWorks 要接受 degraded')
  assert.match(feed, /degraded: cleanDegraded\(degraded\)/, 'degraded 要跟着一页返回')
  assert.match(feed, /return \{ items: \[\], error: '无限画布这次没连上' \}|result\.error \|\| '无限画布这次没连上'/)
  const wall = read('src/components/WorksWall.tsx')
  assert.match(wall, /worksChipCount\(item\.value, counts\[item\.value\], degraded, showCounts\)/)
  assert.match(wall, /emptyKind === 'unreadable'/)
  assert.match(wall, /works-gap-retry/)
  // 空状态那句「还没有作品」不能出现在「没读到」的分支里
  assert.match(wall, /所以现在还不能说「还没有作品」/)
})

