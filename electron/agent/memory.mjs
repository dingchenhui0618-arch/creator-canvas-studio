// 跨会话长期记忆：一个工作区一份，写在应用自己的数据目录里（不进工作区，也不混在会话文件里）。
// 会话内的压缩解决「这一轮说了什么」，这里解决「上次说定的、以后还用得上的事」。
// 两个入口：智能体自己调 remember 工具记一条；用户直接发「记住：…」不调模型也能记。
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeFileAtomic } from './atomic.mjs'
import { distillRun, DISTILL_LIMITS } from './distill.mjs'

// 这些数是本地工作区真正在用的默认值，界面显示的也是它们，不另写一份文案。
export const MEMORY_LIMITS = {
  maxEntries: 40,
  maxEntryChars: 300,
  injectEntries: 8,
  injectChars: 1600,
}

// 同义说法：用户问「上线」时，记着「发布」的也能召回。人工维护，宁缺毋滥。
// 只在召回打分时用，不改原文，也不影响判重。
const ALIAS_GROUPS = [
  ['发布', '发版', '上线', '部署', 'deploy', 'release'],
  ['测试', '自测', '单测', 'test', 'npm test'],
  ['打包', '构建', '编译', 'build'],
  ['记忆', '记住', 'remember'],
  ['工作区', '目录', '文件夹', 'workspace'],
  ['会话', '对话', '聊天', 'thread'],
  ['成片', '视频', '片子', '短视频'],
  ['模板', '模版'],
  ['评审', '审核', '打分', 'review'],
  ['时长', '秒数', '几秒'],
  ['图标', 'logo', 'icon'],
  ['安装包', '安装程序', 'setup', 'installer'],
  ['日志', 'log'],
]

const ALIAS_TOKENS = new Map()
for (let index = 0; index < ALIAS_GROUPS.length; index += 1) {
  for (const word of ALIAS_GROUPS[index]) {
    for (const token of memoryTokens(word)) {
      if (!ALIAS_TOKENS.has(token)) ALIAS_TOKENS.set(token, 'g:' + index)
    }
  }
}

/** 两条记忆的字面相似度：较短那条有一大半的词出现在另一条里，就当说的是同一件事。 */
export function similarity(left, right) {
  const a = memoryTokens(left)
  const b = memoryTokens(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** 把词扩展成「原词 + 它所属的同义组」；同一个意思的几种写法因此能碰头。 */
function expandTokens(tokens) {
  const expanded = new Set(tokens)
  for (const token of tokens) {
    const group = ALIAS_TOKENS.get(token)
    if (group) expanded.add(group)
  }
  return expanded
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
  return normalizeMemoryText(text).toLowerCase().replace(/[\s,.;:!?，。；：！？、'"“”‘’()（）\]【】]/g, '')
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
    if (!data.lastDistill || typeof data.lastDistill !== 'object') data.lastDistill = null
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
   * 召回：先按「词语重合」找出相关条目，再按稀有权重排序——
   * 常见词（工作区、文件）不算什么，罕见词与同义组（上线↔发布）才是真信号。
   * 一条都没碰上的记忆不进上下文；同样分数时优先最近用过的。
   * 条数与总字数都有上限；被召回的记一次使用（界面上的「召回 N 次」）。
   */
  async recall(workspace, { query = '', limit = MEMORY_LIMITS.injectEntries, chars = MEMORY_LIMITS.injectChars } = {}) {
    const data = await this.read(workspace)
    if (!data.entries.length) return []
    const queryTokens = expandTokens(memoryTokens(query))
    if (queryTokens.size === 0) return []

    const docs = data.entries.map((entry) => ({ entry, tokens: expandTokens(memoryTokens(entry.text)) }))
    const documentFrequency = new Map()
    for (const doc of docs) {
      for (const token of doc.tokens) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)
    }
    const total = docs.length
    const weight = (token) => Math.log((total + 1) / ((documentFrequency.get(token) || 0) + 0.5)) + 1

    const scored = []
    for (const doc of docs) {
      let score = 0
      let matched = 0
      for (const token of doc.tokens) {
        if (!queryTokens.has(token)) continue
        matched += 1
        score += weight(token)
      }
      if (!matched) continue
      scored.push({ entry: doc.entry, score, matched })
    }
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

  /**
   * 后台提炼：从最近这一轮用户说过的话里挑长期约定，自动记下（source=distill）。
   * 不调模型、不扣积分；和已有记忆重复的算跳过，并把「看过几句 / 记下几条」留给界面显示。
   */
  async distill(workspace, messages, { limit = DISTILL_LIMITS.maxCandidates } = {}) {
    const { candidates, scanned } = distillRun(messages, { limit })
    const data = await this.read(workspace)
    const known = new Set(data.entries.map((entry) => memoryFingerprint(entry.text)))
    let added = 0
    let skipped = 0
    for (const candidate of candidates) {
      const digest = memoryFingerprint(candidate.text)
      // 判重看两层：完全一样算重复；换了说法但意思大半重合，也算重复——
      // 智能体先记了一条、后台又提炼同一件事时，不该出现两条几乎一样的记忆。
      const near = data.entries.some((entry) => similarity(candidate.text, entry.text) >= 0.6)
      if (known.has(digest) || near) {
        skipped += 1
        continue
      }
      const outcome = await this.add(workspace, { text: candidate.text, source: 'distill' })
      if (outcome.ok) {
        added += 1
        known.add(digest)
      } else {
        skipped += 1
      }
    }
    data.lastDistill = { at: new Date().toISOString(), scanned, added, skipped }
    await this.write(workspace)
    return { scanned, added, skipped }
  }

  /** 上一次后台提炼看得怎么样，给记忆面板显示，不藏。 */
  async stats(workspace) {
    const data = await this.read(workspace)
    return data.lastDistill || null
  }
}