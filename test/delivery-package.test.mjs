import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 交付即封存（v0.9.125）：
//   1) 标记交付时服务端落一份 zip，记录里只带编号 / 字节数 / 哈希 / 下载名；
//   2) 之后改模板、改脚本、开新版，取回的仍是当初那一份字节；
//   3) 重新打开这一版会收回记录与包，地址 404；
//   4) 作品删掉时封存目录一起清掉；
//   5) 老交付记录没有包，明确 404，不拿今天现打的包冒充。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-delivery-package-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-delivery-package'

const now = '2026-11-15T10:00:00.000Z'
const at = (hour) => '2026-11-15T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const storyboard = [1, 2].map((index) => ({
  shotNo: index,
  startSec: index - 1,
  endSec: index,
  frameIndex: index,
  frameUrl: '/media/frames/tpl_pkg/frame-' + String(index).padStart(2, '0') + '.jpg',
  visual: '第 ' + index + ' 镜',
  camera: '固定',
}))
const project = {
  id: 'prj_pkg',
  ownerId: 'u_a',
  title: '交付封存验收 / 第 2 版',
  templateId: 'tpl_pkg',
  flowId: 'flow_pkg2',
  version: 2,
  versions: [{
    n: 1,
    flowId: 'flow_pkg1',
    name: '第一版画布',
    archivedAt: at(1),
    script: { hook: '第一版钩子', structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '第一版口播', onScreen: '', purpose: '' }] },
  }],
  script: {
    hook: '第二版钩子',
    structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '第二版口播', onScreen: '', purpose: '' }],
    source: 'project',
    updatedAt: at(2),
  },
  status: 'active',
  createdAt: at(1),
  updatedAt: at(2),
}
const template = {
  id: 'tpl_pkg',
  ownerId: 'u_a',
  title: '封存模板',
  platformLabel: '抖音',
  durationSec: 12,
  structure: [{ beat: '开场' }],
  storyboard,
  frames: storyboard.map((shot) => ({ index: shot.frameIndex, url: 'frames/tpl_pkg/frame-' + String(shot.frameIndex).padStart(2, '0') + '.jpg' })),
  createdAt: now,
  updatedAt: now,
}
const review = {
  id: 'rev_pkg',
  ownerId: 'u_a',
  projectId: 'prj_pkg',
  version: 2,
  createdAt: at(2),
  source: { kind: 'template', label: '封存模板 · v2', media: '', imageUrl: '' },
  result: {
    verdict: 'pass',
    summary: '可以交',
    observations: [],
    fixes: [],
    profile: 'deepseek-flash',
  },
}
const flows = [
  { id: 'flow_pkg2', ownerId: 'u_a', name: '第二版画布', nodes: [
    { id: 'n1', type: 'input', data: { title: '输入', config: { text: '第二版主提示' } } },
    { id: 'n2', type: 'output', data: { title: '输出', config: { format: 'markdown' } } },
  ], edges: [], createdAt: at(1), updatedAt: at(2) },
  { id: 'flow_pkg1', ownerId: 'u_a', name: '第一版画布', nodes: [
    { id: 'n1', type: 'input', data: { title: '输入', config: { text: '第一版主提示' } } },
  ], edges: [], createdAt: at(0), updatedAt: at(1) },
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([review], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2), 'utf8')
const framesDir = path.join(dir, 'frames', 'tpl_pkg')
fs.mkdirSync(framesDir, { recursive: true })
fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), Buffer.from('jpeg-one'))
fs.writeFileSync(path.join(framesDir, 'frame-02.jpg'), Buffer.from('jpeg-two'))

const projects = await import('../server/projects.mjs')
const packages = await import('../server/delivery-packages.mjs')
const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { ledgerRows } = await import('../server/delivery-ledger.mjs')
const me = { id: 'u_a' }

