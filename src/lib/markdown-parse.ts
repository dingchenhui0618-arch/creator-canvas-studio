// 极简 Markdown 解析（r220）：把模型回答里的标题 / 列表 / 表格 / 代码块 / 引用 /
// 加粗 / 行内代码 / 链接拆成数据，渲染交给 markdown.tsx。解析与渲染分开是为了能单测：
// 纯数据的东西可以用 node:test 跑，不用起浏览器。
//
// 只覆盖模型真正常用的那一小撮语法，不追求 CommonMark 完整实现，也不引入新依赖；
// 渲染走 React 节点，全程不用 dangerouslySetInnerHTML，所以模型写什么都不会变成脚本。

export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }

const FENCE = /^\s*```\s*([A-Za-z0-9+#._-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/
// --- / *** / ___ 这类分隔线：不拦的话会当成一段「---」原文显示出来
const RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/
const QUOTE = /^\s*>\s?/
const LIST_ITEM = /^\s*[-*+]\s+/
const ORDERED_ITEM = /^\s*\d+[.、)]\s+/

/** 只放行能安全打开的地址；其余按原文显示，不当链接。 */
export function isSafeHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(href.trim())
}

export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isBlockStart(line: string, next?: string): boolean {
  if (!line.trim()) return true
  if (FENCE.test(line)) return true
  if (HEADING.test(line)) return true
  if (RULE.test(line)) return true
  if (QUOTE.test(line)) return true
  if (LIST_ITEM.test(line)) return true
  if (ORDERED_ITEM.test(line)) return true
  if (line.trim().startsWith('|') && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes('-')) return true
  return false
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    const fence = line.match(FENCE)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      index += 1 // 跳过收尾的 fence；没有收尾（边生成边渲染）就到末尾为止
      blocks.push({ kind: 'code', lang: fence[1] || '', text: code.join('\n') })
      continue
    }
    if (
      line.trim().startsWith('|') &&
      index + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[index + 1]) &&
      lines[index + 1].includes('-')
    ) {
      const header = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      index += 1
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }
    if (QUOTE.test(line)) {
      const quote: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        quote.push(lines[index].replace(QUOTE, '').trim())
        index += 1
      }
      blocks.push({ kind: 'quote', lines: quote })
      continue
    }
    if (LIST_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const ordered = ORDERED_ITEM.test(line)
      const pattern = ordered ? ORDERED_ITEM : LIST_ITEM
      const items: string[] = []
      while (index < lines.length && pattern.test(lines[index])) {
        items.push(lines[index].replace(pattern, '').trim())
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', lines: paragraph })
    } else {
      // 兜底：认不出的行按原文出一段，绝不死循环
      blocks.push({ kind: 'paragraph', lines: [line] })
      index += 1
    }
  }
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/

export function parseInline(text: string): MarkdownInline[] {
  const source = String(text ?? '')
  const nodes: MarkdownInline[] = []
  let last = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((match = INLINE.exec(source))) {
    if (match.index > last) nodes.push({ kind: 'text', text: source.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith('**')) {
      nodes.push({ kind: 'strong', text: token.slice(2, -2) })
    } else if (token.startsWith('`')) {
      nodes.push({ kind: 'code', text: token.slice(1, -1) })
    } else {
      const link = token.match(LINK)
      if (link && isSafeHref(link[2])) nodes.push({ kind: 'link', text: link[1], href: link[2].trim() })
      else nodes.push({ kind: 'text', text: token })
    }
    last = match.index + token.length
  }
  if (last < source.length) nodes.push({ kind: 'text', text: source.slice(last) })
  return nodes
}

function inlinePlain(text: string): string {
  return parseInline(text)
    .map((token) => {
      if (token.kind === 'link') return token.href && token.href !== token.text ? token.text + ' ' + token.href : token.text
      return token.text
    })
    .join('')
}

/**
 * 复制用的纯文本（r247）：屏幕上渲染的是排版，粘进剪辑软件 / 文档里要的是字。
 * 去掉 ** 加粗、# 标题、表格分隔行这些记号，保留换行、序号与代码块缩进；
 * 链接留成「标题 地址」，分隔线直接丢掉（它只是视觉分段）。
 */
export function markdownPlainText(source: string): string {
  const out: string[] = []
  for (const block of parseMarkdown(source)) {
    if (block.kind === 'code') {
      out.push(block.text.replace(/\s+$/, ''))
      out.push('')
      continue
    }
    if (block.kind === 'table') {
      out.push(block.header.map(inlinePlain).join('\t'))
      for (const row of block.rows) out.push(row.map(inlinePlain).join('\t'))
      out.push('')
      continue
    }
    if (block.kind === 'heading') {
      out.push(inlinePlain(block.text))
      out.push('')
      continue
    }
    if (block.kind === 'rule') continue
    if (block.kind === 'quote') {
      for (const line of block.lines) out.push(inlinePlain(line))
      out.push('')
      continue
    }
    if (block.kind === 'list') {
      block.items.forEach((item, index) => out.push((block.ordered ? index + 1 + '. ' : '· ') + inlinePlain(item)))
      out.push('')
      continue
    }
    out.push(block.lines.map(inlinePlain).join('\n'))
    out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
