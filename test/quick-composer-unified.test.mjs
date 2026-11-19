// 快捷创作几个去向要像同一个产品（r256/r257）。这些是「靠近」的具体数字，不是感觉：
// 左边一条 240px 列表、右边一块工作面、输入卡 8px 内边距 / 中圆角——和「平台对话」一致。
// 谁再把图片 / 视频做回「独立面板 + 自己的标题头 + 16px 内边距」，这里会先拦下来。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')

// 只认行首那条规则（允许缩进）：同一段选择器可能是别处的后缀（.agx-page--platform .qc-root）
function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('(?:^|\\n)[ \\t]*' + escaped + '\\s*\\{').exec(source)
  assert.ok(match, '找不到规则 ' + selector)
  const end = source.indexOf('}', match.index)
  return source.slice(match.index, end)
}

test('图片 / 视频与对话同一个骨架：左 240px 列表 + 右边工作面', () => {
  const shell = rule(css, '.agx-media-shell')
  assert.match(shell, /grid-template-columns: 240px minmax\(0, 1fr\)/)
  // 与 .qc-root 的 240px 一致：切页签时左边那条列表的位置不跳
  assert.match(rule(css, '.qc-root'), /grid-template-columns: 240px minmax\(0, 1fr\)/)
})

test('输入卡密度与「平台对话」一致：8px 内边距、中圆角', () => {
  const card = rule(css, '.agx-composer--media')
  assert.match(card, /padding: 8px/)
  assert.match(card, /border-radius: var\(--radius-md\)/)
  assert.match(rule(css, '.qc-composer'), /padding: 8px/)
})

test('媒体面板不再自带标题头与独立面板壳', () => {
  assert.ok(!page.includes('agx-media-panel'), '还留着独立面板壳 .agx-media-panel')
  assert.ok(!page.includes('agx-media-head'), '还留着自己的标题头 .agx-media-head')
  assert.ok(page.includes('agx-composer--media'), '图片 / 视频没有用统一的输入卡外壳')
})

test('工作流不再占页签：只在页签右边留一条入口（r257）', () => {
  assert.ok(!page.includes("{ id: 'flow'"), '工作流又变回一个页签了')
  assert.ok(!page.includes('FlowPanel'), '快捷创作里还塞着工作流清单面板')
  assert.ok(page.includes('className="agx-flow-link"'), '没有工作流的入口')
  assert.ok(page.includes('onOpenCanvas(flowEntry.id)'), '入口没有去路')
  // 挂在这条作品上的那条流程优先，其次进流程列表：入口写清「几条 / 在帮谁」
  assert.ok(page.includes('flow.project?.id === projectContext.id'), '入口没有认「在帮哪条作品」')
  assert.ok(page.includes("'工作流 · ' + list.length + ' 条'"), '入口上没有流程条数')
})

test('平台对话铺满一屏：只有线程滚，输入卡不出屏幕（r257）', () => {
  assert.ok(page.includes('agx-page--platform'), '页面没有平台对话的布局标记')
  const thread = rule(css, '.agx-page--platform .qc-thread')
  assert.match(thread, /max-height: none/, '线程还留着 56vh 的上限，输入卡会被顶出屏幕')
  assert.match(thread, /min-height: 0/)
  assert.match(rule(css, '.page.agx-page--platform'), /height: 100%/)
  assert.match(rule(css, '.agx-page--platform .agx-quickchat'), /flex: 1 1 auto/)
})
