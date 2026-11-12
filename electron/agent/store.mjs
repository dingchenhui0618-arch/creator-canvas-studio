// 本地会话存储：一个会话一个 JSON，写在应用自己的数据目录里（跟着账号目录走，不进工作区）。
// 写入用临时文件 + rename：断电或强杀时不会留下半个 JSON。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.mjs'

const ID_PATTERN = /^[a-z0-9_-]{6,64}$/i

export class ThreadStore {
  constructor(root) {
    this.root = root
    this.dir = path.join(root, 'threads')
  }

  async ready() {
    await fsp.mkdir(this.dir, { recursive: true })
    return this
  }

  file(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw new Error('会话 id 不合法')
    return path.join(this.dir, id + '.json')
  }

  async list() {
    await this.ready()
    const names = await fsp.readdir(this.dir)
    const items = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await fsp.readFile(path.join(this.dir, name), 'utf8')
        const thread = JSON.parse(raw)
        items.push({
          id: thread.id,
          title: thread.title || '未命名会话',
          updatedAt: thread.updatedAt || thread.createdAt || '',
          turns: thread.turns || 0,
          messages: Array.isArray(thread.messages) ? thread.messages.length : 0,
          compactions: thread.compactions || 0,
        })
      } catch {
        // 单个坏文件不影响列表：跳过，用户下次能重新开始
      }
    }
    return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  async get(id) {
    await this.ready()
    const raw = await fsp.readFile(this.file(id), 'utf8')
    const thread = JSON.parse(raw)
    if (!Array.isArray(thread.messages)) thread.messages = []
    return thread
  }

  async create(title = '新的本地会话') {
    await this.ready()
    const now = new Date().toISOString()
    const thread = {
      id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title,
      summary: '',
      messages: [],
      turns: 0,
      compactions: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.save(thread)
    return thread
  }

  async save(thread) {
    await this.ready()
    const now = new Date().toISOString()
    thread.updatedAt = now
    await writeFileAtomic(this.file(thread.id), JSON.stringify(thread, null, 2))
    return thread
  }

  async remove(id) {
    await this.ready()
    try { await fsp.unlink(this.file(id)) ; return true } catch { return false }
  }
}