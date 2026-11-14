import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 只读分享的离线包（v0.9.124）：
//  1. 拿到分享链接就能下载，包里有现场页、评审对照、帧图与说明；
//  2. 只打分享页已经公开的前 12 镜；两版对照只在分享者打开时进包；
//  3. 包里没有作品编号、账号、画布 / 模板 id、原始素材路径与 token；
//  4. 链接停用后同一个下载地址 404，非 GET 405。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-bundle-'))
process.env.DATA_DIR = dir

const now = '2026-11-15T09:00:00.000Z'
const TOKEN = 'tok_share_bundle_123456'
const SHOTS = 13

const storyboard = Array.from({ length: SHOTS }, (_, index) => ({
  shotNo: index + 1,
  startSec: index,
  endSec: index + 1,
  frameIndex: index + 1,
  frameUrl: '/media/frames/tpl_bundle/frame-' + String(index + 1).padStart(2, '0') + '.jpg',
  visual: '第 ' + (index + 1) + ' 镜画面',
  camera: '固定',
  caption: '',
  audio: '',
}))

const project = {
  id: 'prj_bundle',
  ownerId: 'u_a',
  title: '毛衣折叠收纳法 / 第 3 版',
  templateId: 'tpl_bundle',
  flowId: 'flow_b3',
  version: 3,
  versions: [
    {
      n: 1,
      flowId: 'flow_b1',
      name: '第一版',
      archivedAt: now,
      script: { hook: '旧钩子', structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '旧口播', onScreen: '', purpose: '' }] },
    },
    {
      n: 2,
      flowId: 'flow_b2',
      name: '第二版',
      archivedAt: now,
      script: { hook: '上一版钩子', structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '上一版口播', onScreen: '', purpose: '' }] },
    },
  ],
  script: {
    hook: '毛衣别再叠成球',
    structure: [
      { beat: '开场', startSec: 0, endSec: 3, voiceover: '毛衣别再叠成球，三秒变平整', onScreen: '叠衣', purpose: '留人' },
      { beat: '收尾', startSec: 3, endSec: 6, voiceover: '收进抽屉就好', onScreen: '', purpose: '' },
    ],
    updatedAt: now,
  },
  shareToken: TOKEN,
  shareCreatedAt: now,
  shareCompare: true,
  status: 'active',
  deliveries: [{ version: 2, at: '2026-11-14T10:00:00.000Z', review: { verdict: 'pass', issues: { blocker: 0, major: 0, minor: 1, info: 0, counted: 1, observations: 1 } } }],
  createdAt: now,
  updatedAt: now,
}

const template = {
  id: 'tpl_bundle',
  ownerId: 'u_a',
  title: '收纳模板',
  platformLabel: '抖音',
  durationSec: 26,
  structure: [{ beat: '开场' }, { beat: '收尾' }],
  storyboard,
  frames: storyboard.map((shot) => ({ index: shot.frameIndex, url: shot.frameUrl.replace('/media/', '') })),
  createdAt: now,
  updatedAt: now,
}

const review = {
  id: 'rev_bundle_3',
  ownerId: 'u_a',
  projectId: 'prj_bundle',
  version: 3,
  createdAt: '2026-11-15T08:30:00.000Z',
  source: { kind: 'template', label: '毛衣折叠收纳法 · v3', media: 'frames/tpl_bundle/frame-01.jpg', imageUrl: '' },
  result: {
    verdict: 'needs_review',
    summary: '标题压住折叠起点',
    observations: [
      {
        id: 'obs-1',
        dimension: 'composition',
        severity: 'major',
        statement: '红色标题压住毛衣折叠起点',
        evidence: { x: 0.14, y: 0.45, w: 0.42, h: 0.12 },
        confidence: 0.85,
      },
    ],
    fixes: [{ title: '下移标题', detail: '放到桌面空区' }],
    profile: 'deepseek-flash',
  },
}

const flows = [
  { id: 'flow_b3', ownerId: 'u_a', name: '当前画布', nodes: [
    { id: 'n1', type: 'input', data: { title: '输入', config: { text: '第三版主题' } } },
    { id: 'n2', type: 'llm', data: { title: '写一句', config: { systemPrompt: '第三版提示词' } } },
    { id: 'n3', type: 'output', data: { title: '输出', config: { format: 'markdown' } } },
  ], edges: [], createdAt: now, updatedAt: now },
  { id: 'flow_b2', ownerId: 'u_a', name: '第二版画布', nodes: [
    { id: 'n1', type: 'input', data: { title: '输入', config: { text: '第二版主题' } } },
    { id: 'n2', type: 'llm', data: { title: '写一句', config: { systemPrompt: '第二版提示词' } } },
  ], edges: [], createdAt: now, updatedAt: now },
]

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([review], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2), 'utf8')
const framesDir = path.join(dir, 'frames', 'tpl_bundle')
fs.mkdirSync(framesDir, { recursive: true })
for (let index = 1; index <= SHOTS; index += 1) {
  fs.writeFileSync(path.join(framesDir, 'frame-' + String(index).padStart(2, '0') + '.jpg'), Buffer.from('jpeg-' + index))
}

