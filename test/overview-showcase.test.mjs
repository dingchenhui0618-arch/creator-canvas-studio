import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// 工作台「平台能做出什么」（r314）：五张真实作品画面 + 只在有真实数据时才出现的「我的作品」。
// 这组用例盯三件事：数据表本身干净、图片文件真的在、页面按「示例在前、我的作品在后」的顺序渲染。

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('效果示例：五条都在 public/works 下有真图，且不是外链', () => {
  const source = read('src/domain/showcase.ts')
  const items = [...source.matchAll(/key: '([^']+)',\s*\n\s*src: '([^']+)',/g)].map((m) => ({ key: m[1], src: m[2] }))
  assert.equal(items.length, 5, '示例条数应为 5')
  assert.equal(new Set(items.map((item) => item.key)).size, 5, 'key 不许重复')
  for (const item of items) {
    assert.match(item.src, /^\/works\/[a-z0-9-]+\.jpg$/, '只能引用站内 /works/*.jpg：' + item.src)
    const file = path.join(ROOT, 'public', item.src.replace(/^\//, ''))
    assert.ok(fs.existsSync(file), '图片不存在：' + item.src)
    const bytes = fs.readFileSync(file)
    assert.ok(bytes.length > 20 * 1024, '图片太小，可能是占位图：' + item.src)
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], '不是 JPEG：' + item.src)
  }
})

test('效果示例：文案给信息不给形容词，也不许出现 emoji 或假状态', () => {
  // 只查真正会显示出来的字段：注释里解释「不写生成中」是允许的
  const source = read('src/domain/showcase.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  for (const banned of ['生成中', '即将上线', '敬请期待', '示例图', '占位']) {
    assert.ok(!source.includes(banned), '示例数据里不该出现「' + banned + '」')
  }
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(source), '功能 UI 文案里不许出现 emoji')
  // 每条都要有一行「这一步用到了流程里的什么」的说明，不能只有标题
  const metas = [...source.matchAll(/meta: '([^']+)'/g)].map((m) => m[1])
  assert.equal(metas.length, 5)
  for (const meta of metas) assert.ok(meta.length >= 6, '说明太短：' + meta)
})

test('工作台：示例在前、我的作品在后，且一条都没有时不占一屏', () => {
  const page = read('src/pages/OverviewPage.tsx')
  const showcaseAt = page.indexOf('ov-showcase-grid')
  const wallAt = page.indexOf('aria-labelledby="ov-wall-title"')
  assert.ok(showcaseAt > 0 && wallAt > showcaseAt, '示例区要排在我的作品之前')
  assert.ok(page.includes("import { SHOWCASE } from '../domain/showcase'"))
  assert.ok(
    page.includes("wallItems.length || sectionFailed('模板库') || sectionFailed('作品') ? ("),
    '我的作品要按「有图或读失败」才占位',
  )
  // 示例区是静态数据，不许为了它去请求接口
  assert.ok(!page.includes('useEffect(() => { void loadShowcase'), '示例区不该单独发请求')
})

test('样式：一排放五张竖版，窄屏改成可横滑的一条，间距走 token', () => {
  const css = read('src/styles/overview.css')
  assert.match(css, /\.ov-showcase-grid \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/s)
  assert.match(css, /\.ov-showcase-media \{[^}]*aspect-ratio: 9 \/ 16/s)
  const narrow = css.slice(css.indexOf('@media (max-width: 820px)'))
  assert.ok(narrow.includes('grid-auto-flow: column'), '窄屏要横滑')
  assert.ok(narrow.includes('overflow-x: auto'))
  // 间距必须走 --space-*：示例区的规则里出现裸的 px 边距就算违规
  const block = css.slice(css.indexOf('.ov-showcase {'), css.indexOf('.ov-showcase-note'))
  assert.ok(!/margin(?:-top)?: \d+px/.test(block), '外边距要用 --space-* token')
})
