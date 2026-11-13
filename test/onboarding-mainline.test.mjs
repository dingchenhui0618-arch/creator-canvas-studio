// 上手引导讲的是「一条作品的主线」（v0.9.41）。这一层钉住三件事：
//   1. 引导的每一步都落在一级导航里（工作台 / 作品 / 发现 / 模板库）：
//      画布、视觉评审、智能体、运行记录是能力，不许被写成「一步」——
//      这正是那五个结构性问题的第一条：工具不是目的地。
//   2. 主线四步的顺序是 找 → 拆 → 做 → 交。少一步，引导就又退回「八个各自不错的页面」。
//   3. 引导上写的钱要对得上服务端的计费表：按次扣的只有检索 / 解析 / 评审 / 跑画布，
//      开画布、导出与分享不扣分——哪天计费表变宽了，卡面上那几句必须先改。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

/** nav.ts 里某一段导航的 id：从 'export const <name>' 到下一个 'export const'，再抓 { id: '...' }。 */
function navIds(source, name) {
  const start = source.indexOf('export const ' + name)
  assert.ok(start >= 0, 'nav.ts 里找不到 ' + name)
  const rest = source.indexOf('export const ', start + 'export const '.length)
  const block = source.slice(start, rest < 0 ? undefined : rest)
  return [...block.matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map((match) => match[1])
}

test('引导的每一步都落在一级导航里：画布 / 评审 / 智能体 / 运行不许被写成一步', () => {
  const guide = read('src', 'components', 'WelcomeGuide.tsx')
  const nav = read('src', 'nav.ts')
  const primary = navIds(nav, 'PRIMARY_NAV')
  const tools = navIds(nav, 'TOOL_NAV')

  assert.deepEqual(primary, ['overview', 'projects', 'radar', 'templates'], '一级导航变了：引导与侧栏是同一套去处')
  assert.deepEqual(tools, ['agents', 'canvas', 'review', 'runs'], '工具区变了：引导不能再指向已经不当工具的那一页')

  const pages = [...guide.matchAll(/page:\s*'([a-z-]+)'/g)].map((match) => match[1])
  assert.ok(pages.length >= 4, '引导至少要有四步的去处，现在只有 ' + pages.length + ' 处')
  const outside = pages.filter((page) => !primary.includes(page))
  assert.deepEqual(outside, [], '这些去处不是一级导航（工具不该是引导的落点）：' + outside.join(', '))
  const inTools = pages.filter((page) => tools.includes(page))
  assert.deepEqual(inTools, [], '引导把人送进了工具区：' + inTools.join(', '))
})

test('主线四步的顺序是 找 → 拆 → 做 → 交，各自落在发现 / 模板库 / 作品 / 交付', () => {
  const guide = read('src', 'components', 'WelcomeGuide.tsx')
  const kickers = [...guide.matchAll(/kicker:\s*'([^']+)'/g)].map((match) => match[1])
  const parts = kickers.map((kicker) => kicker.split(' · '))
  assert.deepEqual(parts.map((piece) => piece.length), [3, 3, 3, 3], '每步应当写成「01 · 找 · 发现」三段：' + kickers.join(' / '))
  assert.deepEqual(parts.map((piece) => piece[0]), ['01', '02', '03', '04'])
  assert.deepEqual(parts.map((piece) => piece[1]), ['找', '拆', '做', '交'])
  assert.deepEqual(parts.map((piece) => piece[2]), ['发现', '模板库', '作品', '交付'])
})

test('引导上的价钱对得上服务端计费表：只有检索 / 解析 / 评审 / 跑画布按次扣', () => {
  const config = read('server', 'config.mjs')
  const start = config.indexOf('prices: {')
  assert.ok(start >= 0, 'config.mjs 里找不到 prices 表')
  const end = config.indexOf('concurrency: {', start)
  const block = config.slice(start, end)
  const kinds = [...block.matchAll(/([a-z_]+):\s*Number\(process\.env\.VQ_CREDIT_/g)].map((match) => match[1]).sort()
  assert.deepEqual(kinds, ['chat', 'flow_run', 'replicate', 'review', 'search'], '计费表变了：引导上写的钱要跟着改')

  const guide = read('src', 'components', 'WelcomeGuide.tsx')
  // 四笔钱都从接口读，不写死数字
  for (const key of ['search', 'replicate', 'review', 'flow_run']) {
    assert.match(guide, new RegExp('prices\\??\\.' + key), '引导没有读 ' + key + ' 的真实单价')
  }
  // 不计费的动作要明说，别让人以为点进画布、导出、分享就开始扣分
  assert.match(guide, /开画布不扣积分/, '开画布不计费这件事要在卡面上说清')
  assert.match(guide, /导出与分享不扣积分/, '导出与分享不计费这件事要在卡面上说清')
})
