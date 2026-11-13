// 帮助中心（v0.9.61）。这一轮钉住四件事：
//   1. 三篇内容都在、字段齐全，标题与摘要不是占位文案
//   2. slug 白名单与路由同源：认不出的 slug 落回目录，坏链接不挡人
//   3. 相关文章都能解析成真文章，没有指向自己的死链
//   4. 入口真的接上了：登录页、条款页、设置页、复刻失败与运行失败都能到帮助
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  HELP_ARTICLES,
  HELP_SLUGS,
  findHelpArticle,
  isHelpSlug,
  relatedArticles,
} from '../src/domain/help.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

test('三篇都在，标题、摘要与更新时间都不是占位', () => {
  assert.equal(HELP_ARTICLES.length, 3)
  assert.deepEqual([...HELP_SLUGS], ['credits', 'replicate-failed', 'copyright'])
  for (const article of HELP_ARTICLES) {
    assert.ok(article.title.length >= 6, article.slug + ' 的标题太短')
    assert.ok(article.summary.length >= 16, article.slug + ' 的摘要太短')
    assert.match(article.kicker, /^.+ \/ .+$/, article.slug + ' 的眉标要「中文 / English」两段')
    assert.match(article.updatedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(article.sections.length >= 3, article.slug + ' 至少要三节')
  }
})

test('每一节都有标题和内容，标题不重复', () => {
  const headings = new Set()
  for (const article of HELP_ARTICLES) {
    for (const section of article.sections) {
      assert.ok(section.heading.trim().length >= 4, article.slug + ' 里有空标题')
      assert.equal(headings.has(section.heading), false, '标题重复：' + section.heading)
      headings.add(section.heading)
      const hasBody =
        (section.paragraphs?.length ?? 0) > 0 ||
        (section.bullets?.length ?? 0) > 0 ||
        (section.steps?.length ?? 0) > 0
      assert.equal(hasBody, true, article.slug + ' 的「' + section.heading + '」没有正文')
      for (const text of section.paragraphs ?? []) assert.ok(text.trim().length >= 8)
      for (const text of section.bullets ?? []) assert.ok(text.trim().length >= 8)
      for (const step of section.steps ?? []) {
        assert.ok(step.title.trim().length > 0)
        assert.ok(step.text.trim().length >= 8)
      }
    }
  }
})

test('slug 白名单：认得出三篇，认不出的落回目录', () => {
  assert.equal(isHelpSlug('credits'), true)
  assert.equal(isHelpSlug('replicate-failed'), true)
  assert.equal(isHelpSlug('copyright'), true)
  assert.equal(isHelpSlug('nope'), false)
  assert.equal(isHelpSlug(''), false)
  assert.equal(isHelpSlug(null), false)
  assert.equal(isHelpSlug(undefined), false)
  assert.equal(findHelpArticle('copyright')?.slug, 'copyright')
  assert.equal(findHelpArticle('nope'), null)
  assert.equal(findHelpArticle(null), null)
})

test('相关文章都能解析成真文章，且不指向自己', () => {
  for (const article of HELP_ARTICLES) {
    assert.ok(article.related.length >= 1, article.slug + ' 至少给一条「接着看」')
    assert.equal(article.related.includes(article.slug), false, article.slug + ' 不能指向自己')
    const resolved = relatedArticles(article)
    assert.equal(resolved.length, article.related.length, article.slug + ' 有解析不了的相关文章')
    for (const item of resolved) assert.ok(HELP_SLUGS.includes(item.slug))
  }
})

test('内容对得上产品行为：退回、直链兜底、原始视频不保存', () => {
  const byText = (slug) => {
    const article = findHelpArticle(slug)
    return JSON.stringify(article)
  }
  assert.match(byText('credits'), /退回/)
  assert.match(byText('credits'), /流水/)
  assert.match(byText('replicate-failed'), /直链/)
  assert.match(byText('replicate-failed'), /上游/)
  assert.match(byText('copyright'), /不保存来源平台的原始视频文件|不保存/)
  assert.match(byText('copyright'), /删除模板时帧图一并删除|帧图/)
})

test('路由与页面接线：公开可读，单篇有地址', () => {
  const router = read('src', 'router.ts')
  assert.match(router, /kind: 'help'/)
  assert.match(router, /if \(head === 'help'\)/)
  assert.match(router, /'#\/help'/)
  assert.match(router, /route.kind === 'help'/)

  const app = read('src', 'App.tsx')
  assert.match(app, /<HelpPage slug=\{route\.slug\} \/>/)
  assert.match(app, /kind: 'help', slug: null/)
})

test('入口接真的存在：登录页、条款页、设置页、复刻失败、运行失败', () => {
  assert.match(read('src', 'pages', 'LoginPage.tsx'), /href="#\/help"/)
  assert.match(read('src', 'pages', 'LegalPage.tsx'), /href="#\/help"/)
  assert.match(read('src', 'pages', 'SettingsPage.tsx'), /HELP_ARTICLES/)
  assert.match(read('src', 'pages', 'SettingsPage.tsx'), /'#\/help\/' \+ item.slug/)
  assert.match(read('src', 'components', 'ReplicateModal.tsx'), /#\/help\/replicate-failed/)
  assert.match(read('src', 'pages', 'RunsPage.tsx'), /#\/help\/replicate-failed/)
})

test('帮助页自己能提交反馈，也能回到条款与隐私', () => {
  const page = read('src', 'pages', 'HelpPage.tsx')
  assert.match(page, /FeedbackModal/)
  assert.match(page, /#\/legal\/terms/)
  assert.match(page, /#\/legal\/privacy/)
})
