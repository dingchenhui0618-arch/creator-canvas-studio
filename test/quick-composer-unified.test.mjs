// 快捷创作四个页签要像同一个产品（r256）。这两条是「靠近」的具体数字，不是感觉：
// 左边一条 240px 列表、右边一块工作面、输入卡 8px 内边距 / 中圆角——和「平台对话」一致。
// 谁再把图片 / 视频做回「独立面板 + 自己的标题头 + 16px 内边距」，这里会先拦下来。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')

function rule(source, selector) {
  const index = source.indexOf(selector + ' {')
  assert.ok(index >= 0, '找不到规则 ' + selector)
  const end = source.indexOf('}', index)
  return source.slice(index, end)
}

test('图片 / 视频与对话同一个骨架：左 240px 列表 + 右边工作面', () => {
  const shell = rule(css, '.agx-media-shell')
  assert.match(shell, /grid-template-columns:\s*240px minmax\(0, 1fr\)/)
  // 与 .qc-root 的 240px 一致：切页签时左边那条列表的位置不跳
  assert.match(rule(css, '.qc-root'), /grid-template-columns:\s*240px minmax\(0, 1fr\)/)
})

test('输入卡密度与「平台对话」一致：8px 内边距、中圆角', () => {
  const card = rule(css, '.agx-composer--media')
  assert.match(card, /padding:\s*8px/)
  assert.match(card, /border-radius:\s*var\(--radius-md\)/)
  assert.match(rule(css, '.qc-composer'), /padding:\s*8px/)
})

test('媒体面板不再自带标题头与独立面板壳', () => {
  assert.ok(!page.includes('agx-media-panel'), '还留着独立面板壳 .agx-media-panel')
  assert.ok(!page.includes('agx-media-head'), '还留着自己的标题头 .agx-media-head')
  assert.ok(page.includes('agx-composer--media'), '图片 / 视频没有用统一的输入卡外壳')
})

test('「工作流」是快捷创作里的一个页签，点一行就进那张画布', () => {
  assert.match(page, /\{ id: 'flow', label: '工作流' \}/)
  assert.ok(page.includes('<FlowPanel onOpenFlow={onOpenCanvas}'), '工作流页签没有挂上工作流清单')
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'components', 'FlowPanel.tsx'), 'utf8')
  assert.ok(panel.includes('onOpenFlow(flow.id)'), '清单里的行没有打开工作流的出口')
})
