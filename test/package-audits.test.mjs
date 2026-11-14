import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 封存包巡检（v0.9.132）：定时任务每天把盘上每个封存包验一遍，结论落成一份报告。
// 这组测的是「报告说的是真事」：
//   1) 两个包都对得上就说都对得上，读的字节数按包记、不按估算；
//   2) 坏一条点名那一条；包不在了、目录读不出来分开说，都不写成通过；
//   3) write=false 只算不落盘；报告坏了、没有都回 null，不猜；
//   4) 只读接口按作品过滤，POST 405、作品不在 404。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-package-audits-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-package-audits'

const now = '2026-11-15T10:00:00.000Z'
const files = [
  { name: '说明.txt', data: Buffer.from('这一版交了。', 'utf8') },
  { name: '现场页.html', data: Buffer.from('<html><body>现场页</body></html>', 'utf8') },
  { name: 'frames/shot-01.jpg', data: Buffer.alloc(2048, 7) },
]
const { buildZip } = await import('../server/zip-store.mjs')
const audit = await import('../server/package-audits.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { readZipDirectory, findZipEntry } = await import('../server/zip-read.mjs')

/** 把一份包落到盘点上的位置（和 delivery-packages.mjs 用的是同一条路径）。 */
function seal(projectId, deliveryId, buffer) {
  const folder = path.join(dir, 'delivery-packages', projectId)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, deliveryId + '.zip'), buffer)
}

/** 一条交付记录：巡检只用到 id / version / package 这三样。 */
function delivery(id, version, pkg) {
  return {
    id,
    version,
    at: now,
    package: { fileName: '交付包.zip', bytes: pkg.bytes, sha256: 'a'.repeat(64), fileCount: 3 },
  }
}

function writeProjects(projects) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
}

function dropReport() {
  fs.rmSync(path.join(dir, 'package-audits.json'), { force: true })
}

const good = buildZip(files)

test('两个包都对得上：报告说 checked 2 / problems 0，读的字节数按包记', async () => {
  dropReport()
  seal('prj_a', 'aaaaaaaaaaaaaaaa', good)
  seal('prj_a', 'bbbbbbbbbbbbbbbb', good)
  writeProjects([
    { id: 'prj_a', ownerId: 'u_a', title: '巡检 A', deliveries: [delivery('aaaaaaaaaaaaaaaa', 2, { bytes: good.length }), delivery('bbbbbbbbbbbbbbbb', 1, { bytes: good.length })] },
  ])
  const report = await audit.runPackageAudit()
  assert.equal(report.version, 1)
  assert.equal(report.checked, 2)
  assert.equal(report.problems, 0)
  assert.match(report.at, /^2026-|^\d{4}-\d{2}-\d{2}T/)
  for (const item of report.packages) {
    assert.equal(item.state, 'ok')
    assert.equal(item.ok, true)
    assert.equal(item.total, 3)
    assert.equal(item.passed, 3)
    assert.equal(item.skipped, 0)
    assert.deepEqual(item.failed, [])
    assert.equal(item.bytes, good.length)
    assert.ok(item.readBytes > 0 && item.readBytes <= good.length, '读的字节数应不超过包大小：' + item.readBytes)
  }
  // 落盘了，而且能按原样读回来
  const saved = await audit.readAuditReport()
  assert.ok(saved)
  assert.equal(saved.checked, 2)
  assert.equal(saved.packages.length, 2)
  assert.deepEqual(saved.packages.map((item) => item.deliveryId).sort(), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
})

test('坏一条、少一个、截断：三种都分开说，都不写成通过', async () => {
  dropReport()
  // 1) 改一个字节：这一条 CRC32 对不上
  const broken = Buffer.from(good)
  const target = findZipEntry(readZipDirectory(good).entries, 'frames/shot-01.jpg')
  broken[target.offset + 30 + Buffer.byteLength(target.name, 'utf8') + 10] ^= 0xff
  seal('prj_b', 'cccccccccccccccc', broken)
  // 2) 盘上那份不在了：只写记录，不落文件
  // 3) 截断：目录读不出来
  seal('prj_b', 'eeeeeeeeeeeeeeee', good.subarray(0, good.length - 40))
  writeProjects([
    {
      id: 'prj_b',
      ownerId: 'u_a',
      title: '巡检 B',
      deliveries: [
        delivery('cccccccccccccccc', 3, { bytes: broken.length }),
        delivery('dddddddddddddddd', 2, { bytes: good.length }),
        delivery('eeeeeeeeeeeeeeee', 1, { bytes: good.length - 40 }),
      ],
    },
  ])
  const report = await audit.runPackageAudit()
  assert.equal(report.checked, 3)
  assert.equal(report.problems, 3)
  const [crc, missing, cut] = report.packages
  assert.equal(crc.state, 'ok')
  assert.equal(crc.ok, false)
  assert.equal(crc.passed, 2)
  assert.equal(crc.failed.length, 1)
  assert.equal(crc.failed[0].name, 'frames/shot-01.jpg')
  assert.equal(crc.failed[0].reason, 'crc')
  assert.equal(missing.state, 'missing')
  assert.equal(missing.ok, false)
  assert.equal(missing.bytes, 0)
  assert.equal(cut.state, 'unreadable')
  assert.equal(cut.ok, false)
})

test('不写盘也能算：write=false 只回结论，不落报告', async () => {
  dropReport()
  seal('prj_c', 'ffffffffffffffff', good)
  writeProjects([{ id: 'prj_c', ownerId: 'u_a', title: '巡检 C', deliveries: [delivery('ffffffffffffffff', 1, { bytes: good.length })] }])
  const report = await audit.runPackageAudit({ write: false })
  assert.equal(report.checked, 1)
  assert.equal(report.problems, 0)
  assert.equal(fs.existsSync(path.join(dir, 'package-audits.json')), false)
  // 没有报告时读出来是 null，不是一份空报告
  assert.equal(await audit.readAuditReport(), null)
  // 报告文件坏了也一样：宁可说没有，不猜
  fs.writeFileSync(path.join(dir, 'package-audits.json'), '{"at": 1', 'utf8')
  assert.equal(await audit.readAuditReport(), null)
  fs.writeFileSync(path.join(dir, 'package-audits.json'), '{"packages":[]}', 'utf8')
  assert.equal(await audit.readAuditReport(), null)
})

function mockReq({ method = 'GET' } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = {}
  req.socket = { remoteAddress: '127.0.0.1' }
  req.push(null)
  return req
}
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}) },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(chunk) {
      if (Buffer.isBuffer(chunk)) this.body = chunk
      else if (chunk) this.body = String(chunk)
      this.writableEnded = true
    },
  }
}
async function call(method, pathname) {
  const res = mockRes()
  const url = new URL('http://vq.local' + pathname)
  await createProjectsRouter().handle(mockReq({ method }), res, url, url.pathname)
  return { status: res.statusCode, headers: res.headers, body: res.body }
}

