// 「字被挤没了」的三处（r292）。
//
// 起因：拿生产的真实数据量 1440/390，三处本该读得全的字被挤成省略号——
//  · 评审页左侧「最近评审」：一行里挤着 [结论胶囊][标题][时间]，标题只剩 43px，
//    「毛衣折叠收纳法 · v2」显示成「毛衣…」；
//  · 运行记录：归属说明一行截断，「作品 · 毛衣折叠收纳法 · 第 1 版（归档）」切在括号里；
//  · 作品流竖卡：标题与「时间 · 模型名」各一行截断，「Seedance 2.0 · 极速」只剩「Seedance 2…」。
// 用户的原话是「至少让我看得清楚字是啥」，所以这三处不再靠截断省高度：
// 标题给两行、胶囊与时间退到第二行、模型名允许折行。这里把口径钉住。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (name) => fs.readFileSync(path.join(ROOT, 'src', 'styles', name), 'utf8')
const worksCss = read('works.css')
const runsCss = read('runs.css')
const reviewCss = read('review.css')

/** 文件里第一处同名规则（= 基样式；媒体查询里的覆盖都在后面）。 */
function firstRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少规则：' + selector)
  return match[1]
}

test('作品流：标题两行、时间与模型名折行，不再一行截断', () => {
  const title = firstRule(worksCss, '.works-title')
  assert.match(title, /-webkit-line-clamp:\s*2/)
  assert.match(title, /white-space:\s*normal/)
  assert.doesNotMatch(title, /white-space:\s*nowrap/)
  assert.match(title, /font-size:\s*15px/, '桌面档位不许顺手放大')

  const time = firstRule(worksCss, '.works-time')
  assert.match(time, /white-space:\s*normal/)
  assert.doesNotMatch(time, /text-overflow:\s*ellipsis/)
})

test('运行记录：归属说明最多两行，切在括号里的情况不再出现', () => {
  const where = firstRule(runsCss, '.runs-row-main .runs-row-where')
  assert.match(where, /-webkit-line-clamp:\s*2/)
  assert.match(where, /white-space:\s*normal/)
  assert.doesNotMatch(where, /text-overflow:\s*ellipsis/)
})

test('评审「最近评审」：标题独占一行，胶囊与时间退到第二行', () => {
  const item = firstRule(reviewCss, '.review-history .review-history-item')
  assert.match(item, /grid-template-areas/)
  assert.match(item, /'title title'/, '标题要独占整行，不能再和胶囊、时间挤三列')

  const title = firstRule(reviewCss, '.review-history .review-history-title')
  assert.match(title, /white-space:\s*normal/)
  assert.match(title, /-webkit-line-clamp:\s*2/)
  assert.match(title, /grid-area:\s*title/)
  // 弹层里列宽够（96px + 标题 + 时间），那条路径不许被这条规则带走
  assert.doesNotMatch(reviewCss, /\.review-history-modal \.review-history-item \{[^}]*grid-template-areas/, '弹层布局不该被改')
})
