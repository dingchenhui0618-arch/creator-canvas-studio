// 统一日志与进程兜底。
// 以前这个服务只有零散的 console.log：请求没有一行访问日志，进程级异常根本没有监听，
// 一旦有未捕获异常就是「服务还在占着端口、但请求全挂」，运维看不到任何线索。
// 这里给出三件事：
//   1) 每请求一行 JSON 访问日志（方法、路径、状态码、耗时、账号、IP、请求 id）
//   2) 5xx 额外打一条带堆栈的错误日志，响应体里带同一个 traceId，方便按 id 反查
//   3) unhandledRejection / uncaughtException 的兜底（后者记完日志退出，交给 systemd 重启）
import crypto from 'node:crypto'

const DISABLED = String(process.env.VQ_ACCESS_LOG || '1') === '0'

// 最近请求与错误的环形缓冲：只给内部环境的「排查信息」用，不落盘、不对外。
// 上限刻意很小（400 条请求 / 60 条错误），常驻内存只有几百 KB，重启即清空。
const ACCESS_LIMIT = 400
const ERROR_LIMIT = 60
const accessRing = []
const errorRing = []
let accessTotal = 0
let errorTotal = 0

function pushRing(ring, limit, item) {
  ring.push(item)
  if (ring.length > limit) ring.splice(0, ring.length - limit)
}

export function newTraceId() {
  return crypto.randomBytes(6).toString('hex')
}

function stamp() {
  return new Date().toISOString()
}

function line(fields) {
  // 单行 JSON：journalctl / grep 都能直接用，不需要解析多行块
  return JSON.stringify({ at: stamp(), ...fields })
}

export function logEvent(name, fields = {}) {
  console.log(line({ t: name, ...fields }))
}

export function startAccess(req, res, { ip = '' } = {}) {
  const traceId = newTraceId()
  const trace = { traceId, userId: '' }
  const startedAt = process.hrtime.bigint()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    if (DISABLED) return
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    const url = String(req.url || '/')
    // 健康检查/静态资源刷屏没意义，压成 debug 级别的一行（仍然记录，方便排障）
    const quiet = url === '/api/health' || /^\/(assets|brand|fonts)\//.test(url)
    if (quiet && res.statusCode < 500) return
    const entry = {
      at: stamp(),
      id: traceId,
      m: req.method,
      p: url.split('?')[0],
      s: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      u: trace.userId,
      ip,
    }
    accessTotal += 1
    pushRing(accessRing, ACCESS_LIMIT, entry)
    // 路由自己 catch 的 500 不会走 logRequestError（例如评审失败），这里按状态码补一条，
    // 否则「最近错误」会漏掉最需要看的那类失败；已经有同 id 的堆栈就不重复记。
    if (res.statusCode >= 500 && !errorRing.some((item) => item.id === traceId)) {
      errorTotal += 1
      pushRing(errorRing, ERROR_LIMIT, {
        at: stamp(),
        id: traceId,
        msg: 'HTTP ' + res.statusCode + ' ' + req.method + ' ' + url.split('?')[0],
        scope: 'http',
      })
    }
    console.log(line({ t: 'access', ...entry }))
  }
  res.on('finish', finish)
  res.on('close', finish)
  return trace
}

export function logRequestError(traceId, error, extra = {}) {
  const detail = error && (error.stack || error.message) ? (error.stack || error.message) : String(error)
  const entry = { at: stamp(), id: traceId, msg: String(detail).slice(0, 4000), ...extra }
  errorTotal += 1
  pushRing(errorRing, ERROR_LIMIT, { ...entry, msg: entry.msg.slice(0, 1200) })
  console.error(line({ t: 'error', ...entry }))
}

// 内部环境排障用：返回最近请求与错误，以及本次启动以来的总条数（缓冲会丢旧条目，总数不会）
export function diagnosticsLogs({ access = 120, errors = 30 } = {}) {
  return {
    access: accessRing.slice(-Math.max(1, access)),
    errors: errorRing.slice(-Math.max(1, errors)),
    totals: { access: accessTotal, errors: errorTotal },
    limits: { access: ACCESS_LIMIT, errors: ERROR_LIMIT },
  }
}

// 进程级兜底：未处理的 Promise 拒绝只记录下来（多半是某个后台任务失败），
// 未捕获异常记完整堆栈后退出，让 systemd 用一个干净的进程接管，而不是留在半坏状态。
export function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    logRequestError('', reason, { scope: 'unhandledRejection' })
  })
  process.on('uncaughtException', (error) => {
    logRequestError('', error, { scope: 'uncaughtException' })
    // 给日志一点刷盘时间再退出；systemd Restart=always 会在 1 秒内拉起
    setTimeout(() => process.exit(1), 200)
  })
}