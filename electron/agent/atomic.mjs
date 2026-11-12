// 原子写文件：先写 .tmp 再 rename 覆盖目标。
// Windows 上 rename 偶尔会因为杀毒软件/索引器正打开目标而报 EPERM/EACCES/EBUSY，
// 这种失败重试几十毫秒就过去了（生产实测：刚建好的会话文件第一次改名就被拦过一次），
// 所以这里带退避重试；重试用完仍失败就删掉 .tmp、抛错，原文件保持不动。
import fsp from 'node:fs/promises'
import path from 'node:path'

export const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export async function writeFileAtomic(
  file,
  text,
  { rename = fsp.rename, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 6 } = {},
) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid.toString(36) + Date.now().toString(36) + '.tmp'
  await fsp.writeFile(tmp, text, 'utf8')
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(tmp, file)
      return { attempts: attempt }
    } catch (error) {
      lastError = error
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt === attempts) break
      await sleep(20 * attempt)
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => {})
  throw lastError
}
