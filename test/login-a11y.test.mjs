// 登录页可读性守卫（r286）：登录页是产品的第一屏，这里退步一次，所有人都先看到它。
//
// 2026-11-20 用无头浏览器按 1440 / 390 量出来的原始状况：
//   · 输入框的可点区域只有 19px 高（外层 38px 的框里，input 自己不占高度，点在上下留白上会掉焦点）；
//   · 眼睛按钮 22×22、「记住我」的勾选框 13×13——手指点不着；
//   · 深色品牌栏的次要文字 3.32~4.08:1，低于正文 4.5:1；
//   · 390 宽时品牌栏占满一屏，登录框在首屏之外，想登录得先滚一屏。
// 这一组断言盯住修完的结果，别改回去。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const CSS = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'styles', 'shell.css'), 'utf8')

/** 取某个选择器的第一条规则体（不做层叠计算，够用来盯声明在不在）。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = CSS.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '找不到规则：' + selector)
  return match[1]
}

function decl(body, prop) {
  const hit = body.match(new RegExp('(?:^|[;\\s])' + prop + '\\s*:\\s*([^;]+)'))
  return hit ? hit[1].trim() : ''
}

/** WCAG 相对亮度，用来算「半透明白铺在 #111 上」实际是多少比多少。 */
function channel(value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function contrastOverInk(alpha) {
  const bg = 17
  const fg = Math.round(alpha * 255 + (1 - alpha) * bg)
  const l1 = 0.2126 * channel(fg) + 0.7152 * channel(fg) + 0.0722 * channel(fg)
  const l2 = 0.2126 * channel(bg) + 0.7152 * channel(bg) + 0.0722 * channel(bg)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

test('登录页的输入框够高：整个 44px 的框都是可点区域', () => {
  assert.match(decl(ruleBody('.vq-login .vq-input'), 'height'), /^44px$/)
  assert.match(decl(ruleBody('.vq-input input'), 'height'), /^100%$/, 'input 自己不占高度时，可点区域只剩一行字那么高')
})

test('输入框里的图标按钮与勾选框按手指尺寸来', () => {
  const action = ruleBody('.vq-input-action')
  assert.match(decl(action, 'width'), /^32px$/)
  assert.match(decl(action, 'height'), /^32px$/)
  const check = ruleBody('.vq-check input')
  assert.match(decl(check, 'width'), /^24px$/)
  assert.match(decl(check, 'height'), /^24px$/)
  assert.match(decl(ruleBody('.vq-check'), 'min-height'), /^24px$/)
})

test('深色品牌栏的次要文字至少 4.5:1', () => {
  const targets = ['.vq-login-facts .vq-mono', '.vq-login-evidence-meta', '.vq-login-evidence-meta .vq-mono', '.vq-login-brand-foot .vq-mono']
  for (const selector of targets) {
    const color = decl(ruleBody(selector), 'color')
    const alpha = color.match(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/)
    assert.ok(alpha, selector + ' 不再是半透明白：' + color)
    const ratio = contrastOverInk(parseFloat(alpha[1]))
    assert.ok(ratio >= 4.5, selector + ' 只有 ' + ratio.toFixed(2) + ':1（要 ≥ 4.5）')
  }
})

test('390 宽时表单排在品牌栏前面：登录框要在首屏里', () => {
  const phone = CSS.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/)
  assert.ok(phone, '找不到 640 断点')
  const body = phone[1]
  const panel = body.match(/\.vq-login-panel \{[^}]*order:\s*(\d+)/)
  const brand = body.match(/\.vq-login-brand \{[^}]*order:\s*(\d+)/)
  assert.ok(panel && brand, '640 断点里要把表单与品牌栏排序写清楚')
  assert.ok(Number(panel[1]) < Number(brand[1]), '表单必须先于品牌栏，否则手机上要滚一屏才能登录')
})
