// 版本之间「改了什么」：画布按节点 id 比配置，脚本按段名比口播。
//
// 这段逻辑原本只活在交付稿里（project-deliverable.mjs），作品页要用同一套口径，
// 所以抽出来。两个用途必须给出同一句话：导出的稿子和页面上的版本行不能各说各话。
//
// 边界：
//  - 节点只比 type + data.config；位置、标题、选中态不算改动（复制版本后拖一下不是新版本）。
//  - 脚本以开新版时存的快照为准；没有快照的一侧返回空串，不拿现在的脚本冒充当时。
//  - 画布被删掉的一侧没有节点可读，也不猜。

export const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

// 节点指纹：复制版本时节点 id 沿用，靠 id 认「同一个节点改没改」
export function fingerprint(nodes) {
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

/**
 * 两份节点指纹比出「多了 / 少了 / 改了」，带节点 id 与标题。
 * 任意两版对照要逐项列出节点，所以保留 id；版本行的一句话再从这里的标题生成（v0.9.117）。
 * 缺一侧（画布被删）就返回 null，不猜「没改」。
 */
export function canvasDetail(prev, next) {
  if (!prev || !next) return null
  const before = new Map(prev.map((node) => [node.id, node]))
  const after = new Map(next.map((node) => [node.id, node]))
  const added = []
  const removed = []
  const changed = []
  for (const [id, node] of after) {
    const old = before.get(id)
    if (!old) added.push({ id, title: node.title })
    else if (old.hash !== node.hash) changed.push({ id, title: node.title })
  }
  for (const [id, node] of before) if (!after.has(id)) removed.push({ id, title: node.title })
  return { added, removed, changed }
}

/** 老口径：只要标题，版本行与交付稿的一句话都读它。 */
export function canvasDelta(prev, next) {
  const detail = canvasDetail(prev, next)
  if (!detail) return null
  return {
    added: detail.added.map((node) => node.title),
    removed: detail.removed.map((node) => node.title),
    changed: detail.changed.map((node) => node.title),
  }
}

export function canvasText(delta) {
  if (!delta) return ''
  const bits = []
  if (delta.added.length) bits.push('多 ' + delta.added.length + ' 个（' + names(delta.added) + '）')
  if (delta.removed.length) bits.push('少 ' + delta.removed.length + ' 个（' + names(delta.removed) + '）')
  if (delta.changed.length) bits.push('改 ' + delta.changed.length + ' 个（' + names(delta.changed) + '）')
  return bits.length ? bits.join('、') : '节点没动'
}

const groupBeats = (script) => {
  const map = new Map()
  for (const beat of script.structure) {
    const name = flat(beat?.beat) || '未命名段落'
    if (!map.has(name)) map.set(name, [])
    map.get(name).push(flat(beat?.voiceover))
  }
  return map
}

/**
 * 脚本明细（v0.9.117）：多 / 少 / 改的段各是哪几段，改过的段带上前后口播。
 * 与 scriptText 同一个口径：按段名对、重名段落按出现顺序比词、钩子单独说。
 * 一侧没有分段就不比，返回 null，不硬写「没改」。
 */
export function scriptDetail(prev, next) {
  if (!prev?.structure?.length || !next?.structure?.length) return null
  const before = groupBeats(prev)
  const after = groupBeats(next)
  const added = [...after.keys()].filter((name) => !before.has(name))
  const removed = [...before.keys()].filter((name) => !after.has(name))
  const changed = []
  for (const [name, lines] of after) {
    const old = before.get(name)
    if (!old) continue
    if (old.length !== lines.length || old.some((line, index) => line !== lines[index])) {
      changed.push({ name, before: old, after: lines })
    }
  }
  return {
    added,
    removed,
    changed,
    hookChanged: flat(prev.hook) !== flat(next.hook),
    hookBefore: flat(prev.hook),
    hookAfter: flat(next.hook),
  }
}

// 脚本按段名对：改名不算改口播，重名段落按出现顺序比词
export function scriptText(prev, next) {
  const detail = scriptDetail(prev, next)
  if (!detail) return ''
  const bits = []
  if (detail.added.length) bits.push('多 ' + detail.added.length + ' 段（' + names(detail.added) + '）')
  if (detail.removed.length) bits.push('少 ' + detail.removed.length + ' 段（' + names(detail.removed) + '）')
  if (detail.changed.length) bits.push(detail.changed.length + ' 段口播改过')
  if (!bits.length && !detail.hookChanged) return '跟上一版一样'
  bits.push(detail.hookChanged ? '钩子换过' : '钩子没变')
  return bits.join('、')
}

/**
 * 作品页版本行的一句话：比上一版改了什么。
 * 两侧都能比时，画布与脚本一起说；只有一侧可比就只说那一侧；都没动时收成一句。
 * 返回空串表示「没有可比对的一侧」，页面不硬写「没改」。
 */
export function versionChangeText({ prevNodes, nextNodes, prevScript, nextScript }) {
  const canvas = canvasDelta(fingerprint(prevNodes), fingerprint(nextNodes))
  const canvasLine = canvas ? canvasText(canvas) : ''
  const scriptLine = prevScript && nextScript ? scriptText(prevScript, nextScript) : ''
  const sameCanvas = canvas && !canvas.added.length && !canvas.removed.length && !canvas.changed.length
  const sameScript = scriptLine === '跟上一版一样'
  if (sameCanvas && sameScript) return '画布与脚本都没动'
  const bits = []
  if (canvasLine) bits.push('画布' + canvasLine)
  // 「脚本1 段口播改过」读不通：以数字开头时补一个冒号，与「脚本多 1 段」区分
  if (scriptLine) bits.push('脚本' + (/^\d/.test(scriptLine) ? '：' : '') + scriptLine)
  return bits.join('；')
}

/**
 * 整条作品的版本变更表：行按版次排，给每个「有上一版」的版本算一句。
 * 输入缺节点或脚本时，缺的那一侧自动跳过；返回 { '2': '…', '3': '…' }。
 */
export function versionChangesOf(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && Number.isFinite(Number(row.n)))
  const byNumber = new Map(list.map((row) => [Number(row.n), row]))
  const out = {}
  for (const row of list) {
    const n = Number(row.n)
    const prev = byNumber.get(n - 1)
    if (!prev) continue
    const text = versionChangeText({
      prevNodes: prev.nodes,
      nextNodes: row.nodes,
      prevScript: prev.script,
      nextScript: row.script,
    })
    if (text) out[String(n)] = text
  }
  return out
}

