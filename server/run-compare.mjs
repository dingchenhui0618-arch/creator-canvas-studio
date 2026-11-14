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
