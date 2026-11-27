// r343 独立取证 · 反证（把被测源码改坏，检查必须变红且退出码 = 1）
//
// 铁律：反证只在**副本**上做（.tmp-r343-verify/copy），改完立刻从仓库原件恢复；
// 仓库里的 src/ 与 server/ 一个字节都不动。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(ROOT, '.tmp-r343-verify')
const COPY = path.join(WORK, 'copy')
const PYTHON = process.env.R343_PYTHON || 'python'

const COPY_ENTRIES = ['server', 'scripts', 'src', 'public', 'index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']

function resetCopy() {
  fs.rmSync(COPY, { recursive: true, force: true })
  fs.mkdirSync(COPY, { recursive: true })
  for (const entry of COPY_ENTRIES) {
    const from = path.join(ROOT, entry)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(COPY, entry), { recursive: true })
  }
  // node_modules 用 junction，不复制：vite / react 都从仓库那份读
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(COPY, 'node_modules'), 'junction')
}

function patch(relative, from, to) {
  const file = path.join(COPY, relative)
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) throw new Error('副本里找不到要改的片段：' + relative + ' :: ' + from.slice(0, 60))
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
}

function restore(relative) {
  fs.cpSync(path.join(ROOT, relative), path.join(COPY, relative))
}

function runSuite(script, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const args = script.endsWith('.py') ? [script] : ['--experimental-sqlite', script]
    const command = script.endsWith('.py') ? PYTHON : process.execPath
    const child = spawn(command, args, { cwd: COPY, env: { ...process.env }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (out += chunk.toString('utf8')))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

// 只跑指定的几条（1 起）：R343_PROOFS=1,2,3；不填就全跑
const ONLY = String(process.env.R343_PROOFS || '')
  .split(',')
  .map((item) => Number(item.trim()))
  .filter(Boolean)

const ALL_PROOFS = [
  {
    name: '反证1 · publicModelName 改成恒等函数',
    suite: 'scripts/verify-r343-alias.mjs',
    patch: { file: 'server/models.mjs', from: '  const row = modelRows().find((item) => item.internal === name)\n  return row ? row.id : name', to: '  return name' },
    expect: /\(a1\) GET \/api\/models/
  },
  {
    name: '反证2 · internalModelName 改成恒等函数',
    suite: 'scripts/verify-r343-alias.mjs',
    patch: { file: 'server/models.mjs', from: '  const hit = rows.find((item) => item.id === name) || rows.find((item) => item.internal === name)\n  return hit ? hit.internal : name', to: '  return name' },
    expect: /\(b2\) 切到第二个模型后/,
  },
  {
    name: '反证3 · SYSTEM_PROMPT 里把「VisionQA 通用模型」换成上游厂牌',
    suite: 'scripts/verify-r343-e2e.mjs',
    patch: { file: 'server/chat.mjs', from: "'你是 VisionQA 通用模型，回答一律用简体中文。'", to: "'你是 DeepSeek 助手，回答一律用简体中文。'" },
    expect: /#4\.4 system 里没有任何上游厂牌/,
  },
  {
    name: '反证4 · 去掉「同一档再说一遍不重出」的判断',
    suite: 'scripts/verify-r343-e2e.mjs',
    patch: { file: 'server/chat.mjs', from: '  if (unchanged) {', to: '  if (false) {' },
    expect: /#1\.19 同一值再说一遍不建新任务/,
  },
  {
    name: '反证5 · 生成完不再记下「上一版」',
    suite: 'scripts/verify-r343-e2e.mjs',
    patch: { file: 'server/chat.mjs', from: "  // r343：这条任务就是「上一版」——下一句「改成 8 秒」要照它重出\n  rememberMediaTask(ctx.conv, plan, task, ctx.userMessageId)\n", to: '' },
    expect: /#1\.10 「改成 16:9」按上一版重出了新任务/,
  },
  {
    name: '反证6 · 往普通用户界面塞一个厂牌名',
    suite: 'scripts/verify-r343-ui.py',
    patch: { file: 'src/components/QuickChat.tsx', from: '<strong>一页能记住上下文的对话</strong>', to: '<strong>一页能记住上下文的对话 · 由 DeepSeek 提供</strong>' },
    expect: /普通用户 \/agents 0 厂牌/,
  },
]

const PROOFS = ONLY.length ? ALL_PROOFS.filter((item, index) => ONLY.includes(index + 1)) : ALL_PROOFS

function failLines(text) {
  return text.split(/\r?\n/).filter((line) => line.startsWith('[FAIL]'))
}

fs.mkdirSync(WORK, { recursive: true })
resetCopy()
console.log('[copy] ' + COPY)

const report = []
let exitCode = 0
try {
  // 先跑一遍基线：证明副本本身是「好的」（改坏前的输出要留档）
  const suites = [...new Set(PROOFS.map((proof) => proof.suite))]
  const baselines = new Map()
  for (const suite of suites) {
    console.log('[baseline] ' + suite + ' …')
    const result = await runSuite(suite)
    baselines.set(suite, result)
    fs.writeFileSync(path.join(WORK, 'counterproof-baseline-' + path.basename(suite) + '.log'), result.out)
    console.log('[baseline] ' + suite + ' exit=' + result.code + ' · FAIL 行=' + JSON.stringify(failLines(result.out)))
  }
  report.push({ name: '基线（未改坏的副本）', exit: suites.map((s) => baselines.get(s).code).join(','), red: false, note: '改坏前留档' })

  for (const proof of PROOFS) {
    patch(proof.patch.file, proof.patch.from, proof.patch.to)
    const result = await runSuite(proof.suite)
    restore(proof.patch.file)
    const fails = failLines(result.out)
    const turnedRed = result.code !== 0 && fails.some((line) => proof.expect.test(line))
    const beforeFails = failLines(baselines.get(proof.suite).out)
    const wasRedBefore = beforeFails.some((line) => proof.expect.test(line))
    const ok = turnedRed && !wasRedBefore
    report.push({
      name: proof.name,
      exit: result.code,
      red: ok,
      note: (ok ? '' : '没有按预期变红！') + ' 改坏后 FAIL 行=' + JSON.stringify(fails.slice(0, 4)),
    })
    fs.writeFileSync(path.join(WORK, 'counterproof-after-' + path.basename(proof.suite) + '-' + report.length + '.log'), result.out)
    console.log('[' + (ok ? 'RED-OK' : 'RED-BAD') + '] ' + proof.name + ' · 改 ' + proof.patch.file + ' · 退出码=' + result.code)
    console.log('         改坏后 FAIL 行=' + JSON.stringify(fails.slice(0, 4)))
  }

  console.log('')
  console.log('==== 反证汇总 ====')
  for (const row of report) {
    console.log((row.red ? '[PASS] ' : (row.name.startsWith('基线') ? '[INFO] ' : '[FAIL] ')) + row.name + ' · 退出码=' + row.exit + ' · ' + row.note)
  }
  const bad = report.filter((row) => !row.name.startsWith('基线') && !row.red)
  if (bad.length) exitCode = 1
} catch (error) {
  console.error('反证脚本自己出错：' + String(error?.stack || error))
  exitCode = 1
} finally {
  fs.rmSync(COPY, { recursive: true, force: true })
}
process.exit(exitCode)
