// 评审对照页：把评审说过的问题框在当时的画面上，排成一张 A4 纸。
//
// 为什么需要它：评审结论里每条问题都带一个证据框（相对画面的 x/y/w/h），页面里能高亮，
// 但发给剪辑、拍摄、甲方的交付包里只有文字——「右下角按钮距底边 0px」这句读完还是不知道在哪儿。
// 这张纸把图和框一起印出来，框上的编号与右边的问题列表一条一条对得上。
//
// 三条边界：
//  1. 框是评审当时给出的位置，不是人工复核；纸脚原样写清，不让人误以为有人复核过。
//  2. 只框我们自己存下的帧图（frames/<模板>/<文件>）。评审若评的是外部图片，纸上不替它下载，
//     写「这张图不在包里」——导出时联网取图等于开了个出口，也说不清取回来的是哪一张。
//  3. 每一版只印最近一次评审：同一版重评多次的中间结论在作品页里看，
//     纸只回答「现在这一版被指出什么」。
import { escapeHtml, paperShell, printToolbar } from './project-deliverable-html.mjs'

export const REVIEW_SHEET_LIMITS = { blocks: 3, observations: 8, fixes: 3, notAssessable: 3 }

const VERDICT_LABEL = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }
const SEVERITY_LABEL = { blocker: '阻断', major: '重要', minor: '轻微', info: '提示' }
export const DIMENSION_LABEL = {
  hierarchy: '层级',
  contrast: '对比',
  spacing: '对齐与间距',
  type: '字体与字号',
  color: '色彩',
  composition: '构图与裁切',
  legibility: '可识别性',
}

const pad2 = (value) => String(value).padStart(2, '0')
const pad4 = (value) => String(value).padStart(4, '0')

/** 时间按导出人所在的时区写：纸上的时间要和他自己的时间线对得上。 */
function stamp(value, tzOffsetMinutes) {
  const ms = Date.parse(String(value || ''))
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms + tzOffsetMinutes * 60000)
  return (
    pad4(date.getUTCFullYear()) + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes())
  )
}

/**
 * 评审是在哪张画面上做的：只认我们自己存下的帧图（frames/<模板 id>/<文件名>）。
 * 形状之外一律不收——这条路径要拼给文件系统读，多一种写法就多一个读别人文件的口子。
 */
export function reviewImageRef(source) {
  const matched = String(source?.media || '').match(/^frames\/([\w-]+)\/([\w.-]+)$/)
  if (!matched) return null
  const file = matched[2]
  if (file === '.' || file === '..' || file.includes('..')) return null
  return { templateId: matched[1], file }
}

const clamp01 = (value) => Math.min(1, Math.max(0, value))
const pct = (value) => (clamp01(Number(value) || 0) * 100).toFixed(2)

/**
 * 证据框：坐标是相对画面的 0–1。整块落在画面外的框直接丢掉（画不出来），
 * 压边的框裁到画面里——纸上不能出现一条伸出纸外的框。
 */
export function normalizeBox(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const x = Number(evidence.x)
  const y = Number(evidence.y)
  const w = Number(evidence.w)
  const h = Number(evidence.h)
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return null
  if (w <= 0 && h <= 0) return null
  // 按「左边裁进 0、右边裁进 1」算：直接 clamp 起点会把出画的那部分宽度留在画面里，
  // 框就比模型指的那块大了一圈
  const left = clamp01(x)
  const top = clamp01(y)
  const width = Math.max(0, clamp01(x + w) - left)
  const height = Math.max(0, clamp01(y + h) - top)
  // 贴到边上的框裁完可能只剩一条线：画不出「一块区域」就不画，别在纸上留一条竖线
  if (width <= 0 || height <= 0) return null
  return { x: left, y: top, w: width, h: height }
}

/** 框的位置写成一句人话：.md 里没有图，靠这串百分比能对着原图找。 */
export function boxText(box) {
  if (!box) return ''
  const from = (value) => Math.round(value * 100)
  return '框 x ' + from(box.x) + '–' + from(box.x + box.w) + '% · y ' + from(box.y) + '–' + from(box.y + box.h) + '%'
}

