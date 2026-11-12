// 作品交付稿：把一条作品从来源到交付的现场压成一份 Markdown。
//
// 纯函数：输入是作品详情（/api/projects/:id 返回的那一份）与这一版最近一次评审的完整记录，
// 输出 { fileName, markdown }。不碰网络、不读盘，便于单测。
//
// 三条边界：
//  1. 只写已经发生的事：没评审就写「还没送评审」，不替模型编一句结论。
//  2. 不写凭证：分享 token、ownerId 一律不进稿——token 等于一把能打开这条作品的钥匙。
//  3. 口径跟页面一致：脚本用作品自己的版本优先（scriptView 已算好），
//     版本划分之前留下的评审与运行折进 v1（与 src/domain/project.ts 同一套规则）。
import { describeTiming } from './speech.mjs'
import { DIMENSION_LABEL, boxText, normalizeBox } from './project-review-sheet.mjs'
// 状态与「某一版评过几次」读作品状态那一处：纸上写的状态与页面上那枚胶囊必须是同一句话
import {
  VERDICT_TEXT as VERDICT_LABEL,
  projectStatus,
  reviewsForVersion as reviewsOf,
  decisionFor,
  deliveryOf,
  deliveredCurrent,
} from './project-status.mjs'

/** 交付记录的一句话：这一版交没交、交了哪一版、什么时候。抬头、交付小节与版本表共用。 */
function deliveryText(project, tz) {
  const delivery = deliveryOf(project)
  const delivered = deliveredCurrent(project)
  if (delivered && delivery) {
    return '这一版已经交付 · v' + delivery.version + (delivery.at ? ' · ' + stamp(delivery.at, tz) : '（时间没记录，老记录）')
  }
  if (delivered) return '这一版已经交付（时间没记录，老记录）'
  if (delivery) {
    return '这一版还没交付 · 上一版 v' + delivery.version +
      (delivery.at ? ' 于 ' + stamp(delivery.at, tz) + ' 交付' : ' 交付过（时间没记录）')
  }
  return '还没交付过（在作品页「标记交付」会记下是哪一版、什么时候）'
}

export const DELIVERABLE_LIMITS = { runs: 8, observations: 8, fixes: 6, versions: 6 }

const SEVERITY_LABEL = { blocker: '阻断', major: '重要', minor: '轻微', info: '提示' }
const PACE_LABEL = { fast: '快', slow: '慢', normal: '中' }

// 表格单元格：换行压成空格、竖线转义，否则一个「|」就把整张表拆坏
const cell = (value) =>
  String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()

// 列表行里的值：换行与外层缩进压成单空格，否则一句话就把下面几行顶出列表
const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const sec = (value) => {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 10) / 10 + ' 秒' : '—'
}

const pad2 = (value) => String(value).padStart(2, '0')
const pad4 = (value) => String(value).padStart(4, '0')

/**
 * 时间戳按「导出的人所在的时区」写：稿子是给人看的，UTC 会让人对不上自己的时间线。
 * tzOffsetMinutes 是东经为正的分钟数（北京时间 480）。
 */
function stamp(value, tzOffsetMinutes) {
  const ms = Date.parse(String(value || ''))
  if (!Number.isFinite(ms)) return '—'
  const date = new Date(ms + tzOffsetMinutes * 60000)
  return (
    pad4(date.getUTCFullYear()) + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate()) +
    ' ' + pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes())
  )
}

const day = (value, tzOffsetMinutes) => stamp(value, tzOffsetMinutes).slice(0, 10)

/** 某一版跑过几次：与评审同一套折进规则。 */
function runsOf(counts, version) {
  const own = Number(counts?.[String(version)]) || 0
  const legacy = version === 1 ? Number(counts?.['0']) || 0 : 0
  return own + legacy
}



