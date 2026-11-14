import { createHash } from 'node:crypto'
import { spentOfRun } from './flows.mjs'

// 运行对照（v0.9.110）：把同一条画布的两条运行摆在一起，只读、不重跑、不扣费。
// 页面要回答的是「这次和上次比，哪里变了、慢在哪、多花了多少」，所以这里只给
// 逐节点的状态 / 耗时 / 输出指纹与短预览——完整输出仍在单条运行详情里，不重复搬一遍。

const PREVIEW_MAX = 180
const ERROR_MAX = 260

function clip(value, max) {
  return String(value ?? '').slice(0, max)
}

/** 稳定的 JSON：只用来算输出指纹，键顺序不同不算改动。 */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
}

function outputDigest(output) {
  if (output === null || output === undefined) return ''
  return createHash('sha256').update(stableJson(output)).digest('hex').slice(0, 16)
}

/** 首段只用来辨认「这次写的和上次不一样」，不是用来做逐字对照的。 */
function previewOf(output) {
  if (output === null || output === undefined) return ''
  const raw = typeof output === 'object' && typeof output.text === 'string' ? output.text : stableJson(output)
  const oneLine = String(raw).replace(/\s+/g, ' ').trim()
  return oneLine.length > PREVIEW_MAX ? oneLine.slice(0, PREVIEW_MAX) + '…' : oneLine
}

// 输出差异（v0.9.112）：知道「输出变了」还不够，人要看是哪几行变了。
// 对照本身仍不搬完整输出：差异只在被点名的那一个节点上现算，返回的是改动附近的短行，
// 两端各最多 2.4 万字符、每行最多 160 字符、差异最多 260 行；超了就如实写「只比了前面」。
const DIFF_TEXT_MAX = 24000
const DIFF_LINE_MAX = 160
const DIFF_LINES_MAX = 1200
const DIFF_OUT_MAX = 260
const DIFF_CONTEXT = 3

/** 对象输出按排好序的 JSON 展开，字段改名/改值能落在具体行上，不受键顺序影响。 */
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortedJson(value[key])
    return out
  }
  return value
}

function outputBody(output) {
  if (output === null || output === undefined) return { text: '', kind: 'empty' }
  if (typeof output === 'string') return { text: output, kind: 'text' }
  if (typeof output === 'object' && typeof output.text === 'string') return { text: output.text, kind: 'text' }
  return { text: JSON.stringify(sortedJson(output), null, 2) ?? '', kind: 'json' }
}

function displayLines(text) {
  let clipped = false
  let source = String(text ?? '')
  if (source.length > DIFF_TEXT_MAX) {
    source = source.slice(0, DIFF_TEXT_MAX)
    clipped = true
  }
  source = source.replace(/\r\n?/g, '\n')
  const lines = []
  for (const raw of source.split('\n')) {
    if (!raw) {
      lines.push('')
      continue
    }
    // 长段落按 160 字折开：单行几千字时，逐行比较仍能看见改动落在哪一段。
    const chars = Array.from(raw)
    for (let index = 0; index < chars.length; index += DIFF_LINE_MAX) {
      lines.push(chars.slice(index, index + DIFF_LINE_MAX).join(''))
    }
  }
  if (lines.length > DIFF_LINES_MAX) {
    lines.length = DIFF_LINES_MAX
    clipped = true
  }
  return { lines, clipped }
}

/** 行级 LCS。两边都已被 displayLines 收在 1200 行内，DP 最多约 1.4M 格。 */
function diffLines(before, after) {
  const n = before.length
  const m = after.length
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const at = i * width + j
      dp[at] = before[i] === after[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  let oldNo = 1
  let newNo = 1
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ op: 'same', text: before[i], oldNo, newNo })
      i += 1
      j += 1
      oldNo += 1
      newNo += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ op: 'del', text: before[i], oldNo })
      i += 1
      oldNo += 1
    } else {
      ops.push({ op: 'add', text: after[j], newNo })
      j += 1
      newNo += 1
    }
  }
  while (i < n) {
    ops.push({ op: 'del', text: before[i], oldNo })
    i += 1
    oldNo += 1
  }
  while (j < m) {
    ops.push({ op: 'add', text: after[j], newNo })
    j += 1
    newNo += 1
  }
  return ops
}

