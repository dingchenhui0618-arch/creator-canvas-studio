// 按钮体系（v0.9.45 起，v0.9.47 归一）。这一轮钉住五件事：
//   1. reset 只继承字体族，权重必须低于组件类——否则全站按钮的字号又会被顶回 16px。
//   2. 全站只有一个按钮家族：9 个旧类名（含动态拼类名那种写法）不许再出现。
//   3. 尺寸只三档（28 / 32 / 40），且只能读 --btn-* token，页面里不许再写死 px。
//   4. 语气只换颜色不换尺寸；圆角一律 --radius-sm。
//   5. 焦点圈、按下位移、禁用光标只有一处定义。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const LEGACY = [
  'admin-btn',
  'lw-btn',
  'lw-icon-btn',
  'agx-btn',
  'agx-icon-btn',
  'cv-btn',
  'cv-icon-btn',
  'vq-icon-button',
  'vq-button--tiny',
  'vq-button--block',
]

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(p)
  }
  return out
}

const SRC = walk(path.join(ROOT, 'src'))

test('按钮 reset 用 :where() 降权，只负责继承字体族', () => {
  const css = read('src', 'styles', 'shell.css')
  assert.match(css, /:where\(\.vq-scope\) button,/)
  assert.match(css, /:where\(\.vq-scope\) input \{\s*font: inherit;/)
  assert.doesNotMatch(css, /^\.vq-scope button,\s*$/m)
})

test('尺寸三档全部走 --btn-* token，组件里没有写死的 px', () => {
  const tokens = read('src', 'styles', 'tokens.css')
  for (const name of ['--btn-h-sm', '--btn-h', '--btn-h-lg', '--btn-pad-sm', '--btn-pad', '--btn-font', '--btn-font-sm', '--btn-gap', '--btn-gap-sm']) {
    assert.match(tokens, new RegExp(name + ':[ ]*[0-9]'), '缺 token ' + name)
  }
  const css = read('src', 'styles', 'shell.css')
  const start = css.indexOf('.vq-button {')
  const end = css.indexOf('.vq-link {')
  const block = css.slice(start, end)
  for (const token of ['--btn-h', '--btn-pad', '--btn-font', '--btn-gap', '--radius-sm']) {
    assert.match(block, new RegExp('var\\(\\s*' + token + '\\s*\\)'), '按钮基类没用 ' + token)
  }
  assert.doesNotMatch(block, /height:\s*\d+px/, '按钮基类不许写死高度')
  assert.match(css, /\.vq-button--sm \{[^}]*height: var\(--btn-h-sm\)/)
  assert.match(css, /\.vq-button--lg \{[^}]*height: var\(--btn-h-lg\)/)
  assert.match(css, /\.vq-button--icon \{[^}]*width: var\(--btn-h\)/)
})

test('语气只换颜色，不写尺寸', () => {
  const css = read('src', 'styles', 'shell.css')
  for (const tone of ['primary', 'ghost', 'quiet', 'danger']) {
    const i = css.indexOf('.vq-button--' + tone + ' {')
    assert.ok(i > 0, '缺语气 ' + tone)
    const block = css.slice(i, css.indexOf('}', i))
    assert.doesNotMatch(block, /height:|font-size:|padding:|border-radius:/, tone + ' 里写了尺寸')
  }
})

test('九个旧按钮家族在 src 里归零', () => {
  for (const file of SRC) {
    const source = fs.readFileSync(file, 'utf8')
    const rel = path.relative(ROOT, file)
    for (const name of LEGACY) {
      const re = new RegExp('(^|[^\\w-])' + name.replace(/[-]/g, '\\-') + '(?![\\w-])')
      assert.doesNotMatch(source, re, rel + ' 还有 ' + name)
    }
  }
})

test('交互反馈只有一处定义', () => {
  const css = read('src', 'styles', 'shell.css')
  assert.match(css, /\.vq-button:focus-visible \{[^}]*box-shadow: 0 0 0 3px/)
  assert.match(css, /\.vq-button:not\(:disabled\):active \{[^}]*translateY\(1px\)/)
  assert.match(css, /\.vq-button:disabled \{[^}]*cursor: not-allowed/)
  const all = SRC.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  assert.doesNotMatch(all, /\.vq-button[^{,]*\{\s*outline: 2px solid/, '按钮焦点圈不许用 outline 另起一套')
})

test('页面级布局规则只认 .vq-button，不再兼容两套类名', () => {
  for (const file of [['styles', 'radar.css'], ['styles', 'review.css'], ['styles', 'runs.css'], ['App.css']]) {
    const css = read('src', ...file)
    assert.doesNotMatch(css, /:is\(\.button/, file.join('/') + ' 还在兼容旧的 .button')
  }
})
