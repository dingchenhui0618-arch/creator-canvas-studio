// 作品详情页在手机与平板上的几条底线（r236）。
// 详情页此前只有桌面一档：390 与 768 上正文 12–13px，页里的链接（改脚本 / 提示词 / 查看运行）
// 只有 19–28px 高。这里锁住抬上去的档位，同时锁住「桌面（1081 起）一个像素没动」。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const projectsCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'projects.css'), 'utf8')
const pageSource = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'ProjectPage.tsx'), 'utf8')

/** 取一段 @media 块（按花括号配对），可选再加一层「必须包含某个选择器」的过滤。 */
function mediaBlocks(css, query, mustContain) {
  const out = []
  let from = 0
  for (;;) {
    const start = css.indexOf('@media ' + query, from)
    if (start < 0) break
    let depth = 0
    const open = css.indexOf('{', start)
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      if (css[index] === '}') {
        depth -= 1
        if (depth === 0) {
          out.push(css.slice(open, index + 1))
          from = index + 1
          break
        }
      }
    }
    if (from <= start) break
  }
  return mustContain ? out.filter((block) => block.includes(mustContain)) : out
}

/** 取某条选择器的声明体；选择器写成一组（a,\n b { }）时也能命中。 */
function decls(block, selector) {
  assert.ok(block, '缺少这一段 @media')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp('(?:^|\\n)\\s*' + escaped + '(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少规则：' + selector)
  return match[1]
}

/** 同一选择器可能出现在几组里（字号一组、触控区一组）：全部取回来，再按需断言。 */
function allDecls(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = []
  const regex = new RegExp('(?:^|\\n)\\s*' + escaped + '(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}', 'g')
  for (const match of block.matchAll(regex)) out.push(match[1])
  return out
}

/** 文件里第一处同名规则（= 基样式，媒体查询里的覆盖都在后面）。 */
function firstRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少基样式：' + selector)
  return match[1]
}

const band = mediaBlocks(projectsCss, '(max-width: 1080px)', '.vq-project-detail')[0]
const phone = mediaBlocks(projectsCss, '(max-width: 560px)', '.vq-project-detail')[0]
const narrow = mediaBlocks(projectsCss, '(max-width: 520px)', '.vq-project-detail')[0]

test('详情页的档位只挂在 vq-project-detail 上，不连带作品项目列表', () => {
  assert.ok(band, 'projects.css 里应该有 @media (max-width: 1080px) 的 .vq-project-detail 规则')
  assert.ok(pageSource.includes('vq-page vq-project-page vq-project-detail'), '作品详情页根元素要带 vq-project-detail')
  // 作品项目列表也是 .vq-project-page：抬字号不能顺带把列表页改了
  assert.ok(!projectsCss.includes('@media (max-width: 1080px) {\n  .vq-project-page {\n    --text-mono'), '字号覆盖不该挂在 .vq-project-page 上')
})

test('详情页 1080 以下字号抬一档：正文 16、小字 13、面板标题 17', () => {
  const root = decls(band, '.vq-project-detail')
  assert.match(root, /--text-mono:\s*13px/)
  assert.match(root, /--text-meta:\s*14px/)
  assert.match(root, /--text-copy:\s*16px/)
  assert.match(root, /--text-md:\s*17px/)

  // 12px 的小字整组抬到 13：结论胶囊、运行状态、版本行、节拍编号走 .vq-mono
  for (const selector of ['.vq-project-verdict', '.vq-run-status', '.vq-version-issues', '.vq-project-archive-note', '.vq-project-versions-note']) {
    const body = decls(band, '.vq-project-detail ' + selector)
    assert.match(body, /font-size:\s*13px/, selector + ' 应该抬到 13px')
  }
  const mono = decls(band, '.vq-page.vq-project-detail .vq-mono')
  assert.match(mono, /font-size:\s*13px/)
})

test('详情页 1080 以下触控区：按钮 40px、链接类按钮 40px、胶囊高度跟着抬', () => {
  assert.match(decls(band, '.vq-project-detail .vq-button'), /min-height:\s*40px/)

  for (const selector of ['.vq-project-back', '.vq-script-link', '.vq-shot-prompt-toggle', '.vq-version-review', '.vq-next-cta']) {
    const bodies = allDecls(band, '.vq-project-detail ' + selector)
    assert.ok(bodies.length > 0, '缺少规则：' + selector)
    assert.ok(bodies.some((body) => /min-height:\s*40px/.test(body)), selector + ' 应该给到 40px 触控区')
  }

  // 有显式 height 的那几条要一起改，不然 min-height 压不过 height: 24px
  assert.ok(allDecls(band, '.vq-project-detail .vq-version-review').some((body) => /height:\s*40px/.test(body)), '评审胶囊要显式给 height: 40px')
  assert.match(decls(band, '.vq-project-detail .vq-version-n'), /height:\s*26px/)
  assert.match(decls(band, '.vq-project-detail .vq-project-verdict'), /font-size:\s*13px/)
  assert.ok(allDecls(band, '.vq-project-detail .vq-project-verdict').some((body) => /height:\s*24px/.test(body)), '结论胶囊要显式给 height: 24px')
})

test('手机再抬到 44px，平板停在 40px', () => {
  assert.ok(phone, '应该有 @media (max-width: 560px) 的 .vq-project-detail 规则')
  assert.ok(allDecls(phone, '.vq-project-detail .vq-project-back').some((body) => /min-height:\s*44px/.test(body)), '手机端返回键应该是 44px 高')
  assert.ok(allDecls(phone, '.vq-project-detail .vq-version-review').some((body) => /height:\s*44px/.test(body)), '手机端评审胶囊应该是 44px 高')
  // 平板段不能跟着写 44：768 上应该是 40
  assert.doesNotMatch(decls(band, '.vq-project-detail .vq-project-back'), /44px/)
})

test('320 的版次行改成竖排，窄屏不再被「最近一评 …」顶出屏幕', () => {
  assert.ok(narrow, '应该有 @media (max-width: 520px) 的 .vq-project-detail 规则')
  const row = decls(narrow, '.vq-project-detail .vq-version-row')
  assert.match(row, /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(decls(narrow, '.vq-project-detail .vq-version-row > .vq-version-n'), /justify-self:\s*start/)
})

test('栏目的隐式列钉成 minmax(0, 1fr)：来源面板的长模板名不再把面板顶宽', () => {
  const body = decls(band, '.vq-project-detail .vq-project-col')
  assert.match(body, /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(decls(band, '.vq-project-detail .vq-project-source'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
})

test('桌面（1081 起）没被顺手放大：基样式仍是 12/13px 与 19–24px 的按钮', () => {
  assert.match(firstRule(projectsCss, '.vq-version-review'), /height:\s*24px/)
  assert.match(firstRule(projectsCss, '.vq-script-link'), /font-size:\s*var\(--text-meta\)/)
  assert.doesNotMatch(firstRule(projectsCss, '.vq-script-link'), /min-height/)
  assert.match(firstRule(projectsCss, '.vq-project-verdict'), /font-size:\s*(?:12px|var\(--text-2xs\))/)
  // 新块里不许出现 1081 以上的媒体查询：这一轮只动窄屏
  assert.ok(!projectsCss.includes('min-width: 1081px) and (max-width: 1439px) {\n  .vq-project-detail'), '详情页不该在桌面段里加规则')
})

test('新块里的字号不低于 13px，也没有 11 以下的碎字号', () => {
  for (const block of [band, phone, narrow]) {
    for (const match of block.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      assert.ok(Number(match[1]) >= 13, '字号不该小于 13px：' + match[0])
    }
  }
})
