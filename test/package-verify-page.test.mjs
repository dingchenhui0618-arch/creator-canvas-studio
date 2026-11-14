import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 交付包里的校验页（v0.9.133）：
//   1) 封存出来的 zip 里真有一份「校验.html」，插在说明.txt 后面；
//   2) 它写进页面的清单与 zip 的条目逐条对得上（名字 / 字节数 / CRC32），且不列自己；
//   3) 这一页不联网：没有任何 http(s) 地址、没有外链样式或脚本；
//   4) 作品标题里的标签被转义，文件名原样显示成字；
//   5) 说明.txt 里写了这一页是干什么的；交付记录里的包内清单也带上它。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-verify-page-'))
process.env.DATA_DIR = dir
process.env.VQ_KEY_SECRET = 'test-secret-verify-page'

const at = (hour) => '2026-11-15T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const storyboard = [1, 2].map((index) => ({
  shotNo: index,
  startSec: index - 1,
  endSec: index,
  frameIndex: index,
  frameUrl: '/media/frames/tpl_vf/frame-' + String(index).padStart(2, '0') + '.jpg',
  visual: '第 ' + index + ' 镜',
  camera: '固定',
}))
const project = {
  id: 'prj_vf',
  ownerId: 'u_a',
  title: '验包验收 <script>alert(1)</script>',
  templateId: 'tpl_vf',
  flowId: 'flow_vf',
  version: 1,
  versions: [],
  script: {
    hook: '验包钩子',
    structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '验包口播', onScreen: '', purpose: '' }],
    source: 'project',
    updatedAt: at(2),
  },
  status: 'active',
  createdAt: at(1),
  updatedAt: at(2),
}
const template = {
  id: 'tpl_vf',
  ownerId: 'u_a',
  title: '验包模板',
  platformLabel: '抖音',
  durationSec: 12,
  structure: [{ beat: '开场' }],
  storyboard,
  frames: storyboard.map((shot) => ({ index: shot.frameIndex, url: 'frames/tpl_vf/frame-' + String(shot.frameIndex).padStart(2, '0') + '.jpg' })),
  createdAt: at(1),
  updatedAt: at(2),
}
const flows = [
  { id: 'flow_vf', ownerId: 'u_a', name: '验包画布', nodes: [
    { id: 'n1', type: 'input', data: { title: '输入', config: { text: '验包主提示' } } },
  ], edges: [], createdAt: at(1), updatedAt: at(2) },
]
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2), 'utf8')
const framesDir = path.join(dir, 'frames', 'tpl_vf')
fs.mkdirSync(framesDir, { recursive: true })
fs.writeFileSync(path.join(framesDir, 'frame-01.jpg'), Buffer.from('jpeg-one'))
fs.writeFileSync(path.join(framesDir, 'frame-02.jpg'), Buffer.from('jpeg-two'))

const { createProjectsRouter } = await import('../server/routes/projects.mjs')
const { readZipDirectory, readZipEntry, findZipEntry } = await import('../server/zip-read.mjs')
const { packageVerifyHtml, packageVerifyManifest, VERIFY_PAGE_NAME } = await import('../server/package-verify-page.mjs')
const { packageNote } = await import('../server/project-set-sheet.mjs')

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

let sealed = null

test('标记交付：zip 里带一份校验.html，插在说明.txt 后面', async () => {
  const marked = await call('PATCH', '/api/projects/prj_vf', { status: 'done', tz: 480 })
  assert.equal(marked.status, 200)
  const [delivery] = JSON.parse(marked.body).project.deliveries
  assert.ok(delivery.package)
  const file = path.join(dir, 'delivery-packages', 'prj_vf', delivery.id + '.zip')
  const buffer = fs.readFileSync(file)
  const directory = readZipDirectory(buffer)
  assert.ok(directory, '封存出来的包要能读出目录')
  const names = directory.entries.map((entry) => entry.name)
  assert.ok(names.includes(VERIFY_PAGE_NAME), '包里要有 ' + VERIFY_PAGE_NAME)
  const order = names.indexOf(VERIFY_PAGE_NAME)
  assert.equal(names[order - 1], '说明.txt', '校验页紧跟在说明.txt 后面')
  assert.deepEqual(delivery.package.files.map((item) => item.name), names, '交付记录里的包内清单与 zip 条目一致')
  sealed = { delivery, buffer, directory, names }
})

