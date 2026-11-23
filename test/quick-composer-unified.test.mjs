// 快捷创作几个去向要像同一个产品（r256/r257）。这些是「靠近」的具体数字，不是感觉：
// 左边一条列表、右边一块工作面、输入卡 8px 内边距 / 中圆角——和「平台对话」一致。
// r294：那条列表从 240 收到 208（对话里用户嫌它太大），两条路径仍然同一个数。
// 谁再把图片 / 视频做回「独立面板 + 自己的标题头 + 16px 内边距」，这里会先拦下来。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
// CSS 在 Windows 检出里是 CRLF：rules 里写多行选择器时先把换行统一成 LF 再匹配
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8').replace(/\r\n/g, '\n')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')
// r262：「看大图」抽成共用浮层（快捷创作 + 作品流），浮层的样式搬到了独立文件
const lightboxCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'media-lightbox.css'), 'utf8').replace(/\r\n/g, '\n')
const lightbox = fs.readFileSync(path.join(ROOT, 'src', 'components', 'MediaLightbox.tsx'), 'utf8')
const worksPage = fs.readFileSync(path.join(ROOT, 'src', 'components', 'WorksWall.tsx'), 'utf8')
const worksCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'works.css'), 'utf8').replace(/\r\n/g, '\n')

// 只认行首那条规则（允许缩进）：同一段选择器可能是别处的后缀（.agx-page--platform .qc-root）
function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('(?:^|\\n)[ \\t]*' + escaped + '\\s*\\{').exec(source)
  assert.ok(match, '找不到规则 ' + selector)
  const end = source.indexOf('}', match.index)
  return source.slice(match.index, end)
}

