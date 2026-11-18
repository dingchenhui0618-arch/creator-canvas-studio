// 作品流与作品项目在平板上的几条底线（r235）。
// 561–1080 这一段两头不靠：≤900 侧栏收成图标栏、作品流三列卡片落到 230–330px，
// 而手机那套（≤560）不生效，于是整条流仍是 12–14px、动作 24px 高；
// 作品项目 1024 下一张卡片 354px，标签 12px、搜索 32px、筛选胶囊 30px、状态胶囊 22px。
// 这里锁住抬上去的档位，同时锁住「桌面没被顺手放大」与「列数口径没动」。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const worksCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'works.css'), 'utf8')
const projectsCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'projects.css'), 'utf8')
const shellCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'shell.css'), 'utf8')

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

const BAND = '(min-width: 561px) and (max-width: 1080px)'
const works = mediaBlocks(worksCss, BAND, '.works-chip')[0]
const projects = mediaBlocks(projectsCss, BAND, '.vq-project-card')[0]

/** 取某条选择器的声明体；选择器写成一组（a,\n b { }）时也能命中。 */
function decls(block, selector) {
  assert.ok(block, '缺少这一段 @media')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp('(?:^|\\n)\\s*' + escaped + '(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少规则：' + selector)
  return match[1]
}

/** 文件里第一处同名规则（= 基样式，媒体查询里的覆盖都在后面）。 */
function firstRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少基样式：' + selector)
  return match[1]
}

test('作品流平板段：561–1080 才生效，且不改列数', () => {
  assert.ok(works, 'src/styles/works.css 里应该有 @media (min-width: 561px) and (max-width: 1080px) 的作品流规则')
  assert.match(worksCss, new RegExp('@media \\(min-width: 561px\\) and \\(max-width: 1080px\\) \\{\\s*\\/\\*?|@media \\(min-width: 561px\\) and \\(max-width: 1080px\\) \\{'))
  // 列数是 1080 / 768 / 480 三档定的口径：平板段只管字号与触控区
  assert.doesNotMatch(works, /grid-template-columns/, '平板段不该改列数，列数由 1080 / 768 / 480 三档决定')
})

test('作品流平板段：动作 44px、筛选 40px，正文抬到 13–15px', () => {
  const chip = decls(works, '.works-chip')
  assert.match(chip, /min-height:\s*40px/)
  assert.match(chip, /font-size:\s*14px/)

  const action = decls(works, '.works-action')
  assert.match(action, /min-height:\s*44px/)
  assert.match(action, /font-size:\s*14px/)
  // 下划线要贴着字：触控区向上撑满，文字坐在底部
  assert.match(action, /align-items:\s*flex-end/)

  const more = decls(works, '.works-more.is-button')
  assert.match(more, /min-height:\s*44px/)

  const title = decls(works, '.works-title')
  assert.match(title, /font-size:\s*15px/)
  assert.match(title, /-webkit-line-clamp:\s*2/)
  assert.match(title, /white-space:\s*normal/)

  assert.match(decls(works, '.works-summary'), /font-size:\s*14px/)
  assert.match(decls(works, '.works-time'), /font-size:\s*13px/)
  assert.match(decls(works, '.works-tag'), /font-size:\s*13px/)
  assert.match(decls(works, '.works-open'), /font-size:\s*13px/)
  assert.match(decls(works, '.works-fallback'), /font-size:\s*14px/)

  const close = decls(works, '.works-modal-close')
  assert.match(close, /width:\s*44px/)
  assert.match(close, /height:\s*44px/)
})