function header(detail, ctx) {
  const { project, template, flow, script, versionCounts } = detail
  const { tz, now } = ctx
  const currentReviews = reviewsOf(versionCounts, project.version)
  // 人拍板要写在抬头：收件人第一眼就该知道这份稿子的结论是谁拍的板，纸被转发也一样
  const decision = decisionFor(detail.decisions, currentReviews.lastAt)
  const lines = [
    '# ' + (project.title || '未命名作品'),
    '',
    '一条作品的完整稿：来源、脚本、分镜、评审结论、版本与运行。给剪辑、制片或自己归档，读这一份就够。',
    '',
    '- 作品编号：' + project.id,
    '- 状态：' + projectStatus(project, currentReviews, decision).text + (project.version ? '（当前第 ' + project.version + ' 版）' : ''),
    // 交付是这一版交出去了——收件人要知道交的是哪一版，什么时候交的
    '- 交付：' + deliveryText(project, tz),
    // 没有拍板也照实写：读者会问「这结论谁定的」，答案就是模型 + 还没人复核
    '- 人工复核：' + (decision
      ? (decision.decision === 'pass' ? '人工通过' : '人工不通过') + ' · ' + stamp(decision.at, tz) + (decision.note ? ' · ' + flat(decision.note) : '')
      : '没有（结论由模型给出，还没人拍板）'),
  ]
  if (flow) lines.push('- 画布：' + flow.name + '（' + flow.nodes + ' 个节点）')
  else lines.push('- 画布：还没开')
  if (template) {
    lines.push(
      '- 模板：' + template.title + ' · ' + (template.platformLabel || '未标平台') +
        ' · 原片 ' + sec(template.durationSec) + ' · ' + template.beats + ' 段 / ' + template.shots + ' 镜',
    )
    if (template.reuseCount) lines.push('- 这条模板被用过：' + template.reuseCount + ' 次')
  } else {
    lines.push('- 模板：这条作品绑的模板已被删除，脚本与分镜只能按作品自己存下的版本看')
  }
  if (script) {
    lines.push(
      script.source === 'project'
        ? '- 脚本：这条作品自己的版本（' + stamp(script.updatedAt, tz) + ' 改过，模板再改不影响它）'
        : '- 脚本：跟随模板《' + (template?.title || '—') + '》，模板改了这份稿也会变',
    )
  }
  // 抬头每一行都写成「标签：值」：文件里读着整齐，纸上那几张事实表也因为这一层才排得齐
  lines.push('- 建立：' + stamp(project.createdAt, tz))
  lines.push('- 最后更新：' + stamp(project.updatedAt, tz))
  lines.push('- 导出时间：' + stamp(now.toISOString(), tz))
  return lines
}

// describeTiming 的句子不带句号：拼进段落时补一个，避免两句粘在一起
const period = (value) => {
  const text = flat(value)
  return !text || /[。！？；]$/.test(text) ? text : text + '。'
}

function timingSection(script) {
  const timing = script?.timing
  if (!timing || !timing.estimatedSec) return []
  const out = ['', '## 时长对账', '']
  out.push(
    '台词约需 ' + timing.estimatedSec + ' 秒，原片 ' + (timing.durationSec || 0) + ' 秒，按语速档「' +
      (PACE_LABEL[timing.pace] || '中') + '」估（' + (timing.rate || 0) + ' 字/秒）。' + period(describeTiming(timing)),
  )
  return out
}