/** 只留改动前后 3 行；两段改动离得近就并成一段，离得远写「N 行未变」。 */
function hunkLines(ops) {
  const changes = []
  ops.forEach((item, index) => { if (item.op !== 'same') changes.push(index) })
  if (!changes.length) return { lines: [], truncated: false }
  const ranges = []
  for (const index of changes) {
    const start = Math.max(0, index - DIFF_CONTEXT)
    const end = Math.min(ops.length, index + DIFF_CONTEXT + 1)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else ranges.push({ start, end })
  }
  const lines = []
  let truncated = false
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) {
      if (lines.length >= DIFF_OUT_MAX) { truncated = true; break }
      lines.push({ op: 'skip', count: range.start - cursor })
    }
    for (let index = range.start; index < range.end; index += 1) {
      if (lines.length >= DIFF_OUT_MAX) { truncated = true; break }
      lines.push(ops[index])
    }
    if (truncated) break
    cursor = range.end
  }
  if (!truncated && cursor < ops.length) {
    if (lines.length >= DIFF_OUT_MAX) truncated = true
    else lines.push({ op: 'skip', count: ops.length - cursor })
  }
  return { lines, truncated }
}

/**
 * 一个节点的输出差异。节点在两条运行里都不存在时返回 null；
 * 新增 / 移除的节点也能算（另一侧按空输出），页面目前只对「输出变了」的节点给入口。
 */
export function buildRunOutputDiff(current, previous, nodeId) {
  const id = String(nodeId || '')
  const currentNodes = Array.isArray(current?.nodes) ? current.nodes : []
  const previousNodes = Array.isArray(previous?.nodes) ? previous.nodes : []
  const now = currentNodes.find((node) => String(node?.id || '') === id) || null
  const before = previousNodes.find((node) => String(node?.id || '') === id) || null
  if (!now && !before) return null

  const nowBody = outputBody(now?.output)
  const beforeBody = outputBody(before?.output)
  const nowLines = displayLines(nowBody.text)
  const beforeLines = displayLines(beforeBody.text)
  const ops = diffLines(beforeLines.lines, nowLines.lines)
  const added = ops.filter((item) => item.op === 'add').length
  const removed = ops.filter((item) => item.op === 'del').length
  const hunk = hunkLines(ops)

  return {
    nodeId: id,
    title: String(now?.title || before?.title || ''),
    kind: String(now?.kind || before?.kind || ''),
    // text / json / empty；两边类型不同就是 mixed（例如之前是字符串，现在成了对象）
    outputKind: nowBody.kind === beforeBody.kind ? nowBody.kind : 'mixed',
    stats: {
      same: ops.length - added - removed,
      added,
      removed,
    },
    lines: hunk.lines,
    // 内容被截断与「差异行数超过上限」分开不写死：只要有一项发生，页面都提示「只比了一部分」
    truncated: hunk.truncated || nowLines.clipped || beforeLines.clipped,
  }
}

function nodeResultView(result) {
  if (!result) return null
  return {
    status: String(result.status || ''),
    ms: Number(result.ms) || 0,
    error: result.error ? clip(result.error, ERROR_MAX) : '',
    preview: previewOf(result.output),
  }
}

/** 一条运行在对照里的那一侧：摘要数字都从记录本身取，不重新算账。 */
export function compareSideOf(run) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : []
  const done = nodes.filter((node) => node.status === 'success' || node.status === 'unsupported').length
  return {
    id: String(run?.id || ''),
    status: String(run?.status || ''),
    canceled: Boolean(run?.canceled),
    startedAt: run?.startedAt || '',
    finishedAt: run?.finishedAt || '',
    durationMs: Number(run?.durationMs) || 0,
    queuedMs: Number(run?.queuedMs) || 0,
    total: Number(run?.total) || 0,
    finished: run?.finishedNodes != null && Number.isFinite(Number(run.finishedNodes)) ? Number(run.finishedNodes) : done,
    failed: nodes.filter((node) => node.status === 'error').length,
    // 失败 / 重启的积分已经退回：对照里写「实际花掉」的，不把退回来的又算一遍
    cost: spentOfRun(run),
    refunded: Boolean(run?.credits?.refunded),
  }
}