test('只读接口按作品过滤：只给这一件作品的包，POST 405、作品不在 404', async () => {
  dropReport()
  seal('prj_route', '1111111111111111', good)
  seal('prj_other', '2222222222222222', good)
  writeProjects([
    { id: 'prj_route', ownerId: 'u_a', title: '巡检路由', deliveries: [delivery('1111111111111111', 4, { bytes: good.length })] },
    { id: 'prj_other', ownerId: 'u_a', title: '别的作品', deliveries: [delivery('2222222222222222', 1, { bytes: good.length })] },
  ])
  await audit.runPackageAudit()
  const got = await call('GET', '/api/projects/prj_route/package-audits')
  assert.equal(got.status, 200)
  const body = JSON.parse(got.body)
  assert.equal(body.ok, true)
  assert.ok(body.at)
  assert.equal(body.checked, 1)
  assert.equal(body.problems, 0)
  assert.equal(body.packages.length, 1)
  assert.equal(body.packages[0].deliveryId, '1111111111111111')
  assert.equal(body.packages[0].version, 4)
  assert.equal(body.packages[0].state, 'ok')
  assert.equal(body.packages[0].ok, true)
  assert.equal(body.packages[0].passed, 3)
  assert.equal((await call('POST', '/api/projects/prj_route/package-audits')).status, 405)
  assert.equal((await call('GET', '/api/projects/prj_none/package-audits')).status, 404)
})

test('还没巡检过：接口如实回空，不编一个「通过」', async () => {
  dropReport()
  writeProjects([{ id: 'prj_route', ownerId: 'u_a', title: '巡检路由', deliveries: [] }])
  const got = await call('GET', '/api/projects/prj_route/package-audits')
  assert.equal(got.status, 200)
  const body = JSON.parse(got.body)
  assert.equal(body.at, '')
  assert.equal(body.checked, 0)
  assert.deepEqual(body.packages, [])
  assert.equal(body.problems, 0)
})
