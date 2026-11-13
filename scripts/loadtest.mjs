#!/usr/bin/env node
// 重活压测：起一辆一次性的完整实例 + 本地假上游，把「并发闸门」和「内存峰值」都量出来。
//
// 为什么要有它：v0.9.69 / v0.9.70 的上限（按账号 1~2 条、全站 3 条）是经验值，B2 一直缺
// 「10 个并发会不会 OOM」这一条实测。这里不调任何真实上游、不花一分钱：
//   假上游   —— 本地 HTTP，按 --upstream-ms 故意慢，让任务真的叠在同一时间窗里；
//   真请求   —— 走真实的 /api/review 或 /api/replicate，真扣积分、真过闸门、真落库；
//   真抽帧   —— replicate 那条路真的下载视频、真的 spawn ffmpeg；
//   真读数   —— 采样进程树 RSS、V8 堆、系统 MemAvailable、闸门在跑数、健康探针延迟。
//
// 用法：
//   node scripts/loadtest.mjs --kind=review --n=10                 # 闸门开着（生产默认）
//   node scripts/loadtest.mjs --kind=review --n=10 --guard=off     # 关掉闸门，看 10 并发真实峰值
//   node scripts/loadtest.mjs --kind=replicate --n=10 --guard=off  # 再加上 ffmpeg 子进程那条路
//   node scripts/loadtest.mjs --kind=review --n=3                  # 上限以内的正常路径
//
// 参数：
//   --kind=review|replicate   重活类型（默认 review：整个流程都在本机，不依赖外网）
//   --n=10                    同时提交几条（每个账号一条：评审按账号只放 1 条并行）
//   --upstream-ms=4000        假上游延迟（让任务重叠，而不是排队）
//   --guard=on|off            on=按生产默认（水位 + 全站上限 3）；off=VQ_WATER_GUARD=0 + VQ_GLOBAL_HEAVY=0
//   --image-mb=2.5            review 用的图多大（本机生成，不联网）
//   --video-url=...           replicate 用的视频直链（默认 test-videos.co.uk 的 720p 10s）
//   --heap-mb=384             一次性实例的 V8 堆上限（与生产的 --max-old-space-size 一致）
//   --port=8798               一次性实例端口
//   --data-dir=...            一次性数据目录（默认 .tmp-qa/loadtest-<时间戳>）
//   --timeout-sec=180         等任务收尾的上限
//   --out=...                 结果 JSON 落盘路径（默认 <data-dir>/result.json）
//   --keep                    跑完保留实例与数据目录（排障用；否则一律清掉）
//
// 退出码：0 = 符合预期；1 = 有一条预期没满足；2 = 压测本身没跑起来。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const MB = 1048576
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = {}
  for (const item of argv) {
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    if (eq < 0) args[item.slice(2)] = 'true'
    else args[item.slice(2, eq)] = item.slice(eq + 1)
  }
  return args
}

// ---------- 假上游 ----------
// 一次返回同时满足两条链路的 JSON：视觉分析（structure / storyboard / analysis）
// 与视觉评审（verdict / observations / fixes）。多出来的字段各自忽略，不需要两套假上游。
const FAKE_PAYLOAD = {
  verdict: 'needs_review',
  summary: '压测用固定结论：页头标题对比度偏低，底部按钮距容器过近。',
  observations: [
    {
      dimension: 'contrast',
      severity: 'major',
      statement: '页头标题 #1A1A1A 压在 #F5F5F5 背景上，对比度约 2.4:1',
      evidence: { x: 0.08, y: 0.05, w: 0.62, h: 0.08 },
      confidence: 0.72,
    },
    {
      dimension: 'spacing',
      severity: 'minor',
      statement: '右下角按钮距容器底边 0px，文字下沿被裁约 8px',
      evidence: { x: 0.72, y: 0.86, w: 0.24, h: 0.1 },
      confidence: 0.61,
    },
  ],
  fixes: [{ title: '提亮标题', detail: '标题色改 #111111，标题底压到 #FFFFFF' }],
  notAssessable: ['动效节奏（静帧看不出）'],
  title: '压测用模板',
  contentType: '口播干货',
  tags: ['压测', '通勤'],
  hook: '前三秒先给结果',
  hookType: '结果前置',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '你会不会也这样：明明做完了，却不知道怎么讲', onScreen: '前三秒', purpose: '钩子' },
    { beat: '展开', startSec: 3, endSec: 7, voiceover: '我把整套流程拆成三段，照着做就行', onScreen: '三步', purpose: '给方法' },
    { beat: '收尾', startSec: 7, endSec: 10, voiceover: '先收藏，下一版直接套', onScreen: '收藏', purpose: '收尾' },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 3, frameIndex: 1, visual: '人物近景', camera: '中景固定', caption: '你会不会也这样', audio: '人声', purpose: '钩子' },
    { shotNo: 2, startSec: 3, endSec: 7, frameIndex: 2, visual: '屏幕录制', camera: '推镜', caption: '三步做完', audio: '人声 + 轻 BGM', purpose: '给方法' },
  ],
  analysis: { pacing: '快', viralPoints: ['结果前置'], reusableRules: ['先给结果再解释'], targetAudience: '通勤上班族' },
}

