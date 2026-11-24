// 快捷创作页的「适配」与「参数排列」（r309 / v0.9.282）。
// 2026-11-24 量了 1920 / 1600 / 1440 / 1366 / 1280 / 1100 / 1024 / 768 / 700 / 560 / 390：
// ① 页面上限 1200 且居中，1920 上左侧栏到内容之间空出 242px——顶栏面包屑贴着侧栏、内容却在
//    右边另起一列，那道缝随分辨率变宽；② 图片 / 视频的模型胶囊和四颗参数挤在一行，触发按钮被
//    190px 的上限截成「VisionQA通用图片模型 ·…」，1920 上也一样；③ 最近生成那列的元信息在
//    每个「 · 」处折行，断出只有「· 1:1 ·」的一行，连「224 B」都被拆成两行。
// 这里把三条都钉住：页面左边缘跟着顶栏、模型单独一行且不再省略、短标签内部不断行。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8').replace(/\r\n/g, '\n')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('(?:^|\\n)[ \\t]*' + escaped + '\\s*\\{').exec(source)
  assert.ok(match, '找不到规则 ' + selector)
  const end = source.indexOf('}', match.index)
  return source.slice(match.index, end)
}

test('页面宽度跟着窗口走：左边缘与顶栏面包屑同一个位置，不再居中成一座小岛', () => {
  const root = rule(css, '.agx-page')
  // 上限抬到与 .page 一致：1920 上不再把内容夹在 1200 里
  assert.match(root, /max-width:\s*1520px/)
  // 关键在 margin-inline: 0 auto —— 右边留白可以，左边不许再空出一条随分辨率变宽的缝
  assert.match(root, /margin-inline:\s*0 auto/)
  assert.ok(!/margin:\s*0 auto/.test(root), '又写回居中了')
})

test('图片 / 视频的模型单独一行，参数另起一行（r309）', () => {
  // 结构：模型那一行在 .agx-composer-bar 之前，且不在 .agx-params 里
  const mediaStart = page.indexOf('<div className="agx-composer agx-composer--media">')
  const barStart = page.indexOf('<div className="agx-composer-bar">', mediaStart)
  const modelbar = page.indexOf('<div className="agx-media-modelbar">', mediaStart)
  assert.ok(mediaStart > 0 && barStart > mediaStart, '找不到图片 / 视频的输入卡')
  assert.ok(modelbar > mediaStart && modelbar < barStart, '模型那一行要排在参数行之前')
  const paramsBlock = page.slice(barStart, page.indexOf('agx-composer-actions', barStart))
  assert.ok(!paramsBlock.includes('label="模型"'), '模型胶囊又跑回参数行里了')
  assert.match(paramsBlock, /label="方式"/)
  assert.match(paramsBlock, /label="比例"/)
  // 样式：模型行独占一行；宽度上限写在胶囊的基础规则里（r310 起不再按场景各写一份）
  const bar = rule(css, '.agx-media-modelbar')
  assert.match(bar, /display: flex/)
  assert.match(rule(css, '.agx-media-modelbar .agx-capsule'), /flex: 0 1 auto/)
  // 分隔线只画一条：模型行画在输入框下面，参数行不再画第二条
  assert.match(bar, /border-top: 1px solid var\(--line-faint\)/)
  assert.match(rule(css, '.agx-composer--media .agx-composer-bar'), /border-top: 0/)
})

test('390 上四颗参数排成两列等宽：不再「能挤几颗算几颗」', () => {
  const block = css.slice(css.indexOf('@media (max-width: 560px) {\n  .agx-composer--media .agx-media-modelbar'))
  assert.ok(block.length > 0, '缺少 ≤560 的参数排列规则')
  const head = block.slice(0, block.indexOf('@media (max-width: 900px)'))
  assert.match(head, /display: grid/)
  assert.match(head, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(head, /justify-content: space-between/)
})

test('最近生成的短标签内部不断行：数字与单位之间是不断行空格', () => {
  // formatBytes / shortTimeOf 都改用 U+00A0；写成 '\u00A0' 由 TS 负责转义
  assert.match(page, /const gap = '\\u00A0'/)
  assert.match(page, /return bytes \+ gap \+ 'B'/)
  assert.match(page, /pad\(date\.getDate\(\)\) \+ '\\u00A0' \+ pad\(date\.getHours\(\)\)/)
})

test('最近生成的时间与参数分两行，「1:1 · 224 B」不会再被拆开', () => {
  assert.ok(page.includes('agx-media-recent-time'), '缺少时间那一行')
  assert.ok(page.includes('agx-media-recent-facts'), '缺少参数那一行')
  assert.ok(!page.includes('recentMetaOf'), '旧的一整句拼接要删掉，否则两套写法并存')
  const meta = rule(css, '.agx-media-recent-meta')
  assert.match(meta, /display: grid/)
  const facts = rule(css, '.agx-media-recent-facts')
  assert.match(facts, /white-space: nowrap/)
  assert.match(facts, /text-overflow: ellipsis/)
})
