// 受登录态保护的图片响应（v0.9.89）：ETag 怎么算、If-None-Match 怎么认、
// 304 怎么发。帧图与上传图两条路由共用这一份，所以单独钉住，别只靠路由层顺带测到。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { AUTH_IMAGE_CACHE, etagMatches, imageEtag, sendAuthImage } from '../server/image-response.mjs'

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 0x11)])
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-imgresp-'))

function mockReq(headers = {}) {
  const req = new Readable({ read() {} })
  req.method = 'GET'
  req.headers = { ...headers }
  req.push(null)
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    get bytes() { return Buffer.concat(this.chunks) },
  }
}

test('ETag 由大小与修改时间算：带引号、十六进制、内容变了就变', () => {
  const first = imageEtag({ size: 300, mtimeMs: 1700000000123 })
  assert.match(first, /^"[0-9a-f]+-[0-9a-f]+"$/)
  assert.equal(first, imageEtag({ size: 300, mtimeMs: 1700000000123 }), '同一个文件两次算出来必须一样')
  assert.notEqual(imageEtag({ size: 301, mtimeMs: 1700000000123 }), first)
  assert.notEqual(imageEtag({ size: 300, mtimeMs: 1700000000124 }), first)
  // 缺字段也不该抛：setHeader 里再炸就变成 500 了
  assert.match(imageEtag({}), /^"[0-9a-f]+-[0-9a-f]+"$/)
})

test('If-None-Match：精确、弱前缀 W/、列表、* 都认，别的都不认', () => {
  const etag = '"12c-18bf"'
  assert.equal(etagMatches(etag, etag), true)
  assert.equal(etagMatches('W/' + etag, etag), true, '代理会把强 ETag 改写成弱 ETag')
  assert.equal(etagMatches('"aaa", ' + etag, etag), true)
  assert.equal(etagMatches(' * ', etag), true)
  assert.equal(etagMatches('"12c-18bg"', etag), false)
  assert.equal(etagMatches('', etag), false)
  assert.equal(etagMatches(undefined, etag), false)
})

test('没变化的请求回 304：不带 body、不带 Content-Length，但缓存头与 ETag 照给', async () => {
  const file = path.join(DIR, 'frame-01.jpg')
  fs.writeFileSync(file, JPG)
  const first = await sendFirst(file)
  const headers = first.headers
  assert.equal(first.statusCode, 200)
  const res = mockRes()
  const sent = await sendAuthImage(mockReq({ 'if-none-match': headers.ETag }), res, file, 'image/jpeg')
  assert.equal(sent, true)
  assert.equal(res.statusCode, 304)
  assert.equal(res.chunks.length, 0, '304 不能带 body')
  assert.equal(res.headers['Content-Length'], undefined)
  assert.equal(res.headers['Cache-Control'], AUTH_IMAGE_CACHE)
  assert.equal(AUTH_IMAGE_CACHE, 'private, no-cache')
  assert.equal(res.headers.ETag, headers.ETag)
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff')
})

async function sendFirst(file) {
  const res = mockRes()
  await sendAuthImage(mockReq(), res, file, 'image/jpeg')
  return res
}

test('文件不存在 / 不是文件：返回 false，一个头都不写（调用方照旧回 404）', async () => {
  const missing = mockRes()
  assert.equal(await sendAuthImage(mockReq(), missing, path.join(DIR, 'nope.jpg'), 'image/jpeg'), false)
  assert.equal(missing.statusCode, 0)
  const dirAsFile = mockRes()
  assert.equal(await sendAuthImage(mockReq(), dirAsFile, DIR, 'image/jpeg'), false)
  assert.equal(dirAsFile.statusCode, 0)
})

test('内容变了：旧 ETag 不再命中，回 200 + 新内容', async () => {
  const file = path.join(DIR, 'frame-02.jpg')
  fs.writeFileSync(file, JPG)
  const first = await sendFirst(file)
  const bigger = Buffer.concat([JPG, Buffer.alloc(64, 0x22)])
  fs.writeFileSync(file, bigger)
  const res = mockRes()
  await sendAuthImage(mockReq({ 'if-none-match': first.headers.ETag }), res, file, 'image/jpeg')
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.bytes, bigger)
  assert.notEqual(res.headers.ETag, first.headers.ETag)
})