function scriptSection(script, detail) {
  const hookType = detail?.template?.hookType || ''
  const out = ['', '## 脚本', '']
  if (!script || !script.structure?.length) {
    out.push('还没写脚本：去模板库套一条已解析的模板，或在作品页写第一段口播。')
    return out
  }
  if (script.hook) out.push('开头钩子：' + script.hook + (hookType ? '（' + hookType + '）' : ''), '')
  out.push('| 时间 | 段落 | 口播 | 屏幕字 | 目的 | 念完 |', '| --- | --- | --- | --- | --- | --- |')
  for (const beat of script.structure) {
    const span = Number(beat.startSec) || Number(beat.endSec) ? (Number(beat.startSec) || 0) + '–' + (Number(beat.endSec) || 0) + ' 秒' : '时间待定'
    const read = beat.expectedSec ? sec(beat.expectedSec) + (beat.fit === 'tight' ? ' · 偏多' : '') : '—'
    out.push(
      '| ' + cell(span) + ' | ' + cell(beat.beat) + ' | ' + cell(beat.voiceover) + ' | ' + cell(beat.onScreen) +
        ' | ' + cell(beat.purpose) + ' | ' + cell(read) + ' |',
    )
  }
  const tight = script.structure.filter((beat) => beat.fit === 'tight').length
  if (tight) {
    out.push('', '「偏多」的段落按口播念完会比画面时间长：要么删几句，要么把这一段画面拉长。')
  }
  return out
}

function storyboardSection(detail) {
  const { template } = detail
  const shots = Array.isArray(template?.storyboard) ? template.storyboard : []
  const out = ['', '## 分镜', '']
  if (!shots.length) {
    out.push('模板没有分镜表：换一条已解析的模板，或者按上面的脚本直接拍。')
    return out
  }
  out.push('分镜来自模板《' + template.title + '》：改过的脚本不会自动重排镜头时间。', '')
  for (const shot of shots) {
    out.push(
      '### 镜头 ' + pad2(Number(shot.shotNo) || 0) + ' · ' + (Number(shot.startSec) || 0) + '–' + (Number(shot.endSec) || 0) + ' 秒',
      '',
    )
    const rows = [
      shot.visual ? '- 画面：' + flat(shot.visual) : '',
      shot.camera ? '- 机位：' + flat(shot.camera) : '',
      shot.caption ? '- 字幕：' + flat(shot.caption) : '',
      shot.audio ? '- 音频：' + flat(shot.audio) : '',
      shot.purpose ? '- 用途：' + flat(shot.purpose) : '',
      shot.expectedSec ? '- 念完：' + sec(shot.expectedSec) + (shot.fit === 'tight' ? '（台词偏多）' : '') : '',
    ].filter(Boolean)
    out.push(...(rows.length ? rows : ['- 这一镜没有写画面说明']), '')
  }
  return out
}