/**
 * 以旧版为底开的那一版：改动按底座算，不按上一版算（v0.9.116）。
 * 只返回底座不是上一版的版本——底座就是上一版时，原来的「比上一版」已经说对了。
 * 返回 { '5': { base: 2, text: '画布与脚本都没动' } }；底座那一版被删或已不在表里就不返回。
 */
export function versionBaseChangesOf(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && Number.isFinite(Number(row.n)))
  const byNumber = new Map(list.map((row) => [Number(row.n), row]))
  const out = {}
  for (const row of list) {
    const n = Number(row.n)
    const base = Number(row.base)
    if (!Number.isInteger(base) || base < 1 || base >= n || base === n - 1) continue
    const prev = byNumber.get(base)
    if (!prev) continue
    const text = versionChangeText({
      prevNodes: prev.nodes,
      nextNodes: row.nodes,
      prevScript: prev.script,
      nextScript: row.script,
    })
    if (text) out[String(n)] = { base, text }
  }
  return out
}

const CONFIG_FIELD_LABELS = {
  type: '节点类型',
  text: '输入文本',
  model: '模型',
  temperature: '温度',
  systemPrompt: '提示词',
  keyword: '关键词',
  contentType: '内容类型',
  limit: '条数',
  toolName: '工具',
  expression: '条件',
  format: '输出格式',
  profile: '评审档位',
  image: '评审图片',
}

const NODE_TYPE_LABELS = {
  input: '输入',
  llm: '大模型',
  kb: '知识库',
  tool: '工具',
  condition: '条件',
  output: '输出',
  review: '评审',
}

const EMPTY_FIELD_TEXT = { model: '跟随当前模型', contentType: '不限' }

/** 一个配置项的值变成人能读的一行；空模型写「跟随当前模型」，不写成空白让人猜。 */
function fieldText(value, key) {
  if (value === undefined || value === null || value === '') return EMPTY_FIELD_TEXT[key] || '（空）'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'string') return flat(value) || '（空）'
  try {
    return flat(JSON.stringify(value)) || '（空）'
  } catch {
    return String(value)
  }
}

function clipMiddle(text, max = 180) {
  const value = String(text || '')
  if (value.length <= max) return value
  const head = Math.floor(max * 0.55)
  return value.slice(0, head) + '…' + value.slice(-(max - head - 1))
}

/**
 * 很长的提示词只截「改动的附近」，不把 4000 字整段塞进弹窗。
 * 先找共同前后缀，再各留一段上下文；改动本身也太长时从中间省略。
 */
