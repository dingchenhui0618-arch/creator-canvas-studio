import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

// 前端异常上报：浏览器里炸了的东西（脚本错误、未处理的 Promise、React 渲染抛错）
// 在服务端留一份，后台「系统」页能直接看到，不用等用户截图、也不用翻 journal。
//
// 三条约束：
//   1. 条目封顶 300 条，超过丢最旧的，不占磁盘；
//   2. 同一条错误（同页面 + 同 message）10 分钟内只累加次数，不刷屏；
//   3. 上报内容一律截断 + 抹掉 URL 里的 token，别把密钥写进日志。

const CAP = 300
const DEDUPE_MS = 10 * 60 * 1000
const KINDS = new Set(['error', 'unhandledrejection', 'react', 'resource'])

let cache = null
let writeChain = Promise.resolve()

async function loadAll() {
  if (cache) return cache
  try {
    const text = await fsp.readFile(config.clientErrorsFile, 'utf8')
    const parsed = JSON.parse(text)
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

function enqueueWrite(task) {
  const next = writeChain.then(task, task)
  writeChain = next.catch(() => {})
  return next
}

async function persist(list) {
  cache = list
  return enqueueWrite(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = config.clientErrorsFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
    await fsp.rename(tmp, config.clientErrorsFile)
  })
}

// 单行、去空白、截断；分享链接、票据这类参数一律抹掉
const clean = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

export const scrubUrl = (value) =>
  String(value ?? '').replace(/([?&](?:token|ticket|key|session|share|code)=)[^&\s#]+/gi, '$1***')

export async function recordClientError({ payload = {}, ip = '', user = null }) {
  const message = clean(scrubUrl(payload.message), 300)
  // 跨域脚本错误只有一句 "Script error."：没有信息量，不占条目
  if (!message || message === 'Script error.') return null
  const at = new Date().toISOString()
  const entry = {
    id: 'ce_' + randomUUID().slice(0, 8),
    at,
    lastAt: at,
    count: 1,
    kind: KINDS.has(payload.kind) ? payload.kind : 'error',
    message,
    stack: clean(scrubUrl(payload.stack), 1200),
    page: clean(scrubUrl(payload.page), 160),
    version: clean(payload.version, 40),
    userAgent: clean(payload.userAgent, 200),
    ip: clean(ip, 60),
    userId: user?.id || '',
  }
  const list = await loadAll()
  const now = Date.now()
  const same = list.find(
    (item) => item.message === entry.message && item.page === entry.page && now - Date.parse(item.lastAt) < DEDUPE_MS,
  )
  if (same) {
    const next = list.map((item) => (item === same ? { ...item, count: item.count + 1, lastAt: at } : item))
    await persist(next)
    return next.find((item) => item.id === same.id)
  }
  const next = [entry, ...list].slice(0, CAP)
  await persist(next)
  return entry
}

export async function listClientErrors({ limit = 50 } = {}) {
  const list = await loadAll()
  const sorted = [...list].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  return {
    items: sorted.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))),
    total: list.length,
    last24h: list.filter((item) => Date.parse(item.lastAt) > dayAgo).reduce((sum, item) => sum + item.count, 0),
    limits: { cap: CAP, dedupeMin: DEDUPE_MS / 60000 },
  }
}

export async function clearClientErrors() {
  const list = await loadAll()
  await persist([])
  return list.length
}