function reviewSection(detail, review, tz) {
  const out = ['', '## 评审', '']
  const project = detail.project
  const currentReviews = reviewsOf(detail.versionCounts, project.version)
  if (!review) {
    if (currentReviews.count) {
      out.push('这一版评过 ' + currentReviews.count + ' 次，但最近一次记录的正文没读到；结论以作品页为准。')
    } else if (detail.reviews?.length) {
      const previous = detail.reviews[0]
      out.push(
        '这一版还没送评审。上一版评过，最近结论是「' + (VERDICT_LABEL[previous.verdict] || '未给结论') + '」（' +
          stamp(previous.createdAt, tz) + '）：评审按版本记，结论不混到这一版。',
      )
    } else {
      out.push('还没送过评审：在作品页点「用评审看这版」，结论会记到这一版上。')
    }
    return out
  }

  const result = review.result || {}
  const verdict = VERDICT_LABEL[result.verdict] || '未给结论'
  // 版本 0 是版本划分之前（还没开画布）的记录，标成「v0」会让人以为有第零版
  const reviewedVersion = Number(review.version) || project.version
  out.push('最新一次' + (reviewedVersion ? '（v' + reviewedVersion + '）' : '') + '：' + verdict + ' · ' + stamp(review.createdAt, tz))
  const model = result.profile || result.provider || ''
  const meta = [model ? '模型 ' + model + (result.provider && result.provider !== model ? '（' + result.provider + '）' : '') : '', result.ms ? Math.round(result.ms / 100) / 10 + ' 秒' : ''].filter(Boolean)
  // 前面加「· 」：这一行在 Markdown 里紧跟上一行，渲染成一段时两个信息不会粘在一起
  if (meta.length) out.push('· ' + meta.join(' · '))
  // 这条评审谁拍过板：模型说「需人工确认」时，人给的结论才是最后一句
  const decision = decisionFor(detail.decisions, review.createdAt)
  if (decision) {
    out.push(
      '',
      '人拍板：' + (decision.decision === 'pass' ? '通过' : '不通过') + ' · ' + stamp(decision.at, tz) +
        (decision.note ? '（' + flat(decision.note) + '）' : ''),
    )
  }
  if (result.summary) out.push('', '> ' + String(result.summary).replace(/\r?\n/g, ' '))
  const judge = result.judge
  if (judge && judge.status === 'ok') {
    const bits = []
    if (typeof judge.evidenceConsistent === 'number') bits.push('结论有画面依据 ' + Math.round(judge.evidenceConsistent * 100) + '%')
    if (typeof judge.actionable === 'number') bits.push('修正可直接执行 ' + Math.round(judge.actionable * 100) + '%')
    if (judge.publishRisk && typeof judge.publishRisk.score === 'number') bits.push('发布风险 ' + judge.publishRisk.score)
    if (bits.length) out.push('', '判断层（只作依据，不改结论）：' + bits.join(' · '))
  }

  const observations = Array.isArray(result.observations) ? result.observations.slice(0, DELIVERABLE_LIMITS.observations) : []
  if (observations.length) {
    out.push('', '### 问题（' + observations.length + '）', '')
    let boxed = 0
    observations.forEach((item, index) => {
      const severity = SEVERITY_LABEL[item.severity] || '提示'
      // 依据强度与框位置并进同一个括号：连着两个括号读起来像两句话粘在一起
      const notes = []
      if (typeof item.confidence === 'number') notes.push('依据强度 ' + Math.round(item.confidence * 100) + '%')
      // 框的位置写成百分比：只下这份 .md 的人也能对着原图找到那条判断说的是哪一块
      const box = boxText(normalizeBox(item.evidence))
      if (box) { boxed += 1; notes.push(box) }
      out.push(
        (index + 1) + '. **' + severity + ' · ' + (DIMENSION_LABEL[item.dimension] || item.dimension || '整体') + '**：' + (item.statement || '') +
          (notes.length ? '（' + notes.join(' · ') + '）' : ''),
      )
    })
    // 编号与交付包里的「评审对照页.html」是同一套：纸上框写几号，这里就是第几条
    if (boxed) {
      out.push(
        '',
        '证据框：' + boxed + ' 条问题在画面上框了位置（编号同上）。画面与框的对照图见交付包里的「评审对照页.html」；只拿到这份稿时，按括号里的百分比对着原图找。',
      )
    }
  }

  const fixes = Array.isArray(result.fixes) ? result.fixes.slice(0, DELIVERABLE_LIMITS.fixes) : []
  if (fixes.length) {
    out.push('', '### 修正建议（' + fixes.length + '）', '')
    fixes.forEach((fix, index) => {
      out.push((index + 1) + '. ' + (fix.title || '') + (fix.detail ? '：' + fix.detail : ''))
    })
  }

  const notAssessable = Array.isArray(result.notAssessable) ? result.notAssessable.slice(0, DELIVERABLE_LIMITS.observations) : []
  if (notAssessable.length) {
    out.push('', '### 这次没判断的', '')
    for (const item of notAssessable) out.push('- ' + item)
  }
  return out
}

// ---------- 版本：每一版都写全 ----------
//
// 「把这版和上一版一起发我」是编导最常提的要求，但版本之间能对照的只有三样：
// 画布（旧版画布一直留着）、评审与运行（按版本记）、以及开新版时存下的脚本快照。
// 脚本只有一份（作品级，copy-on-write），更早开的版本没有快照——这一点必须写进稿子，
// 否则读者会以为「v1 的脚本就是现在这个样子」。

