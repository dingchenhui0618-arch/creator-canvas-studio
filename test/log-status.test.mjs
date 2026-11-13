// 访问日志按状态码统计（v0.9.70）。这一组的由来是一个真实的测量错误：
// 上一轮在服务器上用 `grep -c -e ,s.:5` 数 5xx，真实字段是 `,"s":500`，模式一条都匹配不到，
// 于是「0 个 5xx」其实什么都没数到。这个脚本改成解析 JSON 再数——测试就是钉住这件事：
//   1) 500 / 502 / 503 要数出来，不能是 0；
//   2) 耗时为 5000ms 的正常 200 不能算成 5xx（正则数法最容易在这里出错）；
//   3) 非 JSON 行（journald 的 Warning 之类）跳过，不崩；
//   4) --fail-on-5xx 在存在 5xx 时退出码为 1，能挂巡检。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-log-status-'))
const file = path.join(dir, 'journal.txt')
const lines = [
  'Warning: some systemd noise that is not JSON',
  '{"at":"2026-11-13T10:00:00.000Z","t":"access","m":"GET","p":"/api/health","s":200,"ms":2}',
  '{"at":"2026-11-13T10:00:01.000Z","t":"access","m":"GET","p":"/api/credits","s":200,"ms":5000}',
  '{"at":"2026-11-13T10:00:02.000Z","t":"access","m":"POST","p":"/api/review","s":500,"ms":42000}',
  '{"at":"2026-11-13T10:00:03.000Z","t":"access","m":"POST","p":"/api/gateway/v1/images/generations","s":502,"ms":700}',
  '{"at":"2026-11-13T10:00:04.000Z","t":"access","m":"POST","p":"/api/runs/x/run","s":503,"ms":1}',
  '{"at":"2026-11-13T10:00:05.000Z","t":"access","m":"GET","p":"/api/auth/me","s":401,"ms":1}',
  '{"at":"2026-11-13T10:00:06.000Z","t":"boot","msg":"服务启动"}',
]
fs.writeFileSync(file, lines.join('\n') + '\n')

const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['scripts/log-status.mjs', ...args], { encoding: 'utf8' }) }
  } catch (error) {
    return { code: error.status, out: String(error.stdout || '') }
  }
}

test('5xx 要数出来：500 / 502 / 503 共 3 条，不是 0', () => {
  const { code, out } = run([file])
  assert.equal(code, 0)
  assert.match(out, /访问记录 6 条/, '只数 access 记录，Warning 与服务启动那两行不算')
  assert.match(out, /5xx: 3/)
  assert.match(out, /\/api\/review → 500/)
})

test('耗时为 5000ms 的正常 200 不算 5xx（正则数法最容易错在这里）', () => {
  const { out } = run([file])
  assert.match(out, /200: 2/)
  const fiveXxBlock = out.split('5xx:')[1].split('≥3s')[0]
  assert.doesNotMatch(fiveXxBlock, /\/api\/credits/, '慢请求不是错误，不能进 5xx 明细')
  assert.match(out, /≥3s 的慢请求: 1/)
})

test('--fail-on-5xx 有 5xx 时退出码 1，--since 之后的窗口里没有 5xx 时退出码 0', () => {
  assert.equal(run([file, '--fail-on-5xx']).code, 1)
  const later = run([file, '--since', '2026-11-13T11:00:00Z', '--fail-on-5xx'])
  assert.equal(later.code, 0)
  assert.match(later.out, /访问记录 0 条/)
})