test('页面里的清单与 zip 条目逐条对得上，且不列自己', async () => {
  const { buffer, directory } = sealed
  const entry = findZipEntry(directory.entries, VERIFY_PAGE_NAME)
  const read = readZipEntry(buffer, entry)
  assert.ok(read && read.crcOk, '这一页自己也要 CRC32 对得上')
  const html = read.data.toString('utf8')
  const match = html.match(/id="vq-manifest">([\s\S]*?)<\/script>/)
  assert.ok(match, '页面里要有那份清单')
  const manifest = JSON.parse(match[1])
  assert.equal(manifest.self, VERIFY_PAGE_NAME)
  assert.ok(manifest.zip.endsWith('交付包.zip'), '清单要写包名：' + manifest.zip)
  assert.equal(manifest.zip.includes('<'), false, '包名里不留标签字符')
  const want = directory.entries.filter((item) => item.name !== VERIFY_PAGE_NAME)
  assert.deepEqual(manifest.files.map((item) => item.n), want.map((item) => item.name))
  for (const file of manifest.files) {
    const actual = findZipEntry(directory.entries, file.n)
    assert.equal(file.b, actual.bytes, file.n + ' 的字节数要一致')
    assert.equal(file.c, actual.crc >>> 0, file.n + ' 的 CRC32 要一致')
  }
})

test('这一页不联网：没有 http(s) 地址、没有外链样式或脚本', () => {
  const { buffer, directory } = sealed
  const html = readZipEntry(buffer, findZipEntry(directory.entries, VERIFY_PAGE_NAME)).data.toString('utf8')
  assert.equal(/https?:\/\//.test(html), false, '页面里不该出现 http(s) 地址')
  assert.equal(/<link\b/i.test(html), false, '不该有外链样式')
  assert.equal((html.match(/<script\b/g) || []).length, 3, '三处脚本：清单、校验逻辑、纸的外壳')
  assert.equal(/src=/i.test(html), false, '不该有外部脚本或图片')
  // 页面必须能被 file:// 直接打开：不带 ES module、不带 import
  assert.equal(/<script[^>]*type="module"/i.test(html), false, '不用 module 脚本')
  assert.ok(html.includes('把 zip 拖到这里'))
})

test('标题里的标签被转义，成品文案与条数写对', async () => {
  const html = packageVerifyHtml({
    project: { id: 'prj_vf', title: '验包验收 <script>alert(1)</script>', version: 1 },
    zipName: '验包验收-交付包.zip',
    entries: [{ name: '交付稿.md', data: 'hi' }, { name: 'frames/frame-01.jpg', data: 'jpg' }],
    generatedAt: '2026-11-15T02:00:00.000Z',
  })
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '标题要转义')
  assert.equal(html.includes('<script>alert(1)</script>'), false, '不许把标签原样写进页面')
  assert.ok(html.includes('2 个文件的字节数与 CRC32'), '条数要写对')
  assert.ok(html.includes('2026-11-15 10:00'), '打包时间按东八区写')
  const manifest = packageVerifyManifest({ zipName: 'a.zip', files: [{ name: 'x.md', bytes: 3, crc32: 7 }] })
  assert.deepEqual(manifest, { version: 1, zip: 'a.zip', self: VERIFY_PAGE_NAME, files: [{ n: 'x.md', b: 3, c: 7 }] })
})

test('说明.txt 交代了这一页；坏名字被拦在清单外', () => {
  const note = packageNote({ model: { id: 'prj_vf', title: '验包', version: 1 }, frameCount: 2 })
  assert.ok(note.includes('校验.html'), '说明里要有这一页')
  assert.ok(note.includes('不上传、不联网'), '说明里要说清不联网')
  const manifest = packageVerifyManifest({ files: [{ name: '', bytes: 1, crc32: 1 }, { name: 'ok.txt', bytes: 2, crc32: 2 }] })
  assert.deepEqual(manifest.files.map((item) => item.n), ['ok.txt'])
})
test('收据：结论能复制或存成 txt，清单带上作品名与版次', async () => {
  const { buffer, directory } = sealed
  const html = readZipEntry(buffer, findZipEntry(directory.entries, VERIFY_PAGE_NAME)).data.toString('utf8')
  // 静态纸面上没有收据块：它只在核对出结果后才出现
  assert.equal(html.includes('<div class="vf-receipt">'), false, '收据是核对后才生成的')
  assert.ok(html.includes('带走这份结论'), '脚本里要有收据标题')
  assert.ok(html.includes('复制这段'), '要有复制按钮')
  assert.ok(html.includes('存成 核对结果.txt'), '要有存成 txt 的按钮')
  assert.ok(html.includes('这段文字只在你自己的电脑上生成'), '要说清不上传')
  assert.ok(html.includes('@media print { .vf-receipt-row { display: none; } }'), '打印时按钮收起来')
  const manifest = JSON.parse(html.match(/id="vq-manifest">([\s\S]*?)<\/script>/)[1])
  assert.deepEqual(manifest.project, { title: '验包验收 <script>alert(1)</script>', version: 1 }, '清单里带上作品名与版次')
  const blob = html.match(/id="vq-manifest">([\s\S]*?)<\/script>/)[1]
  assert.equal(blob.includes('<'), false, '清单里不留尖括号（标题带标签也拆不坏页面）')
  assert.ok(blob.includes('\\u003cscript'), '标签以 \\u003c 转义后再进清单')
})