async function startFakeUpstream({ delayMs = 4000 } = {}) {
  const stats = { calls: 0, concurrent: 0, peakConcurrent: 0, byPath: {} }
  const server = http.createServer((req, res) => {
    const pathname = String(req.url || '').split('?')[0]
    stats.byPath[pathname] = (stats.byPath[pathname] || 0) + 1
    if (req.method === 'GET' && pathname.endsWith('/models')) {
      const body = JSON.stringify({ data: [{ id: 'loadtest-vision', object: 'model' }] })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    // 请求体读干净：keep-alive 连接里残留的 body 会让下一次请求对不上
    req.on('data', () => {})
    req.on('end', () => {
      stats.calls += 1
      stats.concurrent += 1
      stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.concurrent)
      setTimeout(() => {
        stats.concurrent -= 1
        const body = JSON.stringify({
          id: 'cmpl-loadtest-' + stats.calls,
          model: 'loadtest-vision',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(FAKE_PAYLOAD) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1800, completion_tokens: 900, total_tokens: 2700 },
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(body)
      }, delayMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: 'http://127.0.0.1:' + port + '/v1',
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ---------- 一次性实例 ----------
function ringTail(lines, count = 24) {
  return lines.slice(-count).join('\n')
}

async function startServer({ dataDir, port, env: extra = {} }) {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      API_PORT: String(port),
      VQ_UI_MODE: 'internal',
      // 与生产一致的堆上限：水位判定里的堆百分比阈值就按这个数算，换了它量出来的就不是生产口径
      NODE_OPTIONS: extra.NODE_OPTIONS || '--max-old-space-size=384',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = []
  const err = []
  child.stdout.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim()) out.push(line) })
  child.stderr.on('data', (chunk) => { for (const line of String(chunk).split('\n')) if (line.trim()) err.push(line) })
  const server = { child, pid: child.pid, out, err, exited: false }
  child.on('exit', () => { server.exited = true })
  server.logs = () => ringTail(out.concat(err))
  return server
}

async function waitHealth(base, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2500) })
      if (response.ok) return await response.json()
      lastError = 'HTTP ' + response.status
    } catch (error) {
      lastError = String(error?.message || error)
    }
    await sleep(150)
  }
  throw new Error('一次性实例没起来：' + lastError)
}

// ---------- 账号 ----------
// 账号与登录态直接在进程里造：走 HTTP 注册会被邀请码与 IP 限流挡住，
// 那两层跟「并发闸门」不是一回事，不该成为压测的噪声。
const SEED_SOURCE = [
  "const { pathToFileURL } = await import('node:url')",
  'const auth = await import(pathToFileURL(process.env.SEED_AUTH).href)',
  'const count = Number(process.env.SEED_COUNT || 10)',
  'const accounts = []',
  'for (let i = 0; i < count; i += 1) {',
  "  const user = auth.createUser({ email: 'loadtest' + i + '@example.invalid', password: 'loadtest-pass-' + i + '-x', name: '压测账号 ' + i })",
  "  const session = auth.createSession(user, { userAgent: 'loadtest', ip: '10.9.0.' + (i + 1) })",
  '  accounts.push({ id: user.id, email: user.email, token: session.token })',
  '}',
  "const admin = auth.createUser({ email: 'loadtest-admin@example.invalid', password: 'loadtest-admin-pass-x', name: '压测管理员', kind: 'admin' })",
  "const adminSession = auth.createSession(admin, { userAgent: 'loadtest', ip: '10.9.0.250' })",
  'console.log(JSON.stringify({ accounts, admin: { id: admin.id, token: adminSession.token } }))',
].join('\n')

