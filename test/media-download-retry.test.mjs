// 取回上游文件的重试与错误分类（r264）
//
// 2026-11-19 生产真调 seedance-2.0 4s/480p：上游 275 秒出片成功，我们第一次下载就
// 「fetch failed」，直接把这单判失败并退款——用户白等五分钟。网络抖动要重试；
// 而证书域名不符（SeeAPI 的结果地址是 cdn.orangelight.com.cn、边缘证书却是
// *.cdn.myqcloud.com）是上游 CDN 配错，重试没意义，得说清楚是谁的问题。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const { downloadAsset, certProblem } = await import('../server/media-fetch.mjs')

function server(handler) {
  const hits = []
  const srv = http.createServer((req, res) => {
    hits.push(req.url)
    handler(req, res, hits.length)
  })
  return { srv, hits, listen: () => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + srv.address().port))) }
}

test('网络抖两下就恢复：自动重试，第三次拿到字节，并记下试了几次', async () => {
  const { srv, hits, listen } = server((req, res, n) => {
    if (n <= 2) {
      req.socket.destroy()
      return
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4' })
    res.end(Buffer.from('fake-mp4-bytes'))
  })
  const base = await listen()
  try {
    const got = await downloadAsset(base + '/out.mp4', 'video')
    assert.equal(got.buffer.toString(), 'fake-mp4-bytes')
    assert.equal(got.mime, 'video/mp4')
    assert.equal(got.attempts, 3, '重试两次之后才成功，要能说出真实次数')
    assert.equal(hits.length, 3)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('地址就是不对（404）：不重试，直接报，别拿重试掩盖真因', async () => {
  const { srv, hits, listen } = server((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  const base = await listen()
  try {
    await assert.rejects(() => downloadAsset(base + '/gone.mp4', 'video'), /HTTP 404/)
    assert.equal(hits.length, 1, '404 重试三次只是浪费时间')
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('上游一直连不上：重试到底之后如实说几次', async () => {
  const { srv, hits, listen } = server((req) => req.socket.destroy())
  const base = await listen()
  try {
    await assert.rejects(() => downloadAsset(base + '/flaky.mp4', 'video'), (error) => {
      assert.equal(error.attempts, 3)
      assert.equal(error.transient, true)
      assert.equal(error.cert, false)
      return true
    })
    assert.equal(hits.length, 3)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

test('证书域名不符归成上游 CDN 的问题，不是网络抖动', () => {
  const error = new TypeError('fetch failed')
  error.cause = { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
  assert.equal(certProblem(error), true)
  assert.equal(certProblem(new TypeError('fetch failed')), false)
  assert.equal(certProblem(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' })), true)
})

test('data: 地址照旧直接解，不进重试', async () => {
  const got = await downloadAsset('data:image/png;base64,AAAA', 'image')
  assert.equal(got.mime, 'image/png')
  assert.equal(got.buffer.length, 3)
})
