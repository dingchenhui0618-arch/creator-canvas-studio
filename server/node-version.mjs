// B9：Node 版本锁。
//
// 为什么要这一层：
// - 生产钉的是 Node 22.12.0（deploy/production/install.sh 的 NODE_VERSION），
//   CI 在 22.12.0 与 24 上各跑一遍，本机开发跟 24 走。
// - 低于 22.12 没有 node:sqlite；高于 24 我们没验过。
// - 真正会炸的还不只是版本号，而是启动参数：Node 22 起 node:sqlite 要
//   --experimental-sqlite。哪天 unit 里少了这个参数，报错是一句看不懂的
//   「ERR_UNKNOWN_BUILTIN_MODULE」。所以 server/node-guard.mjs 会在这里先试一次。
//
// 这里只做判断，不打印、不退出：谁需要谁决定怎么处理（CLI 打印、服务器退出）。

export const MIN_NODE = '22.12.0'
export const MAX_MAJOR = 24
export const POLICY = 'Node >= 22.12.0（生产钉 22.12.0；CI 跑 22.12.0 与 24）'

export function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: match[1] + '.' + match[2] + '.' + match[3],
    raw: String(value).trim(),
  }
}

function parts(value) {
  const parsed = typeof value === 'string' ? parseNodeVersion(value) : value
  if (!parsed) return null
  return [parsed.major, parsed.minor, parsed.patch]
}

// 只用三段数字比，不管 v 前缀和 -rc 尾巴；认不出返回 null（别把 null 当 0 用）。
export function compareVersions(left, right) {
  const a = parts(left)
  const b = parts(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

// level: supported（验证过）/ untested（比验证过的新）/ too-old / invalid
export function checkNodeVersion(versions = process.versions, min = MIN_NODE, maxMajor = MAX_MAJOR) {
  const parsed = parseNodeVersion(versions && versions.node)
  if (!parsed) {
    return {
      ok: false,
      level: 'invalid',
      node: String((versions && versions.node) || ''),
      min,
      message: '读不出 Node 版本（process.versions.node 为空或格式不认识）',
    }
  }
  if (compareVersions(parsed, min) < 0) {
    return { ok: false, level: 'too-old', node: parsed.raw, min, message: 'Node ' + parsed.raw + ' 太旧：需要 >= ' + min }
  }
  if (parsed.major > maxMajor) {
    return {
      ok: true,
      level: 'untested',
      node: parsed.raw,
      min,
      message: 'Node ' + parsed.raw + ' 比验证过的 ' + maxMajor + ' 新：没测过，出问题先退回 ' + maxMajor,
    }
  }
  return { ok: true, level: 'supported', node: parsed.raw, min, message: '' }
}

// 启动时用：不支持的版本直接退出 78（EX_CONFIG），别带着一个奇怪的栈继续跑。
export function assertSupportedNode(versions = process.versions, options = {}) {
  const result = checkNodeVersion(versions)
  if (!result.ok) {
    console.error('[node] ' + result.message)
    if (result.level === 'too-old') {
      console.error('[node] 生产启动参数在 deploy/production/visionqa.service：Node 22 需要 --experimental-sqlite。')
    }
    process.exit(78)
  }
  if (result.level === 'untested' && options.warn !== false) console.warn('[node] ' + result.message)
  return result
}
