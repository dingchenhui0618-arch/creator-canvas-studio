// 按钮体系（v0.9.45）。这一轮钉住三件事：
//   1. reset 只继承字体族，权重必须低于组件类——否则全站按钮的字号又会被顶回 16px。
//   2. 用户主线上的四个页面不再出现旧的 .button 类名（含动态拼类名那种写法）。
//   3. 组件类自己的字号还在（11 / 13px 两档），别哪天被人「顺手」改回 16px。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

test('按钮 reset 用 :where() 降权，只负责继承字体族', () => {
  const css = read('src', 'styles', 'shell.css')
  assert.match(css, /:where\(\.vq-scope\) button,/)
  assert.match(css, /:where\(\.vq-scope\) input \{\s*font: inherit;/)
  // 旧的写法（0-1-1）会盖掉 .vq-button / .button / .vq-button--tiny 的字号
  assert.doesNotMatch(css, /^\.vq-scope button,\s*$/m)
})

test('组件类自己的字号与字重没有丢', () => {
  const css = read('src', 'styles', 'shell.css')
  const base = css.slice(css.indexOf('.vq-button {'), css.indexOf('.vq-button--primary'))
  assert.match(base, /font-size: 13px/)
  assert.match(base, /font-weight: 500/)
  const tiny = css.slice(css.indexOf('.vq-button--tiny {'), css.indexOf('.vq-button--tiny {') + 120)
  assert.match(tiny, /font-size: 11px/)
})

test('用户主线四页不再用旧的 .button 类名', () => {
  for (const page of ['TemplateLibraryPage', 'RadarPage', 'ReviewPage', 'RunsPage']) {
    const source = read('src', 'pages', page + '.tsx')
    assert.doesNotMatch(source, /className="button( |")/, page + ' 还有旧的 button 类名')
    assert.doesNotMatch(source, /'button '|'button button--/, page + ' 还有动态拼的 button 类名')
    assert.doesNotMatch(source, /'button--(ghost|primary|tiny|danger)'/, page + ' 还有旧的 button-- 修饰类')
  }
})

test('页面级布局选择器同时认新旧两套类名', () => {
  for (const file of [['styles', 'radar.css'], ['styles', 'review.css'], ['styles', 'runs.css'], ['App.css']]) {
    const css = read('src', ...file)
    // 换类名之后，靠 .button 起作用的宽度 / 换行规则必须还能命中 vq-button
    assert.match(css, /:is\(\.button,\.vq-button\)/)
  }
})
