#!/usr/bin/env node
// 1b 端到端自检：真服务 + 真 SQLite + 真连接器 + 假 agent，验证「人说话 → 连接器 → 房间回话」。
//
// 不起真实上游、不花钱：本地 agent 是一个读 stdin 就回话的小脚本。
// 用法：node scripts/visionchat-e2e.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-1b-e2e-'))
// 假的本地 agent 现写现用：脚本自己就该是自足的，不依赖仓库里某个临时文件
const fakeAgent = path.join(dataDir, 'fake-agent.mjs')
fs.writeFileSync(fakeAgent, [
  'let input = ""',
  'process.stdin.on("data", (chunk) => { input += chunk })',
  'process.stdin.on("end", () => {',
  '  const lines = input.split("\\n").map((line) => line.trim()).filter(Boolean)',
  '  const body = lines.find((line) => !line.startsWith("你在 ") && !line.startsWith("房间") && !line.startsWith("直接给")) || lines[0] || ""',
  '  process.stdout.write("收到：" + body)',
  '})',
  '',
].join('\n'))
process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = 'e2e-secret'
process.env.VQ_REQUIRE_AUTH = '1'

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const alive = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(500) }).then(() => true).catch(() => false)
    if (!alive) return port
  }
  throw new Error('找不到空闲端口')
}

const PORT = await freePort(8991)
const BASE = 'http://127.0.0.1:' + PORT

const auth = await import('../server/auth.mjs')
const rooms = await import('../server/rooms.mjs')
const access = await import('../server/agent-access.mjs')

const AT = String.fromCharCode(64)
const user = auth.createUser({ email: 'e2e' + AT + 'vq.test', password: 'Passw0rd!e2e', name: '主人', kind: 'account' })
const cookie = auth.sessionCookie(auth.createSession(user, { userAgent: 'e2e', ip: '127.0.0.1' }).token).split(';')[0]
const room = rooms.createRoom({ userId: user.id, name: '端到端房间', memberName: user.name })
const code = access.createPairCode({ roomId: room.id, userId: user.id })
const paired = access.pairWithCode({ code: code.code, name: '本地 codex', provider: 'codex' })
const tokenFile = path.join(dataDir, 'token')
fs.writeFileSync(tokenFile, paired.token, { mode: 0o600 })

const server = spawn(process.execPath, ['server/index.mjs'], {
  env: { ...process.env, API_PORT: String(PORT), VQ_REDFOX_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk })
server.stderr.on('data', (chunk) => { serverLog += chunk })

const connector = spawn(process.execPath, [
  path.join('scripts', 'visionchat-connect.mjs'),
  '--base', BASE,
  '--token-file', tokenFile,
  // 路径里有空格（C:\Program Files\nodejs\…），走 shell 必须自己加引号
  '--exec', '"' + process.execPath + '" "' + fakeAgent + '"',
  '--timeout', '20',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let connLog = ''
connector.stdout.on('data', (chunk) => { connLog += chunk })
connector.stderr.on('data', (chunk) => { connLog += chunk })

async function waitFor(check, label, ms = 30000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await sleep(300)
  }
  throw new Error('等待超时：' + label + '\n连接器日志：' + connLog + '\n服务端日志：' + serverLog.slice(-600))
}

let failed = false
try {
  await waitFor(async () => (await fetch(BASE + '/api/health').then((r) => r.ok).catch(() => false)), '实例健康')
  await waitFor(() => connLog.includes('已接入房间'), '连接器接入')
  console.log('[1] 连接器接入成功：' + connLog.split('\n').filter((line) => line.includes('已接入'))[0])

  const posted = await fetch(BASE + '/api/rooms/' + room.id + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ body: '开场先给三个钩子，选一个' }),
  })
  if (!posted.ok) throw new Error('人发消息失败：' + posted.status)

  await waitFor(() => connLog.includes('回了 #'), '连接器回话', 40000)
  console.log('[2] 连接器收到并回话：' + connLog.split('\n').filter((line) => line.includes('收到 #') || line.includes('回了')).join(' | '))

  const list = await fetch(BASE + '/api/rooms/' + room.id + '/messages?limit=10', { headers: { cookie } }).then((r) => r.json())
  const agentMessage = (list.items || []).find((item) => item.senderKind === 'agent')
  if (!agentMessage) throw new Error('房间里没有智能体的消息：' + JSON.stringify(list).slice(0, 300))
  if (!agentMessage.body.startsWith('收到：')) throw new Error('回话内容不对：' + agentMessage.body)
  if (agentMessage.senderName !== '本地 codex') throw new Error('署名不对：' + agentMessage.senderName)
  console.log('[3] 房间里真有一条智能体消息 #' + agentMessage.seq + ' · ' + agentMessage.senderName + ' · ' + agentMessage.body.slice(0, 30))

  // MCP：同一条令牌换工具口
  const init = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + paired.token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  }).then((r) => r.json())
  if (init.result?.serverInfo?.name !== 'visionchat') throw new Error('MCP initialize 不对：' + JSON.stringify(init))
  const tools = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + paired.token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  }).then((r) => r.json())
  console.log('[4] MCP 工具：' + tools.result.tools.map((tool) => tool.name).join(', '))

  // 授权说明可读，且不含令牌
  const guide = await fetch(BASE + '/visionchat.md').then((r) => r.text())
  if (!guide.includes('/api/agent/pair')) throw new Error('/visionchat.md 里没有配对说明')
  if (guide.includes(paired.token)) throw new Error('/visionchat.md 泄露了令牌')
  console.log('[5] /visionchat.md ' + guide.length + ' 字符，含配对说明，不含令牌')

  // 撤销令牌之后连接器要停
  const revoked = await fetch(BASE + '/api/agent/token', { method: 'DELETE', headers: { Authorization: 'Bearer ' + paired.token } })
  if (!revoked.ok) throw new Error('撤销失败：' + revoked.status)
  // 撤销发生在一次长轮询中途：那一轮会照常返回，下一轮才 401，所以最多等 40 秒
  await waitFor(() => connLog.includes('令牌无效或已被撤销'), '撤销后连接器退出', 45000)
  console.log('[6] 撤销令牌后连接器拿到 401 并退出')
} catch (error) {
  failed = true
  console.error('✖ ' + String(error.message || error))
} finally {
  connector.kill()
  server.kill()
  await sleep(300)
  // Windows 上 SQLite 句柄收得慢，删不掉不算失败
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* 临时目录留给系统清 */
  }
}
if (failed) process.exit(1)
console.log('E2E 全绿：人说话 → 连接器 → 房间回话 → MCP → 撤销即停')