function seedAccounts({ dataDir, count, cookieName }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', SEED_SOURCE], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        SEED_AUTH: path.join(ROOT, 'server', 'auth.mjs'),
        SEED_COUNT: String(count),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error('造账号失败（退出码 ' + code + '）：' + (err || out).slice(-800)))
        return
      }
      try {
        const parsed = JSON.parse(String(out).trim().split('\n').pop())
        resolve({
          accounts: parsed.accounts.map((item) => ({ ...item, cookie: cookieName + '=' + item.token })),
          admin: { ...parsed.admin, cookie: cookieName + '=' + parsed.admin.token },
        })
      } catch (error) {
        reject(new Error('造账号的输出解析失败：' + String(error?.message || error) + ' · ' + out.slice(-400)))
      }
    })
  })
}

// ---------- 读数 ----------
function readMeminfo() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const pick = (key) => {
      const hit = text.match(new RegExp('^' + key + ':\\s+(\\d+) kB', 'm'))
      return hit ? Math.round(Number(hit[1]) / 1024) : 0
    }
    const totalMb = pick('MemTotal')
    const availableMb = pick('MemAvailable')
    const swapTotalMb = pick('SwapTotal')
    const swapFreeMb = pick('SwapFree')
    return { totalMb, availableMb, swapUsedMb: Math.max(0, swapTotalMb - swapFreeMb) }
  } catch {
    return null
  }
}

// 进程树 RSS：重活的内存大头常常挂在 ffmpeg 子进程上，只量 Node 进程会系统性低估。
function processTree(pid) {
  const parentOf = new Map()
  const rssOf = new Map()
  let entries = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return null
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    let stat
    try {
      stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8')
    } catch {
      continue
    }
    const close = stat.lastIndexOf(')')
    if (close < 0) continue
    const rest = stat.slice(close + 2).split(' ')
    parentOf.set(Number(name), Number(rest[1]))
    try {
      const status = fs.readFileSync('/proc/' + name + '/status', 'utf8')
      const hit = status.match(/^VmRSS:\s+(\d+) kB/m)
      if (hit) rssOf.set(Number(name), Math.round(Number(hit[1]) / 1024))
    } catch {
      // 进程刚退：跳过
    }
  }
  const tree = []
  const stack = [pid]
  const seen = new Set()
  while (stack.length) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    tree.push(current)
    for (const [child, parent] of parentOf) {
      if (parent === current) stack.push(child)
    }
  }
  return {
    pids: tree.length,
    rssMb: tree.reduce((sum, id) => sum + (rssOf.get(id) || 0), 0),
    children: tree.filter((id) => id !== pid).map((id) => rssOf.get(id) || 0).sort((a, b) => b - a).slice(0, 12),
  }
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarizeStatuses(list) {
  const byStatus = {}
  const byCode = {}
  for (const item of list) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1
    if (item.code) byCode[item.code] = (byCode[item.code] || 0) + 1
  }
  return { byStatus, byCode }
}

// 读数缺失时返回 null 而不是 0：「没量到」和「用了 0 MB」是两件事，报告里要能分开
function memoryPeak(samples, key) {
  const values = samples.map((item) => item && item[key]).filter((value) => Number.isFinite(value))
  return values.length ? values.reduce((max, value) => Math.max(max, value), 0) : null
}

