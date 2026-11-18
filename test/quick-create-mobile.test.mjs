// 手机端快捷创作的两条结构约定（r225）。这一轮修的是两件「看得见但说不出」的事：
//   1. 「平台对话」时页面下面还挂着整块「已自建对话预设」——它跟这段对话没关系，
//      却让 390 宽的一页从 1176px 长到 2187px，还把贴底的输入框顶出视口；
//      所以只在 ≤900 收起来，桌面照旧（桌面那块是这一页的主要内容）。
//   2. 切到「对话预设」或图片 / 视频页签会把平台对话整块卸载，写了一半的提示词直接没了；
//      所以面板改成常驻 + hidden（.qc-root 是 display:grid，hidden 属性在它身上不生效，
//      必须由外层壳负责真正隐藏）。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

/** 取出查询里指定的所有 media 块（按大括号配对，够用且不依赖格式）。 */
function mediaBlocks(css, query) {
  const out = []
  let from = 0
  for (;;) {
    const at = css.indexOf(query, from)
    if (at < 0) return out
    const open = css.indexOf('{', at)
    if (open < 0) return out
    let depth = 0
    let i = open
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push(css.slice(open + 1, i))
    from = i + 1
  }
}

/** 去掉所有 media 块，剩下的就是「任何宽度都生效」的规则。 */
function outsideMedia(css) {
  let text = css
  for (;;) {
    const at = text.indexOf('@media')
    if (at < 0) return text
    const open = text.indexOf('{', at)
    if (open < 0) return text
    let depth = 0
    let i = open
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    text = text.slice(0, at) + text.slice(i + 1)
  }
}

const HIDE_LIBRARY = /\.agx-library\.is-in-platform-chat\s*\{\s*display:\s*none;?\s*\}/
const HIDE_WRAPPER = /\.agx-quickchat\[hidden\]\s*\{\s*display:\s*none;?\s*\}/

test('手机端「平台对话」把自建预设收起来，桌面不收', () => {
  const css = read('src', 'styles', 'agents.css')
  const narrow = mediaBlocks(css, '@media (max-width: 900px)')
  assert.ok(narrow.length > 0, 'agents.css 里应该有 max-width: 900px 的窄屏块')
  assert.ok(
    narrow.some((block) => HIDE_LIBRARY.test(block)),
    '≤900 必须把「平台对话」下的自建预设收起来：它跟当前对话无关，还会把贴底输入框顶出视口',
  )
  assert.doesNotMatch(outsideMedia(css), HIDE_LIBRARY, '这条不能写在所有宽度都生效的位置，桌面要照旧显示')
  assert.ok(
    narrow.some((block) => block.includes('.qc-composer { position: sticky')),
    '收起来之后输入框仍要贴底（这条一直在，别被后来的改动顶掉）',
  )
})

test('平台对话面板常驻：切页签只隐藏不卸载，草稿不会丢', () => {
  const page = read('src', 'pages', 'AgentsPage.tsx')
  assert.doesNotMatch(
    page,
    /\{composerMode === 'chat' && chatSurface === 'platform' \? <QuickChat/,
    '条件渲染会在切页签时卸载面板，草稿与正在生成的回答一起没了',
  )
  assert.match(page, /className="agx-quickchat"\s*\n?\s*hidden=\{!\(composerMode === 'chat' && chatSurface === 'platform'\)\}/)
  assert.match(page, /const \[chatMounted, setChatMounted\] = useState\(composerMode === 'chat'\)/)
  assert.match(page, /if \(mode.id === 'chat'\) setChatMounted\(true\)/, '从图片 / 视频切回对话时面板要重新出现（在点页签那一步做，不在 effect 里再渲染一次）')
})

test('隐藏由外层壳负责：.qc-root 自己是 grid，hidden 盖不住它', () => {
  const css = read('src', 'styles', 'agents.css')
  assert.ok(HIDE_WRAPPER.test(css), '.agx-quickchat[hidden] 必须显式 display: none，否则隐藏的面板仍占位置')
  assert.match(css, /\.qc-root \{\s*display: grid;/, '.qc-root 是 grid：这正是需要外层壳的原因（改了记得回来读这条测试）')
})

test('「对话预设」页签下自建预设照旧显示', () => {
  const page = read('src', 'pages', 'AgentsPage.tsx')
  assert.match(
    page,
    /className=\{'agx-library' \+ \(composerMode === 'chat' && chatSurface === 'platform' \? ' is-in-platform-chat' : ''\)\}/,
    '只给「平台对话」加收起用的类，别把对话预设那边一起藏了',
  )
})
