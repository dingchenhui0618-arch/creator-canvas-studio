// 按账号的并发闸门。
// 检索、复刻、评审、对话都是「一次请求背后挂着一个外部付费调用」的接口，
// 积分能管住总量，管不住瞬时并发：同一个人连点 20 次就等于把上游配额一次打光。
// 这里是进程内计数（单机部署足够），落库没有意义——进程重启时在跑的任务本来也没了。
const inflight = new Map()

function key(userId, kind) {
  return String(userId || 'anonymous') + '|' + kind
}

export function enter(userId, kind, max) {
  const k = key(userId, kind)
  const current = inflight.get(k) || 0
  if (max > 0 && current >= max) return false
  inflight.set(k, current + 1)
  return true
}

export function leave(userId, kind) {
  const k = key(userId, kind)
  const current = inflight.get(k) || 0
  if (current <= 1) inflight.delete(k)
  else inflight.set(k, current - 1)
}

// 全站视角：把某几个 kind 的在跑数加起来（跨账号）。
// 按账号的上限管不住「两个人各来两条」——这台机器只有 2 核 / 1.86 GB，
// 重活撞在一起就是 OOM，进程一死所有人的会话一起断。
// 这里只读计数，不做判断：判断（上限多少、要不要拒）留给 waterline，
// 因为它还取决于当前水位——同一份数字，两处别各算一遍。
export function activeFor(kinds) {
  const wanted = new Set(kinds || [])
  const byKind = {}
  let total = 0
  for (const [k, count] of inflight) {
    const kind = k.slice(k.lastIndexOf('|') + 1)
    if (!wanted.has(kind)) continue
    total += count
    byKind[kind] = (byKind[kind] || 0) + count
  }
  return { total, byKind }
}

export function snapshot() {
  const out = {}
  for (const [k, v] of inflight) out[k] = v
  return out
}
