// 请求体上限：一个 100 MB 的 JSON body 就是一次 OOM（384 MB 堆，Buffer + 字符串 + 解析结果各占一份）。
// 这一组盯住三件事：超限被拒且状态码是 413（不是 500）、超限之后内存不再涨、正常请求不受影响。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MAX_BODY_BYTES, readJsonBody } from '../server/body-reader.mjs'
import { refusalResponse } from '../server/public-error.mjs'

// 自造一个最小 req：只实现 readJsonBody 用到的那三样（headers / 异步迭代 / destroy）。
// 不用真实的 Readable：它的 autoDestroy 在流结束时也会调 destroy，会把「主动断连接」数混进来。
function bodyOf(chunks, { contentLength = null, onDestroy = null, onPull = null } = {}) {
  return {
    headers: contentLength === null ? {} : { 'content-length': String(contentLength) },
    destroy: () => { if (onDestroy) onDestroy() },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (onPull) onPull()
        yield Buffer.from(chunk)
      }
    },
  }
}

test('正常请求体照旧解析（含 BOM）', async () => {
  assert.deepEqual(await readJsonBody(bodyOf(['{"a":1}'])), { a: 1 })
  assert.deepEqual(await readJsonBody(bodyOf(['\uFEFF{"b":2}'])), { b: 2 })
  assert.deepEqual(await readJsonBody(bodyOf([])), {})
  assert.deepEqual(await readJsonBody(bodyOf(['not json'])), {})
})

test('声明就超限：一个字节都不读就拒（413 + BODY_TOO_LARGE）', async () => {
  let pulled = 0
  const oversized = bodyOf(['x'], { contentLength: DEFAULT_MAX_BODY_BYTES + 1, onPull: () => { pulled += 1 } })
  await assert.rejects(() => readJsonBody(oversized), (error) => error.status === 413 && error.code === 'BODY_TOO_LARGE')
  assert.equal(pulled, 0, 'content-length 就超了，不该再去读流')
  const mapped = refusalResponse(Object.assign(new Error('请求体 9 MB 超过了 8 MB 的上限'), { status: 413, code: 'BODY_TOO_LARGE' }))
  assert.equal(mapped.status, 413)
  assert.equal(mapped.body.code, 'BODY_TOO_LARGE')
  assert.match(mapped.body.error, /8 MB/)
})

test('分块传输超限：读完再拒，客户端收得到 413', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x20)
  const chunks = Array.from({ length: 9 }, () => chunk)
  let destroyed = 0
  const extra = bodyOf(chunks, { onDestroy: () => { destroyed += 1 } })
  await assert.rejects(() => readJsonBody(extra), (error) => error.status === 413 && error.code === 'BODY_TOO_LARGE')
  assert.equal(destroyed, 0, '刚过 1 倍上限不该断连接：这次请求还得收到 413')
})

test('超过 4 倍上限：直接断连接（灌数据的不算客户端）', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x20)
  const chunks = Array.from({ length: 40 }, () => chunk)
  let destroyed = 0
  await assert.rejects(
    () => readJsonBody(bodyOf(chunks, { onDestroy: () => { destroyed += 1 } })),
    (error) => error.status === 413,
  )
  assert.equal(destroyed, 1, '超过 4 倍上限要主动断连接')
})

test('上限以内的大请求体照旧通过（8 MB 正好是允许的）', async () => {
  const payload = Buffer.alloc(DEFAULT_MAX_BODY_BYTES - 16, 0x20)
  const text = '{"pad":"' + payload.toString('utf8') + '"}'
  const parsed = await readJsonBody(bodyOf([text], { contentLength: Buffer.byteLength(text) }))
  assert.equal(typeof parsed.pad, 'string')
  assert.equal(parsed.pad.length, DEFAULT_MAX_BODY_BYTES - 16)
})