function judgeLine(judge) {
  if (!judge || judge.status !== 'ok') return ''
  const bits = []
  if (typeof judge.evidenceConsistent === 'number') bits.push('依据 ' + Math.round(judge.evidenceConsistent * 100) + '%')
  if (typeof judge.actionable === 'number') bits.push('可执行 ' + Math.round(judge.actionable * 100) + '%')
  if (judge.publishRisk && typeof judge.publishRisk.score === 'number') bits.push('发布风险 ' + judge.publishRisk.score)
  return bits.join(' · ')
}

/**
 * 每一版只留最近一次评审（版本 0 折进 v1），按版本从新到旧，最多 3 版。
 * 列表摘要和评审全文都走这一条选择：纸上印的是哪几次，这里说了算，两个入口不会各挑一套。
 * 返回 { records, total }：total 是这条作品评过的版数（用于抬头写「印了 2 / 7 版」）。
 */
export function reviewSheetSelection(records) {
  const latest = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue
    // 版本 0 是版本划分之前记的评审，按页面同一套规则折进 v1，否则纸上会写「v0」
    const version = Math.max(1, Math.round(Number(record.version) || 0))
    const seen = latest.get(version)
    if (!seen || String(record.createdAt || '') > String(seen.createdAt || '')) latest.set(version, record)
  }
  return {
    records: [...latest.values()]
      .sort((a, b) => Math.max(1, Math.round(Number(b.version) || 0)) - Math.max(1, Math.round(Number(a.version) || 0)))
      .slice(0, REVIEW_SHEET_LIMITS.blocks),
    total: latest.size,
  }
}

/**
 * 从评审全文里挑出要印的那几次，并把每条问题整理成纸上要的样子。
 * 返回 { blocks, total, shown }：total 是这条作品评过的版数，shown 是纸上印了几版。
 */
export function reviewSheetBlocks(records) {
  const selection = reviewSheetSelection(records)
  const total = selection.total
  const blocks = selection.records.map((record) => {
    const version = Math.max(1, Math.round(Number(record.version) || 0))
    const result = record.result || {}
    const observations = (Array.isArray(result.observations) ? result.observations : [])
      .slice(0, REVIEW_SHEET_LIMITS.observations)
      .map((item, index) => {
        const severity = ['blocker', 'major', 'minor', 'info'].includes(item?.severity) ? item.severity : 'minor'
        const box = normalizeBox(item?.evidence)
        return {
          no: index + 1,
          dimension: DIMENSION_LABEL[String(item?.dimension || '')] || '整体',
          severity,
          severityLabel: SEVERITY_LABEL[severity] || '提示',
          statement: String(item?.statement || ''),
          confidence: Number(item?.confidence) || 0,
          box,
          boxText: boxText(box),
        }
      })
    const verdict = ['pass', 'needs_review', 'fail'].includes(result.verdict) ? result.verdict : ''
    return {
      id: record.id || '',
      version,
      verdict,
      verdictLabel: VERDICT_LABEL[verdict] || '未给结论',
      summary: String(result.summary || ''),
      model: String(result.model || result.provider || ''),
      ms: Number(result.ms) || 0,
      createdAt: String(record.createdAt || ''),
      sourceLabel: String(record.source?.label || record.intent || ''),
      image: reviewImageRef(record.source),
      judge: judgeLine(result.judge),
      observations,
      fixes: (Array.isArray(result.fixes) ? result.fixes : []).slice(0, REVIEW_SHEET_LIMITS.fixes).map((fix) => ({
        title: String(fix?.title || ''),
        detail: String(fix?.detail || ''),
      })),
      notAssessable: (Array.isArray(result.notAssessable) ? result.notAssessable : [])
        .slice(0, REVIEW_SHEET_LIMITS.notAssessable)
        .map((line) => String(line || '')),
    }
  })
  return { blocks, total, shown: blocks.length }
}

