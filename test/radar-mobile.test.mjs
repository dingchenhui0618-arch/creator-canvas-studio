// 爆款雷达手机端（r230）：检索结果在 820 以下必须是紧凑行，不再是一张屏一个 9:16 海报；
// 工具栏不许内部横向溢出；封面上的悬停层在触屏上要收掉；页头 kicker 不许和标题重复。
// 另外两条是这轮踩到的坑：未登录实例检索失败时 paid.refund 抛 TypeError；
// 手机提示文案还写着「检索在电脑上做」，和现在的能力不符。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

/** 取所有匹配的 @media 块（按花括号配对），同一个断点写了两段也能分别取到。 */
function mediaBlocks(file, query) {
  const text = read(file)
  const blocks = []
  let from = 0
  for (;;) {
    const start = text.indexOf('@media ' + query, from)
    if (start < 0) break
    let depth = 0
    let index = text.indexOf('{', start)
    const bodyStart = index
    for (; index < text.length; index += 1) {
      if (text[index] === '{') depth += 1
      if (text[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(text.slice(bodyStart, index + 1))
    from = index + 1
  }
  assert.ok(blocks.length, file + ' 里没有 ' + query + ' 这段')
  return blocks.join('\n')
}

test('820 以下检索结果改紧凑行：单列 + 左封面右文案 + 操作整行', () => {
  const block = mediaBlocks('src/styles/radar.css', '(max-width: 820px)')
  assert.match(block, /\.page--radar \.radar-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(block, /grid-template-areas:\s*'cover copy' 'actions actions'/, '卡片要排成「封面 + 文案」两列、操作占整行')
  assert.match(block, /\.radar-grid\s*\{[^}]*gap:\s*12px/)
})

test('触屏上没有悬停：封面那层看不见的按钮必须收掉，否则点封面就弹复刻', () => {
  const block = mediaBlocks('src/styles/radar.css', '(max-width: 820px)')
  assert.match(block, /\.page--radar \.radar-hover\s*\{\s*display:\s*none/, '窄屏要 display:none 封面悬停层')
  assert.match(block, /\.radar-actions \.vq-button\s*\{[^}]*min-height:\s*32px/, '窄屏操作按钮至少 32px 高')
  assert.match(block, /\.radar-actions\s*\{[^}]*flex-wrap:\s*wrap/, '按钮放不下时要换行，不许把「加入模板库」截成「加入模」')
})

test('320 宽工具栏不再内部溢出：搜索框与平台整行、下拉各半、检索整行', () => {
  const block = mediaBlocks('src/styles/radar.css', '(max-width: 820px)')
  assert.match(block, /\.radar-toolbar\s*\{[^}]*display:\s*grid/, '窄屏工具栏要改成网格')
  assert.match(block, /\.radar-search\s*\{[^}]*min-width:\s*0/, '搜索框的 min-width:220px 会把 320 撑出横向滚动')
  assert.match(block, /\.radar-search\s*\{[^}]*grid-column:\s*1 \/ -1/)
  assert.match(block, /\.vq-select\s*\{[^}]*width:\s*100%/)
  assert.match(block, /\.vq-select__trigger\s*\{[^}]*min-width:\s*0/, '触发按钮自带 min-width:96px，320 宽会顶出 3px')
})

test('页头 kicker 不再和标题重复，库里已有在窄屏只留四个字', () => {
  const page = read('src/pages/RadarPage.tsx')
  assert.match(page, /kicker="找爆款 \/ RADAR"/, 'kicker 要说明这是「找爆款」这一步，别和标题一样')
  assert.doesNotMatch(page, /kicker="爆款雷达"/)
  assert.match(page, /<strong className="radar-title" title=\{item\.title \|\| undefined\}>/, '标题被截断时要能悬停看全')
  assert.match(page, /className="radar-owned-count"/, '「· N 条作品」要单独包一层，窄屏才能只留「库里已有」')
})

test('手机提示不再说检索要在电脑上做', () => {
  const app = read('src/App.tsx')
  const note = app.match(/<span className="vq-mobile-note-text">([\s\S]*?)<\/span>/)
  assert.ok(note, '找不到手机提示那条文案')
  const text = note[1]
  assert.match(text, /手机也能检索/, '现在手机能检索了，文案要跟上')
  assert.match(text, /画布连线与逐帧评审建议在电脑上做/, '仍要在电脑上做的事要说清楚')
  assert.doesNotMatch(text, /检索、拆解与评审建议在电脑上做/, '旧文案和现状矛盾')
})

test('未登录实例失败退款也有形状：beginPaid 的早退分支必须带 refund', () => {
  const index = read('server/index.mjs')
  const branch = index.match(/if \(!user\?\.id\) return \{[^\n]*/)
  assert.ok(branch, '找不到 beginPaid 的未登录分支')
  assert.match(branch[0], /release:/, '早退分支要还并发名额')
  assert.match(branch[0], /refund:/, '少了 refund，检索/复刻失败会抛 TypeError 变成 500')
})
