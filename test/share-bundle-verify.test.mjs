import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 分享离线包里的校验页（v0.9.134）：
//   1) 匿名下载的离线包里真有一份「校验.html」，插在 说明.txt 后面；
//   2) 页面里的清单与包里其它条目逐条对得上（名字 / 字节数 / CRC32），且不列自己；
//   3) 这一页不联网、不带外链，title 写的是「离线包校验」；
//   4) 清单里只有文件名与字节：没有作品编号、模板 / 画布 id、账号与分享 token。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-verify-'))
process.env.DATA_DIR = dir

const now = '2026-11-15T09:00:00.000Z'
const TOKEN = 'tok_share_verify_987654'

const storyboard = [1, 2].map((index) => ({
  shotNo: index,
  startSec: index - 1,
  endSec: index,
  frameIndex: index,
  frameUrl: '/media/frames/tpl_sv/frame-' + String(index).padStart(2, '0') + '.jpg',
  visual: '第 ' + index + ' 镜画面',
  camera: '固定',
}))

const project = {
  id: 'prj_share_verify',
  ownerId: 'u_share_verify',
  title: '分享包验一验',
  templateId: 'tpl_sv',
  flowId: 'flow_sv',
  version: 2,
  versions: [],
  script: {
    hook: '先看结论',
    structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '口播一句', onScreen: '', purpose: '留人' }],
    updatedAt: now,
  },
  shareToken: TOKEN,
  shareCreatedAt: now,
  status: 'active',
  createdAt: now,
  updatedAt: now,
}

const template = {
  id: 'tpl_sv',
  ownerId: 'u_share_verify',
  title: '验包模板',
  platformLabel: '抖音',
  durationSec: 6,
  structure: [{ beat: '开场' }],
  storyboard,
  frames: storyboard.map((shot) => ({ index: shot.frameIndex, url: shot.frameUrl.replace('/media/', '') })),
  createdAt: now,
  updatedAt: now,
}

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), '[]', 'utf8')
const framesDir = path.join(dir, 'frames', 'tpl_sv')
fs.mkdirSync(framesDir, { recursive: true })
for (let index = 1; index <= 2; index += 1) {
  fs.writeFileSync(path.join(framesDir, 'frame-' + String(index).padStart(2, '0') + '.jpg'), Buffer.from('jpeg-' + index))
}

const { createProjectShareRouter } = await import('../server/routes/project-share.mjs')
const { readZipDirectory, readZipEntry, findZipEntry } = await import('../server/zip-read.mjs')
const { VERIFY_PAGE_NAME } = await import('../server/package-verify-page.mjs')
const { crc32 } = await import('../server/zip-store.mjs')
const router = createProjectShareRouter()

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
    },
  }
}

const bundlePath = '/download/share/project/' + TOKEN + '/bundle.zip?tz=480'
let cached = null

/** 匿名下载一次离线包（不带 cookie），后边的用例都读同一份。 */
async function bundle() {
  if (cached) return cached
  const url = new URL('http://localhost' + bundlePath)
  const res = fakeRes()
  const handled = await router.handle({ method: 'GET' }, res, url, url.pathname)
  assert.equal(handled, true)
  assert.equal(res.status, 200)
  const directory = readZipDirectory(res.body)
  assert.ok(directory, '离线包要能读出目录')
  cached = { buffer: res.body, directory }
  return cached
}

const pageHtml = async () => {
  const { buffer, directory } = await bundle()
  return readZipEntry(buffer, findZipEntry(directory.entries, VERIFY_PAGE_NAME)).data.toString('utf8')
}

test('匿名下载的离线包里带校验.html，插在说明.txt 后面', async () => {
  const { directory } = await bundle()
  const names = directory.entries.map((entry) => entry.name)
  assert.ok(names.includes(VERIFY_PAGE_NAME), '离线包里要有 ' + VERIFY_PAGE_NAME + '：' + names.join(' , '))
  assert.equal(names.indexOf(VERIFY_PAGE_NAME), names.indexOf('说明.txt') + 1, '校验页紧跟说明.txt：' + names.join(' , '))
  const html = await pageHtml()
  assert.ok(html.length > 2000, '这一页不该是空壳：' + html.length)
  assert.ok(html.includes('<title>分享包验一验 · 离线包校验 · VisionQA</title>'), '标题要写离线包校验')
  assert.ok(html.includes('把 zip 拖到这里'), '页面上要有拖放区')
})

test('页面清单与包内其它条目逐条对得上，且不列自己', async () => {
  const { buffer, directory } = await bundle()
  const html = await pageHtml()
  const match = html.match(/id="vq-manifest">([\s\S]*?)<\/script>/)
  assert.ok(match, '页面里要有那份清单')
  const manifest = JSON.parse(match[1])
  assert.equal(manifest.self, VERIFY_PAGE_NAME)
  assert.ok(manifest.zip.endsWith('离线包.zip'), '清单要写包名：' + manifest.zip)
  assert.equal(manifest.zip.includes('<'), false, '包名里不留标签字符')
  const want = directory.entries.filter((entry) => entry.name !== VERIFY_PAGE_NAME)
  assert.deepEqual(manifest.files.map((file) => file.n), want.map((entry) => entry.name))
  for (const file of manifest.files) {
    const entry = findZipEntry(directory.entries, file.n)
    const read = readZipEntry(buffer, entry)
    assert.equal(file.b, read.data.length, file.n + ' 的字节数要一致')
    assert.equal(file.c, crc32(read.data) >>> 0, file.n + ' 的 CRC32 要一致')
  }
})

test('这一页不联网：没有 http(s) 地址、外链样式或外部脚本', async () => {
  const html = await pageHtml()
  assert.equal(/https?:\/\//.test(html), false, '页面里不该出现 http(s) 地址')
  assert.equal(/<link\b/i.test(html), false, '不该有外链样式')
  assert.equal(/src=/i.test(html), false, '不该有外部脚本或图片')
  assert.equal((html.match(/<script\b/g) || []).length, 3, '三处脚本：清单、校验逻辑、纸的外壳')
  assert.equal(/<script[^>]*type="module"/i.test(html), false, '不用 module 脚本')
})

test('清单里只有文件名与字节：不出现作品编号、模板 / 画布 id、账号与 token', async () => {
  const { buffer, directory } = await bundle()
  const page = await pageHtml()
  const note = readZipEntry(buffer, findZipEntry(directory.entries, '说明.txt')).data.toString('utf8')
  assert.ok(note.includes(VERIFY_PAGE_NAME), '说明.txt 要交代这一页')
  assert.ok(note.includes('不上传、不联网'), '说明里要说清不联网')
  for (const secret of ['prj_share_verify', 'tpl_sv', 'flow_sv', 'u_share_verify', TOKEN, '/media/']) {
    assert.equal(page.includes(secret), false, '页面里不该出现 ' + secret)
  }
})
