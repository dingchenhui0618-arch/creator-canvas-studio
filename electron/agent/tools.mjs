// 本地工具：能真的读写工作区、真的执行命令。
// 有副作用的三个（write_file / edit_file / run_command）必须用户逐次批准；
// 所有路径都被限制在工作区根目录内—— approvals 是第二道门，不是唯一一道。
// remember 只写本机记忆文件，不碰工作区，所以不需要批准（但它也改不了你的文件）。
import path from 'node:path'
import fsp from 'node:fs/promises'
import { exec } from 'node:child_process'

export const COMMAND_TIMEOUT_MS = 60000
export const SEARCH_LIMITS = { maxFiles: 400, maxMatches: 60, maxFileBytes: 1024 * 1024, maxDepth: 8 }

// 搜代码时没必要翻的东西：一看就是依赖或产物，翻进去只会把命中挤满。
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target',
])

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

export function globToRegExp(glob) {
  const source = String(glob || '')
    .replace(/[.+^$${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
  return new RegExp('^' + source + '$', 'i')
}

async function collectFiles(dir, out, depth = 0) {
  if (out.length >= SEARCH_LIMITS.maxFiles || depth > SEARCH_LIMITS.maxDepth) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= SEARCH_LIMITS.maxFiles) return
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await collectFiles(path.join(dir, entry.name), out, depth + 1)
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name))
    }
  }
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

export function createTools({ root, maxOutput = 8000, memory = null, workspace = root }) {
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
      name: 'search_text',
      description: '在工作区里按关键词找内容，给出「文件:行号: 那一行」（只读）',
      signature: '{"query":"要找的文字","path":"从哪个目录开始，省略为根目录","glob":"只看匹配的文件名，如 *.md","ignoreCase":true}',
      needsApproval: false,
      async run(args = {}) {
        const query = String(args.query || '')
        if (!query) return { ok: false, output: 'query 是空的：要告诉我找什么' }
        const start = resolveInside(root, args.path || '.')
        const matcher = args.glob ? globToRegExp(args.glob) : null
        const flags = args.ignoreCase === false ? '' : 'i'
        let needle
        try {
          needle = new RegExp(query.replace(/[.*+?${}()|[\]\\]/g, '\\$&'), flags)
        } catch {
          return { ok: false, output: 'query 里的写法不合法' }
        }
        const files = []
        await collectFiles(start, files)
        const matches = []
        let scanned = 0
        for (const file of files) {
          if (matches.length >= SEARCH_LIMITS.maxMatches) break
          const rel = path.relative(root, file).replace(/\\/g, '/')
          if (matcher && !matcher.test(rel) && !matcher.test(path.basename(file))) continue
          let stat
          try {
            stat = await fsp.stat(file)
          } catch {
            continue
          }
          if (stat.size > SEARCH_LIMITS.maxFileBytes) continue
          let text
          try {
            text = await fsp.readFile(file, 'utf8')
          } catch {
            continue
          }
          if (text.includes('\u0000')) continue
          scanned += 1
          const lines = text.split(/\r?\n/)
          for (let index = 0; index < lines.length; index += 1) {
            if (matches.length >= SEARCH_LIMITS.maxMatches) break
            if (needle.test(lines[index])) matches.push(rel + ':' + (index + 1) + ': ' + lines[index].trim().slice(0, 160))
          }
        }
        const head = matches.length
          ? '找到 ' + matches.length + ' 处' + (matches.length >= SEARCH_LIMITS.maxMatches ? '（到上限了，可能还有）' : '') + '，扫了 ' + scanned + ' 个文件'
          : '没有找到。扫了 ' + scanned + ' 个文件' + (files.length >= SEARCH_LIMITS.maxFiles ? '（到 ' + SEARCH_LIMITS.maxFiles + ' 个文件上限了，缩小 path 或加 glob 再搜）' : '')
        return { ok: true, output: clampOutput(head + '\n' + matches.join('\n'), maxOutput) }
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
      name: 'edit_file',
      description: '改文件里的一小段：把原文替换成新内容，要求原文在文件里只出现一次（执行前需要用户批准）',
      signature: '{"path":"文件路径","old":"要被替换的原文，多带两行上下文保证唯一","new":"替换成什么"}',
      needsApproval: true,
      async run(args = {}) {
        const file = resolveInside(root, args.path)
        const old = String(args.old ?? '')
        const next = String(args.new ?? '')
        if (!old) return { ok: false, output: 'old 是空的：补丁式编辑要指明替换哪一段原文；要整份重写就用 write_file' }
        if (old === next) return { ok: false, output: 'old 和 new 一样，没有要改的' }
        const text = await fsp.readFile(file, 'utf8')
        const count = text.split(old).length - 1
        if (count === 0) return { ok: false, output: '文件里没有这段原文（注意空白与换行要一字不差）。先用 read_file 或 search_text 核对一遍' }
        if (count > 1) return { ok: false, output: '这段原文在文件里出现了 ' + count + ' 处，改哪一处不确定。多带两行上下文让它唯一' }
        const updated = text.slice(0, text.indexOf(old)) + next + text.slice(text.indexOf(old) + old.length)
        await fsp.writeFile(file, updated, 'utf8')
        const lines = (value) => value.split(/\r?\n/).length
        return {
          ok: true,
          output: '已修改 ' + path.relative(root, file) + '（替换 1 处；' + lines(text) + ' 行 → ' + lines(updated) + ' 行，' + Buffer.byteLength(updated, 'utf8') + ' 字节）',
        }
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
    {
      name: 'remember',
      description: '把以后还用得上的一件事记到这个工作区的长期记忆里（新会话也能看到；不记临时任务内容）',
      signature: '{"text":"一句话说清要记住什么，最多 300 字"}',
      needsApproval: false,
      async run(args = {}) {
        if (!memory) return { ok: false, output: '这个环境没有长期记忆层' }
        const result = await memory.add(workspace, { text: args.text, source: 'agent' })
        if (!result.ok) return result
        return {
          ok: true,
          output: (result.action === 'updated' ? '这条以前记过，已更新：' : '已记住（这个工作区共 ' + result.total + ' 条）：') + result.entry.text,
        }
      },
    },
  ]
}