// 节点指纹：复制版本时节点 id 沿用，靠 id 认「同一个节点改没改」，内容比的是配置文本
function fingerprint(nodes) {
  if (!Array.isArray(nodes)) return null
  return nodes.map((node) => {
    const text = String(node?.type || '') + ':' + JSON.stringify(node?.data?.config ?? {})
    let hash = 2166136261
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return { id: String(node?.id || ''), title: flat(node?.data?.title) || '未命名节点', hash: (hash >>> 0).toString(36) }
  })
}

const names = (list, max = 3) => {
  const shown = list.slice(0, max).join('、')
  return list.length > max ? shown + ' 等 ' + list.length + ' 个' : shown
}

// 句子里的摘要与原因要短：纸上一行排不下三段，读者也只需要知道「大概说了什么」
const shorten = (value, max = 90) => {
  const text = flat(value)
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** 两份节点指纹比出「多了 / 少了 / 改了」；缺一侧（画布被删）就返回 null。 */
function canvasDelta(prev, next) {
  if (!prev || !next) return null
  const before = new Map(prev.map((node) => [node.id, node]))
  const after = new Map(next.map((node) => [node.id, node]))
  const added = []
  const removed = []
  const changed = []
  for (const [id, node] of after) {
    const old = before.get(id)
    if (!old) added.push(node.title)
    else if (old.hash !== node.hash) changed.push(node.title)
  }
  for (const [id, node] of before) if (!after.has(id)) removed.push(node.title)
  return { added, removed, changed }
}

function canvasText(delta) {
  if (!delta) return ''
  const bits = []
  if (delta.added.length) bits.push('多 ' + delta.added.length + ' 个（' + names(delta.added) + '）')
  if (delta.removed.length) bits.push('少 ' + delta.removed.length + ' 个（' + names(delta.removed) + '）')
  if (delta.changed.length) bits.push('改 ' + delta.changed.length + ' 个（' + names(delta.changed) + '）')
  return bits.length ? bits.join('、') : '节点没动'
}

// 脚本按段名对：改名不算改口播，重名段落按出现顺序比词
function scriptText(prev, next) {
  if (!prev?.structure?.length || !next?.structure?.length) return ''
  const group = (script) => {
    const map = new Map()
    for (const beat of script.structure) {
      const name = flat(beat?.beat) || '未命名段落'
      if (!map.has(name)) map.set(name, [])
      map.get(name).push(flat(beat?.voiceover))
    }
    return map
  }
  const before = group(prev)
  const after = group(next)
  const added = [...after.keys()].filter((name) => !before.has(name))
  const removed = [...before.keys()].filter((name) => !after.has(name))
  let changed = 0
  for (const [name, lines] of after) {
    const old = before.get(name)
    if (!old) continue
    if (old.length !== lines.length || old.some((line, index) => line !== lines[index])) changed += 1
  }
  const hookChanged = flat(prev.hook) !== flat(next.hook)
  const bits = []
  if (added.length) bits.push('多 ' + added.length + ' 段（' + names(added) + '）')
  if (removed.length) bits.push('少 ' + removed.length + ' 段（' + names(removed) + '）')
  if (changed) bits.push(changed + ' 段口播改过')
  if (!bits.length && !hookChanged) return '跟上一版一样'
  bits.push(hookChanged ? '钩子换过' : '钩子没变')
  return bits.join('、')
}

/** 评审与运行按版本分组：版本 0 是版本划分之前记的，折进 v1（与页面同一套规则）。 */
function groupByVersion(items) {
  const map = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const version = Math.max(1, Math.round(Number(item?.version) || 0))
    const list = map.get(version) || []
    list.push(item)
    map.set(version, list)
  }
  return map
}

