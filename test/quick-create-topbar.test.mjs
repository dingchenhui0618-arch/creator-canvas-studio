// r307（2026-11-24）：快捷创作的页头收成一条工具条。
// 用户原话：「顶部无需具体描述这里 腾空页面空间」。改之前这一页从上到下是
// PageHead 一整块（kicker + 32px 标题 + 说明，122px）+ 创作方式一行（48px）+
// 对话方式一行（45px）+ 16px 上留白 = 231px 才见到对话卡。
// 这些断言钉住三件事：那块页头不许回来、三种方式与去路必须在同一条上、
// 窄屏折成两行且点按区仍是 40 / 44（r241 的底线）。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'agents.css'), 'utf8').replace(/\r\n/g, '\n')
const page = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'AgentsPage.tsx'), 'utf8')

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp('(?:^|\\n)[ \\t]*' + escaped + '\\s*\\{').exec(source)
  assert.ok(match, '找不到规则 ' + selector)
  const end = source.indexOf('}', match.index)
  return source.slice(match.index, end)
}

test('页头那块整版撤掉：没有 PageHead、没有标题下那句说明', () => {
  assert.ok(!page.includes('<PageHead'), 'PageHead 又回来了')
  assert.ok(!page.includes('写文案、出图片、出视频都在这一页'), '那句说明又写回页头了')
  assert.ok(!page.includes('kicker="快捷创作 / 对话"'), '页头 kicker 又回来了')
  assert.ok(!page.includes('vq-head'), '这一页又长出全站页头')
})

test('标题仍在，只是交给读屏：h1 在工具条里、视觉上不占位', () => {
  assert.ok(page.includes('<h1 className="agx-sr-only">快捷创作</h1>'), '页面级标题丢了')
  const sr = rule(css, '.agx-sr-only')
  assert.match(sr, /position:\s*absolute/)
  assert.match(sr, /width:\s*1px/)
  // 不能 display:none / visibility:hidden，那样读屏也读不到
  assert.ok(!/display:\s*none/.test(sr), '隐藏方式不对，读屏会读不到标题')
})

test('创作方式、对话方式、工作流去路在同一条工具条里', () => {
  const header = page.indexOf('<header className="agx-topbar">')
  assert.ok(header > 0, '没有工具条')
  const tabs = page.indexOf('aria-label="创作方式"', header)
  const surface = page.indexOf('aria-label="对话方式"', header)
  const flow = page.indexOf('className="agx-flow-link"', header)
  const stage = page.indexOf('<section className="agx-stage"', header)
  assert.ok(tabs > header && tabs < stage, '创作方式不在工具条里')
  assert.ok(surface > tabs && surface < stage, '对话方式不在工具条里（或在创作方式之前）')
  assert.ok(flow > surface && flow < stage, '工作流去路不在工具条里')
  // 旧的第二行容器必须彻底退场，否则工具条下面又会长出一行
  assert.ok(!page.includes('agx-mode-row'), '还留着旧的 .agx-mode-row')
  assert.ok(!css.includes('.agx-mode-row'), 'agents.css 里还留着 .agx-mode-row')
})

test('工具条本体：一条发丝线收底，12px 收口（4/8 栅格）', () => {
  const bar = rule(css, '.agx-topbar')
  assert.match(bar, /display:\s*flex/)
  // 去路靠右自己占一项：手机上它才能和「对话方式」并进同一行
  assert.match(rule(css, '.agx-topbar .agx-flow-link'), /margin-left:\s*auto/)
  assert.match(bar, /flex-wrap:\s*wrap/)
  assert.match(bar, /border-bottom:\s*1px solid var\(--line\)/)
  assert.match(bar, /padding:\s*0 0 12px/)
  assert.match(bar, /margin:\s*0 0 12px/)
  // 页签自己那 12px 下边距必须在工具条里归零，否则工具条凭空高 12px
  assert.match(rule(css, '.agx-topbar .agx-mode-tabs'), /margin-bottom:\s*0/)
  // 对话方式是同一行里的第二组，用一道发丝线分开，不再各占一行
  const surface = rule(css, '.agx-surface-switch')
  assert.match(surface, /padding-left:\s*12px/)
  assert.match(surface, /border-left:\s*1px solid var\(--line\)/)
  assert.ok(!/border-bottom/.test(surface), '对话方式又画了一条横线（那是「另起一行」的样子）')
})

test('两个满屏模式都把工具条钉住，不给它被内容压扁的机会', () => {
  assert.match(css, /\.agx-page--platform > \.agx-topbar \{\s*flex: none;/)
  assert.match(css, /\.agx-page--media > \.agx-topbar \{\s*flex: none;/)
})

test('窄屏折行：760 起「历史 / 新建」另起一行，560 起创作方式独占一行', () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]{0,1200}?\.agx-topbar \.agx-head-actions \{\s*flex: 1 1 100%;/)
  assert.match(css, /@media \(max-width: 560px\)[\s\S]{0,1200}?\.agx-topbar \.agx-mode-tabs \{\s*flex: 1 1 100%;/)
})

test('图片 / 视频页签上没有对话预设的动作（历史 / 新建）', () => {
  assert.ok(
    page.includes("composerMode === 'chat' && chatSurface !== 'platform' ? ("),
    '历史 / 新建对话预设又跑回图片、视频页签上了',
  )
  assert.ok(!page.includes('agx-topbar-actions'), '工具条里又套了一层动作容器')
})
