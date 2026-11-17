// 接通体检：每个上游通道只真实调用一次，不重试、不换把（用户 2026-11-17 要求）。
// 运行方式（生产机）：
//   set -a; . /opt/visionqa/.env; set +a
//   sudo -u visionqa node --experimental-sqlite scripts/connectivity-once.mjs
// 结果写到 /var/lib/visionqa/connectivity-<时间戳>.json，并在 stdout 打一张表。
// 注意：会真实产生费用 —— 出图 1 次（$0.048）、出视频 1 次（约 ¥1.4）。
import fs from 'node:fs'
import path from 'node:path'

const startedAt = new Date()
const checks = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function record(name, ok, detail = {}) {
  const row = { name, ok: Boolean(ok), at: new Date().toISOString(), ...detail }
  checks.push(row)
  const badge = row.ok ? 'OK  ' : 'FAIL'
  const extra = row.error ? ' | ' + String(row.error).slice(0, 140) : row.ms ? ' | ' + row.ms + 'ms' : ''
  console.log('[' + badge + '] ' + name + extra)
  return row
}

async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function httpGet(url, ms = 10000) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    return { status: response.status, text: text.slice(0, 400), ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

const keyvault = await import('../server/keyvault.mjs')
const gateway = await import('../server/gateway.mjs')
const chat = await import('../server/chatcall.mjs')
const mailConfig = await import('../server/mail-config.mjs')
const mailer = await import('../server/mailer.mjs')
const { config } = await import('../server/config.mjs')

// 1) 每个启用中的 Key：后台「测试」用的同一条路径（文本/视觉真调一次 max_tokens=1 的 ping，
//    出图/视频只探凭证，避免这里变成第二个花钱的地方）
const keys = keyvault.listKeys().items.filter((item) => item.enabled)
for (const key of keys) {
  try {
    const result = await withTimeout(keyvault.testKey(key.id), 45000, 'Key 自检')
    record('Key · ' + key.name, result.ok, {
      mode: result.mode,
      model: result.model,
      status: result.status,
      ms: result.ms,
      error: result.ok ? '' : result.error || result.upstreamError || '自检未通过',
    })
  } catch (error) {
    record('Key · ' + key.name, false, { error: String(error?.message || error) })
  }
}

// 2) 本机与画布服务的 HTTP 面
for (const [name, url] of [
  ['VisionQA 健康', 'http://127.0.0.1:8799/api/health'],
  ['VisionQA 版本', 'http://127.0.0.1:8799/api/version'],
  ['画布企业服务', 'http://127.0.0.1:5313/enterprise/api/auth/mode'],
  ['画布 API', 'http://127.0.0.1:5312/api/health'],
  ['画布 Web', 'http://127.0.0.1:6677/'],
]) {
  try {
    const result = await httpGet(url)
    record(name, result.status < 500, { status: result.status, ms: result.ms, body: result.text.slice(0, 160) })
  } catch (error) {
    record(name, false, { error: String(error?.message || error) })
  }
}

// 3) 文本：主模型一次真实 chat
let textModel = config.llm.model
try {
  const result = await withTimeout(
    chat.chatCompletion({ model: textModel, messages: [{ role: 'user', content: '只回复两个字：接通' }], maxTokens: 16, capability: 'text', maxKeys: 1 }),
    60000,
    '文本调用',
  )
  record('文本 · ' + textModel, Boolean(result && result.text), { ms: result?.ms, body: String(result?.text || '').slice(0, 40) })
} catch (error) {
  record('文本 · ' + textModel, false, { error: String(error?.message || error) })
}

// 4) 视觉：同一模型带一张 1x1 PNG（真实多模态请求）
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let visionModel = config.vision.model
try {
  const result = await withTimeout(
    chat.chatCompletion({
      model: visionModel,
      messages: [{ role: 'user', content: [{ type: 'text', text: '这张图是什么颜色？只回两个字。' }, { type: 'image_url', image_url: { url: PIXEL } }] }],
      maxTokens: 24,
      capability: 'vision',
      maxKeys: 1,
    }),
    90000,
    '视觉调用',
  )
  record('视觉 · ' + visionModel, Boolean(result && result.text), { ms: result?.ms, body: String(result?.text || '').slice(0, 40) })
} catch (error) {
  record('视觉 · ' + visionModel, false, { error: String(error?.message || error) })
}

// 5) GeteAPI 的 GPT 文本（备用通道）：真实一次
try {
  const result = await withTimeout(
    chat.chatCompletion({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: '只回复两个字：接通' }], maxTokens: 16, capability: 'text', maxKeys: 1 }),
    90000,
    'Gete 文本',
  )
  record('文本 · GeteAPI gpt-5.6-luna', Boolean(result && result.text), { ms: result?.ms, body: String(result?.text || '').slice(0, 40) })
} catch (error) {
  record('文本 · GeteAPI gpt-5.6-luna', false, { error: String(error?.message || error) })
}

