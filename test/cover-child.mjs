// 真子进程：在共享封面目录里干两件事之一——写一张封面、占一个在途槽位。
// 共享目录这一层「同一个数」在单进程里测不出来（两个模块实例本来就看得见同一份文件），
// 但「进程被 SIGKILL 后槽位怎么办」「另一个进程写进来的条目这边能不能读到」必须真进程。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const COVER_MODULE_PATH = path.join(HERE, '..', 'server', 'cover-store.mjs')

const SCRIPT = [
  "const { pathToFileURL } = await import('node:url')",
  'const mod = await import(pathToFileURL(process.env.COVER_MODULE).href)',
  'const dir = process.env.COVER_DIR',
  'const mode = process.env.COVER_MODE',
  'if (mode === "put") {',
  '  const cache = mod.createSharedCoverCache({ dir })',
  '  const ok = cache.put(process.env.COVER_KEY, { type: "image/png", buffer: Buffer.from(process.env.COVER_BODY || "child-image") })',
  '  console.log("COVER " + JSON.stringify({ ok, stats: cache.stats() }))',
  '}',
  'if (mode === "hold") {',
  '  const slots = mod.createSharedSlotLimiter({ dir, max: Number(process.env.COVER_MAX || 1) })',
  '  const handle = await slots.acquire(Number(process.env.COVER_WAIT || 1000))',
  '  console.log("COVER " + JSON.stringify({ ok: Boolean(handle), active: slots.active() }))',
  '  if (handle) setInterval(() => {}, 1000)',
  '}',
].join('\n')

/** 起一个子进程写一张封面 / 占一个槽位；ready 是它回报之后 resolve 的那份结果。 */
export function coverInChild({ mode, dir, key = '', body = '', max = 1, waitMs = 1000 } = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    env: {
      ...process.env,
      COVER_MODULE: COVER_MODULE_PATH,
      COVER_DIR: dir,
      COVER_MODE: mode,
      COVER_KEY: key,
      COVER_BODY: body,
      COVER_MAX: String(max),
      COVER_WAIT: String(waitMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => reject(new Error('子进程没在 15 秒内回报：' + (out || err).slice(-400))), 15000)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (out.includes('COVER ')) {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(out.split('COVER ')[1].split('\n')[0]))
        } catch {
          reject(new Error('子进程回报解析失败：' + out.slice(-300)))
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      err += String(chunk)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('子进程提前退出（' + code + '）：' + (out || err).slice(-400)))
    })
  })
  return { child, ready }
}
