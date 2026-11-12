import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 分享链接上的评审对照纸：拿到链接的人没有账号，也能把问题框在画面上的那张纸打开。
// 这一组盯四件事：不用登录也能 200、画面走带 token 的帧图接口、只印这条作品的评审、
// 链接失效时给一张「已失效」的纸而不是 JSON。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-print-'))
process.env.DATA_DIR = dir

const now = '2026-11-12T12:00:00.000Z'
const TOKEN = 'tok_share_1234567890'

fs.writeFileSync(
  path.join(dir, 'projects.json'),
  JSON.stringify(
    [
      {
        id: 'prj_p',
        ownerId: 'u_a',
        title: '毛衣折叠收纳法',
        templateId: 'tpl_a',
        flowId: '',
        version: 2,
        versions: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
        shareToken: TOKEN,
        shareCreatedAt: now,
      },
    ],
    null,
    2,
  ),
  'utf8',
)

fs.writeFileSync(
  path.join(dir, 'templates.json'),
  JSON.stringify(
    [
      {
        id: 'tpl_a',
        title: '收纳模板',
        kind: 'video',
        platformLabel: '抖音',
        durationSec: 18,
        structure: [],
        storyboard: [{ shotNo: 1, startSec: 0, endSec: 2.3, frameIndex: 1, frameUrl: '/media/frames/tpl_a/frame-01.jpg' }],
        frames: [{ index: 1, url: '/media/frames/tpl_a/frame-01.jpg' }],
      },
    ],
    null,
    2,
  ),
  'utf8',
)

function review(overrides = {}) {
  return {
    id: 'rev_old',
    ownerId: 'u_a',
    projectId: 'prj_p',
    version: 2,
    createdAt: '2026-11-12T10:00:00.000Z',
    source: { kind: 'template', label: '毛衣折叠收纳法 · v2', media: 'frames/tpl_a/frame-01.jpg', imageUrl: '' },
    result: {
      verdict: 'needs_review',
      summary: '旧的那次评审',
      model: 'deepseek-flash',
      observations: [
        {
          dimension: 'composition',
          severity: 'major',
          statement: '旧结论：标题压住折叠起点',
          evidence: { x: 0.13, y: 0.45, w: 0.47, h: 0.12 },
          confidence: 0.85,
        },
      ],
      fixes: [],
      notAssessable: [],
    },
    ...overrides,
  }
}

fs.writeFileSync(
  path.join(dir, 'reviews.json'),
  JSON.stringify(
    [
      review({
        id: 'rev_new',
        createdAt: '2026-11-12T12:00:00.000Z',
        result: {
          ...review().result,
          summary: '新的那次评审',
          observations: [
            {
              dimension: 'composition',
              severity: 'major',
              statement: '最新结论：标题压住折叠起点',
              evidence: { x: 0.13, y: 0.45, w: 0.47, h: 0.12 },
              confidence: 0.9,
            },
          ],
        },
      }),
      review(),
      review({
        id: 'rev_other',
        projectId: 'prj_other',
        createdAt: '2026-11-12T13:00:00.000Z',
        result: { ...review().result, summary: '别条作品的评审', observations: [{ dimension: 'color', severity: 'minor', statement: '别条作品的问题', evidence: null }] },
      }),
    ],
    null,
    2,
  ),
  'utf8',
)

const { createProjectShareRouter } = await import('../server/routes/project-share.mjs')
const router = createProjectShareRouter()

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
  }
}

async function open(pathname) {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const handled = await router.handle({ method: 'GET' }, res, url, url.pathname)
  return { handled, res }
}

test('不用登录也能打开分享链接上的评审对照纸，画面走带 token 的帧图接口', async () => {
  const { handled, res } = await open('/print/share/project/' + TOKEN + '/review?tz=480')
  assert.equal(handled, true)
  assert.equal(res.status, 200)
  assert.match(String(res.headers['Content-Type']), /text\/html/)
  assert.match(res.body, /评审对照 · 毛衣折叠收纳法/)
  assert.match(res.body, /返回分享页/)
  assert.match(res.body, /#\/share\/project\/tok_share_1234567890/)
  assert.match(res.body, /<img src="\/api\/share\/project\/tok_share_1234567890\/frame\/1"/)
  assert.doesNotMatch(res.body, /\/media\/frames/, '分享页拿不到登录态的帧图地址')
  assert.match(res.body, /来自只读分享链接/)
  assert.match(res.body, /data-no="1"/)
  // 每一版只印最近一次：旧的结论不上纸
  assert.match(res.body, /最新结论：标题压住折叠起点/)
  assert.doesNotMatch(res.body, /旧结论/)
  // 别条作品的评审不会被这条链接顺带印出来
  assert.doesNotMatch(res.body, /别条作品的问题/)
  // 内部作品 id / 归属账号不跟着分享出去
  assert.doesNotMatch(res.body, /prj_p/)
  assert.doesNotMatch(res.body, /u_a/)
})

test('链接失效时给一张纸说清楚，不吐 JSON', async () => {
  const { res } = await open('/print/share/project/tok_does_not_exist_123/review')
  assert.equal(res.status, 404)
  assert.match(res.body, /这条分享链接已经失效/)
  assert.match(res.body, /data-print/)
  assert.doesNotMatch(res.body, /SHARE_NOT_FOUND/)
})

test('对照纸只读：POST 打不开', async () => {
  const url = new URL('http://localhost/print/share/project/' + TOKEN + '/review')
  const res = fakeRes()
  await router.handle({ method: 'POST' }, res, url, url.pathname)
  assert.equal(res.status, 405)
  assert.match(res.body, /只能看，不能改/)
})