// ---------------------------------------------------------------------------
// 纸的版面
//
// 左图右文：证据框只框在图里，右边是同一批编号的问题、修正建议与「这次没判断的」。
// 间距全部走 4/8pt 栅格；字号 7.5–22pt 成阶；没有大面积底色，层级靠线宽与字重分。
// ---------------------------------------------------------------------------
const REVIEW_SHEET_CSS = [
  '.bar-textbrand, .sheet-textbrand { font-family: var(--font); font-size: 13pt; font-weight: 600; letter-spacing: -0.01em; }',
  '.rev-intro { margin: 0 0 8pt; font-size: 9pt; line-height: 1.6; color: var(--muted); }',
  '.rev-origin { margin: -4pt 0 8pt; font-size: 8pt; line-height: 1.55; color: var(--faint); }',
  '.rev-block { margin: 16pt 0 0; break-inside: avoid; }',
  '.rev-block h2 { margin-top: 14pt; padding-top: 8pt; }',
  '.rev-body { display: grid; grid-template-columns: 74mm 1fr; gap: 12pt; align-items: start; }',
  '.rev-shot { position: relative; display: block; border: 0.5pt solid var(--line-strong); border-radius: 3pt; background: #f7f7f7; }',
  '.rev-shot img { display: block; width: 100%; height: auto; border-radius: 2.5pt; }',
  '.rev-shot.is-missing { display: grid; place-items: center; min-height: 52mm; padding: 10pt; border-style: dashed; background: #fbfbfb; text-align: center; color: var(--faint); font-size: 8pt; line-height: 1.5; }',
  '.rev-box { position: absolute; border: 1.25pt solid rgba(17, 17, 17, 0.72); border-radius: 2pt; }',
  '.rev-box.is-blocker { border-width: 2pt; border-color: rgba(17, 17, 17, 0.92); }',
  '.rev-box.is-major { border-width: 1.5pt; }',
  '.rev-box.is-minor { border-style: dashed; border-width: 1pt; }',
  '.rev-box.is-info { border-style: dotted; border-width: 1pt; }',
  '.rev-box::before { content: attr(data-no); position: absolute; top: 0; left: 0; min-width: 9pt; height: 9pt; padding: 0 1.5pt; border-radius: 0 0 2pt 0; background: rgba(17, 17, 17, 0.86); color: #ffffff; font-family: var(--mono); font-size: 6.5pt; line-height: 9pt; text-align: center; }',
  '.rev-side { min-width: 0; font-size: 8.5pt; line-height: 1.55; }',
  '.rev-facts { display: grid; grid-template-columns: max-content 1fr; column-gap: 8pt; row-gap: 1pt; margin: 0 0 6pt; font-size: 8pt; line-height: 1.5; }',
  '.rev-facts dt { color: var(--faint); }',
  '.rev-facts dd { margin: 0; min-width: 0; color: var(--ink); }',
  '.rev-quote { margin: 0 0 6pt; padding: 4pt 8pt; border-left: 1.5pt solid var(--line-strong); background: #fbfbfb; font-size: 8pt; line-height: 1.55; color: var(--ink); }',
  '.rev-sev { display: inline-block; margin-right: 3pt; padding: 0 3pt; border: 0.5pt solid rgba(17, 17, 17, 0.2); border-radius: 2pt; background: #fafafa; font-family: var(--mono); font-size: 7pt; line-height: 1.5; color: var(--ink); }',
  '.rev-sev.is-blocker, .rev-sev.is-major { border-color: rgba(17, 17, 17, 0.55); color: var(--ink); }',
  '.rev-obs { margin: 0 0 6pt; padding-left: 13pt; }',
  '.rev-obs li { margin: 0 0 3pt; }',
  '.rev-obs li::marker { font-family: var(--mono); font-size: 8pt; color: var(--ink); }',
  '.rev-conf { font-family: var(--mono); font-size: 7.5pt; color: var(--faint); }',
  '.rev-side h3 { margin: 6pt 0 2pt; font-size: 8.5pt; font-weight: 600; }',
  '.rev-fixes, .rev-na { margin: 0; padding-left: 13pt; font-size: 8pt; line-height: 1.5; }',
  '.rev-fixes li, .rev-na li { margin: 0 0 3pt; }',
  '.rev-none { margin: 0 0 8pt; color: var(--muted); font-size: 8.5pt; }',
  '.rev-foot { margin: 4pt 0 0; font-size: 7.5pt; line-height: 1.55; color: var(--faint); }',
  '.rev-empty { margin: 12pt 0; padding: 12pt 14pt; border: 0.75pt dashed var(--line-strong); border-radius: 3pt; color: var(--muted); font-size: 9.5pt; line-height: 1.7; }',
  '.sheet-foot { margin: 18pt 0 0; padding-top: 6pt; border-top: 0.5pt solid var(--line); color: var(--faint); font-family: var(--mono); font-size: 7pt; letter-spacing: 0.04em; }',
  '@media screen and (max-width: 700px) { .rev-body { grid-template-columns: 1fr; } .rev-shot { max-width: 260px; } }',
].join('\n')

