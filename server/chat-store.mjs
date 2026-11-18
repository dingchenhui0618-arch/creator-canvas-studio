// 快捷创作对话的会话存储（r214）：一个账号一个目录，一条会话一个文件。
//
// 为什么不用现成的「对话预设」历史：那是给智能体用的短轮对话，每条都带预设、输出类型与结构化草稿；
// 这里要的是「一页 DeepSeek」：长上下文、联网搜索、读链接、思考模式，跟预设无关。
// 两者的数据形状不一样，硬塞进一个文件只会让两边都难改。
//
// 落盘口径：
//  - DATA_DIR/chat/<账号 id>/<会话 id>.json：消息正文（最多 200 条，单条最多 32000 字）；
//  - DATA_DIR/chat/<账号 id>/index.json：会话列表（标题、条数、最后一句预览、更新时间）；
//  - 任何越界输入按上限截断，不报错；坏文件当作不存在（一条坏会话不能拖垮整个列表）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'

const MAX_CONVERSATIONS = 30
const MAX_MESSAGES = 200
const MAX_TEXT = 32000
const MAX_TITLE = 60
// 附件抽出来的文字跟着消息存；只给最近 6 条留正文，更早的只留文件名——
// 长对话里最早的几轮本来就会被上下文窗口挤掉（r218 的口径：不假装还记着）。
const MAX_DOC_TEXT = 24000
const KEEP_DOC_TEXT = 6
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/

function rootDir() {
  return path.join(config.dataDir, 'chat')
}

function userDir(userId) {
  const id = String(userId || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!id) throw Object.assign(new Error('账号不合法'), { status: 400, code: 'CHAT_USER' })
  return path.join(rootDir(), id)
}

function safeText(value, max = MAX_TEXT) {
  return String(value ?? '').slice(0, max)
}

/** 消息上的附件形状：只留界面与上下文要用的字段，正文另存 docText。 */
function safeFiles(value) {
  if (!Array.isArray(value) || !value.length) return undefined
  return value.slice(0, 5).map((item) => ({
    id: safeText(item?.id, 40),
    name: safeText(item?.name, 80),
    kind: safeText(item?.kind, 12),
    kindLabel: safeText(item?.kindLabel, 12),
    bytes: Number(item?.bytes) || 0,
    chars: Number(item?.chars) || 0,
    truncated: Boolean(item?.truncated),
    note: safeText(item?.note, 120),
    createdAt: safeText(item?.createdAt, 40),
  }))
}

/** 消息上读到的链接（r219）：界面显示「读了哪几页、多少字、为什么没读到」，正文另存 docText。 */
function safeLinks(value) {
  if (!Array.isArray(value) || !value.length) return undefined
  return value.slice(0, 2).map((item) => ({
    url: safeText(item?.url, 400),
    finalUrl: safeText(item?.finalUrl, 400),
    title: safeText(item?.title, 120),
    ok: Boolean(item?.ok),
    chars: Number(item?.chars) || 0,
    truncated: Boolean(item?.truncated),
    note: safeText(item?.note, 160),
  }))
}

/** 这一轮搜了什么（r246）：只留来源与标题给界面核对，摘要与正文只在上下文里，不重复存。 */
function safeSearch(value) {
  if (!value || typeof value !== 'object') return undefined
  const results = Array.isArray(value.results) ? value.results : []
  return {
    ok: Boolean(value.ok),
    query: safeText(value.query, 120),
    provider: safeText(value.provider, 24),
    providerLabel: safeText(value.providerLabel, 40),
    note: safeText(value.note, 160),
    results: results.slice(0, 6).map((item) => ({
      title: safeText(item?.title, 120),
      url: safeText(item?.url, 400),
      site: safeText(item?.site, 120),
    })),
  }
}