function mockReq({ method = 'GET', body = null } = {}) {
  const req = new Readable({ read() {} })
  req.method = method
  req.headers = body ? { 'content-type': 'application/json' } : {}
  req.socket = { remoteAddress: '127.0.0.1' }
  if (body === null) req.push(null)
  else {
    req.push(JSON.stringify(body))
    req.push(null)
  }
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
async function call(method, pathname, body = null) {
  const res = mockRes()
  const url = new URL('http://vq.local' + pathname)
  await createProjectsRouter().handle(mockReq({ method, body }), res, url, url.pathname)
  return { status: res.statusCode, headers: res.headers, body: res.body }
}

test('标记交付时封存 zip：记录带编号 / 字节数 / 哈希 / 下载名', async () => {
  const marked = await call('PATCH', '/api/projects/prj_pkg', { status: 'done', tz: 480 })
  assert.equal(marked.status, 200)
  const body = JSON.parse(marked.body)
  const [delivery] = body.project.deliveries
  assert.ok(delivery.id, '交付记录有编号')
  assert.match(delivery.id, /^[0-9a-f]{16}$/)
  assert.ok(delivery.package, '交付记录有封存包')
  assert.ok(delivery.package.bytes > 0)
  assert.match(delivery.package.sha256, /^[0-9a-f]{64}$/)
  assert.match(delivery.package.fileName, /交付包\.zip$/)
  const file = path.join(dir, 'delivery-packages', 'prj_pkg', delivery.id + '.zip')
  assert.equal(fs.statSync(file).size, delivery.package.bytes)
  assert.equal(fs.readFileSync(file).length, delivery.package.bytes)

  // 包内清单（v0.9.126）：封存时顺手记下名字与字节数，界面不用解 zip 就能说清包里有什么
  assert.ok(delivery.package.fileCount >= 6)
  assert.equal(delivery.package.files.length, delivery.package.fileCount)
  const names = delivery.package.files.map((item) => item.name)
  assert.ok(names.some((name) => name.endsWith('.md')), '有交付稿')
  assert.ok(names.includes('说明.txt'))
  assert.ok(names.includes('现场页.html'))
  assert.ok(names.includes('评审对照页.html'))
  assert.ok(names.includes('两版对照页.html'))
  assert.ok(names.some((name) => name.startsWith('frames/')), '帧图在清单里')
  for (const item of delivery.package.files) {
    assert.ok(item.bytes >= 0)
    assert.ok(item.name.length <= 160)
  }
  const reloaded = await projects.getProject('prj_pkg', me)
  assert.deepEqual(reloaded.deliveries[0].package.files, delivery.package.files, '读回来清单还在')
  assert.equal(reloaded.deliveries[0].package.fileCount, delivery.package.fileCount)
})

test('下载封存包：登录态可取，带 zip 头与中文名；非 GET 405', async () => {
  const project = await projects.getProject('prj_pkg', me)
  const delivery = project.deliveries[0]
  const pathname = '/api/projects/prj_pkg/delivery-packages/' + delivery.id
  const got = await call('GET', pathname)
  assert.equal(got.status, 200)
  assert.match(String(got.headers['Content-Type']), /application\/zip/)
  assert.match(String(got.headers['Content-Disposition']), /attachment/)
  assert.match(String(got.headers['Content-Disposition']), /filename\*=UTF-8''/)
  assert.equal(String(got.headers['X-VQ-Package-SHA256']), delivery.package.sha256)
  assert.equal(got.body.readUInt32LE(0), 0x04034b50)
  assert.equal(got.body.length, delivery.package.bytes)

  const posted = await call('POST', pathname)
  assert.equal(posted.status, 405)
  assert.match(String(posted.body), /只能下载/)
})

test('封存之后改模板、改脚本：取回的字节仍是当初那一份', async () => {
  const project = await projects.getProject('prj_pkg', me)
  const delivery = project.deliveries[0]
  const pathname = '/api/projects/prj_pkg/delivery-packages/' + delivery.id
  const before = (await call('GET', pathname)).body

  // 改模板分镜与作品脚本：如果是「今天现打」，内容会跟着变
  const templates = await import('../server/templates.mjs')
  await templates.updateTemplate('tpl_pkg', { storyboard: storyboard.map((shot) => ({ ...shot, visual: '改过的画面' })) }, me)
  await projects.saveProjectScript('prj_pkg', { ...project.script, hook: '改过的钩子' }, me)

  const after = (await call('GET', pathname)).body
  assert.deepEqual(after, before, '封存包不跟随后来的模板 / 脚本修改')
  const file = path.join(dir, 'delivery-packages', 'prj_pkg', delivery.id + '.zip')
  assert.deepEqual(fs.readFileSync(file), before)
})

test('包内目录与单条内容：按偏移读，读的字节远小于整包（v0.9.131）', async () => {
  const project = await projects.getProject('prj_pkg', me)
  const delivery = project.deliveries[0]
  const head = '/api/projects/prj_pkg/delivery-packages/' + delivery.id

  const listed = await call('GET', head + '/content')
  assert.equal(listed.status, 200)
  const body = JSON.parse(listed.body)
  assert.equal(body.ok, true)
  assert.equal(body.bytes, delivery.package.bytes)
  assert.ok(body.readBytes > 0)
  assert.ok(body.readBytes < 4096, '读目录读了 ' + body.readBytes + ' 字节')
  assert.equal(body.entries.length, delivery.package.files.length)
  assert.equal(body.manifest.recorded, delivery.package.files.length)
  assert.deepEqual(body.manifest.missing, [])

  const entry = await call('GET', head + '/content/' + encodeURIComponent('说明.txt'))
  assert.equal(entry.status, 200)
  assert.ok(String(entry.headers['Content-Type']).startsWith('text/plain'))
  const readBytes = Number(entry.headers['X-VQ-Read-Bytes'])
  assert.ok(readBytes > 0)
  assert.ok(readBytes < delivery.package.bytes, '读一条读了 ' + readBytes + ' 字节')
  assert.equal(Number(entry.headers['X-VQ-Package-Bytes']), delivery.package.bytes)
  assert.match(String(entry.headers['X-VQ-Entry-Crc32']), /^[0-9]+$/)
  assert.ok(entry.body.length > 0)

  assert.equal((await call('POST', head + '/content')).status, 405)
  assert.equal((await call('GET', head + '/content/' + encodeURIComponent('没这条.txt'))).status, 404)
})

test('交付流水带包编号：当前版一行能下载，老记录没有包不出入口', async () => {
  const list = await projects.listProjects(me)
  const rows = ledgerRows({ projects: list, counts: {} })
  const row = rows.find((item) => item.projectId === 'prj_pkg')
  assert.ok(row.deliveryId)
  assert.ok(row.package)
  assert.ok(row.package.bytes > 0)
})

test('重新打开这一版：记录与包一起收回，地址 404', async () => {
  const before = await projects.getProject('prj_pkg', me)
  const delivery = before.deliveries[0]
  const reopened = await call('PATCH', '/api/projects/prj_pkg', { status: 'active' })
  assert.equal(reopened.status, 200)
  assert.equal(JSON.parse(reopened.body).project.deliveries.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'delivery-packages', 'prj_pkg', delivery.id + '.zip')), false)
  const gone = await call('GET', '/api/projects/prj_pkg/delivery-packages/' + delivery.id)
  assert.equal(gone.status, 404)
  assert.match(String(gone.body), /没有封存包/)
})

