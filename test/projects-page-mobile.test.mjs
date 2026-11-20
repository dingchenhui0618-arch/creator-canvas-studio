// 作品项目在手机上的几条底线（r234）。
// 「作品」切到「作品项目」后，390 下卡片只有 290px 宽、24px 内边距把正文压到 240px：
// 六格数据落到 74px 一格，「1,800 积分」折成「1,800 积 / 分」并把那一路格子拉高；
// 长标题一行就「…」；搜索框 32px、筛选胶囊 30px、状态胶囊 22px，手机上点不准也读不清。
// 这里锁住抬上去的档位，同时锁住「桌面六格 / 780 以下单列 3 × 2」这条口径没被改掉。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'projects.css'), 'utf8')

/** 取一段 @media 块（按花括号配对），可选再加一层「必须包含某个选择器」的过滤。 */
function mediaBlocks(query, mustContain) {
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

const phone = mediaBlocks('(max-width: 560px)', '.vq-project-card')[0]
const tablet = mediaBlocks('(max-width: 780px)', '.vq-projects-grid')[0]

/** 取某条选择器的声明体；选择器写成一组（a,\n b { }）时也能命中。 */
function decls(block, selector) {
  assert.ok(block, '缺少这一段 @media')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp('(?:^|\\n)\\s*' + escaped + '(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少规则：' + selector)
  return match[1]
}

/** 文件里第一处同名规则（= 基样式，媒体查询里的覆盖都在后面）。 */
function firstRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少基样式：' + selector)
  return match[1]
}

test('手机卡片：内边距收到 17px，六格数据改 2 × 3，数字不再折行', () => {
  assert.ok(phone, 'src/styles/projects.css 里应该有 @media (max-width: 560px) 的作品项目规则')
  const card = decls(phone, '.vq-project-card')
  assert.match(card, /padding:\s*16px/, '卡片内边距 16px（原来 24px，240px 正文太窄）')
  assert.match(card, /gap:\s*12px/, '卡片内间距 12px')
  const meta = decls(phone, '.vq-project-card-meta')
  assert.match(meta, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '六格改成 2 × 3')
  assert.match(meta, /gap:\s*8px 16px/, '格间距走 4/8 栅格')
  assert.match(decls(phone, '.vq-project-card-meta b'), /white-space:\s*nowrap/, '「1,800 积分」不许折成两行')
  assert.match(decls(phone, '.vq-project-card-meta em'), /font-size:\s*14px/, '标签 13px（原来 12px）')
})

test('手机标题放到 18px 且允许两行：一行 240px 只剩十四个字', () => {
  const title = decls(phone, '.vq-project-card-title')
  assert.match(title, /font-size:\s*18px/, '标题 18px（原来 17px）')
  assert.match(title, /-webkit-line-clamp:\s*2/, '最多两行')
  assert.match(title, /white-space:\s*normal/, '允许换行（桌面仍是一行省略号）')
  assert.match(title, /display:\s*-webkit-box/, '多行截断要用 -webkit-box')
})

test('手机上其余文字抬一档：来源与「打开作品」16px、时间与版次 14px', () => {
  assert.match(decls(phone, '.vq-project-card-source'), /font-size:\s*16px/, '模板来源 15px')
  assert.match(decls(phone, '.vq-project-card-go'), /font-size:\s*16px/, '「打开作品」15px')
  assert.match(decls(phone, '.vq-project-card-head > .vq-mono'), /font-size:\s*14px/, '右上角时间 13px')
  const version = decls(phone, '.vq-project-card-version')
  assert.match(version, /height:\s*26px/, '版次胶囊 26px 高')
  assert.match(version, /font-size:\s*14px/, '版次胶囊 13px')
  assert.match(decls(phone, '.vq-project-share'), /height:\s*26px/, '分享状态胶囊同样 26px')
})

test('状态胶囊与搜索、筛选的点击区：胶囊 28px、搜索 44px、筛选 40px', () => {
  const page = decls(phone, '.vq-project-page')
  assert.match(page, /--chip-pill-h:\s*28px/, '状态胶囊 28px 高（原来 22px）')
  assert.match(page, /--chip-font:\s*14px/, '胶囊文字 13px（原来 12px）')
  assert.match(page, /--chip-pad:\s*12px/, '胶囊内边距 12px')
  const search = decls(phone, '.vq-toolbar-search')
  assert.match(search, /height:\s*44px/, '搜索框 44px 高（原来 32px）')
  assert.match(search, /min-width:\s*0/, '搜索框要能缩：输入框默认 20 字符宽，不缩就顶出 320 的正文区')
  assert.match(search, /padding:\s*0 16px/, '搜索框内边距 16px')
  assert.match(decls(phone, '.vq-toolbar-search input'), /font-size:\s*16px/, '搜索框正文 15px')
  const clear = decls(phone, '.vq-toolbar-search-clear')
  assert.match(clear, /width:\s*32px/, '清除按钮 32px')
  assert.match(clear, /height:\s*32px/, '清除按钮 32px 高')
  const chip = decls(phone, '.vq-project-page .vq-filter-chip')
  assert.match(chip, /height:\s*40px/, '筛选胶囊 40px 高（原来 30px）')
  assert.match(chip, /font-size:\s*15px/, '筛选胶囊文字 14px（原来 12.5px）')
  assert.match(chip, /padding:\s*0 12px/, '筛选胶囊内边距 12px（三枚胶囊要与「共 N 条」同一行）')
  assert.match(decls(phone, '.vq-project-page .vq-toolbar-count'), /font-size:\s*14px/, '「共 N 条」13px')
})

test('口径没动：780 以下仍单列 3 × 2，桌面仍六格、560 那段只改间距不改列数', () => {
  assert.ok(tablet, '780 那段还在')
  assert.match(decls(tablet, '.vq-projects-grid'), /grid-template-columns:\s*minmax\(0, 1fr\)/, '780 以下单列')
  assert.match(decls(tablet, '.vq-project-card-meta'), /repeat\(3, minmax\(0, 1fr\)\)/, '780 以下是 3 × 2')
  // 560 那段只改间距，不改列数：单列口径由 780 那段负责
  assert.doesNotMatch(decls(phone, '.vq-projects-grid'), /grid-template-columns/, '560 那段不重复定义列数')
  // 桌面基样式不动：两列卡片、六格数据（取文件里第一处定义，即基样式）
  assert.match(firstRule('.vq-projects-grid'), /repeat\(2, minmax\(0, 1fr\)\)/, '桌面作品列表仍是两列')
  assert.match(firstRule('.vq-project-card-meta'), /repeat\(6, minmax\(0, 1fr\)\)/, '桌面卡片仍是六格')
})
