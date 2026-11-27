// r343 独立取证 · 共用骨架（假上游 / 真服务进程 / 播种 / HTTP 客户端）
// 原则：0 次真实上游调用——所有模型请求都打到本进程起的假上游。
import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AT = String.fromCharCode(64)
export const ADMIN_EMAIL = 'verify-admin-r343' + AT + 'verify.test'
export const USER_EMAIL = 'verify-user-r343' + AT + 'verify.test'
export const PASSWORD = 'Passw0rd!demo'
export const KEY_SECRET = 'verify-r343-secret'

export const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(check, timeoutMs = 20000, gap = 25) {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let rounds = 0
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) return null
    rounds += 1
    if (rounds % 40 === 0) {
      const mb = Math.round(process.memoryUsage().heapUsed / 1048576)
      console.log('[wait] ' + Math.round((Date.now() - startedAt) / 1000) + 's heap=' + mb + 'MB')
    }
    await sleep(gap)
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function parseMultipart(buffer, boundary) {
  const parts = []
  const delimiter = Buffer.from('--' + boundary)
  let index = buffer.indexOf(delimiter)
  while (index >= 0) {
    const start = index + delimiter.length
    if (buffer.slice(start, start + 2).toString() === '--') break
    const headerEnd = buffer.indexOf('\r\n\r\n', start)
    if (headerEnd < 0) break
    const headerText = buffer.slice(start, headerEnd).toString('utf8')
    const next = buffer.indexOf(delimiter, headerEnd)
    if (next < 0) break
    let body = buffer.slice(headerEnd + 4, next)
    if (body.slice(-2).toString() === '\r\n') body = body.slice(0, -2)
    const name = (/name="([^"]*)"/.exec(headerText) || [])[1] || ''
    const filename = (/filename="([^"]*)"/.exec(headerText) || [])[1] || ''
    const contentType = (/Content-Type:\s*([^\r\n]+)/i.exec(headerText) || [])[1] || ''
    parts.push({ name, filename, contentType: contentType.trim(), bytes: body })
    // 关键：必须把游标推过这个部件，否则同一个 boundary 会被无限解析（会吃满内存）
    index = next
  }
  return parts
}

/**
 * 假上游：OpenAI 兼容出图 / 参考图 / 文本，加 SeeAPI 视频建任务。
 * 每个请求都留档（含完整正文），断言不看「看起来对」，看真正发出去的东西。
 */
