// 快捷创作的「附件进对话」（r218）：把用户丢进来的脚本、文档、表格先读成文字，再连同问题一起问模型。
//
// 为什么在服务端解析、还要自己写解析器：
//  - 平台没有引入任何文档解析依赖，也不想为了四种格式多吃一个包（何况 docx/xlsx 本质就是 zip + XML）；
//  - 解析放在服务端，用户的原始文件不必进上下文、也不必上传给上游；
//  - 失败要说人话：「扫描件读不出字」「表格先另存为 xlsx」——比把二进制喂给模型更好。
//
// 四条边界：
//  1) 只认 txt/md/csv/json/代码这类纯文本、docx、xlsx、pdf 四种；其他按内容判断后拒，不看扩展名；
//  2) 单个文件 ≤ 8 MB，抽出文字后每个文件最多 20000 字、一条消息合计 24000 字，超了截断并标 truncated；
//  3) 解析结果只属于上传的人：目录带账号 id，读的时候按归属校验，不进分享页、不进交付包；
//  4) PDF 只读文字层：扫描件（纯图片）会明确说读不出字，不做 OCR —— OCR 需要调视觉模型，等用户授权。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { config } from './config.mjs'
import { refusal } from './public-error.mjs'

const MB = 1024 * 1024

export const CHAT_FILE_LIMITS = {
  bytes: 8 * MB,
  fileChars: 20000,
  totalChars: 24000,
  maxPerMessage: 5,
  keepFiles: 20,
  zipEntryBytes: 24 * MB,
}

// 纯文本的扩展名只用来在界面上给个「这是我们能读的」提示；
// 真正决定能不能读的是文件内容（下面 sniff + 解码），改名的图片不会因为叫 .txt 就被当成文字。
export const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'srt',
  'ts', 'tsx', 'js', 'jsx', 'py', 'html', 'htm', 'css', 'yaml', 'yml',
]

const KIND_LABEL = { text: '纯文本', docx: 'Word', xlsx: 'Excel', pdf: 'PDF' }

function fail(status, code, message) {
  return refusal(status, code, message)
}

function safeUserId(value) {
  const id = String(value ?? '')
  return /^[A-Za-z0-9_-]{3,64}$/.test(id) ? id : ''
}

const FILE_ID = /^cf_[a-z0-9]{6,16}_[a-z0-9]{4,12}$/
export function validChatFileId(value) {
  return FILE_ID.test(String(value ?? '')) ? String(value) : ''
}

function clipName(value) {
  const raw = String(value || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim()
  return (raw || '附件').slice(0, 80)
}

// ── 压缩包（docx / xlsx 都是 zip） ─────────────────────────────────────────────
function readZip(buffer, wanted, { maxBytes }) {
  let eocd = -1
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 66000); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { eocd = at; break }
  }
  if (eocd < 0) throw fail(415, 'FILE_ZIP', '这个文件像是 Office 文档，但压缩结构读不出来：用 Word / Excel 另存一次再传')
  const count = buffer.readUInt16LE(eocd + 10)
  let at = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let index = 0; index < count && at + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) break
    const method = buffer.readUInt16LE(at + 10)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    entries.set(name, { method, compressedSize, localOffset })
    at += 46 + nameLength + extraLength + commentLength
  }
  const out = new Map()
  for (const name of wanted) {
    const entry = entries.get(name)
    if (!entry) continue
    const head = entry.localOffset
    if (head + 30 > buffer.length || buffer.readUInt32LE(head) !== 0x04034b50) continue
    const nameLength = buffer.readUInt16LE(head + 26)
    const extraLength = buffer.readUInt16LE(head + 28)
    const start = head + 30 + nameLength + extraLength
    const raw = buffer.subarray(start, start + entry.compressedSize)
    try {
      if (entry.method === 0) out.set(name, raw)
      else if (entry.method === 8) out.set(name, zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }))
    } catch {
      throw fail(413, 'FILE_ZIP_BIG', '这个文档解压后太大，读不完：先删掉一部分内容或另存为较小的文件')
    }
  }
  return out
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function xmlToText(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

// xlsx：先读共享字符串表，再按单元格把值拼回表格（制表符分列、换行分行）。
// 只读第一个工作表：多表的文件在界面上会注明「只读了第一个工作表」，不假装读了全部。
function sheetToText(shared, xml) {
  const rows = []
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = []
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1] || cellMatch[3] || ''
      const body = cellMatch[2] || ''
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || ''
      const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/)
      const inlineMatch = body.match(/<is>([\s\S]*?)<\/is>/)
      let value = ''
      if (type === 's' && valueMatch) value = shared[Number(valueMatch[1])] ?? ''
      else if (type === 'inlineStr' && inlineMatch) value = decodeEntities(inlineMatch.replace(/<[^>]+>/g, ''))
      else if (valueMatch) value = decodeEntities(valueMatch[1])
      cells.push(value.replace(/\t/g, ' ').replace(/\n/g, ' '))
    }
    if (cells.length) rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

