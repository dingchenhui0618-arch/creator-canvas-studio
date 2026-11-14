// 两版对照纸（v0.9.121）：把弹窗里的 v2 → v3 排成一张 A4，打印 / 存 PDF 带走。
//
// 为什么需要它：两版对照现在能回答「改完有没有变好」，但答案只活在作品页的弹窗里。
// 评审、导演、甲方要讨论「这一版值不值得交」时，需要一张能转发、能打印的纸：
// 左边 v2、右边 v3，评审与交付各写各的，画布与脚本逐项列出来。
//
// 三条边界：
//  1. 纸上的数字与弹窗同一份取数（server/project-compare.mjs）：不另算一套。
//  2. 只印有证据的东西：没评过、没交付、没快照就照实写；不拿别的版本顶，也不编「没变」。
//  3. 纸是只读产物：不改画布、不改脚本、不写交付记录、不扣积分；AI 生成标识跟其它三张纸一致。
import { brandRow, escapeHtml, paperShell, printToolbar } from './project-deliverable-html.mjs'
import { AI_LABEL_NOTICE, aiLabelFootText } from './ai-label.mjs'
import { deliveryDrift } from './project-status.mjs'

export const COMPARE_SHEET_LIMITS = { nodes: 6, fields: 12, beats: 6, notes: 4 }

const VERDICT_LABEL = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }
const SEVERITY_LABEL = { blocker: '阻塞', major: '主要', minor: '次要', info: '信息' }
const TONE_LABEL = { better: '变好', worse: '变差', same: '没变', unknown: '看不出来' }
const DRIFT_LEVELS = ['blocker', 'major', 'minor']

const pad2 = (value) => String(value).padStart(2, '0')
const pad4 = (value) => String(value).padStart(4, '0')

function stamp(value, tzOffsetMinutes) {
  const ms = Date.parse(String(value || ''))
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms + tzOffsetMinutes * 60000)
  return (
    pad4(date.getUTCFullYear()) + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes())
  )
}

const count = (value) => Math.max(0, Math.round(Number(value) || 0))

function issueLine(issues) {
  if (!issues) return ''
  return DRIFT_LEVELS
    .filter((level) => count(issues[level]) > 0)
    .map((level) => count(issues[level]) + ' ' + SEVERITY_LABEL[level])
    .join(' · ')
}

function issueGap(issues) {
  const observations = count(issues?.observations)
  const counted = count(issues?.counted)
  return observations > counted ? observations - counted : 0
}

function reviewLine(review) {
  if (!review?.count) return '还没评过'
  const line = issueLine(review.issues)
  const gap = issueGap(review.issues)
  return review.count + ' 次评审' + (line ? ' · ' + line : '') + (gap ? ' · 另有 ' + gap + ' 条没记严重度' : '')
}

function deliverySnapshotText(review) {
  if (review && typeof review === 'object') {
    const verdict = VERDICT_LABEL[review.verdict] || '未记结论'
    const line = issueLine(review.issues)
    const gap = issueGap(review.issues)
    return verdict + (line ? ' · ' + line : '') + (gap ? ' · 另有 ' + gap + ' 条没记严重度' : '')
  }
  if (review === null) return '还没评过'
  return '没记（升级前的交付记录）'
}

function driftText(drift) {
  if (!drift) return ''
  if (drift.kind === 'verdict') return '交付之后又评成「' + (VERDICT_LABEL[drift.verdict] || '未记结论') + '」'
  const line = issueLine(drift.issues)
  return '后来重评过一次' + (line ? '（' + line + '）' : '')
}

function sideHtml(side, role, tz) {
  const review = side.review || {}
  const delivery = side.delivery
  const drift = delivery ? deliveryDrift(delivery.review, review) : null
  const bits = []
  bits.push(
    '<article class="cmp-side">' +
      '<div class="cmp-side-head">' +
        '<span class="cmp-v">v' + count(side.n) + '</span>' +
        '<span class="cmp-role">' + escapeHtml(role) + '</span>' +
        '<span class="cmp-verdict is-' + escapeHtml(review.verdict || 'none') + '">' +
          escapeHtml(review.count ? (VERDICT_LABEL[review.verdict] || '未记结论') : '未评审') +
        '</span>' +
      '</div>' +
      '<p class="cmp-name">' + escapeHtml(side.name || '未命名版本') + '</p>' +
      '<p class="cmp-line">' + escapeHtml(reviewLine(review)) + '</p>',
  )
  bits.push(
    '<p class="cmp-line">' +
      (delivery
        ? '交付过' + (delivery.at ? ' · ' + escapeHtml(stamp(delivery.at, tz)) : ' · 时间没记录')
        : '没交付') +
    '</p>',
  )
  if (delivery) bits.push('<p class="cmp-snapshot">交时评审：' + escapeHtml(deliverySnapshotText(delivery.review)) + '</p>')
  if (drift) {
    bits.push(
      '<p class="cmp-drift is-' + drift.tone + '">' +
        '<span class="cmp-tag">' + escapeHtml(TONE_LABEL[drift.tone] || '有变化') + '</span>' +
        escapeHtml(driftText(drift)) +
      '</p>',
    )
  }
  bits.push('</article>')
  return bits.join('')
}