function boxHtml(observation) {
  const box = observation.box
  return (
    '<span class="rev-box is-' + observation.severity + '" data-no="' + observation.no + '" style="left:' +
    pct(box.x) + '%;top:' + pct(box.y) + '%;width:' + pct(box.w) + '%;height:' + pct(box.h) + '%"></span>'
  )
}

function factRow(label, value) {
  return value ? '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd>' : ''
}

function factItem(label, value) {
  return value ? '<li><span class="fact-k">' + escapeHtml(label) + '</span><span class="fact-v">' + escapeHtml(value) + '</span></li>' : ''
}

/**
 * 一张评审对照纸。
 * imageSrc(block) 决定画面从哪取：线上走 /media/frames，交付包里走 frames/shot-01.jpg
 * 或解包时复制出来的 评审/对照-01.jpg；返回空表示这张图不在这份产物里。
 */
export function reviewSheetHtml({
  project = {},
  records = [],
  now = new Date(),
  tzOffsetMinutes = 480,
  projectId = '',
  offline = false,
  imageSrc = null,
  imageNote = null,
  // 分享出去的纸要回分享页（没有登录态），并写清它来自哪条链接；两处都只影响顶栏与一句话
  backHref = '',
  backLabel = '返回作品',
  hint = '',
  originNote = '',
  // 分享页拿不到交付包里那份帧图清单时的说法；离线包的文案不改
  missingText = '',
} = {}) {
  const tz = Number.isFinite(Number(tzOffsetMinutes)) ? Math.max(-720, Math.min(840, Math.round(Number(tzOffsetMinutes)))) : 480
  const { blocks, total, shown } = reviewSheetBlocks(records)
  const srcOf = typeof imageSrc === 'function'
    ? imageSrc
    : (block) => (block.image ? '/media/frames/' + block.image.templateId + '/' + block.image.file : '')
  const noteOf = typeof imageNote === 'function' ? imageNote : () => ''
  const body = []
  body.push(
    printToolbar({
      projectId,
      tag: '评审对照 / A4',
      meta: '210 x 297 mm',
      hint: hint || (offline ? '解压后直接打印 / 存为 PDF；框只在纸上有' : '纸张选 A4；框与问题编号一一对应'),
      back: !offline && Boolean(backHref || projectId),
      backHref,
      backLabel,
      brand: offline ? 'text' : 'img',
    }),
  )
  body.push('<main class="sheet">')
  body.push(
    '<div class="sheet-brand">' +
      (offline ? '<span class="sheet-textbrand">VisionQA</span>' : '<img class="sheet-mark" src="/brand/visionqa-lockup.svg" alt="VisionQA">') +
      '<span class="sheet-kind">REVIEW / A4</span></div>',
  )
  body.push('<div class="sheet-body">')
  body.push('<h1 class="sheet-title">评审对照 · ' + escapeHtml(project.title || '未命名作品') + '</h1>')
  if (shown) {
    body.push(
      '<p class="rev-intro">评审说过的问题，一条一条框在当时的画面上：左边框上的编号，就是右边问题列表的编号。' +
        (total > shown ? '这条作品评过 ' + total + ' 个版本，这张纸只印最近 ' + shown + ' 版。' : '') +
        '</p>',
    )
  } else {
    body.push(
      '<p class="lede">这一版还没送过评审：先在作品页点「用评审看这版」，结论才会有一条画面与框可印。' +
        '评审按版本记，上一版的结论不搬到这一版上。</p>',
    )
  }
  if (originNote) body.push('<p class="rev-origin">' + escapeHtml(originNote) + '</p>')
  // 抬头事实表：复用交付稿那张纸的 .sheet-facts（标签一列、值一列），扫读比一串「- 标签：值」快
  const facts = [
    factItem('作品编号', project.id || ''),
    factItem('版本', project.version ? 'v' + project.version : ''),
    // 只写「印了几版」；还有更旧的版本没印时把总数带上，读者才知道纸不是全部
    factItem('评审版次', shown ? (total > shown ? shown + ' / ' + total + ' 版' : shown + ' 版') : '—'),
    factItem('导出时间', stamp(now.toISOString(), tz)),
  ].join('')
  if (facts) body.push('<ul class="sheet-facts">' + facts + '</ul>')

  // 纸上到底画了几个框：没有画面就不画框，纸脚也只能数画出来的那些
  let boxed = 0
  for (const block of blocks) {
    const src = srcOf(block) || ''
    const boxes = block.observations.filter((item) => item.box)
    if (src) boxed += boxes.length
    body.push('<section class="rev-block">')
    body.push('<h2>v' + block.version + ' · ' + escapeHtml(block.verdictLabel) + '</h2>')
    body.push('<div class="rev-body">')
    if (src) {
      body.push(
        '<span class="rev-shot"><img src="' + escapeHtml(src) + '" alt="' + escapeHtml('评审画面：' + (block.sourceLabel || '未命名')) + '">' +
          boxes.map(boxHtml).join('') + '</span>',
      )
    } else {
      const missing = block.image
        ? (missingText || '这次评审的帧图不在这份产物里：离线包只放这条作品分镜里的帧。问题与编号仍按原文列出。')
        : '这次评审的画面不在我们的帧图里（评的是外部图片）：框只能对着原图看，问题与编号仍按原文列出。'
      body.push('<span class="rev-shot is-missing">' + escapeHtml(missing) + '</span>')
    }
    const rows = [
      factRow('评审对象', block.sourceLabel),
      factRow('时间', stamp(block.createdAt, tz)),
      factRow('模型', block.model),
      factRow('判断层', block.judge),
    ].join('')
    body.push('<div class="rev-side">')
    if (rows) body.push('<dl class="rev-facts">' + rows + '</dl>')
    if (block.summary) body.push('<blockquote class="rev-quote">' + escapeHtml(block.summary) + '</blockquote>')
    if (block.observations.length) {
      body.push(
        '<ol class="rev-obs">' +
          block.observations
            .map(
              (item) =>
                '<li><span class="rev-sev is-' + item.severity + '">' + escapeHtml(item.severityLabel + ' · ' + item.dimension) + '</span>' +
                escapeHtml(item.statement) +
                (item.confidence ? ' <span class="rev-conf">依据 ' + Math.round(item.confidence * 100) + '%</span>' : '') +
                '</li>',
            )
            .join('') +
          '</ol>',
      )
    } else {
      body.push('<p class="rev-none">这次评审没有给出能落到具体元素上的问题。</p>')
    }
    if (block.fixes.length) {
      body.push('<h3>修正建议（' + block.fixes.length + '）</h3><ul class="rev-fixes">')
      for (const fix of block.fixes) body.push('<li><strong>' + escapeHtml(fix.title) + '</strong>' + (fix.detail ? '：' + escapeHtml(fix.detail) : '') + '</li>')
      body.push('</ul>')
    }
    if (block.notAssessable.length) {
      body.push('<h3>这次没判断的</h3><ul class="rev-na">')
      for (const line of block.notAssessable) body.push('<li>' + escapeHtml(line) + '</li>')
      body.push('</ul>')
    }
    body.push('</div></div>')
    // 纸脚写成一句话：框是谁给的、有没有人复核过、画面是包里的哪一张——这三件事不写清就会被人当成定论
    const notes = [
      src
        ? (boxes.length ? '框是评审当时给出的位置（相对画面比例），不是人工复核' : '这次的问题没有一条带证据框')
        : (boxes.length ? '这次的问题带了框的位置，但画面不在这份产物里，框画不出来' : '这次的问题没有一条带证据框'),
      noteOf(block) || '',
    ].filter(Boolean)
    body.push('<p class="rev-foot">' + escapeHtml(notes.join('；')) + '。</p>')
    body.push('</section>')
  }

  const totalObs = blocks.reduce((sum, block) => sum + block.observations.length, 0)
  body.push(
    '<p class="sheet-foot">由 VisionQA 导出 · ' + escapeHtml(stamp(now.toISOString(), tz)) + ' · ' +
      (shown ? totalObs + ' 条问题（' + boxed + ' 条带框） / ' + shown + ' 版' : '没有可印的评审') + '</p>',
  )
  body.push('</div>')
  body.push('</main>')
  return paperShell((project.title || '未命名作品') + ' · 评审对照 · VisionQA', body.join('\n'), REVIEW_SHEET_CSS)
}