function atomicWrite(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 不生效，不影响正确性 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function indexFile(userId) { return path.join(userDir(userId), 'index.json') }
function convFile(userId, id) { return path.join(userDir(userId), id + '.json') }

function readIndex(userId) {
  const raw = readJson(indexFile(userId), null)
  const rows = Array.isArray(raw?.items) ? raw.items : []
  return rows
    .filter((row) => row && ID_RE.test(String(row.id || '')))
    .map((row) => ({
      id: String(row.id),
      title: safeText(row.title, MAX_TITLE) || '新对话',
      preview: safeText(row.preview, 120),
      messageCount: Number(row.messageCount) || 0,
      createdAt: Number(row.createdAt) || 0,
      updatedAt: Number(row.updatedAt) || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function writeIndex(userId, rows) {
  atomicWrite(indexFile(userId), { version: 1, items: rows.slice(0, MAX_CONVERSATIONS) })
}

export function listConversations(userId) {
  return readIndex(userId)
}

export function createConversation(userId, options = {}) {
  const rows = readIndex(userId)
  if (rows.length >= MAX_CONVERSATIONS) {
    // 超出上限时先删最老的一条（会话是草稿，不是作品；不提示、不阻塞）
    const oldest = rows[rows.length - 1]
    if (oldest) {
      try { fs.unlinkSync(convFile(userId, oldest.id)) } catch { /* 已经不在了 */ }
      rows.pop()
    }
  }
  const now = Date.now()
  const conv = {
    id: 'c' + now.toString(36) + crypto.randomBytes(3).toString('hex'),
    title: safeText(options.title, MAX_TITLE) || '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
  atomicWrite(convFile(userId, conv.id), conv)
  writeIndex(userId, [{ id: conv.id, title: conv.title, preview: '', messageCount: 0, createdAt: now, updatedAt: now }, ...rows])
  return conv
}

export function getConversation(userId, conversationId) {
  const id = String(conversationId || '')
  if (!ID_RE.test(id)) return null
  const conv = readJson(convFile(userId, id), null)
  if (!conv || !Array.isArray(conv.messages)) return null
  return {
    id,
    title: safeText(conv.title, MAX_TITLE) || '新对话',
    createdAt: Number(conv.createdAt) || 0,
    updatedAt: Number(conv.updatedAt) || 0,
    messages: conv.messages.slice(-MAX_MESSAGES).map((item) => ({
      id: String(item.id || ''),
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: safeText(item.content),
      at: Number(item.at) || 0,
      model: safeText(item.model, 80),
      ms: Number(item.ms) || 0,
      meta: item.meta && typeof item.meta === 'object' ? item.meta : null,
      files: safeFiles(item.files),
      links: safeLinks(item.links),
      search: safeSearch(item.search),
      docText: safeText(item.docText, MAX_DOC_TEXT),
    })),
  }
}

export function saveConversation(userId, conv) {
  const kept = (conv.messages || []).slice(-MAX_MESSAGES)
  const messages = kept.map((item, index) => ({
    id: String(item.id || ('m' + Date.now().toString(36))),
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: safeText(item.content),
    at: Number(item.at) || Date.now(),
    model: safeText(item.model, 80),
    ms: Number(item.ms) || 0,
    meta: item.meta && typeof item.meta === 'object' ? item.meta : null,
    files: safeFiles(item.files),
    links: safeLinks(item.links),
    search: safeSearch(item.search),
    // 只给最近几条留附件正文：更早的留在消息里只会让会话文件越滚越大，而且已经挤不进上下文
    docText: index < kept.length - KEEP_DOC_TEXT ? '' : safeText(item.docText, MAX_DOC_TEXT),
  }))
  const next = {
    id: conv.id,
    title: safeText(conv.title, MAX_TITLE) || '新对话',
    createdAt: Number(conv.createdAt) || Date.now(),
    updatedAt: Date.now(),
    messages,
  }
  atomicWrite(convFile(userId, next.id), next)
  const rows = readIndex(userId).filter((row) => row.id !== next.id)
  const last = messages[messages.length - 1]
  rows.unshift({
    id: next.id,
    title: next.title,
    preview: safeText(last?.content, 120),
    messageCount: messages.length,
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
  })
  writeIndex(userId, rows)
  return getConversation(userId, next.id)
}

export function deleteConversation(userId, conversationId) {
  const id = String(conversationId || '')
  if (!ID_RE.test(id)) return false
  const exists = fs.existsSync(convFile(userId, id))
  try { fs.unlinkSync(convFile(userId, id)) } catch { /* 已经不在了 */ }
  writeIndex(userId, readIndex(userId).filter((row) => row.id !== id))
  return exists
}

/** 上下文：最近 N 条、总字数封顶；超了从最早的开始丢，保留最后一条用户消息。 */
export function contextMessages(messages, maxCount = 30, maxChars = 60000) {
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && String(item.content || '').trim())
    .map((item) => {
      let content = String(item.content).slice(0, MAX_TEXT)
      // r245：图片只在发送那一轮真的给模型看，之后只剩这行说明。
      // 不写这行的话，模型看到历史里那句「三张图哪里不对」会以为自己还看得见那些图。
      const imageNames = Array.isArray(item.files)
        ? item.files.filter((file) => String(file?.kind || '') === 'image').map((file) => String(file?.name || '')).filter(Boolean)
        : []
      if (imageNames.length) {
        content += '\n\n【这一轮带过 ' + imageNames.length + ' 张图片（' + imageNames.join('、') + '）：图片只在发送那一轮参与理解，后面只按文件名记住】'
      }
      const docText = typeof item.docText === 'string' ? item.docText.trim() : ''
      if (!docText) return { role: item.role, content }
      // 附件原文跟着那一轮一起进上下文：模型看到的是「用户这句话 + 附件里的文字」
      const names = Array.isArray(item.files)
        ? item.files.map((file) => String(file?.name || '')).filter(Boolean).join('、')
        : ''
      // 这一轮到底带了什么，就在上下文里写清楚：附件 / 用户给的链接 / 平台自己搜的网页
      const labelParts = []
      if (names) labelParts.push('附件（' + names + '）')
      if (Array.isArray(item.links) && item.links.length) labelParts.push('链接')
      // 搜了但没搜成也要写上：否则这段 docText 会被当成「附件」的正文（r246 修正）
      if (item.search) labelParts.push(item.search.ok ? '联网搜索' : '联网搜索（没搜成）')
      const label = labelParts.length ? labelParts.join('、') : '附件'
      return { role: item.role, content: content + '\n\n【这一轮的' + label + '】\n' + docText }
    })
  const picked = []
  let chars = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (picked.length >= maxCount) break
    if (chars + row.content.length > maxChars && picked.length > 0) break
    picked.unshift(row)
    chars += row.content.length
  }
  return picked
}

/** 给会话起个标题：第一句用户输入的前 24 个字，去掉换行。 */
export function titleFrom(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  return line.slice(0, 24) || '新对话'
}

export const CHAT_LIMITS = { MAX_CONVERSATIONS, MAX_MESSAGES, MAX_TEXT, MAX_TITLE }