function deltaBox(label, value, unit) {
  return '<div class="cmp-delta"><b>' + count(value) + '</b><span>' + escapeHtml((unit || '') + label) + '</span></div>'
}

function namedList(label, names) {
  if (!names.length) return ''
  return '<p class="cmp-names"><span>' + escapeHtml(label) + '</span>' + escapeHtml(names.join('、')) + '</p>'
}

function canvasHtml(compare, baseLabel, targetLabel) {
  const canvas = compare.canvas
  const out = []
  out.push('<section class="cmp-section">')
  out.push('<h2>画布</h2>')
  if (!canvas) {
    out.push('<p class="cmp-muted">有一侧画布读不到：画布这一侧不比，脚本仍按快照比。</p>')
    out.push('</section>')
    return out.join('')
  }
  const fields = canvas.fields || {}
  const fieldTotal = Object.values(fields).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
  out.push(
    '<p class="cmp-meta">' +
      count(compare.base.nodes) + ' → ' + count(compare.target.nodes) + ' 节点' +
      (fieldTotal ? ' · ' + fieldTotal + ' 项参数' : '') +
    '</p>',
  )
  const touched = canvas.added.length || canvas.removed.length || canvas.changed.length
  if (!touched) {
    out.push('<p class="cmp-muted">节点没动。</p>')
    out.push('</section>')
    return out.join('')
  }
  out.push('<div class="cmp-deltas">' +
    deltaBox('新增节点', canvas.added.length) +
    deltaBox('去掉节点', canvas.removed.length) +
    deltaBox('改过节点', canvas.changed.length) +
    '</div>')
  out.push(namedList('多：', canvas.added.map((item) => item.title)))
  out.push(namedList('少：', canvas.removed.map((item) => item.title)))

  let fieldShown = 0
  let nodesShown = 0
  const changed = canvas.changed || []
  for (const node of changed) {
    if (nodesShown >= COMPARE_SHEET_LIMITS.nodes) break
    nodesShown += 1
    const list = Array.isArray(fields[node.id]) ? fields[node.id] : []
    out.push('<div class="cmp-node">')
    out.push('<h3>' + escapeHtml(node.title) + '<span>' + (list.length ? list.length + ' 项参数' : '配置改过') + '</span></h3>')
    if (!list.length) {
      out.push('<p class="cmp-muted">具体改了哪一项没记：只知节点配置与上一版不同。</p>')
    } else {
      out.push('<table class="cmp-table"><thead><tr><th>参数</th><th>' + escapeHtml(baseLabel) + '</th><th>' + escapeHtml(targetLabel) + '</th></tr></thead><tbody>')
      for (const field of list) {
        if (fieldShown >= COMPARE_SHEET_LIMITS.fields) break
        fieldShown += 1
        out.push(
          '<tr><td>' + escapeHtml(field.label) + '</td>' +
          '<td>' + escapeHtml(field.before) + '</td>' +
          '<td>' + escapeHtml(field.after) + '</td></tr>',
        )
      }
      out.push('</tbody></table>')
    }
    out.push('</div>')
  }
  if (nodesShown < changed.length) {
    out.push('<p class="cmp-muted">还有 ' + (changed.length - nodesShown) + ' 个改过的节点没印：这张纸只列前 ' + COMPARE_SHEET_LIMITS.nodes + ' 个。</p>')
  } else if (fieldShown < fieldTotal) {
    out.push('<p class="cmp-muted">还有 ' + (fieldTotal - fieldShown) + ' 项参数没印：这张纸最多列 ' + COMPARE_SHEET_LIMITS.fields + ' 项。</p>')
  }
  out.push('</section>')
  return out.join('')
}

function beatsText(lines) {
  return (Array.isArray(lines) ? lines : []).filter(Boolean).join(' ') || '（空）'
}