// ── PDF：只读文字层 ──────────────────────────────────────────────────────────
function pdfUnescape(value) {
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]
    if (ch !== '\\') { out += ch; continue }
    const next = value[index + 1]
    index += 1
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b' || next === 'f') out += ' '
    else if (next === '(' || next === ')' || next === '\\') out += next
    else if (next >= '0' && next <= '7') {
      let digits = next
      while (digits.length < 3 && value[index + 1] >= '0' && value[index + 1] <= '7') {
        digits += value[index + 1]
        index += 1
      }
      out += String.fromCharCode(Number.parseInt(digits, 8))
    } else if (next === '\n') {
      /* 续行 */
    } else if (next !== undefined) out += next
  }
  return out
}

function pdfStrings(body) {
  const found = []
  // TJ 数组：[ (甲) -20 (乙) ] TJ  —— 拆成一个个字符串再拼
  const arrayRe = /\[((?:[^\[\]\\]|\\.)*)\]\s*TJ/g
  let match
  while ((match = arrayRe.exec(body))) {
    const inner = match[1]
    const stringRe = /\(((?:\\.|[^)\\])*)\)/g
    let piece
    let line = ''
    while ((piece = stringRe.exec(inner))) line += pdfUnescape(piece[1])
    if (line) found.push(line)
  }
  // 单个字符串：(甲) Tj / ' / "
  const singleRe = /\(((?:\\.|[^)\\])*)\)\s*(?:Tj|'|")/g
  while ((match = singleRe.exec(body))) {
    const value = pdfUnescape(match[1])
    if (value) found.push(value)
  }
  return found.join('\n')
}

function pdfToText(buffer, { maxBytes }) {
  const pieces = []
  const source = buffer.toString('latin1')
  const streamRe = /stream\r?\n/g
  let match
  while ((match = streamRe.exec(source))) {
    const start = match.index + match[0].length
    const end = source.indexOf('endstream', start)
    if (end < 0) break
    const raw = buffer.subarray(start, end)
    let decoded = null
    try { decoded = zlib.inflateSync(raw, { maxOutputLength: maxBytes }).toString('latin1') } catch { decoded = null }
    if (!decoded) {
      try { decoded = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }).toString('latin1') } catch { decoded = null }
    }
    // 没有压缩的内容流（部分生成器会这么写）直接当正文读
    if (!decoded && /\bBT\b/.test(raw.toString('latin1'))) decoded = raw.toString('latin1')
    if (!decoded) continue
    if (!/\b(?:Tj|TJ)\b/.test(decoded)) continue
    const text = pdfStrings(decoded)
    if (text.trim()) pieces.push(text)
    if (pieces.join('\n').length > maxBytes) break
  }
  return tidy(pieces.join('\n'))
}

// ── 认得出来是什么文件 ────────────────────────────────────────────────────────
export function sniffDocument(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null
  const head = buffer.toString('latin1', 0, 1024)
  if (head.startsWith('%PDF-')) return { kind: 'pdf' }
  if (buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    const names = []
    const source = buffer.toString('latin1')
    const nameRe = /word\/document\.xml/g
    if (nameRe.test(source)) names.push('docx')
    if (/xl\/worksheets\/sheet1\.xml/.test(source)) names.push('xlsx')
    if (names.length) return { kind: names[0] }
    return null
  }
  return { kind: 'text' }
}

/** 纯文本解码：先按 UTF-8 严格解，失败再试 GB18030（Windows 记事本常见），都不行就是二进制。 */
export function decodeText(buffer) {
  let text = ''
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      text = new TextDecoder('gb18030', { fatal: true }).decode(buffer)
    } catch {
      throw fail(415, 'FILE_TYPE', '这个文件按内容看不是文字：支持 txt / md / csv / json / 代码，以及 Word、Excel、PDF')
    }
  }
  const clean = text.replace(/^\uFEFF/, '')
  const controls = (clean.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length
  if (clean.length > 200 && controls / clean.length > 0.02) {
    throw fail(415, 'FILE_TYPE', '这个文件按内容看不是文字（二进制内容太多）：换一个，或者把要用的那段贴进输入框')
  }
  return clean
}

