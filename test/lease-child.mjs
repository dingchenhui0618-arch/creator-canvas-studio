// 真子进程：在同一个共享目录里占住名额，然后停在原地。
// 这就是「另一台实例」的最小形态——两个测试文件都用它，避免各写一份 spawn。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEASE_MODULE = path.join(HERE, '..', 'server', 'heavy-lease.mjs')

export const LEASE_MODULE_PATH = LEASE_MODULE

const SCRIPT = [
  "const { pathToFileURL } = await import('node:url')",
  'const mod = await import(pathToFileURL(process.env.LEASE_MODULE).href)',
  'const n = Number(process.env.LEASE_N || 1)',
  'const cap = Number(process.env.LEASE_LIMIT || 0)',
  'const held = []',
  'for (let i = 0; i < n; i += 1) {',
  "  const got = mod.acquireHeavyLease(process.env.LEASE_KIND || 'review', { limit: cap })",
  "  if (!got.ok) { console.log('REFUSED ' + (got.active || 0)); process.exit(3) }",
  '  held.push(got.lease)',
  '}',
  "console.log('READY ' + held.length)",
  'setInterval(() => {}, 1000)',
].join('\n')

/** 起一个子进程占住租约；ready 是它真正占好之后 resolve 的条数。 */
export function holdInChild({ dir, count = 1, kind = 'review', limit = 0 }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    env: {
      ...process.env,
      VQ_HEAVY_LEASE_DIR: dir || process.env.VQ_HEAVY_LEASE_DIR || '',
      LEASE_MODULE,
      LEASE_N: String(count),
      LEASE_LIMIT: String(limit),
      LEASE_KIND: kind,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => reject(new Error('子进程没在 15 秒内占好名额：' + (out || err).slice(-400))), 15000)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (out.includes('READY')) {
        clearTimeout(timer)
        resolve(Number(out.split('READY')[1].trim().split(/\s+/)[0]) || 0)
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

export async function stopChild(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
}