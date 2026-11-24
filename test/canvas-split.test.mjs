// 两张画布分开（v0.9.163，用户 2026-11-16 明确要求）：
//   · VisionQA 自己的节点编排叫「工作流」，地址仍是 #/canvas；
//   · 外部那张自由画布叫「无限画布」，地址是 #/board（#/board/<画布ID> 点名一块）。
// 这一层钉住四件事（都读源码，不需要起服务）：
//   1. 工具区里工作流与无限画布各占一项，名字不再共用「画布」；
//   2. 路由里两条地址各写各的，旧地址 #/canvas/project/<id> 改写成 #/board/<id>；
//   3. 外壳把 #/board 交给 BoardPage，工作流页不再收画布项目；
//   4. 外部画布的 iframe / 票据 / 画布项目只剩在 BoardPage 里——工作流页一份都不许留。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

/** nav.ts 里 TOOL_NAV 那一段：从 'export const TOOL_NAV' 到下一个 'export const'。 */
function toolBlock() {
  const source = read('src', 'nav.ts')
  const start = source.indexOf('export const TOOL_NAV')
  assert.ok(start >= 0, 'nav.ts 里找不到 TOOL_NAV')
  const rest = source.indexOf('export const ', start + 'export const '.length)
  return source.slice(start, rest < 0 ? undefined : rest)
}

// r311 起工具区多了「我的资产」：它是复刻的地基，所以排在最前，逻辑仍是一件工具占一项。
test('工具区：我的资产 / 智能体 / 工作流 / 无限画布 / 视觉评审 / 运行记录', () => {
  const block = toolBlock()
  const ids = [...block.matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map((m) => m[1])
  assert.deepEqual(ids, ['assets', 'agents', 'canvas', 'board', 'review', 'runs'], '工具区变了：工作流与无限画布要各占一项')
  const canvas = block.slice(block.indexOf("id: 'canvas'"), block.indexOf("id: 'board'"))
  const board = block.slice(block.indexOf("id: 'board'"), block.indexOf("id: 'review'"))
  assert.match(canvas, /label: '工作流'/, '节点编排那一项叫「工作流」')
  assert.doesNotMatch(canvas, /label: '画布'/, '「画布」这个名字不许再留给工作流')
  assert.match(board, /label: '无限画布'/, '外部那张画布叫「无限画布」')
  // 页面名与导航是同一套说法：面包屑、命令面板都读 pageLabels
  const labels = read('src', 'domain', 'types.ts')
  assert.match(labels, /canvas: '工作流'/, 'pageLabels 里工作流要叫工作流')
  assert.match(labels, /board: '无限画布'/, 'pageLabels 里无限画布要叫无限画布')
})

test('路由：两条地址各写各的，旧画布项目地址改写成无限画布', () => {
  const router = read('src', 'router.ts')
  assert.match(router, /if \(head === 'board'\) return \{ kind: 'page', page: 'board', boardId: tail \|\| undefined \}/, '缺少无限画布地址解析')
  assert.match(router, /if \(tail === 'project' && segments\[2\]\) return \{ kind: 'page', page: 'board', boardId: segments\[2\] \}/, '旧的 #/canvas/project/<id> 要改写成无限画布')
  assert.match(router, /if \(route\.page === 'board'\) return route\.boardId \? '#\/board\/'/, '无限画布的回写地址不对')
  assert.match(router, /if \(route\.page === 'board'\) return 'page:board:'/, '无限画布的 routeKey 不对')
  // 工作流的三个入口照旧
  assert.match(router, /page: 'canvas'/, '工作流的地址不能丢')
  assert.match(router, /canvasRunLinkFromSegments\(segments\)/, '工作流的运行地址不能丢')
})

test('外壳：#/board 交给 BoardPage，工作流页不再收画布项目', () => {
  const app = read('src', 'App.tsx')
  assert.match(app, /const BoardPage = lazy\(\(\) => import\('\.\/pages\/BoardPage'\)\)/, 'App 没按需加载 BoardPage')
  assert.match(app, /case 'board':/, 'App 没有 board 分支')
  const boardCase = app.slice(app.indexOf("case 'board':"), app.indexOf("case 'projects':"))
  assert.match(boardCase, /<BoardPage/, 'board 分支没渲染 BoardPage')
  assert.match(boardCase, /boardId=\{route\.boardId\}/, '无限画布要按地址打开某一块')
  const canvasCase = app.slice(app.indexOf("case 'canvas':"), app.indexOf("case 'board':"))
  assert.doesNotMatch(canvasCase, /canvasId=/, '工作流页不该再收画布项目')
  assert.doesNotMatch(canvasCase, /onToggleFocus/, '专注模式归无限画布，工作流页没有这一项')
})

test('外部画布只活在 BoardPage：工作流页里没有 iframe、票据与画布项目', () => {
  const canvas = read('src', 'pages', 'CanvasPage.tsx')
  for (const banned of ['getBdcStatus', 'listBdcCanvases', 'createBdcCanvas', 'writeBdcNote', 'getCanvasSessionTicket', 'iframe', "page: 'board'"]) {
    assert.equal(canvas.includes(banned), false, '工作流页里不该再出现 ' + banned)
  }
  const board = read('src', 'pages', 'BoardPage.tsx')
  for (const needed of ['getBdcStatus', 'listBdcCanvases', 'getCanvasSessionTicket', 'vqCredit', 'loadCanvas', '<iframe']) {
    assert.ok(board.includes(needed), '无限画布页缺少 ' + needed)
  }
})