function versionSection(detail, tz) {
  const { project } = detail
  const out = ['', '## 版本对照']
  if (!project.version) {
    out.push('', '还没开画布，所以只有脚本这一版。')
    return out
  }
  const archived = [...(Array.isArray(detail.versions) ? detail.versions : [])].sort((a, b) => a.n - b.n)
  const current = {
    n: project.version,
    name: detail.flow?.name || '当前版',
    nodes: detail.flow?.nodes || 0,
    available: Boolean(detail.flow),
    archivedAt: '',
    nodeList: detail.flow?.nodeList || null,
    script: detail.script || null,
    current: true,
  }
  // 归档版本的快照字段是 scriptSnapshot（详情视图只在导出时带它）；正文里统一当 script 用
  const rows = [...archived.map((entry) => ({ ...entry, script: entry.scriptSnapshot || null, current: false })), current]
  const byNumber = new Map(rows.map((row) => [row.n, row]))
  const reviewMap = groupByVersion(detail.reviews)
  const runMap = groupByVersion(detail.runs)
  // 哪几版交出去过：表里标在版次后面，每版现场再写一条时间
  const deliveredVersions = new Map(
    (Array.isArray(project.deliveries) ? project.deliveries : [])
      .map((entry) => [Math.round(Number(entry.version) || 0), String(entry.at || '')]),
  )
  for (const list of reviewMap.values()) {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }
  for (const list of runMap.values()) {
    list.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  }
  const beats = (script) => (Array.isArray(script?.structure) ? script.structure.length : 0)
  const scriptCell = (row) => {
    if (row.current) return beats(row.script) ? beats(row.script) + ' 段' : '没写脚本'
    return row.script ? beats(row.script) + ' 段' : '没存快照'
  }

  out.push(
    '',
    '共 ' + rows.length + ' 版，现在是 v' + project.version + '。开新版本时会给这一版的脚本存一份快照；' +
      '在这之前开的版本没有快照，那几版当时的口播已经找不回来了。',
  )
  // 当前版相对上一版改了什么：这是「把这版和上一版一起发我」里读者最先要看的一句
  const previous = byNumber.get(project.version - 1) || null
  if (previous) {
    const canvas = canvasText(canvasDelta(fingerprint(previous.nodeList), fingerprint(current.nodeList)))
    const script = scriptText(previous.script, current.script)
    const bits = [canvas ? '画布' + canvas : '', script ? '脚本' + script : ''].filter(Boolean)
    if (bits.length) out.push('', 'v' + current.n + ' 比 v' + previous.n + '：' + bits.join('；') + '。')
  }

  out.push('', '| 版本 | 画布 | 节点 | 脚本 | 评审 | 运行 | 最近结论 | 归档 |', '| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    const counter = reviewsOf(detail.versionCounts, row.n)
    const runs = runsOf(detail.runCounts, row.n)
    out.push(
      '| v' + row.n + (row.current ? '（当前）' : '') + (deliveredVersions.has(row.n) ? ' · 已交付' : '') +
        ' | ' + cell(row.name) + ' | ' + row.nodes + ' | ' + scriptCell(row) + ' | ' +
        (counter.count ? counter.count + ' 次' : '未评') + ' | ' + (runs ? runs + ' 次' : '没跑过') + ' | ' +
        (VERDICT_LABEL[counter.lastVerdict] || '—') + ' | ' + (row.current ? '—' : stamp(row.archivedAt, tz)) + ' |',
    )
  }

  // 每一版的现场：从新到旧，一版一小段；版数多时只写最近几版，上面的表里仍然有全量
  const blocks = rows.filter((row) => !row.current).reverse().slice(0, DELIVERABLE_LIMITS.versions)
  if (blocks.length) {
    out.push('', '下面按从新到旧，把每一版的画布、脚本、评审与运行放在一起。')
    for (const row of blocks) {
      const before = byNumber.get(row.n - 1) || null
      out.push('', '### v' + row.n + ' · ' + flat(row.name), '')
      out.push(
        '- 归档：' + stamp(row.archivedAt, tz) + ' · ' +
          (row.available ? '画布 ' + row.nodes + ' 个节点' : '画布已经被删除，只剩这一行归档记录'),
      )
      if (deliveredVersions.has(row.n)) {
        const at = deliveredVersions.get(row.n)
        out.push('- 交付：' + (at ? stamp(at, tz) + ' 交出去过' : '交出去过（时间没记录）'))
      }
      const canvas = canvasText(canvasDelta(fingerprint(before?.nodeList), fingerprint(row.nodeList)))
      if (before && canvas) out.push('- 画布：比 v' + before.n + ' ' + canvas)
      if (row.script) {
        const hook = flat(row.script.hook)
        const delta = before ? (before.script ? scriptText(before.script, row.script) : '') : ''
        const compare = before
          ? (before.script ? '；比 v' + before.n + ' ' + delta : '；v' + before.n + ' 没存快照，比不了')
          : '；最早一版'
        out.push(
          '- 脚本：' + beats(row.script) + ' 段' + (hook ? '，钩子「' + shorten(hook, 40) + '」' : '') +
            (row.script.source === 'template' ? '（当时跟随模板）' : '') + compare,
        )
      } else {
        out.push('- 脚本：这一版没存快照（开版时还没有快照功能），当时的口播找不回来了')
      }
      const reviews = reviewMap.get(row.n) || []
      const counter = reviewsOf(detail.versionCounts, row.n)
      if (!reviews.length) {
        out.push('- 评审：' + (counter.count ? '评过 ' + counter.count + ' 次，正文不在最近 20 条里' : '没评过'))
      } else {
        const last = reviews[0]
        const extras = [stamp(last.createdAt, tz), last.observations ? last.observations + ' 条问题' : ''].filter(Boolean)
        out.push(
          '- 评审：' + (counter.count || reviews.length) + ' 次；最近「' + (VERDICT_LABEL[last.verdict] || '未给结论') + '」' +
            '（' + extras.join('，') + '）' + (last.summary ? '：' + shorten(last.summary) : ''),
        )
      }
      const listed = runMap.get(row.n) || []
      const total = runsOf(detail.runCounts, row.n)
      if (!total) {
        out.push('- 运行：没跑过')
      } else if (!listed.length) {
        out.push('- 运行：' + total + ' 次（明细不在最近 20 条里）')
      } else {
        const failed = listed.filter((run) => run.status !== 'success' || run.error)
        const latest = failed[0]
        // 失败原因本身常带括号：用「」包起来，读的时候不会和外面的说明括号混成一句
        const reason = latest ? '（最近一次 ' + stamp(latest.startedAt, tz) + ' 失败：「' + shorten(latest.error || '没记原因', 60) + '」）' : ''
        const outcome = !failed.length
          ? '都成功'
          : listed.length >= total && failed.length >= total
            ? (total === 1 ? '这次失败了' : '全失败') + reason
            : failed.length + ' 次失败' + reason
        // 明细只留最近 20 条：总次数比明细多时要说明，否则「1 次失败」会被读成全部
        const scope = listed.length < total ? '，明细只留最近 ' + listed.length + ' 次（其中 ' + outcome + '）' : '，' + outcome
        out.push('- 运行：' + total + ' 次' + scope)
      }
    }
  }

  if (archived.length) {
    out.push('', '旧版本的画布还在的话能打开看，但改它不会写回那一版：要改就在最新一版上改。')
  }
  return out
}

