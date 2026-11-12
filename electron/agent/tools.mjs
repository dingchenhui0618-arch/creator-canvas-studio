// 本地工具：能真的读写工作区、真的执行命令。
// 有副作用的两个（write_file / run_command）必须用户逐次批准；
// 所有路径都被限制在工作区根目录内—— approvals 是第二道门，不是唯一一道。
import path from 'node:path'
import fsp from 'node:fs/promises'
import { exec } from 'node:child_process'

export const COMMAND_TIMEOUT_MS = 60000

export function resolveInside(root, target) {
  const abs = path.resolve(root, String(target || '.'))
  const rel = path.relative(root, abs)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs
  throw new Error('只能访问工作区里的路径：' + target)
}

export function clampOutput(text, limit = 8000) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return value.slice(0, limit) + '\n…（已截断，原输出 ' + value.length + ' 字）'
}

function runShell(command, cwd) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
      const parts = []
      parts.push('退出码：' + code)
      if (stdout && String(stdout).trim()) parts.push('stdout:\n' + String(stdout).trim())
      if (stderr && String(stderr).trim()) parts.push('stderr:\n' + String(stderr).trim())
      if (error && error.killed) parts.push('（超时被终止，上限 ' + Math.round(COMMAND_TIMEOUT_MS / 1000) + ' 秒）')
      resolve({ ok: code === 0, output: parts.join('\n') })
    })
  })
}

export function createTools({ root, maxOutput = 8000 }) {
  if (!root) throw new Error('工具需要工作区根目录')
  return [
    {
      name: 'list_dir',
      description: '列出一个目录里的文件和子目录（只读）',
      signature: '{"path":"相对工作区的目录，省略为当前目录"}',
      needsApproval: false,
      async run(args = {}) {
        const dir = resolveInside(root, args.path || '.')
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        const lines = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, 200)
          .map((entry) => (entry.isDirectory() ? 'd ' + entry.name + '/' : 'f ' + entry.name))
        return { ok: true, output: lines.length ? lines.join('\n') : '（空目录）' }
      },
    },
    {
      name: 'read_file',
      description: '读工作区里的一个文本文件（只读，默认前 200 行）',
      signature: '{"path":"文件路径","offset":1,"limit":200}',
      needsApproval: false,
      async run(args = {}) {
        const file = resolveInside(root, args.path)
        const stat = await fsp.stat(file)
        if (stat.size > 2 * 1024 * 1024) return { ok: false, output: '文件超过 2MB，先换个小文件或用命令取片段' }
        const text = await fsp.readFile(file, 'utf8')
        const lines = text.split(/\r?\n/)
        const offset = Math.max(1, Number(args.offset) || 1)
        const limit = Math.min(2000, Math.max(1, Number(args.limit) || 200))
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const header = '文件 ' + path.relative(root, file) + '（共 ' + lines.length + ' 行，读第 ' + offset + ' 行起的 ' + slice.length + ' 行）'
        return { ok: true, output: clampOutput(header + '\n' + slice.join('\n'), maxOutput) }
      },
    },
    {
      name: 'write_file',
      description: '在工作区里写一个文件（会覆盖同名文件，执行前需要用户批准）',
      signature: '{"path":"文件路径","content":"完整文件内容"}',
      needsApproval: true,
      async run(args = {}) {
        const file = resolveInside(root, args.path)
        const content = String(args.content ?? '')
        if (!content) return { ok: false, output: '拒绝写空文件：content 是空的' }
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await fsp.writeFile(file, content, 'utf8')
        return { ok: true, output: '已写入 ' + path.relative(root, file) + '（' + Buffer.byteLength(content, 'utf8') + ' 字节）' }
      },
    },
    {
      name: 'run_command',
      description: '在工作区里执行一条本机命令（执行前需要用户批准，上限 60 秒）',
      signature: '{"command":"要执行的命令","cwd":"相对工作区的目录，省略为根目录"}',
      needsApproval: true,
      async run(args = {}) {
        const command = String(args.command || '').trim()
        if (!command) return { ok: false, output: '命令是空的' }
        const cwd = resolveInside(root, args.cwd || '.')
        const result = await runShell(command, cwd)
        return { ok: result.ok, output: clampOutput(result.output, maxOutput) }
      },
    },
  ]
}