// ---------- 判定 ----------
// 每一条都是压测要回答的问题本身，不是「跑完就算过」：
//   闸门开着时不该放进超过上限的活，被拒的必须是「没开始」而不是「跑到一半失败」；
//   闸门关掉时所有请求都该进来（那一次是量峰值，不是量拒绝）；
//   两种情况下实例都不该死、名额都该还回来、健康探针都不该被打到不可用。
function evaluate({ summary, guard, n, cap }) {
  const problems = []
  const accepted = Number(summary.requests.accepted || 0)
  if (!summary.aliveAfter) problems.push('压测结束后实例已经不在了（进程退出 / 被杀）')
  if (summary.drainedActive !== 0) problems.push('跑完名额没还回来：闸门里还挂着 ' + summary.drainedActive + ' 条')
  if (summary.requests.byStatus['500']) problems.push('出现 ' + summary.requests.byStatus['500'] + ' 个 500：重活失败会退款，但这不是预期路径')
  if (guard === 'off') {
    if (accepted !== n) problems.push('闸门关着却有请求被拒：accepted=' + accepted + ' / n=' + n + '，拒绝原因 ' + JSON.stringify(summary.requests.byCode))
  } else {
    if (accepted > cap) problems.push('放进来的活超过全站上限：accepted=' + accepted + ' > cap=' + cap)
    if (accepted < 1) problems.push('一条都没放进来：闸门可能把正常请求也拒了')
    const unexpected = Object.keys(summary.requests.byCode).filter((code) => ['SERVER_BUSY', 'MEMORY_PRESSURE', 'CONCURRENCY_LIMIT'].indexOf(code) < 0)
    if (unexpected.length) problems.push('被拒的原因不是「名额满 / 水位红线」：' + unexpected.join('、'))
  }
  if (summary.health.max > 5000) problems.push('压测期间健康探针最慢 ' + summary.health.max + ' ms：主线程被打到不可用')
  return { ok: problems.length === 0, problems }
}