export async function startFakeUpstream(options = {}) {
  const requests = []
  const reply = options.reply || '我是 VisionQA 通用模型。'
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const contentType = String(req.headers['content-type'] || '')
      const entry = {
        method: req.method,
        url: req.url,
        contentType,
        authorization: /^Bearer\s+/.test(String(req.headers.authorization || '')),
        headers: { ...req.headers },
        at: Date.now(),
        raw,
        json: null,
        parts: null,
      }
      if (/multipart\/form-data/i.test(contentType)) {
        const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
        entry.boundary = matched ? (matched[1] || matched[2]).trim() : ''
        entry.parts = parseMultipart(raw, entry.boundary)
      } else if (raw.length) {
        try {
          entry.json = JSON.parse(raw.toString('utf8'))
        } catch {
          entry.json = null
        }
      }
      requests.push(entry)
      console.log('[fake] ' + req.method + ' ' + req.url + ' bytes=' + raw.length)

      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (req.method === 'POST' && /\/chat\/completions$/.test(req.url)) {
        const body = entry.json || {}
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n')
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        json(200, {
          model: String(body.model || 'fake'),
          choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })
        return
      }
      if (req.method === 'POST' && /\/images\/(generations|edits)$/.test(req.url)) {
        json(200, { created: 1, data: [{ b64_json: 'data:image/png;base64,' + TINY_PNG.toString('base64') }] })
        return
      }
      if (req.method === 'POST' && /\/video\/generations$/.test(req.url)) {
        json(200, { id: 'fake_video_task_1', status: 'queued' })
        return
      }
      json(404, { error: { code: 'FAKE_NOT_FOUND', message: 'fake upstream has no ' + req.url } })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  return {
    origin,
    requests,
    of: (pattern) => requests.filter((item) => pattern.test(item.url)),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function runNode(args, { root = ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (err += chunk.toString('utf8')))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

export function seedEnv(dataDir) {
  return { DATA_DIR: dataDir, VQ_KEY_SECRET: KEY_SECRET, VQ_CREDIT_WELCOME: '300', VQ_REQUIRE_AUTH: '1' }
}

export function runSeed({ dataDir, origin, root = ROOT }) {
  return runNode([path.join(root, 'scripts', 'verify-r343-seed.mjs'), 'seed', dataDir, origin], {
    root,
    env: seedEnv(dataDir),
  })
}

export function readBalance({ dataDir, email, root = ROOT }) {
  return runNode([path.join(root, 'scripts', 'verify-r343-seed.mjs'), 'balance', dataDir, email], {
    root,
    env: seedEnv(dataDir),
  })
}

export async function startServer({ dataDir, port, fakeOrigin, root = ROOT, extraEnv = {} }) {
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    VQ_KEY_SECRET: KEY_SECRET,
    VQ_CREDIT_WELCOME: '300',
    VQ_REQUIRE_AUTH: '1',
    VQ_UI_MODE: 'prod',
    VISION_BASE_URL: fakeOrigin + '/v1',
    VISION_API_KEY: 'sk-verify-fake-1234567890',
    VISION_MODEL: 'deepseek-flash',
    VISION_FALLBACKS: '',
    LLM_MODEL: 'deepseek-flash',
    LLM_FALLBACKS: '',
    API_PORT: String(port),
    ...extraEnv,
  }
  const child = spawn(process.execPath, ['--experimental-sqlite', path.join(root, 'server', 'index.mjs')], {
    cwd: root,
    env,
    windowsHide: true,
  })
  // 只留最后 200KB：假上游 / 真服务在异常时可能刷日志，别把取证进程自己撑爆。
  // 同时落一份文件（排障时父进程可能先死，内存里那份就丢了）。
  let log = ''
  const logFile = path.join(ROOT, '.tmp-r343-verify', 'server-' + port + '.log')
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.writeFileSync(logFile, '')
  } catch {}
  const append = (chunk) => {
    const text = chunk.toString('utf8')
    log = (log + text).slice(-200000)
    try {
      fs.appendFileSync(logFile, text)
    } catch {}
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const base = 'http://127.0.0.1:' + port
  const ready = await waitFor(
    async () => {
      try {
        const res = await fetch(base + '/api/health')
        return res.ok
      } catch {
        return false
      }
    },
    60000,
    150,
  )
  if (!ready) {
    child.kill()
    throw new Error('临时服务没起来；进程日志：\n' + log.slice(-4000))
  }
  return {
    base,
    child,
    log: () => log,
    close: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('close', () => resolve())
        child.kill()
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          resolve()
        }, 4000)
      }),
  }
}

export async function api(base, pathname, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  const finalHeaders = { ...headers }
  if (cookie) finalHeaders.Cookie = cookie
  let payload
  if (raw !== undefined) {
    payload = raw
  } else if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + pathname, { method, headers: finalHeaders, body: payload })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, text, json, setCookie: res.headers.get('set-cookie') || '' }
}

export async function login(base, email, password = PASSWORD) {
  const res = await api(base, '/api/auth/login', { method: 'POST', body: { email, password } })
  if (res.status !== 200) throw new Error('登录失败 ' + res.status + ' ' + res.text.slice(0, 300))
  return res.setCookie.split(';')[0]
}

// ── 断言记账：每条都打印原始细节，最后统一决定退出码 ──────────────────────────
export function createReport(title) {
  const rows = []
  return {
    rows,
    check(name, ok, detail = '') {
      rows.push({ name, ok: Boolean(ok), detail: String(detail) })
      console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' :: ' + detail : ''))
      return Boolean(ok)
    },
    finish() {
      const failed = rows.filter((row) => !row.ok)
      console.log('')
      console.log('==== ' + title + ' ====')
      console.log('共 ' + rows.length + ' 条，通过 ' + (rows.length - failed.length) + '，失败 ' + failed.length)
      for (const row of failed) console.log('  FAIL · ' + row.name + ' :: ' + row.detail)
      return failed.length ? 1 : 0
    },
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function dump(file, text) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, text, 'utf8')
}
