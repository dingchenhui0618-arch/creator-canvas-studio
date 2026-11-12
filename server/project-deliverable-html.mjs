// 交付稿打印版：把同一份 Markdown 排成一张 A4 纸（浏览器打印 → 存为 PDF）。
//
// 为什么从 Markdown 再渲染一次，而不是照着作品详情再写一遍排版：
//  1. 内容只有一个来源。稿子（.md）与纸（A4）永远同文，不会出现「文件里写 25.3 秒、纸上写别的」。
//  2. Markdown 是我们自己生成的（# / ## / ### / - / 1. / > / 表格 / **粗体** / ---），
//     渲染器只认这几样；遇到不认识的行按段落输出，宁可难看也不吞内容。
//  3. 打印走浏览器自己的 PDF 引擎（Ctrl+P）：中文断行、字体、分页交给它，不新增依赖，
//     也不用在服务器上装 Chromium。
//
// 安全：所有文本先转义再拼标签。作品标题或台词里写着 <script> 也只显示成字。

export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// 行内：先转义再认粗体。我们生成的都是 **…** 这一种。
function inline(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, '<strong>' + '$1' + '</strong>')
}

// 表格行拆单元格：\| 是内容里的竖线（不是分隔符），拆完再交给 inline 转义
export function splitTableRow(line) {
  const body = String(line).trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells = []
  let current = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (body[i] === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += body[i]
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

const isTableRow = (line) => /^\|/.test(String(line).trim())
const isTableRule = (line) => /^\|[\s:|-]+\|?$/.test(String(line).trim()) && String(line).includes('-')
const isHeading = (line) => /^#{1,3}\s+/.test(String(line).trim())
const isQuote = (line) => String(line).trim().startsWith('> ')
const isBullet = (line) => /^-\s+/.test(String(line).trim())
const isOrdered = (line) => /^\d+\.\s+/.test(String(line).trim())
const isRule = (line) => /^-{3,}$/.test(String(line).trim())
const startsBlock = (line) =>
  !String(line).trim() ||
  isHeading(line) || isQuote(line) || isBullet(line) || isOrdered(line) || isRule(line) || isTableRow(line)

/**
 * Markdown → 纸上的 HTML 片段。
 * 抬头三件东西单独认出：h1 是标题、紧跟着的一段是引题、第一张列表是「标签：值」的事实表。
 * 事实表按冒号拆成两列更利于扫读，拆不出就整行放进去，不丢字。
 */
export function renderDeliverableBody(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let coverZone = true
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) {
      i += 1
      continue
    }

    if (isHeading(line)) {
      const level = line.match(/^#+/)[0].length
      const tag = 'h' + level
      const text = inline(line.replace(/^#+\s+/, ''))
      out.push('<' + tag + (level === 1 ? ' class="sheet-title"' : '') + '>' + text + '</' + tag + '>')
      if (level !== 1) coverZone = false
      i += 1
      continue
    }

    if (isRule(line)) {
      out.push('<hr>')
      coverZone = false
      i += 1
      continue
    }

    if (isQuote(line)) {
      const parts = []
      while (i < lines.length && isQuote(lines[i])) {
        parts.push(lines[i].trim().slice(2))
        i += 1
      }
      out.push('<blockquote><p>' + inline(parts.join(' ')) + '</p></blockquote>')
      coverZone = false
      continue
    }

    if (isTableRow(line)) {
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].trim())
        i += 1
      }
      const head = splitTableRow(rows[0])
      const body = rows.slice(1).filter((row) => !isTableRule(row)).map(splitTableRow)
      const html = ['<table>']
      html.push('<thead><tr>' + head.map((cell) => '<th>' + inline(cell) + '</th>').join('') + '</tr></thead>')
      if (body.length) {
        html.push(
          '<tbody>' +
            body.map((row) => '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join('') + '</tr>').join('') +
            '</tbody>',
        )
      }
      html.push('</table>')
      out.push(html.join(''))
      coverZone = false
      continue
    }

    if (isBullet(line)) {
      const items = []
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].trim().replace(/^-\s+/, ''))
        i += 1
      }
      if (coverZone) {
        // 抬头事实表：只拆「标签：值」，标签限 2–8 个字且不含冒号
        const cells = items.map((item) => {
          const pair = item.match(/^([^：:]{2,8})[：:]\s*(.+)$/)
          if (!pair) return '<li><span class="fact-v">' + inline(item) + '</span></li>'
          return (
            '<li><span class="fact-k">' + inline(pair[1]) + '</span><span class="fact-v">' + inline(pair[2]) + '</span></li>'
          )
        })
        out.push('<ul class="sheet-facts">' + cells.join('') + '</ul>')
        coverZone = false
      } else {
        out.push('<ul>' + items.map((item) => '<li>' + inline(item) + '</li>').join('') + '</ul>')
      }
      continue
    }

    if (isOrdered(line)) {
      const items = []
      while (i < lines.length && isOrdered(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i += 1
      }
      out.push('<ol>' + items.map((item) => '<li>' + inline(item) + '</li>').join('') + '</ol>')
      coverZone = false
      continue
    }

    const parts = [line]
    i += 1
    while (i < lines.length && !startsBlock(lines[i])) {
      parts.push(lines[i].trim())
      i += 1
    }
    const lede = coverZone && out.some((block) => block.startsWith('<h1'))
    out.push('<p' + (lede ? ' class="lede"' : '') + '>' + inline(parts.join(' ')) + '</p>')
    coverZone = coverZone && lede
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 纸的样式
//
// 单位全部用 pt / mm：屏幕上是 1:1 的 A4 预览（96dpi 下 210mm 约 794px），
// 打印时浏览器按物理尺寸排版，两边是同一套数字。间距只走 4/8pt 栅格。
// ---------------------------------------------------------------------------
export const PAPER_CSS = [
  ':root {',
  '  --ink: #111111;',
  '  --muted: #5d5d5d;',
  '  --faint: #6f6f6f;',
  '  --line: rgba(17, 17, 17, 0.12);',
  '  --line-strong: rgba(17, 17, 17, 0.24);',
  '  --line-faint: rgba(17, 17, 17, 0.06);',
  '  --paper: #ffffff;',
  '  --canvas: #f4f4f4;',
  '  --font: "Figtree", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;',
  '  --mono: "Geist Mono", ui-monospace, "Cascadia Mono", monospace;',
  '}',
  '@font-face { font-family: "Figtree"; src: url("/fonts/figtree.woff2") format("woff2"); font-weight: 300 900; font-style: normal; font-display: swap; }',
  '@font-face { font-family: "Geist Mono"; src: url("/fonts/geist-mono.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }',
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; padding: 0; }',
  'body { background: var(--canvas); color: var(--ink); font-family: var(--font); -webkit-font-smoothing: antialiased; }',
  '',
  '/* 顶栏：只在屏幕上有；纸自己不带页面壳 */',
  '.bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 56px; padding: 0 24px; background: rgba(251, 251, 251, 0.94); border-bottom: 1px solid var(--line); backdrop-filter: blur(8px); }',
  '.bar-left, .bar-right { display: flex; align-items: center; gap: 12px; min-width: 0; }',
  '.bar-brand { display: block; height: 18px; width: auto; }',
  '.bar-tag { padding: 4px 10px; border: 1px solid var(--line-strong); border-radius: 999px; font-size: 12px; font-weight: 500; color: var(--ink); white-space: nowrap; }',
  '.bar-meta { font-family: var(--mono); font-size: 11px; letter-spacing: 0.02em; color: var(--faint); white-space: nowrap; }',
  '.bar-hint { font-size: 12px; color: var(--faint); }',
  '.bar-link { color: var(--muted); text-decoration: none; font-size: 13px; border-bottom: 1px solid transparent; padding-bottom: 1px; }',
  '.bar-link:hover { color: var(--ink); border-bottom-color: var(--line-strong); }',
  '.bar-print { appearance: none; border: 1px solid var(--ink); border-radius: 10px; background: var(--ink); color: #ffffff; font-family: var(--font); font-size: 13px; font-weight: 500; padding: 8px 16px; cursor: pointer; }',
  '.bar-print:hover { background: #2b2b2b; border-color: #2b2b2b; }',
  '.bar-print:active { transform: translateY(0.5px); }',
  '.bar-print:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }',
  '',
  '/* 纸 */',
  '.sheet { width: 210mm; min-height: 297mm; margin: 24px auto 48px; padding: 16mm 14mm; background: var(--paper); border-radius: 6px; box-shadow: 0 1px 2px rgba(17, 17, 17, 0.05), 0 12px 32px rgba(17, 17, 17, 0.08); }',
  '.sheet-brand { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 10pt; border-bottom: 0.75pt solid var(--line-strong); margin-bottom: 18pt; }',
  '.sheet-mark { display: block; height: 14pt; width: auto; }',
  '.sheet-kind { font-family: var(--mono); font-size: 7.5pt; letter-spacing: 0.1em; color: var(--faint); white-space: nowrap; }',
  '',
  '/* 版面：正文 10pt / 1.7；标题三阶 22 / 13 / 10.5 */',
  '.sheet-body { counter-reset: sheet-sec; font-size: 10pt; line-height: 1.7; color: var(--ink); }',
  '.sheet-body h1.sheet-title { margin: 0 0 8pt; font-size: 22pt; line-height: 1.25; font-weight: 600; letter-spacing: -0.01em; }',
  '.sheet-body p { margin: 0 0 8pt; }',
  '.sheet-body p.lede { margin: 0 0 12pt; font-size: 11pt; line-height: 1.65; color: var(--muted); }',
  '.sheet-body h2 { margin: 22pt 0 8pt; padding-top: 10pt; border-top: 0.75pt solid var(--line); font-size: 13pt; line-height: 1.4; font-weight: 600; break-after: avoid; }',
  '.sheet-body h2::before { counter-increment: sheet-sec; content: counter(sheet-sec, decimal-leading-zero); margin-right: 8pt; font-family: var(--mono); font-size: 8pt; font-weight: 400; color: var(--faint); vertical-align: 1.5pt; }',
  '.sheet-body h3 { margin: 12pt 0 4pt; font-size: 10.5pt; line-height: 1.5; font-weight: 600; break-after: avoid; }',
  '.sheet-body strong { font-weight: 600; }',
  '.sheet-body ul, .sheet-body ol { margin: 0 0 8pt; padding-left: 16pt; }',
  '.sheet-body li { margin: 2pt 0; }',
  '.sheet-body li::marker { color: var(--faint); }',
  '.sheet-body ol li::marker { font-family: var(--mono); font-size: 8.5pt; }',
  '.sheet-body h3 + ul { break-inside: avoid; }',
  '.sheet-body blockquote { margin: 8pt 0 10pt; padding: 6pt 12pt; border-left: 2pt solid var(--line-strong); background: #fafafa; }',
  '.sheet-body blockquote p { margin: 0; }',
  '.sheet-body hr { margin: 18pt 0 10pt; border: 0; border-top: 0.75pt solid var(--line); }',
  '.sheet-body table { width: 100%; margin: 4pt 0 12pt; border-collapse: collapse; font-size: 8.5pt; line-height: 1.5; break-inside: avoid; }',
  '.sheet-body thead { display: table-header-group; }',
  '.sheet-body th { padding: 4pt 6pt; border-bottom: 0.75pt solid var(--line-strong); background: #fbfbfb; font-weight: 500; color: var(--muted); text-align: left; white-space: nowrap; }',
  '.sheet-body td { padding: 3.5pt 6pt; border-bottom: 0.5pt solid var(--line-faint); vertical-align: top; word-break: break-word; }',
  // 首列（时间 / 版本）与末列（念完 / 积分 / 归档）不折行：折了反而更难读
  '.sheet-body th:first-child, .sheet-body td:first-child, .sheet-body th:last-child, .sheet-body td:last-child { white-space: nowrap; }',
  '.sheet-body tr { break-inside: avoid; }',
  '.sheet-body a { color: inherit; }',
  '.sheet-body a.cta { display: inline-block; text-decoration: none; }',
  '',
  '/* 抬头事实表：标签一列、值一列，扫读比一串「- 标签：值」快 */',
  '.sheet-body .sheet-facts { display: grid; grid-template-columns: max-content 1fr; column-gap: 12pt; row-gap: 1.5pt; margin: 0 0 16pt; padding: 10pt 0; border-top: 0.75pt solid var(--line); border-bottom: 0.75pt solid var(--line); list-style: none; break-inside: avoid; }',
  // li 用 display: contents：标签与值各占一列，标签列宽取最长那个，值整列对齐
  '.sheet-body .sheet-facts li { display: contents; font-size: 9pt; line-height: 1.6; }',
  '.sheet-body .fact-k { grid-column: 1; color: var(--faint); }',
  '.sheet-body .fact-v { grid-column: 2; min-width: 0; color: var(--ink); }',
  '',
  '@media (max-width: 900px) {',
  '  .bar { height: auto; padding: 8px 16px; flex-wrap: wrap; gap: 8px; }',
  '  .bar-hint, .bar-meta { display: none; }',
  '  .sheet { width: auto; min-height: 0; margin: 16px 12px 24px; padding: 20px 16px; }',
  '}',
  '',
  '/* 手机上（只在屏幕上）：宽表自己横向滚，别把整页顶出屏幕。打印时仍是正常表格。 */',
  '@media screen and (max-width: 700px) {',
  '  .sheet-body table { display: block; overflow-x: auto; }',
  '}',
  '',
  '/* 打印：去掉屏幕装饰，纸张与页边距交给 @page；标题不留孤行、镜头不跨页 */',
  '@media print {',
  '  html, body { background: #ffffff; }',
  '  .bar { display: none; }',
  '  .sheet { width: auto; min-height: 0; margin: 0; padding: 0; border-radius: 0; box-shadow: none; }',
  '  .sheet-body h1.sheet-title { font-size: 21pt; }',
  '  .sheet-body p, .sheet-body li { orphans: 2; widows: 2; }',
  '}',
  '@page { size: A4; margin: 16mm 14mm; }',
].join('\n')

