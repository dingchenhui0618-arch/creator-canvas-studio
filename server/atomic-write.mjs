// 原子写（r284）：先写 .tmp 再 rename 覆盖，本来是为了「不让别人读到半个文件」。
//
// 但这个 rename 在 Windows 上会被别人正在读的那个文件挡住——**目标文件被打开时，
// rename 覆盖会直接报 EPERM**。作品流 / 最近生成每 2.5 秒轮询一次任务，
// 后台正好在写同一个任务的终态，两边撞上的概率不小；撞上就是这一次写不进去：
// 任务永远停在「进行中」，用户白扣了积分还看不到结果（2026-11-20 全量测试实测：
// media.generate.error EPERM ... rename 'mgen_x.json.tmp' -> 'mgen_x.json'）。
//
// 所以补一层重试：只重试「暂时性」的错误码（EPERM / EBUSY / EACCES / EAGAIN），
// 每次多等一会儿，最多 6 次；别的错误（路径不存在、盘满）立刻抛出去，不装成成功。
import fsp from 'node:fs/promises'

/** 这几个错误码是「现在不行，过一会儿可能就行」，值得重试。 */
export const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN'])

export function isTransientRenameError(error) {
  return TRANSIENT_RENAME_CODES.has(String(error?.code || ''))
}

/**
 * 带重试的 rename。
 * rename 可以注入（单测用它模拟「前两次 EPERM，第三次成功」），默认就是 fsp.rename。
 */
export async function renameWithRetry(from, to, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 6)
  const delayMs = Math.max(0, Number(options.delayMs ?? 25))
  const rename = options.rename || fsp.rename
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(from, to)
      return { ok: true, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      if (!isTransientRenameError(error)) break
      if (attempt < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
      }
    }
  }
  const failure = lastError instanceof Error ? lastError : new Error('重命名失败')
  failure.renameFrom = from
  failure.renameTo = to
  throw failure
}

/**
 * 原子写一个文件：写 <target>.<pid>.<rand>.tmp 再 rename。
 * 失败时把临时文件删掉（别在数据目录里留一堆看不出是什么的 .tmp），并把原错误抛出去。
 */
export async function writeFileAtomic(target, data, options = {}) {
  const mode = options.mode ?? 0o600
  const tmp = target + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
  await fsp.writeFile(tmp, data, { mode })
  try {
    const result = await renameWithRetry(tmp, target, options)
    return { ok: true, attempts: result.attempts, bytes: Buffer.byteLength(String(data)) }
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
