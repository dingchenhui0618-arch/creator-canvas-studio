// 快捷创作几个去向要像同一个产品（r256/r257）。这些是「靠近」的具体数字，不是感觉：
// 左边一条 240px 列表、右边一块工作面、输入卡 8px 内边距 / 中圆角——和「平台对话」一致。
// 谁再把图片 / 视频做回「独立面板 + 自己的标题头 + 16px 内边距」，这里会先拦下来。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
// CSS 在 Windows 检出里是 CRLF：rules 里写多行选择器时先把换行统一成 LF 再匹配
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8').replace(/\r\n/g, '\n')
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

test('输入卡密度与「平台对话」一致：8px 内边距、中圆角（r259 起是默认值）', () => {
  // r256 时这条密度只写在 .agx-composer--media 上，对话预设那张卡还是 24px 圆角 + 16px 内边距；
  // r259 把密度提到 .agx-composer 本身，两种输入卡这才真正是一个控件。
  const card = rule(css, '.agx-composer')
  assert.match(card, /padding: 8px/)
  assert.match(card, /border-radius: var\(--radius-md\)/)
  const platform = rule(css, '.qc-composer')
  assert.match(platform, /padding: 8px/)
  assert.match(platform, /border-radius: var\(--radius-md\)/)
  // 媒体输入卡不许再把密度覆盖回去（覆盖回来就等于又胖一圈）
  assert.ok(
    !/\.agx-composer--media\s*\{[^}]*padding/.test(css),
    '图片 / 视频又把内边距覆盖回去了',
  )
})