// 顶栏（只在屏幕上有）：认品牌、认出这是哪一种纸、给一条回作品页的路，和一个打印按钮。
// offline（下进交付包、解压后双击打开）时没有「返回作品」——那个地址在本机打不开，留着只会 404。
export function printToolbar({
  projectId = '',
  tag = 'A4 打印稿',
  meta = '210 x 297 mm',
  hint = '纸张选 A4；想要页码就在打印对话框里打开「页眉和页脚」',
  back = true,
  brand = 'img',
  // 这一种纸自己要多带一个控件（现场页的「只印哪几镜」）：插在提示与返回之间，打印时整条顶栏都隐藏
  extra = '',
} = {}) {
  const backHref = projectId ? '/#/projects/' + encodeURIComponent(projectId) : '/#/projects'
  const mark =
    brand === 'img'
      ? '<img class="bar-brand" src="/brand/visionqa-lockup.svg" alt="VisionQA">'
      : '<span class="bar-textbrand">VisionQA</span>'
  return (
    '<header class="bar">' +
    '<div class="bar-left">' +
    mark +
    '<span class="bar-tag">' + escapeHtml(tag) + '</span>' +
    '<span class="bar-meta">' + escapeHtml(meta) + '</span>' +
    '</div>' +
    '<div class="bar-right">' +
    '<span class="bar-hint">' + escapeHtml(hint) + '</span>' +
    extra +
    (back ? '<a class="bar-link" href="' + escapeHtml(backHref) + '">返回作品</a>' : '') +
    '<button class="bar-print" type="button" data-print>打印 / 存为 PDF</button>' +
    '</div>' +
    '</header>'
  )
}