test('作品流桌面口径没被放大：12.5px 胶囊、24px 动作、14px 标题', () => {
  assert.match(firstRule(worksCss, '.works-chip'), /font-size:\s*12\.5px/)
  assert.match(firstRule(worksCss, '.works-action'), /min-height:\s*24px/)
  assert.match(firstRule(worksCss, '.works-title'), /font-size:\s*14px/)
  assert.match(firstRule(worksCss, '.works-grid'), /repeat\(4,/)
})

test('作品项目平板段：标题 18px、来源与打开 15px、标签 13px', () => {
  assert.ok(projects, 'src/styles/projects.css 里应该有 @media (min-width: 561px) and (max-width: 1080px) 的作品项目规则')

  const title = decls(projects, '.vq-project-card-title')
  assert.match(title, /font-size:\s*18px/)
  assert.match(title, /-webkit-line-clamp:\s*2/)
  assert.match(title, /white-space:\s*normal/)

  assert.match(decls(projects, '.vq-project-card-source'), /font-size:\s*15px/)
  assert.match(decls(projects, '.vq-project-card-go'), /font-size:\s*15px/)
  assert.match(decls(projects, '.vq-project-card-meta em'), /font-size:\s*13px/)
  // 96px 一格要放得下「1,800 积分」：数字与单位不拆行
  assert.match(decls(projects, '.vq-project-card-meta b'), /white-space:\s*nowrap/)
  assert.match(decls(projects, '.vq-project-card-head > .vq-mono'), /font-size:\s*13px/)

  // 选择器写成一组时取组里第一条：后面的 `,\n  .vq-project-share` 由 decls 的「组尾」分支吃掉
  const share = decls(projects, '.vq-project-card-version')
  assert.match(share, /height:\s*26px/)
  assert.match(share, /font-size:\s*13px/)
})

test('1081–1439：两列卡片还不够宽，六格同样按 3 × 2', () => {
  // 1200 下两列卡片只有 442px：六列落到 58px 一格，「1,830 积分」折成两行；
  // 1440 的 562px 才够排六列。这一段单独按 3 × 2，1440 及以上不动。
  const band = mediaBlocks(projectsCss, '(min-width: 1081px) and (max-width: 1439px)', '.vq-project-card-meta')[0]
  assert.ok(band, 'src/styles/projects.css 里应该有 1081–1439 的六格规则')
  assert.match(decls(band, '.vq-project-card-meta'), /repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(firstRule(projectsCss, '.vq-project-card-meta'), /repeat\(6,\s*minmax\(0,\s*1fr\)\)/)
})

test('作品项目平板段：搜索 44px、筛选 40px、状态胶囊 26px', () => {
  const search = decls(projects, '.vq-toolbar-search')
  assert.match(search, /height:\s*44px/)
  // 输入框默认 20 字符宽会成为搜索框的最小宽度：没有 min-width:0 就会被撑出正文区
  assert.match(search, /min-width:\s*0/)
  assert.match(decls(projects, '.vq-toolbar-search input'), /font-size:\s*15px/)
  assert.match(decls(projects, '.vq-toolbar-search-clear'), /width:\s*32px/)

  const chip = decls(projects, '.vq-project-page .vq-filter-chip')
  assert.match(chip, /height:\s*40px/)
  assert.match(chip, /font-size:\s*14px/)
  assert.match(decls(projects, '.vq-project-page .vq-filter-chip__count'), /font-size:\s*13px/)

  const tokens = decls(projects, '.vq-project-page')
  assert.match(tokens, /--chip-pill-h:\s*26px/)
  assert.match(tokens, /--chip-font:\s*13px/)

  // 状态胶囊与六格数据的列数口径都没动：780 以下单列、1080 以下六格 3 × 2
  assert.doesNotMatch(projects, /grid-template-columns/, '平板段不该改列数')
})

test('作品项目桌面口径没被放大：17px 标题、32px 搜索、30px 筛选', () => {
  assert.match(firstRule(projectsCss, '.vq-project-card-title'), /font-size:\s*17px/)
  // 搜索框与筛选胶囊的基样式在 shell.css（两页共用），不在 projects.css 里
  assert.match(firstRule(shellCss, '.vq-toolbar-search'), /height:\s*32px/)
  assert.match(firstRule(shellCss, '.vq-toolbar-search input'), /font-size:\s*14px/)
  assert.match(firstRule(shellCss, '.vq-filter-chip'), /height:\s*30px/)
  assert.match(firstRule(shellCss, '.vq-filter-chip'), /font-size:\s*12\.5px/)
  assert.match(firstRule(projectsCss, '.vq-project-card-meta em'), /font-size:\s*12px/)
  assert.match(firstRule(projectsCss, '.vq-project-card-go'), /font-size:\s*14px/)
})