// ---------- 主流程 ----------
async function run(options) {
  const startedAt = new Date()
  const dataDir = options.dataDir
  await fsp.mkdir(dataDir, { recursive: true })
  const cookieName = 'vq_session'
  const base = 'http://127.0.0.1:' + options.port

  const fake = await startFakeUpstream({ delayMs: options.upstreamMs })
  const guardEnv = options.guard === 'off'
    ? { VQ_WATER_GUARD: '0', VQ_GLOBAL_HEAVY: '0' }
    : { VQ_GLOBAL_HEAVY: '3' }
  // 评审在独立 worker 里跑（默认）还是退回同进程：两臂只差这一个变量
  guardEnv.VQ_REVIEW_ISOLATE = options.isolate === 'off' ? '0' : '1'
  const server = await startServer({
    dataDir,
    port: options.port,
    env: {
      ...guardEnv,
      VISION_BASE_URL: fake.url,
      VISION_API_KEY: 'loadtest-key',
      VISION_MODEL: 'loadtest-vision',
      LLM_MODEL: 'loadtest-vision',
      VISION_TIMEOUT_MS: '120000',
      // 强制走本地链路：VisionQA 插件服务（若在跑）与远端算力都会让这次量到的不是这台机器。
      // 写成空字符串而不是删掉：config 的 .env 读取只补「未定义」的键，空值能挡住 .env 里的值。
      VISIONQA_SERVICE_URL: 'http://127.0.0.1:9',
      REPLICATE_REMOTE_URL: '',
      VISION_MODELS: '',
      VISION_FALLBACKS: '',
      LLM_FALLBACKS: '',
      NODE_OPTIONS: '--max-old-space-size=' + options.heapMb,
    },
  })
  const cleanup = async () => {
    try { server.child.kill('SIGTERM') } catch (error) { /* 已经退了 */ }
    await sleep(1500)
    try { if (!server.exited) server.child.kill('SIGKILL') } catch (error) { /* 同上 */ }
    await fake.close().catch(() => {})
    if (!options.keep) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  try {
    const health = await waitHealth(base)
    const seed = await seedAccounts({ dataDir, count: options.n, cookieName })
    const nonce = Date.now().toString(36)
    const mediaRel = 'loadtest/' + nonce + '-big.jpg'
    let mediaBytes = 0
    if (options.kind === 'review') {
      await makeTestImage(path.join(dataDir, mediaRel), options.imageMb)
      mediaBytes = (await fsp.stat(path.join(dataDir, mediaRel))).size
    }

    const samples = []
    const healths = []
    const responses = []
    let running = true

    const sampleOnce = async () => {
      const tree = processTree(server.pid)
      const memory = readMeminfo()
      let water = null
      try {
        const response = await fetch(base + '/api/admin/waterline', { headers: { Cookie: seed.admin.cookie }, signal: AbortSignal.timeout(2000) })
        if (response.ok) water = await response.json()
      } catch (error) {
        // 采样失败不影响压测本身
      }
      samples.push({
        t: Date.now(),
        treeRssMb: tree ? tree.rssMb : null,
        treePids: tree ? tree.pids : null,
        childrenRssMb: tree ? tree.children : [],
        availableMb: memory ? memory.availableMb : null,
        totalMb: memory ? memory.totalMb : null,
        swapUsedMb: memory ? memory.swapUsedMb : null,
        heapUsedMb: water && water.heap ? water.heap.heapUsedMb : null,
        heapLimitMb: water && water.heap ? water.heap.heapLimitMb : null,
        heapPercent: water && water.heap ? water.heap.heapPercent : null,
        level: water ? water.level : null,
        active: water && water.heavy ? water.heavy.active : null,
        limit: water && water.heavy ? water.heavy.limit : null,
        full: water && water.heavy ? water.heavy.full : null,
        upstreamConcurrent: fake.stats.concurrent,
      })
    }
    const sampler = (async () => {
      while (running) {
        await sampleOnce()
        await sleep(250)
      }
    })()
    const prober = (async () => {
      while (running) {
        const started = Date.now()
        try {
          const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) })
          healths.push({ ms: Date.now() - started, status: response.status })
        } catch (error) {
          healths.push({ ms: Date.now() - started, status: 0, error: String(error && error.message || error) })
        }
        await sleep(300)
      }
    })()

    // 同时提交：每个账号一条（评审按账号只放 1 条并行），并把 X-Forwarded-For 打散，
    // 避免「每分钟 N 次」的入口限流把并发闸门的结论盖住。
    const submitOne = async (account, index) => {
      const body = options.kind === 'review'
        ? { media: mediaRel, intent: '压测：' + index, label: '压测图' }
        : { url: options.videoUrl, item: { id: 'loadtest-' + nonce + '-' + index, title: '压测视频 ' + index, platform: 'douyin', platformLabel: '抖音', stats: { likes: 0, comments: 0, shares: 0, collects: 0 } } }
      const started = Date.now()
      try {
        const response = await fetch(base + (options.kind === 'review' ? '/api/review' : '/api/replicate'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: account.cookie,
            'X-Forwarded-For': '10.9.0.' + (index + 1),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(60000, options.timeoutSec * 1000)),
        })
        const text = await response.text()
        let parsed = null
        try { parsed = JSON.parse(text) } catch (error) { parsed = null }
        responses.push({
          index,
          status: response.status,
          code: (parsed && parsed.code) || '',
          error: parsed && parsed.error ? String(parsed.error).slice(0, 160) : '',
          ms: Date.now() - started,
          jobId: (parsed && parsed.jobId) || null,
        })
      } catch (error) {
        responses.push({ index, status: 0, code: 'NETWORK', error: String(error && error.message || error).slice(0, 160), ms: Date.now() - started })
      }
    }
    const submitStarted = Date.now()
    await Promise.all(seed.accounts.map((account, index) => submitOne(account, index)))
    const submitMs = Date.now() - submitStarted

    // replicate 是异步任务：等每条真的跑完（或超时）再收读数，否则「在跑」的峰值会被提前关掉。
    const jobs = []
    if (options.kind === 'replicate') {
      const deadline = Date.now() + options.timeoutSec * 1000
      const pending = new Map(responses.filter((item) => item.jobId).map((item) => [item.jobId, item]))
      while (pending.size && Date.now() < deadline) {
        for (const jobId of [...pending.keys()]) {
          try {
            const response = await fetch(base + '/api/jobs/' + jobId, { headers: { Cookie: seed.admin.cookie }, signal: AbortSignal.timeout(3000) })
            if (!response.ok) continue
            const job = await response.json()
            if (job.status === 'done' || job.status === 'error') {
              jobs.push({ jobId, status: job.status, step: job.step, ms: Date.now() - Date.parse(job.createdAt || Date.now()), error: job.error || null })
              pending.delete(jobId)
            }
          } catch (error) {
            // 下一次再查
          }
        }
        if (pending.size) await sleep(500)
      }
      for (const jobId of pending.keys()) jobs.push({ jobId, status: 'timeout', step: '', ms: 0, error: '未在 ' + options.timeoutSec + ' 秒内收尾' })
    }

    // 收尾后再量一次：名额还回来了没有、实例还活着没有
    await sleep(1500)
    running = false
    await Promise.all([sampler, prober])
    let aliveAfter = false
    let drainedActive = null
    let waterAfter = null
    try {
      const response = await fetch(base + '/api/admin/waterline', { headers: { Cookie: seed.admin.cookie }, signal: AbortSignal.timeout(3000) })
      if (response.ok) {
        waterAfter = await response.json()
        aliveAfter = true
        drainedActive = waterAfter.heavy ? waterAfter.heavy.active : null
      }
    } catch (error) {
      aliveAfter = false
    }

    // 隔离层自己的计数：这一轮到底有几单进了 worker（/api/review/health 只读，不扣费）
    let isolateAfter = null
    if (options.kind === 'review') {
      try {
        const response = await fetch(base + '/api/review/health', { headers: { Cookie: seed.admin.cookie }, signal: AbortSignal.timeout(3000) })
        if (response.ok) isolateAfter = (await response.json()).isolate || null
      } catch (error) {
        // 量不到就空着，不编数字
      }
    }

    const statuses = summarizeStatuses(responses)
    const observedLimit = waterAfter && waterAfter.heavy ? waterAfter.heavy.configLimit : null
    const finite = (values) => values.filter((value) => Number.isFinite(value))
    const summary = {
      arm: options.label,
      kind: options.kind,
      guard: options.guard,
      n: options.n,
      upstreamMs: options.upstreamMs,
      heapMb: options.heapMb,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      submitMs,
      templateCount: health ? health.templates : null,
      mediaBytes,
      videoUrl: options.kind === 'replicate' ? options.videoUrl : null,
      requests: {
        total: responses.length,
        accepted: responses.filter((item) => item.status === 200).length,
        rejected: responses.filter((item) => item.status !== 200).length,
        byStatus: statuses.byStatus,
        byCode: statuses.byCode,
        durations: responses.map((item) => item.ms),
        rejectedExamples: responses.filter((item) => item.status !== 200).slice(0, 3),
      },
      jobs,
      jobsDone: jobs.filter((item) => item.status === 'done').length,
      upstream: { calls: fake.stats.calls, peakConcurrent: fake.stats.peakConcurrent, byPath: fake.stats.byPath },
      memory: {
        source: samples.some((item) => item.treeRssMb !== null) ? 'proc' : 'unavailable',
        baselineTreeRssMb: samples[0] ? samples[0].treeRssMb : null,
        peakTreeRssMb: memoryPeak(samples, 'treeRssMb'),
        peakChildRssMb: memoryPeak(samples.map((item) => ({ child: (item.childrenRssMb || []).reduce((sum, value) => sum + value, 0) })), 'child'),
        peakHeapUsedMb: memoryPeak(samples, 'heapUsedMb'),
        peakHeapPercent: memoryPeak(samples, 'heapPercent'),
        heapLimitMb: (samples.find((item) => item.heapLimitMb) || {}).heapLimitMb || null,
        minAvailableMb: finite(samples.map((item) => item.availableMb)).reduce((min, value) => Math.min(min, value), Infinity),
        baselineAvailableMb: samples[0] ? samples[0].availableMb : null,
        peakSwapUsedMb: memoryPeak(samples, 'swapUsedMb'),
        totalMb: samples[0] ? samples[0].totalMb : null,
      },
      waterline: {
        levels: samples.reduce((acc, item) => {
          if (!item.level) return acc
          acc[item.level] = (acc[item.level] || 0) + 1
          return acc
        }, {}),
        maxActive: memoryPeak(samples, 'active'),
        limitSeen: [...new Set(samples.map((item) => item.limit).filter((value) => value !== null))],
      },
      health: {
        count: healths.length,
        p50: percentile(healths.map((item) => item.ms), 50),
        p95: percentile(healths.map((item) => item.ms), 95),
        max: healths.reduce((max, item) => Math.max(max, item.ms), 0),
        failures: healths.filter((item) => item.status !== 200).length,
      },
      isolate: options.kind === 'review' ? { mode: options.isolate, report: isolateAfter } : null,
      aliveAfter,
      drainedActive,
      observedLimit,
      afterHeapUsedMb: waterAfter && waterAfter.heap ? waterAfter.heap.heapUsedMb : null,
      afterLevel: waterAfter ? waterAfter.level : null,
    }
    const verdict = evaluate({ summary, guard: options.guard, n: options.n, cap: Number(observedLimit) || 3 })
    summary.verdict = verdict
    if (options.keepSamples) summary.samples = samples
    return { summary, dataDir, logs: server.logs, child: server.child }
  } finally {
    await cleanup()
    if (options.keep) console.log('数据目录已保留（实例已停）：' + dataDir)
  }
}