// 6) 出图：GeteAPI GPT Image 2，真实一张（1024x1024）
try {
  const result = await withTimeout(
    gateway.generateImage({ model: 'gpt-image-2', prompt: '一张纯白背景、正中一个 32px 灰色圆点，极简，无文字', size: '1024x1024', n: 1 }),
    240000,
    '出图',
  )
  const data = Array.isArray(result?.data) ? result.data : []
  const hasImage = data.some((item) => item?.b64_json || item?.url)
  record('出图 · GeteAPI gpt-image-2', Boolean(result?.ok) && hasImage, {
    ms: result?.ms,
    items: data.length,
    first: data[0]?.url ? 'url' : data[0]?.b64_json ? 'b64 ' + String(data[0].b64_json).length + ' 字符' : '无',
  })
} catch (error) {
  record('出图 · GeteAPI gpt-image-2', false, { error: String(error?.message || error) })
}

// 7) 出视频：SeeAPI Seedance 2.0，480p / 4 秒，真实一次；提交后每 5 秒轮询，最长 8 分钟
try {
  const created = await withTimeout(
    gateway.createVideoTask({ model: 'seedance-2.0', prompt: '一只白色陶瓷杯在木桌上缓慢旋转，纯色背景，无文字', duration: 4, resolution: '480p' }),
    120000,
    '建视频任务',
  )
  const taskId = String(created?.id || '')
  if (!taskId) throw new Error('上游没有返回任务 id：' + JSON.stringify(created).slice(0, 160))
  const deadline = Date.now() + 8 * 60 * 1000
  let last = null
  let status = ''
  while (Date.now() < deadline) {
    await sleep(5000)
    last = await withTimeout(gateway.pollVideoTask(taskId), 60000, '轮询视频')
    status = String(last?.status || '')
    if (['succeeded', 'failed', 'refunded', 'canceled'].includes(status)) break
  }
  const url = String(last?.video_url || last?.url || last?.data?.[0]?.url || '')
  record('出视频 · SeeAPI seedance-2.0', status === 'succeeded', {
    taskId,
    status,
    ms: Date.now() - startedAt.getTime(),
    video: url ? 'url ' + url.slice(0, 120) : '无链接',
    error: status === 'succeeded' ? '' : String(last?.error?.message || '没有在 8 分钟内拿到终态'),
  })
} catch (error) {
  record('出视频 · SeeAPI seedance-2.0', false, { error: String(error?.message || error) })
}

// 8) 邮件通道：只做 SMTP 握手验证，不发信、不碰收件人
try {
  const resolved = await mailConfig.resolveMail()
  if (!resolved || !resolved.smtp || !resolved.smtp.host) {
    record('邮件通道', false, { error: '未配置（data/mail.json 与环境变量都没有）' })
  } else {
    const verified = await withTimeout(mailer.verifySmtp(resolved.smtp), 20000, 'SMTP 握手')
    record('邮件通道', verified.ok !== false, { host: resolved.smtp.host, port: resolved.smtp.port, body: JSON.stringify(verified).slice(0, 120) })
  }
} catch (error) {
  record('邮件通道', false, { error: String(error?.message || error) })
}

// 9) 平台网关自述
try {
  const status = gateway.gatewayStatus()
  record('平台生成通道', Boolean(status), { body: JSON.stringify(status).slice(0, 300) })
} catch (error) {
  record('平台生成通道', false, { error: String(error?.message || error) })
}

const report = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  version: (() => {
    try {
      return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    } catch {
      return 'unknown'
    }
  })(),
  pass: checks.filter((item) => item.ok).length,
  fail: checks.filter((item) => !item.ok).length,
  checks,
}
const out = path.join(config.dataDir, 'connectivity-' + startedAt.toISOString().replace(/[:.]/g, '-') + '.json')
fs.writeFileSync(out, JSON.stringify(report, null, 2))
console.log('\n通过 ' + report.pass + ' / 失败 ' + report.fail + '，报告：' + out)
