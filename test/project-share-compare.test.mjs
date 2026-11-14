import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 只读分享上的两版对照（v0.9.123）：
//  1. 默认不带；分享者主动打开才给，关掉后同一个 token 上的纸立即 404。
//  2. 固定「当前版 vs 上一版」，地址里的 base/target 不能改方向。
//  3. 纸只印这条作品的两版，不带内部 id、账号、原始素材路径。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-share-compare-'))
process.env.DATA_DIR = dir

const now = '2026-11-15T09:00:00.000Z'
const TOKEN = 'tok_share_compare_123456'

const projects = [
  {
    id: 'prj_cmp',
    ownerId: 'u_a',
    title: '毛衣折叠收纳法',
    templateId: '',
    flowId: 'flow_v3',
    version: 3,
    versions: [
      {
        n: 1,
        flowId: 'flow_v1',
        name: '第一版',
        archivedAt: now,
        script: {
          hook: '旧钩子',
          structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '旧口播', onScreen: '', purpose: '' }],
        },
      },
      {
        n: 2,
        flowId: 'flow_v2',
        name: '第二版',
        archivedAt: now,
        script: {
          hook: '别再把毛衣叠成球',
          structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '上一版口播', onScreen: '', purpose: '' }],
        },
      },
    ],
    script: {
      hook: '别再把毛衣叠成球',
      structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '这一版口播', onScreen: '', purpose: '' }],
      updatedAt: now,
    },
    shareToken: TOKEN,
    shareCreatedAt: now,
    shareCompare: true,
    status: 'active',
    deliveries: [
      {
        version: 2,
        at: '2026-11-14T10:00:00.000Z',
        review: { verdict: 'pass', issues: { blocker: 0, major: 0, minor: 1, info: 0, counted: 1, observations: 1 } },
      },
    ],
    createdAt: now,
    updatedAt: now,
  },
]

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(
  path.join(dir, 'flows.json'),
  JSON.stringify(
    [
      {
        id: 'flow_v3',
        ownerId: 'u_a',
        name: '当前画布',
        nodes: [
          { id: 'n1', type: 'input', data: { title: '输入主题', config: { text: '这一版主题' } } },
          { id: 'n2', type: 'llm', data: { title: '大模型调用', config: { model: '', temperature: 0.5, systemPrompt: '这一版提示词' } } },
          { id: 'n3', type: 'output', data: { title: '流程输出', config: { format: 'markdown' } } },
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'flow_v2',
        ownerId: 'u_a',
        name: '上一版画布',
        nodes: [
          { id: 'n1', type: 'input', data: { title: '输入主题', config: { text: '上一版主题' } } },
          { id: 'n2', type: 'llm', data: { title: '大模型调用', config: { model: '', temperature: 0.3, systemPrompt: '上一版提示词' } } },
          { id: 'n4', type: 'review', data: { title: '视觉评审', config: { profile: 'brand', image: '' } } },
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    null,
    2,
  ),
  'utf8',
)

const projectsApi = await import('../server/projects.mjs')
const { publicProjectView } = await import('../server/project-share.mjs')
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

async function open(pathname, method = 'GET') {
  const url = new URL('http://localhost' + pathname)
  const res = fakeRes()
  const handled = await router.handle({ method }, res, url, url.pathname)
  return { handled, res }
}

async function publicView() {
  const project = await projectsApi.getProjectByShareToken(TOKEN)
  return publicProjectView({
    project,
    template: null,
    script: project.script,
    reviews: { count: 0, lastVerdict: '', lastAt: '' },
    runs: 0,
    token: TOKEN,
  })
}

test('分享默认不带两版对照；打开后在公开视图里只给当前版 vs 上一版', async () => {
  await projectsApi.setProjectShareCompare('prj_cmp', { id: 'u_a' }, false)
  const off = await publicView()
  assert.equal(off.versionCompare, null)

  const changed = await projectsApi.setProjectShareCompare('prj_cmp', { id: 'u_a' }, true)
  assert.equal(changed.compare, true)
  const on = await publicView()
  assert.deepEqual(on.versionCompare, { base: 2, target: 3 })
  assert.doesNotMatch(JSON.stringify(on), /flow_v3|flow_v2|prj_cmp|u_a/, '公开视图不夹带内部 id')
})

test('匿名能打开分享链接上的两版对照纸，固定当前版 vs 上一版', async () => {
  await projectsApi.setProjectShareCompare('prj_cmp', { id: 'u_a' }, true)
  // 地址里乱塞 base/target 也不能改方向：分享页只给最近两版
  const { handled, res } = await open('/print/share/project/' + TOKEN + '/versions/compare?base=1&target=3&tz=480')
  assert.equal(handled, true)
  assert.equal(res.status, 200)
  assert.match(String(res.headers['Content-Type']), /text\/html/)
  assert.match(res.body, /两版对照 · 毛衣折叠收纳法/)
  assert.match(res.body, /v2 → v3/)
  assert.doesNotMatch(res.body, /v1 → v3/)
  assert.match(res.body, /返回分享页/)
  assert.match(res.body, /#\/share\/project\/tok_share_compare_123456/)
  assert.match(res.body, /来自只读分享链接/)
  assert.match(res.body, /AI 生成/)
  // 纸里应看到改过的节点与口播，但不带内部 id、账号与原始素材路径
  assert.match(res.body, /输入主题/)
  assert.match(res.body, /这一版提示词/)
  assert.doesNotMatch(res.body, /prj_cmp/)
  assert.doesNotMatch(res.body, /u_a/)
  assert.doesNotMatch(res.body, /flow_v3/)
  assert.doesNotMatch(res.body, /\/media\//)
})

test('分享者关掉对照后，同一个地址给一张说清楚的纸而不是内容', async () => {
  await projectsApi.setProjectShareCompare('prj_cmp', { id: 'u_a' }, false)
  const { res } = await open('/print/share/project/' + TOKEN + '/versions/compare')
  assert.equal(res.status, 404)
  assert.match(res.body, /这张对照纸没有随分享打开/)
  assert.match(res.body, /data-print/)
  assert.doesNotMatch(res.body, /输入主题|这一版提示词/)
})

test('失效链接与 POST 都打不开对照纸', async () => {
  const missing = await open('/print/share/project/tok_does_not_exist_123/versions/compare')
  assert.equal(missing.res.status, 404)
  assert.match(missing.res.body, /分享链接已经失效/)

  const posted = await open('/print/share/project/' + TOKEN + '/versions/compare', 'POST')
  assert.equal(posted.res.status, 405)
  assert.match(posted.res.body, /只能看，不能改/)
})

test('对照开关不改 token，停止分享时连字段一起清掉', async () => {
  const opened = await projectsApi.enableProjectShare('prj_cmp', { id: 'u_a' }, { compare: false })
  assert.equal(opened.compare, false)
  const before = await projectsApi.getProjectByShareToken(opened.token)
  assert.equal(before.share.compare, false)

  const on = await projectsApi.setProjectShareCompare('prj_cmp', { id: 'u_a' }, true)
  assert.equal(on.token, opened.token, '开关不换 token')
  const after = await projectsApi.getProjectByShareToken(opened.token)
  assert.equal(after.share.compare, true)

  assert.equal(await projectsApi.disableProjectShare('prj_cmp', { id: 'u_a' }), true)
  assert.equal(await projectsApi.getProjectByShareToken(opened.token), null)
})
