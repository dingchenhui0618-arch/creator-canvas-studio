// 评审 worker 入口（v0.9.77）：常驻在这个线程里，一单一单按池派下来的顺序跑。
//
// 它继承主线程的 process.env 与 execArgv（--experimental-sqlite 等），所以配置、模型通道、
// 数据目录口径与主进程完全一致；写入侧只走 SQLite（用量台账 INSERT，WAL + busy_timeout），
// 不做「读-改-写」的 JSON 账本，避免两条线程互相覆盖。
// 一单出错只回一条 error，不让整个线程退出——池里的线程要能继续接下一单。
import { parentPort } from 'node:worker_threads'
import { reviewVisual } from './review.mjs'

const post = (message) => {
  try { parentPort.postMessage(message) } catch { /* 主线程已经走了，回话没有意义 */ }
}

parentPort.on('message', async (message) => {
  if (!message || message.type !== 'job') return
  const id = message.id
  const payload = message.payload || {}
  const bytes = payload.imageBytes
  try {
    const result = await reviewVisual({
      ...payload,
      imageBytes: bytes ? Buffer.from(bytes) : undefined,
      log: (line) => post({ type: 'log', id, message: String(line) }),
    })
    post({ type: 'done', id, result })
  } catch (error) {
    post({
      type: 'error',
      id,
      message: String(error?.message || error),
      code: String(error?.code || ''),
      status: Number(error?.status) || 0,
    })
  }
})
