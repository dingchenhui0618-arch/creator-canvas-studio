// 语法护栏（v0.9.78）：这一轮真踩过——一次整文件写入把 server/index.mjs 截断了。
// 没有任何测试 import 它（测试只 import 路由与模块），所以 692 条测试全绿、CI 也是绿的，
// 一直到部署时 systemd journal 里才炸出 SyntaxError: Unexpected end of input，线上短暂不可用。
// 这里用一次子进程（带 --experimental-vm-modules）把 server/ 与 scripts/ 下每个模块都解析一遍：
// 只解析、不执行，几百毫秒，先于部署拦住「被截断 / 语法坏了」的文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 子进程里做扫描：vm.SourceTextModule 只在 --experimental-vm-modules 下存在；
// 一个进程解析全部文件，比「每个文件起一次 node --check」快两个数量级（实测 46 s → 不到 1 s）。
const SCRIPT = [
  "import vm from 'node:vm'",
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  'const roots = JSON.parse(process.env.SCAN_ROOTS || "[]")',
  'const files = []',
  'const walk = (dir) => {',
  '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {',
  '    const full = path.join(dir, entry.name)',
  '    if (entry.isDirectory()) walk(full)',
  "    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) files.push(full)",
  '  }',
  '}',
  'for (const root of roots) walk(root)',
  'const broken = []',
  'for (const file of files) {',
  '  const source = fs.readFileSync(file, "utf8")',
  '  try {',
  '    if (file.endsWith(".cjs")) new vm.Script(source, { filename: file })',
  '    else new vm.SourceTextModule(source, { identifier: file })',
  '  } catch (error) {',
  '    broken.push({ file, message: String(error && error.message || error).split("\\n")[0] })',
  '  }',
  '}',
  'console.log(JSON.stringify({ total: files.length, broken }))',
].join('\n')

test('server 与 scripts 下每个模块都能被解析（截断 / 语法错在部署前拦住）', async () => {
  const { stdout } = await run(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', SCRIPT], {
    env: { ...process.env, SCAN_ROOTS: JSON.stringify([path.join(ROOT, 'server'), path.join(ROOT, 'scripts')]) },
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const parsed = JSON.parse(String(stdout).trim().split('\n').pop())
  assert.ok(parsed.total > 40, '扫到的文件数不对：' + parsed.total)
  assert.deepEqual(parsed.broken, [], '这些文件解析失败（多半是被写截断了）：\n' + parsed.broken.map((item) => item.file + '：' + item.message).join('\n'))
})