// 压测用的图：本机生成、不从网上拉 —— 图的内容不重要，「多大、要不要编码」才影响内存。
async function makeTestImage(file, sizeMb) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const ffmpeg = await ffmpegPath()
  const target = Math.round(sizeMb * MB)
  // 底图固定 1200x1200（q=2 约 0.5~1 MB），再在尾部填充到目标大小。
  // 为什么不按像素估：JPEG 每像素多少字节跟画面噪声强相关，估出来的边长大一倍都很常见；
  // 而服务端与假上游都不解码这张图，只把它读成字节再 base64 ——「文件多大」才是要量的东西。
  await runOnce(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=1200x1200,noise=alls=12:allf=t',
    '-frames:v', '1', '-q:v', '2', file,
  ])
  const stat = await fsp.stat(file)
  if (!stat.size) throw new Error('压测图生成失败：' + file)
  if (stat.size > target) throw new Error('--image-mb=' + sizeMb + ' 比底图（' + Math.round(stat.size / 1024) + ' KB）还小，调大一点')
  await fsp.appendFile(file, Buffer.alloc(target - stat.size, 0))
  const final = await fsp.stat(file)
  if (final.size !== target) throw new Error('压测图大小不对：' + final.size + ' / ' + target)
  return final.size
}

async function ffmpegPath() {
  const mod = await import('ffmpeg-static')
  return path.resolve(String(mod.default || mod))
}

