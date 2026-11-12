// 视觉交付底线落到可执行的检查上（用户 2026-11-05 定的那六条里的三条）。
// 这一层不测「界面跑不跑得通」，测的是改界面的人有没有随手写 13px / 26px：
//   1. 间距只走 4/8 栅格：4 8 12 16 24 32 48 64（1–2px 只留给描边内缩这种视觉补偿）；
//   2. 微标签字号 11px 起（10px 在 1x 屏上必糊）；
//   3. 圆角只用一套尺度：6 10 14 20 24 999。
// 另外把两处「小屏被撑坏」的结构写成断言，免得下次改页头/顶栏又改回去。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const GRID = new Set([4, 8, 12, 16, 24, 32, 48, 64])
const HAIRLINE_MAX = 2
const RADIUS_SCALE = new Set([6, 10, 14, 20, 24, 999])
const SPACE_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
])

function cssFiles() {
  const out = [path.join(ROOT, 'src', 'App.css'), path.join(ROOT, 'src', 'index.css')]
  const dir = path.join(ROOT, 'src', 'styles')
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.endsWith('.css')) out.push(path.join(dir, name))
  }
  return out
}

/** 把一份 CSS 拆成声明：一行里塞多条（App.css 全是单行）也要拆开。 */
function declarations(text) {
  const out = []
  text.split('\n').forEach((line, index) => {
    const clean = line.replace(/\/\*.*?\*\//g, '')
    for (const chunk of clean.split(';')) {
      const match = chunk.match(/(?:^|[\s{])([a-z-]+)\s*:\s*([^:{}]+)$/)
      if (!match) continue
      out.push({ line: index + 1, prop: match[1], value: match[2].trim() })
    }
  })
  return out
}

function pxTokens(value) {
  return (value.match(/(?:^|[\s,(])-?([\d.]+)px/g) || []).map((piece) => parseFloat(piece.replace(/^[\s,(]-?/, '')))
}

test('间距只走 4/8 栅格：1–2px 只做描边内缩，其余必须是 4 的倍数档位', () => {
  const bad = []
  for (const file of cssFiles()) {
    for (const found of declarations(fs.readFileSync(file, 'utf8'))) {
      if (!SPACE_PROPS.has(found.prop)) continue
      if (found.value.includes('(') || found.value.includes('var(')) continue
      for (const px of pxTokens(found.value)) {
        if (px <= HAIRLINE_MAX) continue
        if (GRID.has(px)) continue
        bad.push(path.relative(ROOT, file) + ':' + found.line + '  ' + found.prop + ': ' + found.value)
      }
    }
  }
  assert.deepEqual(bad, [], '这些间距不在 4/8 栅格上：\n' + bad.join('\n'))
})

test('微标签字号 11px 起：10 / 10.5px 在 1x 屏上一律发糊', () => {
  const bad = []
  for (const file of cssFiles()) {
    for (const found of declarations(fs.readFileSync(file, 'utf8'))) {
      if (found.prop !== 'font-size') continue
      const px = found.value.match(/^([\d.]+)px$/)
      if (px && parseFloat(px[1]) < 11) bad.push(path.relative(ROOT, file) + ':' + found.line + '  ' + found.value)
    }
  }
  assert.deepEqual(bad, [], '这些字号小于 11px：\n' + bad.join('\n'))
})

test('圆角只用一套尺度：6 10 14 20 24 999', () => {
  const bad = []
  for (const file of cssFiles()) {
    for (const found of declarations(fs.readFileSync(file, 'utf8'))) {
      if (found.prop !== 'border-radius') continue
      if (found.value.includes('var(') || found.value.includes('/')) continue
      for (const px of pxTokens(found.value)) {
        if (RADIUS_SCALE.has(px)) continue
        bad.push(path.relative(ROOT, file) + ':' + found.line + '  border-radius: ' + found.value)
      }
    }
  }
  assert.deepEqual(bad, [], '这些圆角不在尺度上：\n' + bad.join('\n'))
})

test('尺度本身不许被改小：tokens.css 仍然是那四档圆角和八档间距', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
  for (const [name, px] of [['--space-1', 4], ['--space-2', 8], ['--space-3', 12], ['--space-4', 16], ['--space-6', 24], ['--space-8', 32], ['--space-12', 48], ['--space-16', 64]]) {
    assert.match(tokens, new RegExp(name + ':\\s*' + px + 'px'), name + ' 应该还是 ' + px + 'px')
  }
  for (const [name, px] of [['--radius-sm', 10], ['--radius-md', 14], ['--radius-lg', 20], ['--radius-xl', 24], ['--radius-pill', 999]]) {
    assert.match(tokens, new RegExp(name + ':\\s*' + px + 'px'), name + ' 应该还是 ' + px + 'px')
  }
})

/** 取某个 @media 块（按花括号配对），用来断言小屏专用规则还在。 */
function mediaBlock(file, query) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const start = text.indexOf('@media ' + query)
  assert.ok(start >= 0, file + ' 里没有 ' + query + ' 这段')
  let depth = 0
  let index = text.indexOf('{', start)
  const from = index
  for (; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, index + 1)
    }
  }
  throw new Error('花括号没配对：' + file + ' ' + query)
}

test('页头在窄屏不许把标题区撑成 384px 高（flex-basis 变成高度的那次事故）', () => {
  const block = mediaBlock('src/styles/page-head.css', '(max-width: 760px)')
  assert.match(block, /flex-direction:\s*column/, '窄屏页头应该是竖排')
  assert.match(block, /flex-wrap:\s*nowrap/, '竖排时 flex-wrap 必须是 nowrap，否则 flex-basis: 24rem 会变成 384px 高')
  assert.match(block, /\.vq-head-main\s*\{[^}]*flex:\s*none/, '.vq-head-main 在竖排时要 flex: none')
})

test('顶栏在 390 宽不许被模型按钮顶出去（横向滚动那次事故）', () => {
  const block = mediaBlock('src/styles/shell.css', '(max-width: 640px)')
  assert.match(block, /\.vq-model-name\s*\{[^}]*display:\s*none/, '窄屏要收起模型名，只留图标 + 箭头')
  assert.match(block, /\.vq-model-trigger\s*\{[^}]*max-width:\s*48px/, '窄屏模型按钮要限宽 48px')
  assert.match(block, /\.vq-breadcrumb\s*\{[^}]*white-space:\s*nowrap/, '面包屑不许换行成两行')
})