function runSection(detail, tz) {
  const out = ['', '## 运行记录', '']
  const runs = Array.isArray(detail.runs) ? detail.runs : []
  if (!runs.length) {
    out.push('还没跑过画布：跑一次之后，每个版本的耗时、失败节点与积分都会记在这里。')
    return out
  }
  const shown = runs.slice(0, DELIVERABLE_LIMITS.runs)
  out.push(
    '共 ' + (detail.runTotal || runs.length) + ' 次运行' +
      (runs.length > shown.length ? '，这里列最新 ' + shown.length + ' 次' : '') + '。',
    '',
    '| 开始 | 版本 | 状态 | 节点 | 耗时 | 积分 |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  for (const run of shown) {
    const ok = run.status === 'success'
    const duration = Number(run.durationMs) > 0
      ? (run.durationMs >= 60000 ? Math.floor(run.durationMs / 60000) + ' 分 ' + Math.round((run.durationMs % 60000) / 1000) + ' 秒' : Math.round(run.durationMs / 100) / 10 + ' 秒')
      : '—'
    const credits = run.credits && run.credits.cost ? run.credits.cost + ' 积分' + (run.credits.refunded ? '（已退）' : '') : '不计费'
    out.push(
      '| ' + stamp(run.startedAt, tz) + ' | v' + (run.version || 0) + ' | ' + (ok ? '成功' : '失败') + ' | ' +
        (run.total || 0) + (run.failed ? '（' + run.failed + ' 失败）' : '') + ' | ' + duration + ' | ' + credits + ' |',
    )
  }
  const failed = shown.filter((run) => run.error)
  if (failed.length) {
    out.push('', '### 失败原因', '')
    for (const run of failed) out.push('- ' + stamp(run.startedAt, tz) + '：' + run.error)
  }
  return out
}