test('图片 / 视频与对话同一个骨架：左 208px 列表 + 右边工作面', () => {
  const shell = rule(css, '.agx-media-shell')
  assert.match(shell, /grid-template-columns: 208px minmax\(0, 1fr\)/)
  // 与 .qc-root 的 208px 一致：切页签时左边那条列表的位置不跳
  assert.match(rule(css, '.qc-root'), /grid-template-columns: 208px minmax\(0, 1fr\)/)
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

// r295：对话那张输入卡里的 textarea 自己画过一道 1px 直角黑框
// （.agx-page textarea:focus-visible 的 outline，点进去就出现），右下角还带缩放柄；
// 图片 / 视频那张 .agx-textarea 一直没有这两样。现在两张卡都只剩「整张卡片」一层框。
test('输入卡只有一层框：textarea 自己不描边、不带缩放柄（r295）', () => {
  const input = rule(css, '.qc-input')
  assert.match(input, /border:\s*0/, '对话的 textarea 又给自己描边了')
  assert.match(input, /resize:\s*none/, '对话的 textarea 又长出了右下角缩放柄')
  assert.match(
    css,
    /\.qc-composer \.qc-input:focus,\s*\n\.qc-composer \.qc-input:focus-visible \{ outline: 0; \}/,
    '对话的 textarea 又自己画焦点框了（整张卡片那层框之外的第二层）',
  )
  // 焦点提示不能跟着一起消失：整张卡片转墨 + 柔光，和 .agx-composer 同一套
  const focused = rule(css, '.qc-composer:focus-within')
  assert.match(focused, /border-color: var\(--ink\)/)
  assert.match(focused, /box-shadow: var\(--ring-soft\)/)
  // 描边与阴影也要同一档，否则切页签时一张卡深一张卡浅
  assert.match(rule(css, '.qc-composer'), /border: 1px solid var\(--line-strong\)/)
  assert.match(rule(css, '.qc-composer'), /box-shadow: var\(--shadow-card\)/)
  assert.match(rule(css, '.agx-composer'), /border: 1px solid var\(--line-strong\)/)
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
  assert.ok(page.includes('MediaLightbox'), '没有看大图的浮层')
  // r261：浮层记的是「正在看哪一条」（zoomTask），左边「最近生成」也开这一个
  assert.ok(page.includes("zoomTask && !hidden && zoomTask.status === 'succeeded'"), '浮层没有只对成功结果开，或被隐藏的面板还会把浮层留在屏幕上')
  // r262 起这两个属性在共用浮层组件里
  assert.match(lightbox, /role="dialog"/)
  assert.match(lightbox, /aria-modal="true"/)
  assert.ok(page.includes("event.key === 'Escape'"), 'Esc 关不掉浮层')
  // 关掉浮层的三个出口：叉、关闭按钮、Esc；面板上要重跑的那一下（r283 的「再生成一次」）也要顺手收掉
  assert.match(
    page,
    /const retryFromTask = async \(item: MediaTask\) => \{[\s\S]{0,1600}?setZoomTask\(null\)/,
    '重跑之前要先把浮层收掉',
  )
  // 浮层必须是整页固定层，压过窄屏历史弹层（z-index 60）
  const box = rule(lightboxCss, '.vq-lightbox')
  assert.match(box, /position: fixed/)
  assert.match(box, /inset: 0/)
  assert.match(box, /z-index: 70/)
  // 缩略图仍卡 340px；浮层里的图按视口缩放，不带这个上限
  assert.match(rule(css, '.agx-media-image,\n.agx-media-video'), /max-height: 340px/)
  // 必须是具体数值：在「高度由内容决定」的弹性盒里，百分比 max-height 会退化成 none
  assert.match(rule(lightboxCss, '.vq-lightbox-stage img,\n.vq-lightbox-stage video'), /max-height: calc\(100vh - 208px\)/)
  assert.ok(!/vq-lightbox-stage img[^{]*\{[^}]*340px/.test(lightboxCss), '浮层里的图还受缩略图上限管')
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
  assert.ok(page.includes("'来自「最近生成」'"), '浮层没有说明这条来自最近生成')
  assert.match(rule(lightboxCss, '.vq-lightbox-note'), /margin-left: auto/)
})

// r262：作品流的「看大图」和快捷创作共用同一个浮层。
// 以前作品流有自己一套 880px 弹层（.works-modal）：没有卡片底、图放大后跟背后的卡片文字叠在一起，
// 也没有「卡片跟着图收窄」——同一件事在同一个产品里不该有两种样子。
test('作品流与快捷创作共用同一个看大图浮层（r262）', () => {
  assert.ok(page.includes('<MediaLightbox'), '快捷创作没有用共用浮层')
  assert.ok(worksPage.includes('<MediaLightbox'), '作品流没有用共用浮层')
  assert.ok(worksPage.includes("import MediaLightbox from './MediaLightbox'"), '作品流没有引那个组件')
  // 作品流自己那套弹层必须彻底退场：组件、类名、样式都不许留
  assert.ok(!worksPage.includes('works-modal'), '作品流还留着旧的弹层 DOM')
  assert.ok(!worksCss.includes('works-modal'), '作品流还留着旧的弹层样式')
  // 浮层是同一个：整页固定层、压暗、Esc 关、图按视口缩放
  assert.match(lightbox, /role="dialog"/)
  assert.match(lightbox, /aria-modal="true"/)
  assert.match(lightboxCss, /background: rgba\(8, 8, 9, 0\.78\)/)
  // 视频点开就播：静音自动播浏览器才不拦（作品流那套 autoPlay 不带 muted，一打开就停在 0:00）
  assert.match(lightbox, /<video src=\{src\} controls playsInline preload="metadata" autoPlay=\{videoAutoPlay\} muted=\{videoAutoPlay\}/)
  // 卡片上的「看大图」字是 13px，但触控区不能只有 19px
  assert.match(rule(worksCss, '.works-open'), /min-height:\s*24px/)
  // 视频那一条的入口写「看视频」，别让一条片子挂着「看大图」
  assert.ok(worksPage.includes("isVideo ? '看视频' : '看大图'"), '视频卡片还写着「看大图」')
})