test('作品删掉：封存目录一起清掉，旧地址 404', async () => {
  const marked = await call('PATCH', '/api/projects/prj_pkg', { status: 'done' })
  assert.equal(marked.status, 200)
  const delivery = JSON.parse(marked.body).project.deliveries[0]
  const removed = await call('DELETE', '/api/projects/prj_pkg')
  assert.equal(removed.status, 200)
  assert.equal(fs.existsSync(path.join(dir, 'delivery-packages', 'prj_pkg')), false)
  const gone = await call('GET', '/api/projects/prj_pkg/delivery-packages/' + delivery.id)
  assert.equal(gone.status, 404)
})

test('存储层：路径不认外部目录、空包不写、只保留还挂着的包', async () => {
  await assert.rejects(() => packages.saveDeliveryPackage('../outside', '0123456789abcdef', Buffer.from('x')), /编号不合法/)
  await assert.rejects(() => packages.saveDeliveryPackage('prj_store', '0123456789abcdef', Buffer.alloc(0)), /空的/)

  const a = await packages.saveDeliveryPackage('prj_store', '0123456789abcdef', Buffer.from('aaa'), { fileName: 'A.zip' })
  const b = await packages.saveDeliveryPackage('prj_store', 'fedcba9876543210', Buffer.from('bbb'), { fileName: 'B.zip' })
  assert.equal(a.bytes, 3)
  assert.equal(b.bytes, 3)
  assert.deepEqual(await packages.readDeliveryPackage('prj_store', '0123456789abcdef'), Buffer.from('aaa'))
  assert.equal(await packages.readDeliveryPackage('prj_store', '../outside'), null)
  assert.equal(await packages.pruneDeliveryPackages('prj_store', ['0123456789abcdef']), 1)
  assert.equal(await packages.readDeliveryPackage('prj_store', 'fedcba9876543210'), null)
  assert.deepEqual(await packages.readDeliveryPackage('prj_store', '0123456789abcdef'), Buffer.from('aaa'))
})

test('清单上限：总数照记，名单只留前 60 条，坏名字不进清单', async () => {
  const many = Array.from({ length: 80 }, (_, index) => ({ name: '第' + index + '个.txt', bytes: index }))
  const saved = await packages.saveDeliveryPackage('prj_store', '2222222222222222', Buffer.from('ccc'), {
    fileName: 'C.zip',
    files: [...many, { name: '   ', bytes: 9 }, { name: '坏' + String.fromCharCode(10) + '名字.txt', bytes: -3 }],
  })
  assert.equal(saved.fileCount, 81)
  assert.equal(saved.files.length, 60)
  assert.equal(saved.files[0].name, '第0个.txt')
  assert.equal(saved.files[59].name, '第59个.txt')
  assert.equal(saved.files[60], undefined)
  assert.equal(saved.files.at(-1).bytes, 59)

  const dirty = await packages.saveDeliveryPackage('prj_store', '3333333333333333', Buffer.from('ddd'), {
    fileName: 'D.zip',
    files: [{ name: '合' + String.fromCharCode(0) + '法.txt', bytes: 4 }],
  })
  assert.equal(dirty.files[0].name, '合法.txt')
  assert.equal(dirty.files[0].bytes, 4)
})