const projectsApi = await import('../server/projects.mjs')
const { createProjectShareRouter } = await import('../server/routes/project-share.mjs')
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

async function open(pathname, method = 'GET') {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const handled = await router.handle({ method }, res, url, url.pathname)
  return { handled, res }
}

/** 只读 ZIP 的本地头：store 条目是「头 + 文件名 + 数据」顺序排下来的。 */
function entries(buffer) {
  const out = []
  let offset = 0
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const nameLen = buffer.readUInt16LE(offset + 26)
    const extraLen = buffer.readUInt16LE(offset + 28)
    const size = buffer.readUInt32LE(offset + 18)
    const name = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8')
    const data = buffer.slice(offset + 30 + nameLen + extraLen, offset + 30 + nameLen + extraLen + size)
    out.push({ name, data })
    offset += 30 + nameLen + extraLen + size
  }
  return out
}

const bundlePath = '/download/share/project/' + TOKEN + '/bundle.zip?tz=480'

test('匿名能下载离线包：现场页、评审对照、两版对照、帧图与说明都在', async () => {
  const { handled, res } = await open(bundlePath)
  assert.equal(handled, true)
  assert.equal(res.status, 200)
  assert.match(String(res.headers['Content-Type']), /application\/zip/)
  assert.match(String(res.headers['Content-Disposition']), /attachment/)
  assert.match(String(res.headers['Content-Disposition']), /filename\*=UTF-8''/)
  assert.match(String(res.headers['Content-Disposition']), /%E7%A6%BB%E7%BA%BF%E5%8C%85/)
  assert.equal(res.body.readUInt32LE(0), 0x04034b50)

  const list = entries(res.body)
  const names = list.map((entry) => entry.name)
  assert.ok(names.includes('现场页.html'))
  assert.ok(names.includes('评审对照页.html'))
  assert.ok(names.includes('两版对照页.html'))
  assert.ok(names.includes('说明.txt'))
  // 分享页只展示前 12 镜：第 13 镜不进包
  assert.equal(names.filter((name) => /^frames\/shot-\d+\.jpg$/.test(name)).length, 12)
  assert.ok(!names.includes('frames/shot-13.jpg'))
  assert.equal(list.filter((entry) => entry.name.endsWith('.jpg')).length, 12)
})

test('包里的内容与分享页同一批：没有作品 / 账号 / 画布 / 模板 id、token 与原始素材路径', async () => {
  const { res } = await open(bundlePath)
  const text = entries(res.body)
    .filter((entry) => entry.name.endsWith('.html') || entry.name.endsWith('.txt'))
    .map((entry) => entry.data.toString('utf8'))
    .join('\n')
  assert.match(text, /毛衣折叠收纳法/)
  assert.match(text, /第三版提示词/)
  assert.match(text, /红色标题压住毛衣折叠起点/)
  assert.match(text, /v2 → v3/)
  assert.match(text, /原片共 13 镜/)
  assert.match(text, /AI 生成/)
  assert.doesNotMatch(text, /prj_bundle/)
  assert.doesNotMatch(text, /u_a/)
  assert.doesNotMatch(text, /flow_b3|flow_b2/)
  assert.doesNotMatch(text, /tpl_bundle/)
  assert.doesNotMatch(text, /tok_share_bundle_123456/)
  assert.doesNotMatch(text, /\/media\//)
})

test('分享者关掉两版对照后，离线包里也少那一页；打开后才带', async () => {
  await projectsApi.setProjectShareCompare('prj_bundle', { id: 'u_a' }, false)
  const off = entries((await open(bundlePath)).res.body).map((entry) => entry.name)
  assert.ok(!off.includes('两版对照页.html'))

  await projectsApi.setProjectShareCompare('prj_bundle', { id: 'u_a' }, true)
  const on = entries((await open(bundlePath)).res.body).map((entry) => entry.name)
  assert.ok(on.includes('两版对照页.html'))
})

test('链接停用后离线包 404，非 GET 405', async () => {
  const posted = await open(bundlePath, 'POST')
  assert.equal(posted.res.status, 405)
  assert.match(posted.res.body.toString('utf8'), /只能下载/)

  await projectsApi.disableProjectShare('prj_bundle', { id: 'u_a' })
  const gone = await open(bundlePath)
  assert.equal(gone.res.status, 404)
  assert.match(gone.res.body.toString('utf8'), /这个离线包已经打不开/)
})

test('下载文件名只留作品名与版次', async () => {
  const { shareBundleFileName } = await import('../server/project-share-bundle.mjs')
  assert.equal(shareBundleFileName({ title: 'a/b:c*?', version: 3 }), 'VisionQA-a b c-v3-离线包.zip')
  assert.equal(shareBundleFileName({ title: '   ', version: 0 }), 'VisionQA-未命名作品-v0-离线包.zip')
})
