// 原子写守卫（r285）：Windows 上「rename 覆盖一个正被读的文件」会 EPERM，
// 一次失败就等于这一次写没发生（r284 实测：任务永远停在「进行中」、积分与结果一起丢）。
// 所以 server/ 里只留一个允许 rename 的地方：server/atomic-write.mjs。
// 新写一个 store 请用它导出的 writeFileAtomic / writeFileAtomicSync；
// 真需要自己动 rename（例如把文件挪去回收站）时，在那一行（或上一行）写
//   // atomic-write-exempt: 原因
// 让检查放行，并在 code review 里说清为什么不走重试。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = fileURLToPath(new URL('../server/', import.meta.url))
const HELPER = 'atomic-write.mjs'
const RAW_RENAME = /\brenameSync\s*\(|\.rename\s*\(/

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

test('server/ 里除 atomic-write.mjs 之外没有裸 rename', () => {
  const offenders = []
  for (const file of walk(SERVER_DIR)) {
    if (path.basename(file) === HELPER) continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!RAW_RENAME.test(line)) return
      const previous = index > 0 ? lines[index - 1] : ''
      if (line.includes('atomic-write-exempt') || previous.includes('atomic-write-exempt')) return
      offenders.push(path.relative(SERVER_DIR, file) + ':' + (index + 1) + ' ' + line.trim())
    })
  }
  assert.deepEqual(offenders, [], '这些地方绕过了原子写：\n' + offenders.join('\n'))
})

test('原子写helper 两种形态都在，供同步 store 与异步路由各自使用', async () => {
  const mod = await import('../server/atomic-write.mjs')
  for (const name of ['writeFileAtomic', 'writeFileAtomicSync', 'renameWithRetry', 'renameSyncWithRetry']) {
    assert.equal(typeof mod[name], 'function', name)
  }
})

test('写盘 store 都接到 helper 上（抽样：偏好 / 配额 / 价格 / 画布归属 / 作品 / 模板）', () => {
  const samples = [
    ['preferences.mjs', /writeFileAtomicSync\(file, JSON\.stringify\(data, null, 2\)\)/],
    ['quota.mjs', /writeFileAtomicSync\(file, JSON\.stringify\(data, null, 2\)\)/],
    ['usage-meter.mjs', /writeFileAtomicSync\(pricesFile\(\), JSON\.stringify\(payload, null, 2\)\)/],
    ['canvas-owner.mjs', /writeFileAtomicSync\(file, JSON\.stringify\(/],
    ['projects.mjs', /await writeFileAtomic\(projectsFile, JSON\.stringify\(list, null, 2\), \{ mode: 0o666 \}\)/],
    ['templates.mjs', /await writeFileAtomic\(config\.templatesFile, JSON\.stringify\(list, null, 2\), \{ mode: 0o666 \}\)/],
    ['keyvault.mjs', /writeFileAtomicSync\(keysFile\(\), JSON\.stringify\(state, null, 2\)\)/],
  ]
  for (const [name, pattern] of samples) {
    const text = fs.readFileSync(path.join(SERVER_DIR, name), 'utf8')
    assert.match(text, pattern, name)
    assert.match(text, /from '\.\/atomic-write\.mjs'/, name + ' 没有 import helper')
  }
})