function scriptHtml(compare, baseLabel, targetLabel) {
  const script = compare.script
  const out = []
  out.push('<section class="cmp-section">')
  out.push('<h2>脚本</h2>')
  if (!script) {
    out.push('<p class="cmp-muted">有一侧脚本没存快照：脚本这一侧不比，画布仍按节点比。</p>')
    out.push('</section>')
    return out.join('')
  }
  out.push(
    '<p class="cmp-meta">' + count(compare.base.beats) + ' → ' + count(compare.target.beats) + ' 段' +
      (script.hookChanged ? ' · 开头钩子换过' : '') + '</p>',
  )
  const touched = script.added.length || script.removed.length || script.changed.length || script.hookChanged
  if (!touched) {
    out.push('<p class="cmp-muted">口播与钩子都没动。</p>')
    out.push('</section>')
    return out.join('')
  }
  out.push('<div class="cmp-deltas">' +
    deltaBox('新增段', script.added.length) +
    deltaBox('去掉段', script.removed.length) +
    deltaBox('改过段', script.changed.length) +
    '</div>')
  out.push(namedList('多：', script.added))
  out.push(namedList('少：', script.removed))
  if (script.hookChanged) {
    out.push('<div class="cmp-hook"><span class="cmp-kicker">开头钩子</span>')
    out.push('<p><b>' + escapeHtml(baseLabel) + '</b>' + escapeHtml(script.hookBefore || '（空）') + '</p>')
    out.push('<p><b>' + escapeHtml(targetLabel) + '</b>' + escapeHtml(script.hookAfter || '（空）') + '</p>')
    out.push('</div>')
  }
  if (script.changed.length) {
    out.push('<div class="cmp-quotes">')
    for (const beat of script.changed.slice(0, COMPARE_SHEET_LIMITS.beats)) {
      out.push('<p class="cmp-quote"><b>' + escapeHtml(beat.name) + '</b>' +
        '<span>' + escapeHtml(beatsText(beat.before)) + ' → ' + escapeHtml(beatsText(beat.after)) + '</span></p>')
    }
    out.push('</div>')
    if (script.changed.length > COMPARE_SHEET_LIMITS.beats) {
      out.push('<p class="cmp-muted">还有 ' + (script.changed.length - COMPARE_SHEET_LIMITS.beats) + ' 段改过的口播没印。</p>')
    }
  }
  out.push('</section>')
  return out.join('')
}

/**
 * 一张两版对照纸。
 * compare 就是 /api/projects/:id/versions/compare 的响应体（含 base / target / canvas / script）。
 */