/**
 * 抽文字。返回 { kind, text, truncated, note }。
 * 有 note 时界面会把它显示在附件旁边（例如「只读了第一个工作表」）。
 */
export function extractDocument(buffer, { name = '', maxChars = CHAT_FILE_LIMITS.fileChars } = {}) {
  const size = Buffer.isBuffer(buffer) ? buffer.length : 0
  if (!size) throw fail(400, 'FILE_EMPTY', '没有收到文件内容：换一个再传')
  if (size > CHAT_FILE_LIMITS.bytes) {
    const mb = Math.round((size / MB) * 10) / 10
    throw fail(413, 'FILE_TOO_LARGE', '这个文件 ' + mb + ' MB，超过 8 MB 上限：先压一下或截取要用的部分')
  }
  const sniffed = sniffDocument(buffer)
  if (!sniffed) {
    throw fail(415, 'FILE_TYPE', '这个压缩包不是 Word 也不是 Excel：只支持 txt / md / csv / json / 代码，以及 docx / xlsx / pdf')
  }
  let kind = sniffed.kind
  let note = ''
  let text = ''
  if (kind === 'pdf') {
    text = pdfToText(buffer, { maxBytes: CHAT_FILE_LIMITS.zipEntryBytes })
    if (text.replace(/\s/g, '').length < 20) {
      throw fail(
        422,
        'FILE_PDF_NO_TEXT',
        '这份 PDF 里没有可读的文字（多半是扫描件或图片导出的），暂时读不出来：把文字贴进输入框，或换一份有文字层的 PDF',
      )
    }
    note = '只读了 PDF 的文字层，图片里的字读不到'
  } else if (kind === 'docx') {
    const entries = readZip(buffer, ['word/document.xml'], { maxBytes: CHAT_FILE_LIMITS.zipEntryBytes })
    const xml = entries.get('word/document.xml')
    if (!xml) throw fail(415, 'FILE_TYPE', '这个 Word 文档里没有正文：换一个再传')
    text = tidy(xmlToText(xml.toString('utf8')))
    note = '只读了 Word 的正文，批注、脚注、图片里的字读不到'
  } else if (kind === 'xlsx') {
    const entries = readZip(buffer, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'], { maxBytes: CHAT_FILE_LIMITS.zipEntryBytes })
    const sheet = entries.get('xl/worksheets/sheet1.xml')
    if (!sheet) throw fail(415, 'FILE_TYPE', '这个 Excel 里没有第一个工作表的正文：换一个再传')
    const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || ''
    const shared = (sharedXml.match(/<si>[\s\S]*?<\/si>/g) || []).map((item) =>
      decodeEntities(item.replace(/<(?:\/)?t[^>]*>/g, '').replace(/<[^>]+>/g, '')),
    )
    text = tidy(sheetToText(shared, sheet.toString('utf8')))
    note = '只读了第一个工作表，每个单元格只取值'
  } else {
    text = decodeText(buffer)
    kind = 'text'
    const ext = String(name).toLowerCase().split('.').pop() || ''
    if (['csv', 'tsv'].includes(ext)) note = '按纯文本读的，表格结构（列）没有还原'
  }
  const trimmed = tidy(text)
  if (!trimmed) throw fail(422, 'FILE_NO_TEXT', '这个文件里没有可读的文字：换一个，或者把要用的那段贴进输入框')
  const truncated = trimmed.length > maxChars
  return {
    kind,
    text: truncated ? trimmed.slice(0, maxChars) : trimmed,
    chars: Math.min(trimmed.length, maxChars),
    totalChars: trimmed.length,
    truncated,
    note,
  }
}

// ── 存储 ────────────────────────────────────────────────────────────────────
function rootDir() {
  return path.join(config.dataDir, 'chat', 'files')
}

function userDir(userId) {
  const id = safeUserId(userId)
  if (!id) throw fail(400, 'FILE_USER', '附件的归属账号不对')
  return path.join(rootDir(), id)
}

function fileFor(userId, id) {
  return path.join(userDir(userId), validChatFileId(id) + '.json')
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* Windows 不生效，不影响正确性 */ }
}

