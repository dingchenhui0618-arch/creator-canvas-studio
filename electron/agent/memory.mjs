// 跨会话长期记忆：一个工作区一份，写在应用自己的数据目录里（不进工作区，也不混在会话文件里）。
// 会话内的压缩解决「这一轮说了什么」，这里解决「上次说定的、以后还用得上的事」。
// 两个入口：智能体自己调 remember 工具记一条；用户直接发「记住：…」不调模型也能记。
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeFileAtomic } from './atomic.mjs'

// 这些数是本地工作区真正在用的默认值，界面显示的也是它们，不另写一份文案。
export const MEMORY_LIMITS = {
  maxEntries: 40,
  maxEntryChars: 300,
  injectEntries: 8,
  injectChars: 1600,
}

// 工作区路径 → 文件名：同一个目录无论怎么写大小写 / 斜杠，都落到同一份记忆。
export function memoryKey(workspace) {
  const normalized = path.resolve(String(workspace || '.')).replace(/\\/g, '/').toLowerCase()
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)
}

export function normalizeMemoryText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

// 判重只看「说的是不是同一件事」：去掉空白与标点再比，避免同一条记两次。
export function memoryFingerprint(text) {
  return normalizeMemoryText(text).toLowerCase().replace(/[\s,.;:!?，。；：！？、'"“”‘’()（）\[\]【】]/g, '')
}

/** 粗分词：英文按词、中文按二元组。只用于召回排序，不追求语言学分词。 */
export function memoryTokens(text) {
  const value = String(text || '').toLowerCase()
  const tokens = new Set()
  for (const word of value.match(/[a-z0-9_@.-]{2,32}/g) || []) tokens.add(word)
  const cjk = value.replace(/[^\u3400-\u9fff]/g, '')
  for (let index = 0; index + 1 < cjk.length; index += 1) tokens.add(cjk.slice(index, index + 2))
  return tokens
}

/** 记忆写进系统提示的那一段：明确说是「以前记的」，与用户当次说的话分开。 */
export function memoryBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const lines = []
  lines.push('## 这个工作区里你记得的事')
  lines.push('下面是以前在这个工作区里记下的（不是用户这次说的）。相关时可以参考；和用户现在说的冲突，以现在为准；事实不确定就重新读文件或问用户，不要凭记忆编造。')
  for (const entry of entries) lines.push('- ' + entry.text)
  return lines.join('\n')
}

export class MemoryStore {
  constructor(root) {
    this.root = root
    this.dir = path.join(root, 'memory')
    this.cache = new Map()
  }

  async ready() {
    await fsp.mkdir(this.dir, { recursive: true })
    return this
  }

  file(workspace) {
    return path.join(this.dir, memoryKey(workspace) + '.json')
  }

  async read(workspace) {
    const file = this.file(workspace)
    if (this.cache.has(file)) return this.cache.get(file)
    let data = { workspace: String(workspace || ''), entries: [] }
    try {
      data = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      // 第一次用这个工作区，或者文件坏了：从空开始，不阻断对话
    }
    if (!Array.isArray(data.entries)) data.entries = []
    data.entries = data.entries.filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
    data.workspace = String(workspace || '')
    this.cache.set(file, data)
    return data
  }

  async write(workspace) {
    const data = await this.read(workspace)
    await fsp.mkdir(this.dir, { recursive: true })
    await writeFileAtomic(this.file(workspace), JSON.stringify(data, null, 2))
    return data
  }

  async list(workspace) {
    const data = await this.read(workspace)
    return [...data.entries].sort((a, b) => String(b.usedAt || '').localeCompare(String(a.usedAt || '')))
  }

  /** 记一条。同一件事重复记只更新原文并把它顶到最近用过，不会多出一条。 */
  async add(workspace, { text, source = 'agent' } = {}) {
    const clean = normalizeMemoryText(text).slice(0, MEMORY_LIMITS.maxEntryChars)
    if (!clean) return { ok: false, output: '要记的内容是空的' }
    const data = await this.read(workspace)
    const now = new Date().toISOString()
    const fingerprint = memoryFingerprint(clean)
    const existing = data.entries.find((entry) => memoryFingerprint(entry.text) === fingerprint)
    if (existing) {
      existing.text = clean
      existing.usedAt = now
      existing.source = source || existing.source || ''
      await this.write(workspace)
      return { ok: true, action: 'updated', entry: existing, total: data.entries.length }
    }
    const entry = {
      id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: clean,
      source,
      createdAt: now,
      usedAt: now,
      uses: 0,
    }
    data.entries.push(entry)
    // 满 40 条之后淘汰「最少用到、最久没用」的那条：留着的是还在被召回的
    while (data.entries.length > MEMORY_LIMITS.maxEntries) {
      let worst = 0
      for (let index = 1; index < data.entries.length; index += 1) {
        const current = data.entries[index]
        const best = data.entries[worst]
        const currentUses = Number(current.uses) || 0
        const bestUses = Number(best.uses) || 0
        if (currentUses < bestUses) worst = index
        else if (currentUses === bestUses && String(current.usedAt || '') < String(best.usedAt || '')) worst = index
      }
      data.entries.splice(worst, 1)
    }
    await this.write(workspace)
    return { ok: true, action: 'added', entry, total: data.entries.length }
  }

  async remove(workspace, id) {
    const data = await this.read(workspace)
    const before = data.entries.length
    data.entries = data.entries.filter((entry) => entry.id !== String(id || ''))
    if (data.entries.length === before) return { ok: false, output: '没有这条记忆' }
    await this.write(workspace)
    return { ok: true, total: data.entries.length }
  }

  async clear(workspace) {
    const data = await this.read(workspace)
    const removed = data.entries.length
    data.entries = []
    await this.write(workspace)
    return { ok: true, removed }
  }

  /**
   * 召回：按当前这句话与每条记忆的词语重合度排序，重合多的先上；
   * 同样重合度时优先最近被用到的。条数与总字数都有上限，不让记忆挤占上下文。
   * 被召回的会记一次使用（界面上的「召回 N 次」就是这个数）。
   */
  async recall(workspace, { query = '', limit = MEMORY_LIMITS.injectEntries, chars = MEMORY_LIMITS.injectChars } = {}) {
    const data = await this.read(workspace)
    if (!data.entries.length) return []
    const tokens = memoryTokens(query)
    const scored = data.entries.map((entry) => {
      const entryTokens = memoryTokens(entry.text)
      let score = 0
      for (const token of entryTokens) if (tokens.has(token)) score += 1
      return { entry, score }
    })
    scored.sort((a, b) => b.score - a.score || String(b.entry.usedAt || '').localeCompare(String(a.entry.usedAt || '')))
    const picked = []
    let used = 0
    for (const item of scored) {
      if (picked.length >= limit) break
      const size = item.entry.text.length
      if (picked.length > 0 && used + size > chars) continue
      picked.push(item.entry)
      used += size
    }
    if (picked.length > 0) {
      const now = new Date().toISOString()
      for (const entry of picked) {
        entry.usedAt = now
        entry.uses = (Number(entry.uses) || 0) + 1
      }
      await this.write(workspace)
    }
    return picked
  }
}
