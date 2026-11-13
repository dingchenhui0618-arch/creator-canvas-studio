// 胶囊与标签体系（v0.9.46）。这一轮钉住五件事：
//   1. 全站只有三档尺寸（状态 22 / 结论 26 / 标签 20），且走 --chip-* token，不许页面自己写。
//   2. 语气只换颜色：七种语气都得在同一个地方定义。
//   3. 以前那 10 个长得像胶囊的类名（有的 16px、有的 6px 圆角）不许再出现。
//   4. 胶囊窄屏不许被抻长、也不许把字折成两行——只能整行换行。
//   5. 评审页页头三颗胶囊必须能换行，否则 390 上又把页面顶出横向滚动。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const PILL_LEGACY = ['vq-project-status', 'vq-chip', 'status-pill', 'cv-run-badge', 'admin-badge', 'vq-health-tag', 'vq-badge', 'agx-tag', 'template-shared']

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(rel, out)
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

test('三档尺寸都走 --chip-* token，胶囊自己不写 px 高', () => {
  const tokens = read('src', 'styles', 'tokens.css')
  assert.match(tokens, /--chip-pill-h:\s*22px;/)
  assert.match(tokens, /--chip-pill-h-lg:\s*26px;/)
  assert.match(tokens, /--chip-tag-h:\s*20px;/)
  const css = read('src', 'styles', 'shell.css')
  const start = css.indexOf('.vq-pill {')
  const block = css.slice(start, css.indexOf('.vq-pill__dot'))
  assert.match(block, /height: var\(--chip-pill-h\);/)
  assert.doesNotMatch(block, /height:\s*\d+px/, '胶囊高度不许写成字面量')
  assert.doesNotMatch(block, /font-size:\s*\d+px/, '胶囊字号不许写成字面量')
  const tag = css.slice(css.indexOf('.vq-tag {'), css.indexOf('.vq-tag--ink'))
  assert.match(tag, /height: var\(--chip-tag-h\);/)
  assert.match(tag, /border-radius: var\(--radius-pill\);/)
  assert.doesNotMatch(tag, /height:\s*\d+px/)
})

test('语气只有颜色差别，七种语气都在一处定义', () => {
  const css = read('src', 'styles', 'shell.css')
  for (const tone of ['is-idle', 'is-live', 'is-pass', 'is-warn', 'is-fail', 'is-done', 'is-mock']) {
    assert.match(css, new RegExp('\\.vq-pill\\.' + tone), '缺少语气 ' + tone)
  }
  // 语气规则里不许再出现尺寸：换语气只换颜色
  const toneBlock = css.slice(css.indexOf('.vq-pill.is-pass'), css.indexOf('.vq-tag {'))
  assert.doesNotMatch(toneBlock, /height:/, '语气规则里不该写高度')
  assert.doesNotMatch(toneBlock, /font-size:/, '语气规则里不该写字号')
  assert.match(css, /\.vq-pill--lg \{\s*height: var\(--chip-pill-h-lg\);\s*font-size: var\(--chip-font-lg\);/, '结论胶囊要单独一档且走 token')
})

test('旧的十个胶囊类名彻底退场', () => {
  for (const file of walk('src')) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    for (const legacy of PILL_LEGACY) {
      assert.ok(!source.includes(legacy), file + ' 还在用旧胶囊类名 ' + legacy)
    }
  }
})

test('胶囊窄屏不被抻长、也不折字', () => {
  const css = read('src', 'styles', 'shell.css')
  for (const selector of ['.vq-pill {', '.vq-tag {']) {
    const block = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
    assert.match(block, /width: fit-content;/, selector + ' 会被网格拉开成一条空长条')
    assert.match(block, /white-space: nowrap;/, selector + ' 不许把胶囊里的字折成两行')
    assert.match(block, /flex: none;/, selector + ' 不许被旁边的内容压扁')
  }
})

test('评审页页头三颗胶囊允许换行', () => {
  const css = read('src', 'styles', 'review.css')
  assert.match(css, /\.review-head-status \{[^}]*flex-wrap:\s*wrap;/, '三颗胶囊在 390 上会把页面顶出横向滚动')
})
