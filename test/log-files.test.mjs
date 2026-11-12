import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 日志保留策略：按天轮转 + 保留天数 + 总量上限。
// 这三条一旦失效，磁盘会被访问日志慢慢吃满，而且没人会发现。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-logs-'))
process.env.DATA_DIR = dir
process.env.VQ_LOG_RETENTION_DAYS = '7'
process.env.VQ_LOG_MAX_MB = '0.001' // 1KB，方便用几个小文件验证总量上限

const logs = await import('../server/log-files.mjs')
const logsDir = path.join(dir, 'logs')

const write = (name, bytes) => {
  fs.mkdirSync(logsDir, { recursive: true })
  fs.writeFileSync(path.join(logsDir, name), 'x'.repeat(bytes))
}

test('日期键与文件名按天轮转', () => {
  assert.match(logs.dayKey(new Date(2026, 10, 12)), /^2026-11-12$/)
  assert.equal(logs.logFilePath('access', new Date(2026, 0, 3)), path.join(logsDir, 'access-2026-01-03.log'))
})

test('写入落到当天的文件，未知类型忽略', async () => {
  logs.appendLog('access', { t: 'access', p: '/api/templates', s: 200 })
  logs.appendLog('app', '启动完成')
  logs.appendLog('nope', { anything: true })
  await logs.flushLogs()
  const today = logs.dayKey()
  const access = fs.readFileSync(path.join(logsDir, 'access-' + today + '.log'), 'utf8').trim().split('\n')
  assert.equal(access.length, 1)
  assert.equal(JSON.parse(access[0]).p, '/api/templates')
  assert.equal(fs.readFileSync(path.join(logsDir, 'app-' + today + '.log'), 'utf8').trim(), '启动完成')
  assert.deepEqual(fs.readdirSync(logsDir).filter((name) => name.startsWith('nope')), [])
})

test('过期文件按保留天数删掉，保留期内的不动', async () => {
  const now = new Date()
  const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const recent = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
  write('error-' + logs.dayKey(old) + '.log', 10)
  write('access-' + logs.dayKey(recent) + '.log', 10)
  const result = await logs.pruneLogs()
  assert.ok(result.removed.includes('error-' + logs.dayKey(old) + '.log'))
  assert.ok(!result.removed.includes('access-' + logs.dayKey(recent) + '.log'))
  assert.equal(fs.existsSync(path.join(logsDir, 'error-' + logs.dayKey(old) + '.log')), false)
  assert.equal(fs.existsSync(path.join(logsDir, 'access-' + logs.dayKey(recent) + '.log')), true)
})

test('总量超过上限时从最旧的开始删，至少留一个', async () => {
  for (const name of fs.readdirSync(logsDir)) fs.unlinkSync(path.join(logsDir, name))
  const now = Date.now()
  const day = (offset) => logs.dayKey(new Date(now - offset * 24 * 60 * 60 * 1000))
  write('access-' + day(3) + '.log', 600)
  write('access-' + day(2) + '.log', 600)
  write('access-' + day(1) + '.log', 600)
  const result = await logs.pruneLogs()
  assert.ok(result.removed.length >= 1)
  const left = fs.readdirSync(logsDir)
  assert.ok(left.length >= 1)
  const total = left.reduce((sum, name) => sum + fs.statSync(path.join(logsDir, name)).size, 0)
  assert.ok(total <= 1024, '清理后总量要回到上限以内，实际 ' + total)
})

test('列表给出保留策略、总量与最新文件', async () => {
  const info = await logs.listLogs()
  assert.equal(info.retentionDays, 7)
  assert.equal(info.maxTotalMb, 0.001)
  assert.equal(info.totalFiles, fs.readdirSync(logsDir).length)
  assert.ok(info.totalBytes > 0)
  assert.ok(info.files.length >= 1)
  assert.ok(info.newestDay >= info.oldestDay)
})
