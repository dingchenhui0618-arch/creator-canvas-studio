// 页面宽度与胶囊宽度统一（r310 / v0.9.283）。
// 2026-11-24 在 1920 上量：工作台 / 作品 / 视觉评审 / 运行记录 / 设置的内容左边停在 x=438，
// 而顶栏面包屑与快捷创作页都在 x=236——同一屏两个左边起点，中间空出 202px。
// 原因是这些页的容器写死 1280 居中；快捷创作页 r309 已改成「上限 1520 + 左边对齐」。
// 同一天量「对话」页签的胶囊：触发按钮写死 max-width: 190px，值一长就收成省略号。
// 这里把两件事钉住：所有用户页同一个上限、同一个左边起点；胶囊按内容宽度排。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

function read(rel) {
  return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n')
}

function escapeSelector(selector) {
  return selector.replace(/[.*+?^${()|[\]\\]/g, '\\$&')
}

/**
 * 页面容器那条规则：同一个选择器在文件里可能出现多次（.review-page 先写了布局、后面才写页面框），
 * 所以取「带 max-width 的那一条」。App.css 是一条一行压起来的，行首锚点接不住，退到分号 / 花括号之后。
 */
function pageRule(source, selector) {
  const escaped = escapeSelector(selector)
  const lineStart = new RegExp('(?:^|\n)[ \t]*' + escaped + '\\s*\\{', 'g')
  let match = null
  let block = null
  while ((match = lineStart.exec(source))) {
    const start = source.indexOf(selector, match.index)
    const end = source.indexOf('}', start)
    const candidate = source.slice(start, end)
    if (/max-width:|min-width:/.test(candidate)) block = candidate
    lineStart.lastIndex = end
  }
  if (!block) {
    const loose = new RegExp('(?:[;}]\\s*)' + escaped + '\\s*\\{').exec(source)
    if (loose) {
      const start = source.indexOf(selector, loose.index)
      const end = source.indexOf('}', start)
      const candidate = source.slice(start, end)
      if (/max-width:|min-width:/.test(candidate)) block = candidate
    }
  }
  assert.ok(block, '找不到带 max-width 的规则 ' + selector)
  return block
}

const PAGES = [
  ['src/App.css', '.page'],
  ['src/styles/overview.css', '.vq-page'],
  ['src/styles/runs.css', '.runs-page'],
  ['src/styles/review.css', '.review-page'],
  ['src/styles/nav.css', '.vq-skeleton'],
]

test('所有用户页共用一个宽度上限与一个左边起点（r310）', () => {
  for (const [file, selector] of PAGES) {
    const block = pageRule(read(file), selector)
    assert.match(block, /max-width:\s*1520px/, selector + ' 的上限要和快捷创作页一致')
    // 关键在 margin-inline: 0 auto —— 宽屏只往右长，左边不许再空出一条随分辨率变宽的缝
    assert.match(block, /margin-inline:\s*0 auto/, selector + ' 要贴左边对齐')
    assert.ok(!/margin:\s*0 auto/.test(block), selector + ' 又写回居中了')
  }
})

test('胶囊不再有 190px 的硬上限：宽度由值决定', () => {
  const css = read('src/styles/agents.css')
  const capsule = pageRule(css, '.agx-capsule')
  assert.match(capsule, /max-width:\s*100%/)
  assert.match(capsule, /min-width:\s*0/)
  const trigger = pageRule(css, '.agx-capsule-trigger')
  assert.ok(!/190px/.test(trigger), '190px 的上限还在，长模型名又会被截')
  assert.match(trigger, /max-width:\s*100%/)
  assert.match(trigger, /min-width:\s*0/)
  // 省略号只在值比整行还长时兜底用，不能把 nowrap 一起去掉
  const em = pageRule(css, '.agx-capsule-trigger em')
  assert.match(em, /text-overflow:\s*ellipsis/)
  assert.match(em, /white-space:\s*nowrap/)
})