function runOnce(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(file + ' 退出码 ' + code + '：' + err.slice(-400)))))
    child.on('error', reject)
  })
}

function readOptions(argv) {
  const args = parseArgs(argv)
  const kind = args.kind === 'replicate' ? 'replicate' : 'review'
  const n = Math.max(1, Math.min(40, Number(args.n || 10)))
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  const guard = args.guard === 'off' ? 'off' : 'on'
  return {
    kind,
    n,
    guard,
    upstreamMs: Math.max(0, Math.min(120000, Number(args['upstream-ms'] || 4000))),
    imageMb: Math.max(0.1, Math.min(40, Number(args['image-mb'] || 2.5))),
    heapMb: Math.max(128, Math.min(4096, Number(args['heap-mb'] || 384))),
    videoUrl: args['video-url'] || 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4',
    port: Math.max(1024, Math.min(65000, Number(args.port || 8798))),
    dataDir: path.resolve(String(args['data-dir'] || path.join(ROOT, '.tmp-qa', 'loadtest-' + stamp))),
    timeoutSec: Math.max(20, Math.min(1800, Number(args['timeout-sec'] || 180))),
    out: args.out ? path.resolve(String(args.out)) : '',
    keep: args.keep === 'true',
    keepSamples: args['keep-samples'] === 'true',
    // 评审隔离开关（v0.9.77）：默认开；--isolate=off 量「退回同进程」那一臂
    isolate: args.isolate === 'off' ? 'off' : 'on',
    label: String(args.label || (kind + '-n' + n + '-guard-' + guard + (args.isolate === 'off' ? '-iso-off' : ''))),
  }
}

