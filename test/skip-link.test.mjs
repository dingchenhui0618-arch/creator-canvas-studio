// r338：「跳到主要内容」——键盘用户的第一站。
//
// 为什么加它：--focus 走查里每一屏都是「外壳 45 站 → 正文」，键盘用户每翻一页都得先按二十几下 Tab。
// 这个站平时收成 1×1，只有拿到焦点时现身；页面的地址栏就是路由（#/overview 这种），
// 所以它不能用锚点默认行为去跳（会把路由换掉），必须拦住默认行为、只把焦点送到 #vq-main。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const APP = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8')
// 「拦住默认行为 + 把焦点送到正文」这两句必须挨着（少一句都等于没跳：前者会把路由换掉，后者不挪焦点）
const SKIP_RE = /event\.preventDefault\(\)[\s\S]{0,40}document\.getElementById\('vq-main'\)\?\.focus\(\)/
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/styles/shell.css'), 'utf8')

const cssBlock = (selector) => {
  const at = CSS.indexOf(selector + ' {')
  if (at < 0) return ''
  const end = CSS.indexOf('}', at)
  return CSS.slice(at, end < 0 ? CSS.length : end + 1)
}

test('r338 · 跳到主要内容：外壳第一站是它，href 指向正文容器', () => {
  assert.ok(APP.includes('className="vq-skip"'), 'App.tsx 里没有 .vq-skip 这一站')
  assert.ok(APP.includes('href="#vq-main"'), '跳转目标不是 #vq-main')
  assert.ok(APP.includes("document.getElementById('vq-main')?.focus()"), '没有把焦点送到正文（只改地址不挪焦点等于没跳）')
  assert.ok(SKIP_RE.test(APP), '没拦住默认行为：这个站的地址栏就是路由，#vq-main 会把路由换掉（拦住默认行为 + 把焦点送到正文，两件事要挨着写）')
})

test('r338 · 跳到主要内容：正文容器可以被聚焦，但不占 Tab 的一站', () => {
  assert.ok(APP.includes('id="vq-main"'), '正文容器没有 id=vq-main')
  assert.ok(/id="vq-main"\s+tabIndex=\{-1\}/.test(APP), '正文容器缺 tabIndex={-1}（少了它读屏不会从正文开始念，多一个 0 会白占一站）')
})

test('r338 · 跳到主要内容：平时收着、拿到焦点才现身，且现身那一下走过渡', () => {
  const base = cssBlock('.vq-skip')
  assert.ok(base, 'shell.css 里没有 .vq-skip')
  assert.ok(/width:\s*1px/.test(base) && /height:\s*1px/.test(base), '平时不是 1×1：会占位、也会进「划过」那一层的取景')
  assert.ok(/clip-path:\s*inset\(50%\)/.test(base), '平时没有 clip-path 收着（只收 1px 不留裁剪，焦点框会露出来）')
  assert.ok(/border:\s*1px solid transparent/.test(base), '平时不该有可见描边')
  const focus = cssBlock('.vq-skip:focus-visible')
  assert.ok(focus, '没有 :focus-visible 那一档：键盘走到它时看不见')
  assert.ok(/width:\s*auto/.test(focus) && /clip-path:\s*none/.test(focus), '拿到焦点时没有展开')
  assert.ok(/box-shadow/.test(focus), '拿到焦点时没有环（与 r336 的焦点口径不一致）')
  for (const prop of ['color', 'background-color', 'border-color', 'box-shadow']) {
    assert.ok(new RegExp('transition:[^;]*' + prop).test(base), '基类的过渡里少了 ' + prop + '：这一站在焦点那一层会被记成硬切')
  }
})

test('r338 · 跳到主要内容：这两条改回去要能被发现（反证）', () => {
  const unclipped = CSS.replace('  clip-path: inset(50%);\n', '')
  assert.ok(unclipped !== CSS, '改坏用的锚点没匹配到')
  assert.ok(!/clip-path:\s*inset\(50%\)/.test(cssBlockFrom(unclipped, '.vq-skip')), '把裁剪删掉之后断言没发现（这一站平时就会露出来）')
  const noPrevent = APP.replace(SKIP_RE, "document.getElementById('vq-main')?.focus()")
  assert.notEqual(noPrevent, APP, '改坏用的锚点没匹配到')
  assert.ok(!SKIP_RE.test(noPrevent), '去掉 preventDefault 之后断言没发现（#vq-main 会把路由换掉）')
})

function cssBlockFrom(css, selector) {
  const at = css.indexOf(selector + ' {')
  if (at < 0) return ''
  const end = css.indexOf('}', at)
  return css.slice(at, end < 0 ? css.length : end + 1)
}
