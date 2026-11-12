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

export const DELIVERABLE_LIMITS = { runs: 8, observations: 8, fixes: 6 }

const VERDICT_LABEL = { pass: '通过', needs_review: '需人工确认', fail: '不通过' }
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

/** 某一版评过找几次：版本划分之前记在 0 上的评审算进 v1，否则老作品会显示成没评过。 */
function reviewsOf(counts, version) {
  const own = counts?.[String(version)]
  const legacy = version === 1 ? counts?.['0'] : undefined
  if (!own && !legacy) return { count: 0, lastVerdict: '', lastAt: '' }
  if (!own) return legacy
  if (!legacy) return own
  const latest = String(own.lastAt) >= String(legacy.lastAt) ? own : legacy
  return { count: (own.count || 0) + (legacy.count || 0), lastVerdict: latest.lastVerdict, lastAt: latest.lastAt }
}

/** 某一版跑过几次：与评审同一套折进规则。 */
function runsOf(counts, version) {
  const own = Number(counts?.[String(version)]) || 0
  const legacy = version === 1 ? Number(counts?.['0']) || 0 : 0
  return own + legacy
}

/** 状态胶囊：与作品页同一个口径（已交付 / 待开画布 / 在做 / 已评审）。 */
function statusLabel(project, reviewCount) {
  if (project.status === 'done') return '已交付'
  if (!project.flowId) return '待开画布'
  if (!reviewCount) return '在做'
  return '已评审'
}

function header(detail, ctx) {
  const { project, template, flow, script, versionCounts } = detail
  const { tz, now } = ctx
  const currentReviews = reviewsOf(versionCounts, project.version)
  const lines = [
    '# ' + (project.title || '未命名作品'),
    '',
    '一条作品的完整稿：来源、脚本、分镜、评审结论、版本与运行。给剪辑、制片或自己归档，读这一份就够。',
    '',
    '- 作品编号：' + project.id,
    '- 状态：' + statusLabel(project, currentReviews.count) + (project.version ? '（当前第 ' + project.version + ' 版）' : ''),
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
    observations.forEach((item, index) => {
      const severity = SEVERITY_LABEL[item.severity] || '提示'
      const confidence = typeof item.confidence === 'number' ? '（依据强度 ' + Math.round(item.confidence * 100) + '%）' : ''
      out.push((index + 1) + '. **' + severity + ' · ' + (item.dimension || '整体') + '**：' + (item.statement || '') + confidence)
    })
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

function versionSection(detail, tz) {
  const { project } = detail
  const out = ['', '## 版本对照', '']
  if (!project.version) {
    out.push('还没开画布，所以只有脚本这一版。')
    return out
  }
  out.push('| 版本 | 画布 | 节点 | 评审 | 运行 | 最近结论 | 归档 |', '| --- | --- | --- | --- | --- | --- | --- |')
  const rows = [
    ...(detail.versions || []).map((entry) => ({ n: entry.n, name: entry.name, nodes: entry.nodes, archivedAt: entry.archivedAt, current: false })),
    { n: project.version, name: detail.flow?.name || '当前版', nodes: detail.flow?.nodes || 0, archivedAt: '', current: true },
  ]
  for (const row of rows) {
    const counter = reviewsOf(detail.versionCounts, row.n)
    const runs = runsOf(detail.runCounts, row.n)
    out.push(
      '| v' + row.n + (row.current ? '（当前）' : '') + ' | ' + cell(row.name) + ' | ' + row.nodes + ' | ' +
        (counter.count ? counter.count + ' 次' : '未评') + ' | ' + (runs ? runs + ' 次' : '没跑过') + ' | ' +
        (VERDICT_LABEL[counter.lastVerdict] || '—') + ' | ' + (row.current ? '—' : stamp(row.archivedAt, tz)) + ' |',
    )
  }
  if ((detail.versions || []).length) {
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

function deliverySection(detail) {
  const { project } = detail
  const out = ['', '## 交付', '']
  out.push('- 标记交付：' + (project.status === 'done' ? '已标记' : '还没标记'))
  out.push(
    '- 只读分享：' + (detail.share ? '已开启（链接不写进这份稿：它会让人不用登录就能看，只在作品页复制）' : '没开启'),
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
    ...deliverySection(detail || {}),
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
