#!/usr/bin/env node
// 密钥扫描：本地提交前与 CI 都跑（B4）。
//
// 为什么不用现成的 gitleaks：它在 CI 里要单独下二进制、组织账号还要 license；
// 更要紧的是本项目测试夹具里本来就有一堆假 Key（sk-test-…、test-secret-…），
// 必须靠 allowlist 才不误报。规则不多、场景固定，自己写反而能直接进单测。
// 规则照 gitleaks 默认规则里最常命中的几类挑：私钥、云厂商 Key、GitHub / Slack /
// OpenAI / Google 的 Key、JWT、带口令的连接串，以及 key = ""…" 这种赋值。
//
// 命中即退出码 1。假 Key 夹具在行尾写 `secret-scan:allow` 豁免这一行——
// 比在脚本里维护一份路径 allowlist 诚实：谁都能看见「这里为什么放行」。
//
// 用法：
//   node scripts/scan-secrets.mjs            # 扫所有被 git 跟踪的文件
//   node scripts/scan-secrets.mjs --staged   # 只扫已暂存的改动（pre-commit）
//   node scripts/scan-secrets.mjs --json     # 机器可读
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// [id, 中文说明, 正则]；统一不带 g，按行扫。
export const RULES = [
  ['private-key', '私钥', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-access-key', 'AWS 访问 Key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', 'GitHub Token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['slack-token', 'Slack Token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['openai-key', 'sk- 开头的模型 Key', /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{24,}\b/],
  ['google-api-key', 'Google API Key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', 'JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['url-credentials', '连接串里的口令', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]{1,64}:[^\s/@]{6,}@/i],
  // 只认字符串字面量：password: hash(x) 这种表达式不报，否则真报告会被淹掉
  ['assigned-secret', '赋值给 key/secret/token 的随机串', /\b(?:api[_-]?key|apikey|secret|secret[_-]?key|password|passwd|pwd|token|access[_-]?key|private[_-]?key)\b\s*[:=]\s*(['"`])([^'"`\n]{16,})\1/i],
  // 不带引号的赋值只认「全大写变量名 = 随机串」，缩小到 env / shell / yaml 的写法
  // 值里不许有 / 和 .：否则 DATA_DIR=/var/lib/visionqa 这种路径全被当成密钥（实测 5 条噪音）
  ['env-assignment', '不带引号的赋值', /^\s*(?:export\s+)?[A-Z][A-Z0-9_]{3,}\s*=\s*([A-Za-z0-9_-]{24,})\s*$/],
]

// 值里带这些词就是占位符 / 环境变量 / 文档示例，不当真密钥。
const PLACEHOLDER = [
  'process.env', 'import.meta.env', 'os.environ', 'getenv(', '${', '{{', '<', '>',
  'your', 'example', 'dummy', 'sample', 'placeholder', 'changeme', 'change-me',
  'test', 'fake', 'mock', 'xxx', 'redact', 'secret-for', 'e2e', 'not-a-real', 'notreal',
  'todo', 'fixme', 'undefined', 'null', '...', '***', '\u2022\u2022\u2022',
]

// 这些目录天生全是假 Key（sk-test-…、test-secret-…）。值类规则在这里只会制造几十条
// 噪音、把真报告淹掉，所以豁免；但私钥与云厂商 Key 的格式太特殊，一旦出现基本就是
// 真事故，任何路径都不豁免。
const FIXTURE_PATHS = [/^(?:test|tests)\//, /^scripts\/test-/, /^scripts\/mock-/, /^e2e\//]
const VALUE_RULES = new Set(['openai-key', 'github-token', 'slack-token', 'jwt', 'url-credentials', 'assigned-secret', 'env-assignment'])

export function isFixturePath(file) {
  const normalized = String(file || '').replace(/\\/g, '/')
  return FIXTURE_PATHS.some((re) => re.test(normalized))
}

// Shannon 熵：真 Key 是随机的（4 以上），夹具是人手拼的词（3.5 以下）。
export function shannonEntropy(text) {
  const value = String(text || '')
  if (!value) return 0
  const counts = new Map()
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / value.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

// 被 git 跟踪的 .env 一定是配置事故；示例文件除外。
const ENV_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template'])

// 输出里只给首尾几位：日志会转发、会贴进工单，不能把整把 Key 再泄一次。
export function maskValue(value) {
  const text = String(value || '')
  if (!text) return ''
  if (text.length <= 8) return text.slice(0, 1) + '\u2026'
  return text.slice(0, 4) + '\u2026' + text.slice(-3)
}

function hasPlaceholder(text) {
  const lower = String(text).toLowerCase()
  return PLACEHOLDER.some((token) => lower.includes(token))
}

// 赋值类规则最容易被文档、环境变量和夹具糊住：只报「像随机串」的值。
// 判据是「长 + 字符种类多 + 熵高」：真 Key 是随机的，手拼的英文词熵上不去。
// 纯 hex 单独放行——16 种字符的熵上限只有 4，按 3.9 卡会把真 hex 口令全漏掉。
// 代价：短的、纯字母的口令会漏报。这是有意的取舍：宁可漏一条，也不要每天几十条噪音。
export function looksRandom(value) {
  const text = String(value || '')
  if (text.length < 20) return false
  if (/\s/.test(text)) return false
  if (hasPlaceholder(text)) return false
  if (new Set(text).size < 10) return false
  if (!/[a-z]/i.test(text) || !/[0-9]/.test(text)) return false
  if (/^[0-9a-f]{24,}$/i.test(text)) return true
  return shannonEntropy(text) >= 3.9
}

export function checkEnvFile(file) {
  const base = path.basename(file)
  if (base === '.env' || (base.startsWith('.env.') && !ENV_ALLOWED.has(base))) {
    return { file, line: 1, rule: 'tracked-env-file', why: '被 git 跟踪的 .env 文件', value: base }
  }
  return null
}

// 扫一段文本；file 只用于结果里定位。导出让单测直接喂字符串。
export function scanText(text, file = '<text>') {
  const findings = []
  const fixture = isFixturePath(file)
  const lines = String(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || line.includes('secret-scan:allow')) continue
    for (const [id, why, re] of RULES) {
      if (fixture && VALUE_RULES.has(id)) continue
      const match = re.exec(line)
      if (!match) continue
      const raw = match[2] || match[1] || match[0]
      if (id === 'assigned-secret' && !looksRandom(raw)) continue
      if (id !== 'private-key' && hasPlaceholder(match[0])) continue
      findings.push({ file, line: index + 1, rule: id, why, value: maskValue(raw) })
      break // 一行只报第一处，够定位了
    }
  }
  return findings
}

export function scanFile(file, root = process.cwd()) {
  const full = path.join(root, file)
  let buffer
  try {
    buffer = fs.readFileSync(full)
  } catch {
    return { findings: [], skipped: 'unreadable' }
  }
  if (buffer.length > 2 * 1024 * 1024) return { findings: [], skipped: 'too-large' }
  if (buffer.subarray(0, 8000).includes(0)) return { findings: [], skipped: 'binary' }
  return { findings: scanText(buffer.toString('utf8'), file), skipped: '' }
}

function gitList(args, cwd) {
  const bin = process.env.GIT_BIN || 'git'
  return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const json = argv.includes('--json')
  const staged = argv.includes('--staged')
  const quiet = argv.includes('--quiet')
  const allow = argv.filter((arg) => arg.startsWith('--allow=')).map((arg) => arg.slice('--allow='.length))
  const files = (staged
    ? gitList(['diff', '--cached', '--name-only', '--diff-filter=ACM'], root)
    : gitList(['ls-files'], root))
    .filter((file) => !allow.some((rule) => file === rule || file.startsWith(rule)))

  const findings = []
  let scanned = 0
  let skipped = 0
  for (const file of files) {
    const envHit = checkEnvFile(file)
    if (envHit) {
      findings.push(envHit)
      continue
    }
    const result = scanFile(file, root)
    if (result.skipped) {
      skipped += 1
      continue
    }
    scanned += 1
    findings.push(...result.findings)
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: findings.length === 0, scanned, skipped, findings }, null, 2) + '\n')
  } else if (findings.length) {
    console.error('\u2717 密钥扫描：' + findings.length + ' 处疑似密钥')
    for (const hit of findings) {
      console.error('  ' + hit.file + ':' + hit.line + '  ' + hit.why + '  ' + hit.value)
    }
    console.error('  假 Key：行尾加 secret-scan:allow；真 Key：先从仓库移除，再轮换。')
  } else if (!quiet) {
    console.log('\u2713 密钥扫描：' + scanned + ' 个文件（跳过 ' + skipped + ' 个二进制/超限文件），没发现疑似密钥')
  }

  return findings.length ? 1 : 0
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    process.exitCode = main()
  } catch (cause) {
    console.error('密钥扫描挂了：' + (cause && cause.message ? cause.message : cause))
    process.exitCode = 2
  }
}