function formatReport(summary) {
  const m = summary.memory
  const mb = (value) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value + ' MB')
  const lines = []
  lines.push('· ' + summary.arm + '：' + summary.kind + ' · ' + summary.n + ' 并发 · 闸门' + (summary.guard === 'on' ? '开' : '关') + ' · 假上游 ' + summary.upstreamMs + ' ms · 堆上限 ' + summary.heapMb + ' MB')
  lines.push('  请求：' + JSON.stringify(summary.requests.byStatus) + ' · 拒绝原因 ' + JSON.stringify(summary.requests.byCode))
  lines.push('  放进来 ' + summary.requests.accepted + ' 条 / 共 ' + summary.requests.total + ' 条；实例回报的全站上限 ' + summary.observedLimit)
  if (summary.jobs.length) lines.push('  任务：' + summary.jobsDone + ' / ' + summary.jobs.length + ' 跑完 · ' + JSON.stringify(summary.jobs.map((item) => item.status)))
  lines.push('  内存：进程树峰值 ' + mb(m.peakTreeRssMb) + '（基线 ' + mb(m.baselineTreeRssMb) + '，子进程合计峰值 ' + mb(m.peakChildRssMb) + '）')
  lines.push('  V8 堆：峰值 ' + mb(m.peakHeapUsedMb) + ' / 上限 ' + mb(m.heapLimitMb) + '（' + m.peakHeapPercent + '%）')
  lines.push('  系统：可用内存最低 ' + mb(m.minAvailableMb) + ' / 共 ' + mb(m.totalMb) + '，交换已用峰值 ' + mb(m.peakSwapUsedMb))
  lines.push('  闸门：在跑峰值 ' + summary.waterline.maxActive + ' 条 · 水位档位 ' + JSON.stringify(summary.waterline.levels) + ' · 假上游并发峰值 ' + summary.upstream.peakConcurrent)
  lines.push('  健康探针：p50 ' + summary.health.p50 + ' ms / p95 ' + summary.health.p95 + ' ms / 最慢 ' + summary.health.max + ' ms（失败 ' + summary.health.failures + '）')
  if (summary.isolate) {
    const report = summary.isolate.report
    lines.push('  评审隔离：' + (summary.isolate.mode === 'on' ? '开（独立 worker）' : '关（同进程）') + (report ? ' · 进 worker ' + report.runs + ' 单（成功 ' + report.ok + ' / 失败 ' + report.failed + '）· 堆上限 ' + report.heapMb + ' MB' : ' · 没读到计数'))
  }
  lines.push('  收尾：实例存活 ' + (summary.aliveAfter ? '是' : '否') + ' · 名额还回 ' + (summary.drainedActive === 0 ? '是' : '否（剩 ' + summary.drainedActive + '）'))
  lines.push('  判定：' + (summary.verdict.ok ? '通过' : '不通过 · ' + summary.verdict.problems.join('；')))
  return lines.join('\n')
}

if (IS_MAIN) {
  const options = readOptions(process.argv.slice(2))
  let result
  try {
    result = await run(options)
  } catch (error) {
    console.error('压测没跑起来：' + (error && error.stack || error))
    process.exit(2)
  }
  const outPath = options.out || path.join(ROOT, '.tmp-qa', 'result-' + options.label + '.json')
  await fsp.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {})
  await fsp.writeFile(outPath, JSON.stringify(result.summary, null, 2)).catch(() => {})
  console.log(formatReport(result.summary))
  console.log('  结果 JSON：' + outPath)
  if (!result.summary.verdict.ok) {
    console.log('  实例日志（最后 24 行）：' + '\n' + result.logs())
    process.exit(1)
  }
  process.exit(0)
}

export { evaluate, formatReport, memoryPeak, parseArgs, percentile, summarizeStatuses }