// 纸的外壳：extraCss / extraScript 给需要自己版面的那一种纸（现场页）追加样式与脚本，
// 仍然共用同一套纸张与字体。extraScript 必须是可信的常量（这里只放我们自己写的那几行），
// 不接任何用户内容——用户数据一律先过 escapeHtml 再进纸。
export function paperShell(title, body, extraCss = '', extraScript = '') {
  return (
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<style>\n' + PAPER_CSS + (extraCss ? '\n' + extraCss : '') + '\n</style>\n</head>\n<body>\n' +
    body + '\n' +
    (extraScript ? '<script>' + extraScript + '</script>\n' : '') +
    '<script>var b=document.querySelector("[data-print]");if(b){b.addEventListener("click",function(){window.print()})}</script>\n' +
    '</body>\n</html>\n'
  )
}

/**
 * A4 打印稿：同一份 Markdown，排成一张纸。
 * projectId 只用来拼「返回作品」的地址，不参与内容。
 */
export function deliverablePrintHtml({ markdown, projectId = '', title = '交付稿' }) {
  const body =
    printToolbar({ projectId }) +
    '\n<main class="sheet">\n' +
    '<div class="sheet-brand"><img class="sheet-mark" src="/brand/visionqa-lockup.svg" alt="VisionQA">' +
    '<span class="sheet-kind">DELIVERABLE / A4</span></div>\n' +
    '<div class="sheet-body">\n' + renderDeliverableBody(markdown) + '\n</div>\n</main>'
  return paperShell((title || '交付稿') + ' · 交付稿 · VisionQA', body)
}

/**
 * 打不开这张稿时也给一张纸：这个地址是在新标签里打开的，
 * 吐一段 JSON 会让人以为页面坏了（登录过期是最常见的那种）。
 */
export function printNoticeHtml({ title = '打不开这张稿', message = '', href = '/#/projects', label = '返回作品' }) {
  const body =
    '<main class="sheet">\n' +
    '<div class="sheet-brand"><img class="sheet-mark" src="/brand/visionqa-lockup.svg" alt="VisionQA">' +
    '<span class="sheet-kind">DELIVERABLE / A4</span></div>\n' +
    '<div class="sheet-body">\n<h1 class="sheet-title">' + escapeHtml(title) + '</h1>\n' +
    '<p class="lede">' + escapeHtml(message) + '</p>\n' +
    '<p><a class="bar-print cta" href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</a></p>\n' +
    '</div>\n</main>'
  return paperShell(title + ' · VisionQA', body)
}