/** 给前端的形状：不含正文，只说明「读了什么、多少字」。 */
export function publicChatFile(meta) {
  return {
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    kindLabel: KIND_LABEL[meta.kind] || '文件',
    bytes: meta.bytes,
    chars: meta.chars,
    truncated: Boolean(meta.truncated),
    note: meta.note || '',
    createdAt: meta.createdAt,
  }
}

function readMeta(userId, id) {
  const target = fileFor(userId, id)
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

function makeRoom(userId) {
  const dir = userDir(userId)
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    if (!validChatFileId(id)) continue
    const meta = readMeta(userId, id)
    if (meta) rows.push({ id, createdAt: String(meta.createdAt || '') })
  }
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  while (rows.length >= CHAT_FILE_LIMITS.keepFiles) {
    const oldest = rows.shift()
    try { fs.rmSync(fileFor(userId, oldest.id), { force: true }) } catch { break }
  }
}

export function saveChatFile({ userId, buffer, name = '' }) {
  const id = safeUserId(userId)
  if (!id) throw fail(400, 'FILE_USER', '附件的归属账号不对')
  const extracted = extractDocument(buffer, { name })
  makeRoom(id)
  const fileId = 'cf_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex').slice(0, 8)
  const meta = {
    version: 1,
    id: fileId,
    ownerId: id,
    name: clipName(name),
    kind: extracted.kind,
    bytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
    chars: extracted.chars,
    totalChars: extracted.totalChars,
    truncated: extracted.truncated,
    note: extracted.note,
    text: extracted.text,
    createdAt: new Date().toISOString(),
  }
  atomicWrite(fileFor(id, fileId), meta)
  return publicChatFile(meta)
}

export function listChatFiles(userId, limit = CHAT_FILE_LIMITS.keepFiles) {
  const id = safeUserId(userId)
  if (!id) return []
  const dir = userDir(id)
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const meta = readMeta(id, name.slice(0, -5))
    if (meta) rows.push(meta)
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const size = Math.max(1, Math.min(CHAT_FILE_LIMITS.keepFiles, Number(limit) || CHAT_FILE_LIMITS.keepFiles))
  return rows.slice(0, size).map(publicChatFile)
}

export function deleteChatFile(userId, fileId) {
  const id = safeUserId(userId)
  if (!id || !validChatFileId(fileId)) return false
  const target = fileFor(id, fileId)
  const exists = fs.existsSync(target)
  try { fs.rmSync(target, { force: true }) } catch { return false }
  return exists
}

/** 读正文（只给归属账号；读不到当不存在）。 */
export function readChatFile(userId, fileId) {
  const id = safeUserId(userId)
  if (!id || !validChatFileId(fileId)) return null
  return readMeta(id, fileId)
}

/**
 * 一条消息要带的附件：按顺序读，读不到的跳过（别人删了/不是自己的），
 * 总字数封顶——附件再多，这一轮的上下文也是有限的，不能让一段 20 万字的稿子把上下文挤爆。
 */
export function resolveChatFiles(userId, fileIds = []) {
  const ids = (Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean)
  const seen = new Set()
  const files = []
  const blocks = []
  let used = 0
  let skipped = 0
  for (const fileId of ids) {
    if (seen.has(fileId)) continue
    seen.add(fileId)
    const meta = readChatFile(userId, fileId)
    if (!meta) { skipped += 1; continue }
    let text = String(meta.text || '')
    let clipped = Boolean(meta.truncated)
    const room = CHAT_FILE_LIMITS.totalChars - used
    if (room <= 0) {
      // 还有附件没地方放：明确告诉模型有几份没读到，不要让回答假装看过
      skipped += 1
      continue
    }
    if (text.length > room) {
      text = text.slice(0, room)
      clipped = true
    }
    used += text.length
    files.push(publicChatFile(meta))
    blocks.push('【附件 ' + files.length + '：' + meta.name + '（' + KIND_LABEL[meta.kind] + '，约 ' + meta.chars + ' 字' +
      (clipped ? '，已截断' : '') + '）】\n' + text)
  }
  const text = blocks.length
    ? blocks.join('\n\n') + (skipped ? '\n\n【还有 ' + skipped + ' 个附件这次没带上：总字数已到上限，或文件已被删除】' : '')
    : ''
  return { files, text, skipped, chars: used }
}

export { KIND_LABEL }