/**
 * 逐节点对照两条运行。
 * 上一版画布与这一版可能节点不同：以这次运行为主序列，上次多出来的节点排在后面并标成「这次没有」。
 * 相同 id 的节点如果内容或上游改过，即使输出碰巧一样也不算「一致」——指纹说的是「跑的是不是同一件事」。
 */
export function buildRunCompare(current, previous) {
  const currentNodeList = Array.isArray(current?.nodes) ? current.nodes : []
  const previousNodeList = Array.isArray(previous?.nodes) ? previous.nodes : []
  const currentMap = new Map(currentNodeList.map((node) => [node.id, node]))
  const previousMap = new Map(previousNodeList.map((node) => [node.id, node]))
  const currentRevisions = current?.nodeRevisions && typeof current.nodeRevisions === 'object' ? current.nodeRevisions : {}
  const previousRevisions = previous?.nodeRevisions && typeof previous.nodeRevisions === 'object' ? previous.nodeRevisions : {}

  const order = []
  const seen = new Set()
  for (const node of [...currentNodeList, ...previousNodeList]) {
    const id = String(node?.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  const counts = { added: 0, removed: 0, statusChanged: 0, outputChanged: 0, revisionChanged: 0, unchanged: 0 }
  const nodes = order.map((id) => {
    const now = currentMap.get(id) || null
    const before = previousMap.get(id) || null
    const added = Boolean(now) && !before
    const removed = Boolean(before) && !now
    const statusChanged = Boolean(now && before && now.status !== before.status)
    const outputChanged = Boolean(now && before && outputDigest(now.output) !== outputDigest(before.output))
    const revisionChanged = Boolean(
      currentRevisions[id] && previousRevisions[id] && currentRevisions[id] !== previousRevisions[id],
    )
    if (added) counts.added += 1
    if (removed) counts.removed += 1
    if (statusChanged) counts.statusChanged += 1
    if (outputChanged) counts.outputChanged += 1
    if (revisionChanged) counts.revisionChanged += 1
    const changed = added || removed || statusChanged || outputChanged || revisionChanged
    if (!changed) counts.unchanged += 1
    return {
      id,
      kind: String(now?.kind || before?.kind || ''),
      title: String(now?.title || before?.title || ''),
      current: nodeResultView(now),
      previous: nodeResultView(before),
      added,
      removed,
      statusChanged,
      outputChanged,
      revisionChanged,
      // 只对这一侧都在的节点给差值；新增 / 移除没有「快了多少」可言
      msDelta: now && before ? (Number(now.ms) || 0) - (Number(before.ms) || 0) : null,
    }
  })

  const graphChanged = Boolean(
    current?.flowRevision && previous?.flowRevision && current.flowRevision !== previous.flowRevision,
  )
  const graphUnknown = Boolean(!current?.flowRevision || !previous?.flowRevision)

  return {
    comparable: true,
    flowId: String(current?.flowId || ''),
    flowName: String(current?.flowName || ''),
    current: compareSideOf(current),
    previous: compareSideOf(previous),
    graph: {
      changed: graphChanged,
      unknown: graphUnknown,
      currentRevision: String(current?.flowRevision || ''),
      previousRevision: String(previous?.flowRevision || ''),
    },
    nodes,
    totals: {
      ...counts,
      changed: nodes.filter((node) => node.added || node.removed || node.statusChanged || node.outputChanged || node.revisionChanged).length,
      durationDelta: (Number(current?.durationMs) || 0) - (Number(previous?.durationMs) || 0),
      costDelta: compareSideOf(current).cost - compareSideOf(previous).cost,
      failedDelta: compareSideOf(current).failed - compareSideOf(previous).failed,
    },
  }
}
