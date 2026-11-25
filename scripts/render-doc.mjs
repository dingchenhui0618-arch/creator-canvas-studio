#!/usr/bin/env node
// 把仓库里的 Markdown 文档渲染成一页可读的 HTML（本地看稿用，不进构建产物）。
//
//   node scripts/render-doc.mjs docs/visionchat-proposal-2026-11-25.md [输出.html]
//
// 为什么自己写：仓库里没有 marked/markdown-it，为看一份方案装一个渲染器不值当。
// 只支持本项目文档真的会用到的语法：标题、分隔线、表格、列表（含缩进子项）、引用、
// 围栏代码、行内加粗/斜体/行内代码/链接。够用就好，遇到不认识的语法原样输出。

import fs from 'node:fs'
import path from 'node:path'

const input = process.argv[2]
if (!input) {
  console.error('用法：node scripts/render-doc.mjs <文档.md> [输出.html]')
  process.exit(2)
}
const source = fs.readFileSync(input, 'utf8')
const output = process.argv[3] || input.replace(/\.md$/, '.html')

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(text) {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/g, (_, code) => '<code>' + code + '</code>')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^(https?:|mailto:|#|\/)/.test(href) ? href : '#'
    return '<a href="' + safe + '" target="_blank" rel="noreferrer">' + label + '</a>'
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return out
}

const lines = source.replace(/\r\n/g, '\n').split('\n')
const html = []
let index = 0
let listStack = [] // { tag, indent }

function closeLists(toIndent = -1) {
  while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
    html.push('</' + listStack.pop().tag + '>')
  }
}

while (index < lines.length) {
  const line = lines[index]

  // 围栏代码
  if (/^```/.test(line)) {
    const lang = line.slice(3).trim()
    const body = []
    index += 1
    while (index < lines.length && !/^```/.test(lines[index])) {
      body.push(lines[index])
      index += 1
    }
    index += 1
    closeLists()
    html.push('<pre' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') + '><code>' + escapeHtml(body.join('\n')) + '</code></pre>')
    continue
  }

  // 表格：表头 + 分隔行
  if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]*-[\s|:-]*\|/.test(lines[index + 1] || '')) {
    closeLists()
    const readRow = (row) =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    const head = readRow(line)
    index += 2
    const rows = []
    while (index < lines.length && /^\s*\|/.test(lines[index])) {
      rows.push(readRow(lines[index]))
      index += 1
    }
    html.push('<table><thead><tr>' + head.map((cell) => '<th>' + inline(cell) + '</th>').join('') + '</tr></thead><tbody>')
    for (const row of rows) {
      html.push('<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join('') + '</tr>')
    }
    html.push('</tbody></table>')
    continue
  }

  if (/^\s*$/.test(line)) {
    closeLists(0)
    index += 1
    continue
  }

  if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
    closeLists()
    html.push('<hr>')
    index += 1
    continue
  }

  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) {
    closeLists()
    const level = heading[1].length
    html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>')
    index += 1
    continue
  }

  if (/^\s*>\s?/.test(line)) {
    closeLists()
    const body = []
    while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
      body.push(lines[index].replace(/^\s*>\s?/, ''))
      index += 1
    }
    html.push('<blockquote>' + body.map((row) => inline(row)).join('<br>') + '</blockquote>')
    continue
  }

  const bullet = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
  if (bullet) {
    const indent = bullet[1].length
    const tag = /\d/.test(bullet[2]) ? 'ol' : 'ul'
    const top = listStack[listStack.length - 1]
    if (!top || indent > top.indent) {
      listStack.push({ tag, indent })
      html.push('<' + tag + '>')
    } else if (indent < top.indent) {
      closeLists(indent)
      if (!listStack.length) {
        listStack.push({ tag, indent })
        html.push('<' + tag + '>')
      }
    }
    html.push('<li>' + inline(bullet[3]) + '</li>')
    index += 1
    continue
  }

  // 普通段落：连续的几行合成一段
  closeLists()
  const body = []
  while (
    index < lines.length &&
    !/^\s*$/.test(lines[index]) &&
    !/^(#{1,6})\s/.test(lines[index]) &&
    !/^\s*\|/.test(lines[index]) &&
    !/^\s*>/.test(lines[index]) &&
    !/^\s*(---|\*\*\*)\s*$/.test(lines[index]) &&
    !/^\s*([-*+]|\d+\.)\s/.test(lines[index]) &&
    !/^```/.test(lines[index])
  ) {
    body.push(lines[index])
    index += 1
  }
  html.push('<p>' + inline(body.join(' ')) + '</p>')
}
closeLists()

const title = path.basename(input, '.md')
const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --ink: #16181d;
    --muted: #4b5160;
    --faint: #7c8290;
    --line: #e3e5ea;
    --surface: #f7f8fa;
    --accent: #1a56db;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 24px 96px;
    background: #fff;
    color: var(--ink);
    font: 15px/1.75 "Alibaba PuHuiTi 3.0", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.01em; line-height: 1.35; }
  h1 { margin: 0 0 24px; font-size: 30px; }
  h2 { margin: 40px 0 16px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 22px; }
  h3 { margin: 28px 0 12px; font-size: 17px; }
  h4 { margin: 24px 0 8px; font-size: 15px; color: var(--muted); }
  p { margin: 12px 0; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(26, 86, 219, 0.3); }
  code { padding: 1px 5px; border-radius: 4px; background: var(--surface); font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; }
  pre { overflow-x: auto; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  pre code { padding: 0; background: none; }
  blockquote { margin: 16px 0; padding: 12px 16px; border-left: 3px solid var(--line); background: var(--surface); color: var(--muted); }
  blockquote p { margin: 0; }
  table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 12px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { background: var(--surface); font-weight: 600; }
  hr { margin: 32px 0; border: 0; border-top: 1px solid var(--line); }
  ul, ol { margin: 12px 0; padding-left: 22px; }
  li { margin: 6px 0; }
  strong { font-weight: 600; }
  @media (max-width: 720px) {
    body { padding: 24px 16px 64px; }
    h1 { font-size: 24px; }
    table { display: block; overflow-x: auto; }
  }
</style>
</head>
<body>
<main>
${html.join('\n')}
</main>
</body>
</html>
`

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, page)
console.log('写出 ' + output + ' · ' + Math.round(page.length / 1024) + ' KB')