function deliverySection(detail, tz) {
  const { project } = detail
  const out = ['', '## 交付', '']
  out.push('- 交付：' + deliveryText(project, tz))
  const history = (Array.isArray(project.deliveries) ? project.deliveries : [])
    .map((entry) => 'v' + entry.version + (entry.at ? ' · ' + stamp(entry.at, tz) : ' · 时间没记录'))
    .reverse()
  if (history.length) out.push('- 交付记录：' + history.join('；'))
  out.push(
    '- 只读分享：' + (detail.share
      ? '已开启（拿到链接的人不用登录就能看脚本、分镜、评审次数与评审对照纸；链接不写进这份稿，只在作品页复制）'
      : '没开启'),
  )
  return out
}

export function projectDeliverable(detail, { review = null, now = new Date(), tzOffsetMinutes = 480 } = {}) {
  const tz = Number.isFinite(Number(tzOffsetMinutes)) ? Math.max(-720, Math.min(840, Math.round(Number(tzOffsetMinutes)))) : 480
  const project = detail?.project || {}
  const ctx = { tz, now }
  const script = detail?.script || null
  const lines = [
    ...header(detail || {}, ctx),
    ...timingSection(script),
    ...scriptSection(script, detail || {}),
    ...storyboardSection(detail || {}),
    ...reviewSection(detail || {}, review, tz),
    ...versionSection(detail || {}, tz),
    ...runSection(detail || {}, tz),
    ...deliverySection(detail || {}, tz),
    '',
    '---',
    '',
    '由 VisionQA 导出 · ' + (script?.structure?.length || 0) + ' 段脚本 / ' + (detail?.template?.shots || 0) + ' 个镜头' +
      (project.flowId ? ' · 画布 ' + (detail?.flow?.nodes || 0) + ' 个节点' : ''),
  ]
  // 空段落不占位；连续空行压成一行，免得某些 Markdown 渲染器把空行堆成空白页
  const markdown = lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n').trim() + '\n'
  return { fileName: deliverableFileName(project, now, tz), markdown }
}

export function deliverableFileName(project, now = new Date(), tzOffsetMinutes = 480) {
  const safe = String(project?.title || '未命名作品')
    .replace(/[\\/:*?"<>|]/g, '-')
    // 控制字符用 Unicode 类别清（\p{Cc}），不把裸控制字符写进正则（静态检查会判它可疑）
    .replace(/[\p{Cc}]/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
  return 'VisionQA-' + (safe || '未命名作品') + '-' + day(now.toISOString(), tzOffsetMinutes).replace(/-/g, '') + '.md'
}