function fieldExcerpt(before, after) {
  const a = String(before || '')
  const b = String(after || '')
  if (a.length <= 260 && b.length <= 260) return { before: a || '（空）', after: b || '（空）', truncated: false }
  let prefix = 0
  const maxPrefix = Math.min(a.length, b.length)
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  const maxSuffix = Math.min(a.length - prefix, b.length - prefix)
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const context = 42
  const start = Math.max(0, prefix - context)
  const aTail = Math.min(a.length, a.length - suffix + context)
  const bTail = Math.min(b.length, b.length - suffix + context)
  const aChanged = clipMiddle(a.slice(prefix, Math.max(prefix, a.length - suffix)), 150)
  const bChanged = clipMiddle(b.slice(prefix, Math.max(prefix, b.length - suffix)), 150)
  const aText = (start > 0 ? '…' : '') + a.slice(start, prefix) + aChanged + a.slice(a.length - suffix, aTail) + (aTail < a.length ? '…' : '')
  const bText = (start > 0 ? '…' : '') + b.slice(start, prefix) + bChanged + b.slice(b.length - suffix, bTail) + (bTail < b.length ? '…' : '')
  return {
    before: aText || '（空）',
    after: bText || '（空）',
    truncated: aText !== a || bText !== b,
  }
}

/**
 * 一个节点改在哪几项参数上：类型与 config 的每个键都比。
 * 只返回改过的项；位置、标题不在 config 里，天然不算。
 */
function nodeFieldChanges(beforeNode, afterNode) {
  const changes = []
  const beforeType = String(beforeNode?.type || '')
  const afterType = String(afterNode?.type || '')
  if (beforeType !== afterType) {
    changes.push({
      key: 'type',
      label: CONFIG_FIELD_LABELS.type,
      before: NODE_TYPE_LABELS[beforeType] || beforeType || '（空）',
      after: NODE_TYPE_LABELS[afterType] || afterType || '（空）',
      truncated: false,
    })
  }
  const beforeConfig = beforeNode?.data?.config && typeof beforeNode.data.config === 'object' ? beforeNode.data.config : {}
  const afterConfig = afterNode?.data?.config && typeof afterNode.data.config === 'object' ? afterNode.data.config : {}
  const keys = [...new Set([...Object.keys(afterConfig), ...Object.keys(beforeConfig)])]
  for (const key of keys) {
    const before = fieldText(beforeConfig[key], key)
    const after = fieldText(afterConfig[key], key)
    if (before === after) continue
    changes.push({
      key,
      label: CONFIG_FIELD_LABELS[key] || key,
      ...fieldExcerpt(before, after),
    })
  }
  if (!changes.length && JSON.stringify(beforeConfig) !== JSON.stringify(afterConfig)) {
    const excerpt = fieldExcerpt(fieldText(beforeConfig, 'config'), fieldText(afterConfig, 'config'))
    changes.push({ key: 'config', label: '节点配置', ...excerpt })
  }
  return changes
}

/**
 * 改过的节点差在哪几项参数（v0.9.118）：按节点 id 给一份明细。
 * 只给改过的节点；多 / 少节点没有「前后参数」可比，不硬凑。
 */
export function canvasFieldDetail(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return {}
  const before = new Map(prev.map((node) => [String(node?.id || ''), node]))
  const after = new Map(next.map((node) => [String(node?.id || ''), node]))
  const fields = {}
  for (const [id, node] of after) {
    const old = before.get(id)
    if (!old) continue
    const changes = nodeFieldChanges(old, node)
    if (changes.length) fields[id] = changes
  }
  return fields
}

/**
 * 任意两版对照（v0.9.117）：给版本行的一句话，加上可逐项列出的画布与脚本明细。
 * 只读、不写任何东西；方向按 base → target，反过来选就是看「改回去了什么」。
 * 返回的 canvas / script 在一侧读不到时为 null，调用方照 notes 说清哪一侧不比。
 */
export function versionCompareOf({ baseNodes, targetNodes, baseScript, targetScript }) {
  const canvas = canvasDetail(fingerprint(baseNodes), fingerprint(targetNodes))
  // 改过的节点再差到具体参数：没有改动就不带 fields，老调用方读到的结构不变（v0.9.118）
  if (canvas) {
    const fields = canvasFieldDetail(baseNodes, targetNodes)
    if (Object.keys(fields).length) canvas.fields = fields
  }
  return {
    summary: versionChangeText({
      prevNodes: baseNodes,
      nextNodes: targetNodes,
      prevScript: baseScript,
      nextScript: targetScript,
    }),
    canvas,
    script: scriptDetail(baseScript, targetScript),
  }
}