export function compareSheetHtml({
  project = {},
  compare = {},
  now = new Date(),
  tzOffsetMinutes = 480,
  projectId = '',
  offline = false,
  // 分享出去的纸要回分享页（没有登录态）；两处都只影响顶栏与一句来源说明
  backHref = '',
  backLabel = '返回作品',
  hint = '',
  originNote = '',
} = {}) {
  const tz = Number.isFinite(Number(tzOffsetMinutes)) ? Math.max(-720, Math.min(840, Math.round(Number(tzOffsetMinutes)))) : 480
  const base = compare.base || {}
  const target = compare.target || {}
  const baseLabel = 'v' + count(base.n)
  const targetLabel = 'v' + count(target.n)
  const reviewChange = compare.reviewChange || null
  const notes = (Array.isArray(compare.notes) ? compare.notes : []).slice(0, COMPARE_SHEET_LIMITS.notes)
  const body = []

  body.push(
    printToolbar({
      projectId,
      tag: '两版对照 / A4',
      meta: '210 x 297 mm',
      hint: hint || (offline ? '解压后直接打印 / 存为 PDF；只读对照，不重跑、不扣积分' : '纸张选 A4；只读对照，不重跑、不扣积分'),
      back: !offline && Boolean(backHref || projectId),
      backHref,
      backLabel,
      brand: offline ? 'text' : 'img',
    }),
  )
  body.push('<main class="sheet">')
  body.push(brandRow({ mark: offline ? 'text' : 'img', kind: 'VERSION DIFF / A4', aiLabel: true }))
  body.push('<div class="sheet-body">')
  body.push('<h1 class="sheet-title">两版对照 · ' + escapeHtml(project.title || '未命名作品') + '</h1>')
  body.push(
    '<p class="lede">' + escapeHtml(baseLabel + ' → ' + targetLabel) +
      '：左边是基准，右边是对照。这一张只回答「改了什么、评审与交付怎么说」，不替人判断要不要交。' +
    '</p>',
  )

  body.push(
    '<ul class="sheet-facts">' +
      (project.id ? '<li><span class="fact-k">作品编号</span><span class="fact-v">' + escapeHtml(project.id) + '</span></li>' : '') +
      '<li><span class="fact-k">对照</span><span class="fact-v">' + escapeHtml(baseLabel + ' → ' + targetLabel) + '</span></li>' +
      '<li><span class="fact-k">导出时间</span><span class="fact-v">' + escapeHtml(stamp(now.toISOString(), tz)) + '</span></li>' +
    '</ul>',
  )
  body.push('<p class="sheet-ai-note">' + escapeHtml(AI_LABEL_NOTICE) + '</p>')
  if (originNote) body.push('<p class="sheet-origin-note">' + escapeHtml(originNote) + '</p>')

  body.push('<section class="cmp-summary">')
  body.push('<p class="cmp-kicker">一句话</p>')
  body.push('<p class="cmp-lede">' + escapeHtml(compare.summary || '这两版没有可比的数据。') + '</p>')
  body.push('</section>')

  body.push('<section class="cmp-section">')
  body.push('<h2>评审与交付</h2>')
  body.push('<div class="cmp-sides">')
  body.push(sideHtml(base, '基准', tz))
  body.push(sideHtml(target, '对照', tz))
  body.push('</div>')
  if (reviewChange) {
    body.push(
      '<p class="cmp-change is-' + escapeHtml(reviewChange.tone || 'unknown') + '">' +
        '<span class="cmp-tag">' + escapeHtml(TONE_LABEL[reviewChange.tone] || '看不出来') + '</span>' +
        escapeHtml(reviewChange.text || '') +
      '</p>',
    )
  }
  body.push('</section>')

  body.push(canvasHtml(compare, baseLabel, targetLabel))
  body.push(scriptHtml(compare, baseLabel, targetLabel))

  if (notes.length) {
    body.push('<section class="cmp-section">')
    body.push('<h2>这张纸没比的部分</h2>')
    body.push('<ul class="cmp-notes">' + notes.map((note) => '<li>' + escapeHtml(note) + '</li>').join('') + '</ul>')
    body.push('</section>')
  }

  body.push(
    '<p class="sheet-foot">由 VisionQA 导出 · ' + escapeHtml(stamp(now.toISOString(), tz)) +
      ' · 只读对照：不改画布、不改脚本、不写交付记录、不扣积分 · ' +
      escapeHtml(aiLabelFootText()) + '</p>',
  )
  body.push('</div>')
  body.push('</main>')

  return paperShell(
    (project.title || '未命名作品') + ' · 两版对照 · VisionQA',
    body.join('\n'),
    COMPARE_SHEET_CSS,
    '',
    { aiLabel: true },
  )
}

