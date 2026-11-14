// 真子进程：在同一个共享目录里排进画布出图的队，然后停在原地（每 300 毫秒摸一次心跳）。
// 这就是「另一个实例」的最小形态——v0.9.93 的排队位是整机口径，得有一个真进程才测得出来。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const WAIT_MODULE_PATH = path.join(HERE, '..', 'server', 'wait-queue.mjs')

const SCRIPT = [
  "const { pathToFileURL } = await import('node:url')",
  'const mod = await import(pathToFileURL(process.env.WAIT_MODULE).href)',
  "const kind = process.env.WAIT_KIND || 'canvas_gen'",
  'const ticket = process.env.WAIT_TICKET || "child"',
  'const joined = mod.joinWaitQueue(kind, ticket, { maxWaiting: Number(process.env.WAIT_MAX || 0) })',
  "console.log('WAIT ' + JSON.stringify({ ok: joined.ok, position: joined.position, waiting: joined.waiting, scope: joined.scope, full: Boolean(joined.full) }))",
  'setInterval(() => { mod.heartbeatWaitQueue(kind, ticket) }, 300)',
].join('\n')

/** 起一个子进程排进队；ready 是它真的排进去之后 resolve 的那份名次。 */
export function waitInChild({ dir, kind = 'canvas_gen', ticket = 'child', maxWaiting = 0 } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    env: {
      ...process.env,
      VQ_HEAVY_LEASE_DIR: dir || process.env.VQ_HEAVY_LEASE_DIR || '',
      WAIT_MODULE: WAIT_MODULE_PATH,
      WAIT_KIND: kind,
      WAIT_TICKET: ticket,
      WAIT_MAX: String(maxWaiting),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => reject(new Error('子进程没在 15 秒内排进队：' + (out || err).slice(-400))), 15000)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (out.includes('WAIT ')) {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(out.split('WAIT ')[1].split('\n')[0]))
        } catch {
          reject(new Error('子进程回报解析失败：' + out.slice(-300)))
        }
      }
    })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('子进程提前退出（' + code + '）：' + (out || err).slice(-400)))
    })
  })
  return { child, ready }
}
