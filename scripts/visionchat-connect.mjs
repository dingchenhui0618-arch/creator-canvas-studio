#!/usr/bin/env node
// VisionChat 本地连接器（r315 一期 1b，可选加速器）。
//
// 作用：用房间令牌（vqc_...）长轮询收件箱，收到消息就交给本机的一个命令执行，
// 把它的 stdout 回传到房间里。平台只发消息、只收文本——它不会把任何命令下到这台机器，
// 也不会探到这台机器上有什么。
//
// 用法（把令牌存进权限 0600 的文件，别贴在命令行里，命令行会进 shell history）：
//   node scripts/visionchat-connect.mjs \
//     --base https://visionqa.wavisionai.cn \
//     --token-file ~/.visionchat/token \
//     --exec "claude -p"
//
// 命令从 stdin 读提示词、把回答写 stdout。常见搭配：
//   --exec "codex exec -"        codex 的 exec 模式
//   --exec "claude -p"           Claude Code 一次性输出
//   --exec "workbuddy run -"     你自己的 agent CLI
//
// 参数：
//   --base <url>         服务地址，默认 https://visionqa.wavisionai.cn
//   --token-file <path>  令牌文件（推荐）；也接受 VQC_TOKEN 环境变量
//   --exec <command>     必填，执行命令（从 stdin 读提示词）
//   --timeout <sec>      单条消息最长执行多久，默认 120
//   --once               只拉一轮（给 cron / 计划任务用），处理完就退出
//   --quiet              只打印错误
//
// 边界（与文档一致）：同一令牌同时只处理一条消息；自己的发言不会回灌给自己；
// 令牌只对这一个房间有效，撤回/移出房间后立刻 401。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)

function flag(name, fallback = '') {
  const index = args.indexOf('--' + name)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : 'true'
}

const BASE = String(flag('base', 'https://visionqa.wavisionai.cn')).replace(/\/+$/, '')
const TOKEN_FILE = flag('token-file', '')
const EXEC = flag('exec', '')
const TIMEOUT_SEC = Math.max(10, Number(flag('timeout', '120')) || 120)
const ONCE = flag('once', 'false') === 'true'
const QUIET = flag('quiet', 'false') === 'true'
const WAIT_SEC = 25

function log(...parts) {
  if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...parts)
}

function fail(message) {
  console.error('连接器：' + message)
  process.exit(1)
}

function readToken() {
  if (process.env.VQC_TOKEN) return process.env.VQC_TOKEN.trim()
  if (!TOKEN_FILE) fail('要给 --token-file <path>（或设 VQC_TOKEN 环境变量）')
  const expanded = TOKEN_FILE.startsWith('~') ? path.join(os.homedir(), TOKEN_FILE.slice(1)) : TOKEN_FILE
  if (!fs.existsSync(expanded)) fail('找不到令牌文件：' + expanded)
  // Windows 上没有 POSIX 权限位，这条只在 Linux / macOS 上检查
  if (process.platform !== 'win32') {
    const stat = fs.statSync(expanded)
    if ((stat.mode & 0o077) !== 0) console.warn('警告：令牌文件权限不是 0600，别人能读到；建议 chmod 600 ' + expanded)
  }
  const token = fs.readFileSync(expanded, 'utf8').trim()
  if (!token.startsWith('vqc_')) fail('令牌格式不对：应该是 vqc_ 开头')
  return token
}

const TOKEN = readToken()
if (!EXEC) fail('要给 --exec "<命令>"，命令从 stdin 读提示词')

async function api(pathname, options = {}) {
  const response = await fetch(BASE + pathname, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  if (response.status === 401) {
    fail('令牌无效或已被撤销（401）。让主人在房间里重新接入，再换一份令牌文件。')
  }
  if (!response.ok) {
    throw new Error((data && (data.error || data.code)) || 'HTTP ' + response.status)
  }
  return data
}

/** 跑一条命令：提示词走 stdin，回答取 stdout。超时就杀掉，不把机器拖死。 */
function runExec(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXEC, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
      reject(new Error('超过 ' + TIMEOUT_SEC + ' 秒没有回答'))
    }, TIMEOUT_SEC * 1000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (code !== 0 && !out.trim()) {
        reject(new Error('命令退出码 ' + code + (err ? '：' + err.trim().split('\n').slice(-1)[0] : '')))
        return
      }
      resolve(out.trim())
    })
    // 给命令一段上下文：谁说的、在哪个房间
    child.stdin.end(prompt)
  })
}

let me = null
let cursor = 0
let stopped = false

async function handleMessage(message) {
  const prompt = [
    '你在 VisionQA 的一个聊天室「' + (me?.room?.name || '') + '」里，成员名是「' + (me?.member?.name || '') + '」。',
    '房间里的人刚说：',
    message.body,
    '',
    '直接给出你要回的话（纯文本，不要加前后缀说明，不要贴命令）。',
  ].join('\n')
  log('收到 #' + message.seq + ' ← ' + message.senderName + '（' + message.body.slice(0, 40) + '）')
  let reply = ''
  try {
    reply = await runExec(prompt)
  } catch (error) {
    reply = '（' + (me?.member?.name || '我') + ' 没能回话：' + String(error.message || error) + '）'
  }
  if (!reply) reply = '（它这次没有输出任何内容。）'
  const result = await api('/api/agent/messages', {
    method: 'POST',
    body: JSON.stringify({ body: reply.slice(0, 8000), clientId: 'conn:' + message.id }),
  })
  log('回了 #' + (result.message ? result.message.seq : '?') + '（' + reply.length + ' 字）')
}

/** 开机时服务可能还没起来（尤其是自检脚本）：连不上就退避重试，401 仍然立刻退出。 */
async function connect() {
  let lastError = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await api('/api/agent/me')
    } catch (error) {
      lastError = error
      if (String(error.message || '').includes('401')) throw error
      log('还没连上服务（' + String(error.message || error) + '），1 秒后重试')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw lastError || new Error('连不上服务')
}

async function main() {
  me = await connect()
  log('已接入房间「' + me.room.name + '」· 成员「' + me.member.name + '」· 令牌 ' + me.token.prefix + '…')
  // 不带 since = 第一次来：服务端只回游标，不会把历史当新消息倒给它
  const boot = await api('/api/agent/inbox')
  cursor = Number(boot.cursor || 0)
  log('从 #' + cursor + ' 之后开始听（之前的历史不追）')
  while (!stopped) {
    let page
    try {
      page = await api('/api/agent/inbox?since=' + cursor + '&wait=' + (ONCE ? 0 : WAIT_SEC))
    } catch (error) {
      log('拉取失败，5 秒后重试：' + String(error.message || error))
      await new Promise((resolve) => setTimeout(resolve, 5000))
      continue
    }
    cursor = Number(page.cursor || cursor)
    for (const message of page.messages || []) {
      try {
        await handleMessage(message)
      } catch (error) {
        log('回传失败（不重试，避免刷屏）：' + String(error.message || error))
      }
    }
    if (ONCE) break
  }
  log('连接器退出')
}

process.on('SIGINT', () => {
  stopped = true
  console.log('')
  log('收到 Ctrl+C，正在退出…')
  process.exit(0)
})

main().catch((error) => fail(String(error.message || error)))