test('媒体面板不再自带标题头：只留一层负责挂载的壳', () => {
  // 这层壳不是「独立面板」（没有标题头、没有自己的边框与内边距），
  // 它的作用只是让图片 / 视频两个面板都挂着、只隐藏不卸载（切回来提示词还在）。
  const panel = rule(css, '.agx-page--media .agx-media-panel')
  assert.match(panel, /display: flex/)
  assert.ok(!/border|padding/.test(panel), '这层壳又长出边框或内边距了')
  assert.match(css, /\.agx-page--media \.agx-media-panel\[hidden\] \{\s*display: none;/)
  assert.ok(page.includes('className="agx-media-panel"'), '两个媒体面板的挂载壳没了')
  assert.ok(!page.includes('agx-media-head'), '还留着自己的标题头 .agx-media-head')
  assert.ok(page.includes('agx-composer--media'), '图片 / 视频没有用统一的输入卡外壳')
})

test('图片 / 视频也收进一屏：只有结果区滚，输入卡钉在底部（r259）', () => {
  assert.ok(page.includes('agx-page--media'), '页面没有图片 / 视频的布局标记')
  assert.match(rule(css, '.page.agx-page--media'), /height: 100%/)
  assert.match(rule(css, '.agx-page--media .agx-media-out'), /overflow-y: auto/)
  assert.match(rule(css, '.agx-page--media .agx-composer--media'), /margin-top: auto/)
  // 「已自建对话预设」是对话页签的内容，图片 / 视频下不许把页面再撑高一段
  assert.match(css, /\.agx-page--media \.agx-library \{\s*display: none;/)
})

test('当前方式不收参考素材时，参考区收成一行（r259）', () => {
  assert.ok(page.includes('const refsIdle = maxRefs === 0 && assets.length === 0'), '没有判断「托架空且方式不收」')
  assert.ok(page.includes('agx-qc-refs-idle'), '没有那一行说明')
  assert.match(rule(css, '.agx-qc-refs-idle'), /font-size: var\(--text-xs\)/)
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

test('结果区点开看大图（r260）：矮屏上 1:1 的图不再只能看见一条', () => {
  // 缩略图本身是入口，另外结果卡动作栏里还有一个明确的「看大图 / 放大看」
  assert.ok(page.includes('agx-media-zoom'), '缩略图不是「看大图」的入口')
  assert.ok(page.includes('agx-lightbox'), '没有看大图的浮层')
  // r261：浮层记的是「正在看哪一条」（zoomTask），左边「最近生成」也开这一个
  assert.ok(page.includes("zoomTask && !hidden && zoomTask.status === 'succeeded'"), '浮层没有只对成功结果开，或被隐藏的面板还会把浮层留在屏幕上')
  assert.match(page, /role="dialog"/)
  assert.match(page, /aria-modal="true"/)
  assert.ok(page.includes("event.key === 'Escape'"), 'Esc 关不掉浮层')
  // 关掉浮层的三个出口：叉、关闭按钮、Esc；「再生成 / 清掉结果」也要顺手带上
  assert.match(page, /const reset = \(\) => \{\s*if \(active\) return\s*setZoomTask\(null\)/)
  // 浮层必须是整页固定层，压过窄屏历史弹层（z-index 60）
  const box = rule(css, '.agx-lightbox')
  assert.match(box, /position: fixed/)
  assert.match(box, /inset: 0/)
  assert.match(box, /z-index: 70/)
  // 缩略图仍卡 340px；浮层里的图按视口缩放，不带这个上限
  assert.match(rule(css, '.agx-media-image,\n.agx-media-video'), /max-height: 340px/)
  // 必须是具体数值：在「高度由内容决定」的弹性盒里，百分比 max-height 会退化成 none
  assert.match(rule(css, '.agx-lightbox-stage img,\n.agx-lightbox-stage video'), /max-height: calc\(100vh - 208px\)/)
  assert.ok(!/agx-lightbox-stage img[^{]*\{[^}]*340px/.test(css), '浮层里的图还受缩略图上限管')
})

test('平台对话铺满一屏：只有线程滚，输入卡不出屏幕（r257）', () => {
  assert.ok(page.includes('agx-page--platform'), '页面没有平台对话的布局标记')
  const thread = rule(css, '.agx-page--platform .qc-thread')
  assert.match(thread, /max-height: none/, '线程还留着 56vh 的上限，输入卡会被顶出屏幕')
  assert.match(thread, /min-height: 0/)
  assert.match(rule(css, '.page.agx-page--platform'), /height: 100%/)
  assert.match(rule(css, '.agx-page--platform .agx-quickchat'), /flex: 1 1 auto/)
})

// r261：左边「最近生成」以前只有文字，想找一张图得挨条读提示词。
// 现在每行左边一块 48px 缩略图：图片直接显示，视频取第 0.1 秒当封面（只读 metadata，不下整条），
// 点缩略图开的是右边同一个看大图浮层。
test('最近生成带缩略图，点开是同一个看大图浮层（r261）', () => {
  assert.ok(page.includes('function RecentThumb('), '没有最近生成的缩略图组件')
  assert.ok(page.includes('agx-media-recent-thumb'), '每行没有缩略图')
  assert.ok(page.includes('onClick={() => setZoomTask(item)}'), '点缩略图没有开看大图浮层')
  assert.ok(page.includes('element.currentTime = 0.1'), '视频封面没有取第 0.1 秒那一帧')
  assert.match(page, /<video ref=\{videoRef\} src=\{task.downloadUrl\} muted playsInline preload="metadata"/)
  // 两个面板都挂着只隐藏：切页签时浮层要收掉，不然它会盖住刚切过去的那一页
  assert.match(page, /useEffect\(\(\) => \{[\s\S]{0,220}?if \(hidden\) setZoomTask\(null\)/, '切页签没有把浮层收掉')
  // 缩略图与文字是兄弟：缩略图开浮层、文字打开这一条，点哪儿都不会误触另一个
  const thumb = rule(css, '.agx-media-recent-thumb')
  assert.match(thumb, /width: 48px/)
  assert.match(thumb, /height: 48px/)
  assert.match(thumb, /cursor: zoom-in/)
  assert.match(rule(css, '.agx-media-recent-thumb img,\n.agx-media-recent-thumb video'), /object-fit: cover/)
  // 缩略图那一列 48px 之后，文字那半必须能收缩，否则提示词会把动作按钮挤到看不见
  assert.match(rule(css, '.agx-media-recent-body'), /min-width: 0/)
  assert.match(rule(css, '.agx-media-recent-open'), /flex: 1 1 auto/)
  // 从「最近生成」点开的浮层要说清它不是右边正在看的那一条
  assert.ok(page.includes('agx-lightbox-note'), '浮层没有说明这条来自最近生成')
  assert.match(rule(css, '.agx-lightbox-note'), /margin-left: auto/)
})
