import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeHref, markdownPlainText, parseInline, parseMarkdown } from '../src/lib/markdown-parse.ts'

test('标题按级数为 heading，行内的加粗与代码被拆出来', () => {
  const blocks = parseMarkdown('## 结构与**钩子**\n\n### 分镜')
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'heading'])
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[1].level, 3)
  const inline = parseInline('先说**结论**再看 `case` 与 `代码`')
  assert.deepEqual(
    inline.map((token) => token.kind),
    ['text', 'strong', 'text', 'code', 'text', 'code'],
  )
  assert.equal(inline[1].text, '结论')
  assert.equal(inline[3].text, 'case')
  assert.equal(inline[5].text, '代码')
})

test('无序与有序列表各自成块，条目里的加粗保留', () => {
  const blocks = parseMarkdown('- 开场三秒**抓人**\n- 中间留一个反转\n\n1. 先写钩子\n2. 再写结构')
  assert.deepEqual(blocks.map((b) => b.kind), ['list', 'list'])
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(blocks[0].items, ['开场三秒**抓人**', '中间留一个反转'])
  assert.equal(blocks[1].ordered, true)
  assert.deepEqual(blocks[1].items, ['先写钩子', '再写结构'])
})

test('代码块保留缩进与语言，未闭合也吃到末尾', () => {
  const closed = parseMarkdown('\u0060\u0060\u0060js\nconst a = 1\n  const b = 2\n\u0060\u0060\u0060\n\n收尾一段')
  assert.equal(closed[0].kind, 'code')
  assert.equal(closed[0].lang, 'js')
  assert.equal(closed[0].text, 'const a = 1\n  const b = 2')
  assert.equal(closed[1].kind, 'paragraph')
  const open = parseMarkdown('\u0060\u0060\u0060\n只写了一半')
  assert.equal(open.length, 1)
  assert.equal(open[0].text, '只写了一半')
})

test('表格按表头/分隔行/数据行拆开，中文字段不丢', () => {
  const blocks = parseMarkdown('| 时间段 | 动作 |\n| --- | --- |\n| 0-3s | 抛问题 |\n| 3-8s | 给答案 |')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].kind, 'table')
  assert.deepEqual(blocks[0].header, ['时间段', '动作'])
  assert.deepEqual(blocks[0].rows, [
    ['0-3s', '抛问题'],
    ['3-8s', '给答案'],
  ])
})

test('多行段落保留换行，不会每行单开一段', () => {
  const blocks = parseMarkdown('第一行\n第二行\n\n新的一段')
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0].lines, ['第一行', '第二行'])
  assert.deepEqual(blocks[1].lines, ['新的一段'])
})

test('引用与分隔线单独成块，不再当普通文字吐出来', () => {
  const blocks = parseMarkdown('> 三秒之内要给到信息\n> 否则划走\n\n---\n\n收尾')
  assert.deepEqual(blocks.map((b) => b.kind), ['quote', 'rule', 'paragraph'])
  assert.deepEqual(blocks[0].lines, ['三秒之内要给到信息', '否则划走'])
})

test('链接只放行 http/https/mailto，其余按原文显示', () => {
  assert.equal(isSafeHref('https://example.com/a'), true)
  assert.equal(isSafeHref('mailto:a@b.com'), true)
  assert.equal(isSafeHref('javascript:alert(1)'), false)
  assert.equal(isSafeHref('data:text/html,<script>'), false)
  const tokens = parseInline('看[这篇](https://example.com/x)和[坏的](javascript:alert)')
  assert.deepEqual(
    tokens.map((token) => token.kind),
    ['text', 'link', 'text', 'text'],
  )
  assert.equal(tokens[1].href, 'https://example.com/x')
  assert.equal(tokens[3].text, '[坏的](javascript:alert)')
  // 不安全的地址一个链接 token 都不许留
  assert.equal(tokens.every((token) => token.kind !== 'link' || isSafeHref(token.href)), true)
})

test('Windows 换行与空输入都不炸', () => {
  const blocks = parseMarkdown('## 标题\r\n\r\n正文')
  assert.deepEqual(blocks.map((b) => b.kind), ['heading', 'paragraph'])
  assert.deepEqual(parseMarkdown(''), [])
  assert.deepEqual(parseMarkdown('\n\n\n'), [])
})

test('脏输入不死循环：只有竖线、只有尖括号、只有短横线', () => {
  assert.deepEqual(parseMarkdown('|').map((b) => b.kind), ['paragraph'])
  assert.deepEqual(parseMarkdown('>').map((b) => b.kind), ['quote'])
  assert.deepEqual(parseMarkdown('-').map((b) => b.kind), ['paragraph'])
  assert.deepEqual(parseMarkdown('---').map((b) => b.kind), ['rule'])
})

// 复制回答（r247）：屏幕上渲染的是排版，剪贴板里要的是能直接粘走的字
test('复制成纯文本：标题、加粗、表格与序号的记号都去掉，换行与缩进保住', () => {
  const answer = [
    '## 口播分镜',
    '',
    '先说**结论**：三秒内给信息。',
    '',
    '- 第一镜：**开场钩子**',
    '- 第二镜：给答案',
    '',
    '| 镜号 | 时长 |',
    '| --- | --- |',
    '| 1 | 0-3s |',
    '',
    '\u0060\u0060\u0060js',
    'const a = 1',
    '  const b = 2',
    '\u0060\u0060\u0060',
    '',
    '---',
    '',
    '参考：[一篇](https://example.com/x)',
  ].join('\n')
  const text = markdownPlainText(answer)
  assert.equal(text.includes('**'), false)
  assert.equal(text.includes('##'), false)
  assert.equal(text.includes('| ---'), false)
  assert.match(text, /^口播分镜$/m)
  assert.match(text, /^先说结论：三秒内给信息。$/m)
  assert.match(text, /^· 第一镜：开场钩子$/m)
  assert.match(text, /^1\t0-3s$/m)
  assert.match(text, /^  const b = 2$/m)
  assert.match(text, /参考：一篇 https:\/\/example\.com\/x/)
  // 分隔线不在正文里留一行光秃秃的 ---
  assert.equal(/^---$/m.test(text), false)
})

test('复制成纯文本：空输入与只有分隔线都返回空，不吐一串空行', () => {
  assert.equal(markdownPlainText(''), '')
  assert.equal(markdownPlainText('   \n\n'), '')
  assert.equal(markdownPlainText('---'), '')
})