const COMPARE_SHEET_CSS = [
  '.cmp-summary { margin: 0 0 16pt; padding: 10pt 0; border-top: 0.75pt solid var(--line-strong); border-bottom: 0.75pt solid var(--line); }',
  '.cmp-kicker { margin: 0 0 4pt; font-family: var(--mono); font-size: 7pt; letter-spacing: 0.1em; color: var(--faint); text-transform: uppercase; }',
  '.cmp-lede { margin: 0; font-size: 14pt; line-height: 1.55; font-weight: 500; letter-spacing: -0.01em; }',
  '.cmp-section { margin: 0 0 16pt; break-inside: avoid; }',
  '.cmp-section h2 { margin-top: 16pt; }',
  '.cmp-meta { margin: 0 0 6pt; font-family: var(--mono); font-size: 8pt; line-height: 1.55; color: var(--faint); }',
  '.cmp-muted { margin: 4pt 0 8pt; font-size: 8.5pt; line-height: 1.6; color: var(--muted); }',
  '.cmp-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8pt; align-items: stretch; }',
  '.cmp-side { min-width: 0; padding: 8pt; border: 0.75pt solid var(--line-strong); border-radius: 3pt; background: #fcfcfc; break-inside: avoid; }',
  '.cmp-side-head { display: flex; align-items: center; gap: 6pt; }',
  '.cmp-v { font-family: var(--mono); font-size: 10pt; font-weight: 600; }',
  '.cmp-role { font-family: var(--mono); font-size: 7pt; letter-spacing: 0.08em; color: var(--faint); }',
  '.cmp-verdict { margin-left: auto; padding: 0 4pt; border: 0.5pt solid var(--line-strong); border-radius: 999px; font-size: 7.5pt; line-height: 1.6; white-space: nowrap; }',
  '.cmp-verdict.is-pass { border-color: var(--ink); }',
  '.cmp-verdict.is-needs_review, .cmp-verdict.is-fail { border-color: var(--ink); background: #f2f2f2; }',
  '.cmp-name { margin: 4pt 0 2pt; font-size: 9pt; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }',
  '.cmp-line, .cmp-snapshot { margin: 0; font-size: 8pt; line-height: 1.6; color: var(--muted); overflow-wrap: anywhere; }',
  '.cmp-snapshot { color: var(--faint); }',
  '.cmp-drift { margin: 4pt 0 0; padding-top: 4pt; border-top: 0.5pt dotted var(--line-strong); font-size: 8pt; line-height: 1.55; }',
  '.cmp-tag { display: inline-block; margin-right: 4pt; padding: 0 4pt; border: 0.5pt solid var(--line-strong); border-radius: 2pt; font-family: var(--mono); font-size: 7pt; line-height: 1.55; color: var(--ink); }',
  '.cmp-drift.is-worse .cmp-tag, .cmp-change.is-worse .cmp-tag { border-color: var(--ink); background: var(--ink); color: #ffffff; }',
  '.cmp-drift.is-better .cmp-tag, .cmp-change.is-better .cmp-tag { border-color: var(--ink); }',
  '.cmp-change { margin: 8pt 0 0; padding-top: 6pt; border-top: 0.75pt solid var(--line); font-size: 9pt; line-height: 1.55; }',
  '.cmp-deltas { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8pt; margin: 0 0 8pt; }',
  '.cmp-delta { padding: 6pt 8pt; border: 0.5pt solid var(--line); border-radius: 3pt; background: #fbfbfb; }',
  '.cmp-delta b { display: block; font-family: var(--mono); font-size: 15pt; line-height: 1.2; font-weight: 500; }',
  '.cmp-delta span { display: block; margin-top: 2pt; font-size: 7.5pt; color: var(--faint); }',
  '.cmp-names { margin: 0 0 4pt; font-size: 8pt; line-height: 1.55; color: var(--muted); overflow-wrap: anywhere; }',
  '.cmp-names span { margin-right: 4pt; font-family: var(--mono); font-size: 7pt; color: var(--faint); }',
  '.cmp-node { margin: 8pt 0 0; break-inside: avoid; }',
  '.cmp-node h3 { display: flex; align-items: baseline; justify-content: space-between; gap: 8pt; margin: 0 0 4pt; font-size: 9pt; font-weight: 600; }',
  '.cmp-node h3 span { font-family: var(--mono); font-size: 7.5pt; font-weight: 400; color: var(--faint); white-space: nowrap; }',
  '.cmp-table { width: 100%; margin: 0 0 4pt; border-collapse: collapse; font-size: 8pt; line-height: 1.5; }',
  '.cmp-table th { padding: 3pt 5pt; border-bottom: 0.75pt solid var(--line-strong); background: #fbfbfb; font-weight: 500; color: var(--muted); text-align: left; }',
  '.cmp-table td { padding: 3pt 5pt; border-bottom: 0.5pt solid var(--line-faint); vertical-align: top; overflow-wrap: anywhere; }',
  '.cmp-table tr { break-inside: avoid; }',
  '.cmp-table th:nth-child(1), .cmp-table td:nth-child(1) { width: 20%; white-space: nowrap; color: var(--faint); }',
  '.cmp-hook { margin: 8pt 0 0; padding: 6pt 8pt; border-left: 1.5pt solid var(--line-strong); background: #fbfbfb; break-inside: avoid; }',
  '.cmp-hook p { margin: 2pt 0 0; font-size: 8pt; line-height: 1.55; overflow-wrap: anywhere; }',
  '.cmp-hook b { display: inline-block; min-width: 18pt; margin-right: 4pt; font-family: var(--mono); font-size: 7.5pt; color: var(--faint); }',
  '.cmp-quotes { margin: 6pt 0 0; }',
  '.cmp-quote { margin: 0 0 4pt; padding: 4pt 6pt; border: 0.5pt solid var(--line-faint); border-radius: 2pt; font-size: 8pt; line-height: 1.55; break-inside: avoid; }',
  '.cmp-quote b { display: block; margin-bottom: 1pt; font-size: 8pt; }',
  '.cmp-quote span { display: block; color: var(--muted); overflow-wrap: anywhere; }',
  '.cmp-notes { margin: 0; padding-left: 13pt; font-size: 8pt; line-height: 1.6; color: var(--muted); }',
  '.sheet-origin-note { margin: 0 0 12pt; padding-left: 8pt; border-left: 1.5pt solid var(--line-strong); font-size: 8pt; line-height: 1.6; color: var(--faint); }',
  '.cmp-notes li { margin: 0 0 3pt; }',
  '@media screen and (max-width: 700px) { .cmp-sides { grid-template-columns: 1fr; } .cmp-deltas { grid-template-columns: repeat(3, minmax(0, 1fr)); } .cmp-table { display: block; overflow-x: auto; } }',
].join('\n')
