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

/** 两份节点指纹比出「多了 / 少了 / 改了」；缺一侧（画布被删）就返回 null。 */
export function canvasDelta(prev, next) {
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

export function canvasText(delta) {
  if (!delta) return ''
  const bits = []
  if (delta.added.length) bits.push('多 ' + delta.added.length + ' 个（' + names(delta.added) + '）')
  if (delta.removed.length) bits.push('少 ' + delta.removed.length + ' 个（' + names(delta.removed) + '）')
  if (delta.changed.length) bits.push('改 ' + delta.changed.length + ' 个（' + names(delta.changed) + '）')
  return bits.length ? bits.join('、') : '节点没动'
}

// 脚本按段名对：改名不算改口播，重名段落按出现顺序比词
export function scriptText(prev, next) {
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
