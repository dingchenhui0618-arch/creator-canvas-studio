import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 智能体草稿写进作品（v0.9.30）：结构化草稿的第三个出口。
// 这一组盯五条口径：
//   1. 写进去的是脚本（钩子 + 段落），草稿的分镜不跟着走，也不编一份分镜进作品；
//   2. 走作品脚本的 copy-on-write：模板与别的作品不动；
//   3. 覆盖要说清楚：回执里带被换掉的那一份（来源与段数），不是静默替换；
//   4. 画布那边的复刻提示词一起换——但用户手改过的提示词一个字不碰；
//   5. 看得见才动得手：别人的作品 404，没有段落 400，没有作品 400。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-agent-project-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const me = { id: 'u_a', name: 'A' }
const other = { id: 'u_b', name: 'B' }

const template = {
  id: 'tpl_coffee',
  ownerId: 'u_a',
  title: '咖啡 3 分钟',
  contentType: '口播',
  durationSec: 18,
  hook: '模板的钩子',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '模板第一句', onScreen: '' },
    { beat: '做法', startSec: 3, endSec: 8, voiceover: '模板第二句', onScreen: '' },
    { beat: '收尾', startSec: 8, endSec: 12, voiceover: '模板第三句', onScreen: '' },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 3, visual: '杯子放下', camera: '近景', caption: '模板第一句', audio: '', purpose: '' },
  ],
  timing: { estimatedSec: 6, actualSec: 18, durationSec: 18, fit: 'loose', pace: '快', rate: 6.5625, overSec: 0, tight: 0, loose: 2 },
  analysis: { pacing: '快', reusableRules: [], viralPoints: [], targetAudience: '' },
  createdAt: at(1, 0),
  updatedAt: at(1, 0),
}

const projects = [
  // 跟随模板：写之前脚本来自模板（3 段），写之后是它自己的版本
  {
    id: 'prj_follow',
    ownerId: 'u_a',
    title: '跟着模板的那条',
    templateId: template.id,
    flowId: '',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 1),
    updatedAt: at(1, 1),
  },
  // 画布出生、没有模板（v0.9.29）：脚本与分镜都还没有，正是草稿最该落的地方
  {
    id: 'prj_bare',
    ownerId: 'u_a',
    title: '照画布建的那条',
    templateId: '',
    flowId: '',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 2),
    updatedAt: at(1, 2),
  },
  // 已经有自己的脚本：写之前要能说清「换掉了几段」
  {
    id: 'prj_own',
    ownerId: 'u_a',
    title: '已经改过脚本的那条',
    templateId: '',
    flowId: '',
    version: 2,
    versions: [],
    status: 'active',
    script: {
      hook: '我自己写的钩子',
      structure: [
        { beat: '我的一段', startSec: 0, endSec: 3, voiceover: '我自己写的口播', onScreen: '' },
        { beat: '我的二段', startSec: 3, endSec: 6, voiceover: '第二句', onScreen: '' },
        { beat: '我的三段', startSec: 6, endSec: 9, voiceover: '第三句', onScreen: '' },
        { beat: '我的四段', startSec: 9, endSec: 12, voiceover: '第四句', onScreen: '' },
      ],
      updatedAt: at(2, 0),
    },
    createdAt: at(1, 3),
    updatedAt: at(2, 0),
  },
  // 有画布：写脚本时把复刻提示词一起换掉
  {
    id: 'prj_canvas',
    ownerId: 'u_a',
    title: '有画布的那条',
    templateId: '',
    flowId: 'flow_rep',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 4),
    updatedAt: at(1, 4),
  },
  // 文字提示词，手改过：不许覆盖
  {
    id: 'prj_hand',
    ownerId: 'u_a',
    title: '提示词手改过的那条',
    templateId: '',
    flowId: 'flow_hand',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 5),
    updatedAt: at(1, 5),
  },
  // 接口那一条：路由测试没有登录态，单独留一条空作品
  {
    id: 'prj_route',
    ownerId: 'u_a',
    title: '接口写进去的那条',
    templateId: '',
    flowId: '',
    version: 0,
    versions: [],
    status: 'active',
    createdAt: at(1, 7),
    updatedAt: at(1, 7),
  },
  // 别人的作品
  {
    id: 'prj_other',
    ownerId: 'u_b',
    title: '别人的作品',
    templateId: '',
    flowId: '',
    version: 1,
    versions: [],
    status: 'active',
    createdAt: at(1, 6),
    updatedAt: at(1, 6),
  },
]

const AUTO_PREFIX = '按模板结构复写一条同类型脚本'
const flows = [
  {
    id: 'flow_rep',
    name: '有画布的那条 · 复刻脚本',
    ownerId: 'u_a',
    nodes: [
      { id: 'n_input', type: 'input', position: { x: 80, y: 140 }, data: { kind: 'input', title: '原始素材', config: { text: '旧钩子' } } },
      {
        id: 'n_llm',
        type: 'llm',
        position: { x: 420, y: 140 },
        data: { kind: 'llm', title: '复刻脚本', config: { systemPrompt: AUTO_PREFIX + '：开场 → 做法 → 收尾。开头钩子参考：旧钩子。' } },
      },
    ],
    edges: [{ id: 'e_input_llm', source: 'n_input', target: 'n_llm' }],
    createdAt: at(2, 1),
    updatedAt: at(2, 1),
  },
  {
    id: 'flow_hand',
    name: '提示词手改过那条的画布',
    ownerId: 'u_a',
    nodes: [
      { id: 'n_llm', type: 'llm', position: { x: 420, y: 140 }, data: { kind: 'llm', title: '复刻脚本', config: { systemPrompt: '我自己手写的提示词：按我的口吻来' } } },
    ],
    edges: [],
    createdAt: at(2, 2),
    updatedAt: at(2, 2),
  },
]

fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(flows, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([], null, 2), 'utf8')

const agentProject = () => import('../server/agent-project.mjs')
const projectsModule = () => import('../server/projects.mjs')

// 草稿：与 normalizeDraft 产出的形状一致（structure 已经带好时长字段）
const draft = {
  title: '咖啡机一分钟出片',
  hook: '别再花三十块买一杯了',
  contentType: '口播',
  structure: [
    { beat: '钩子', startSec: 0, endSec: 0, voiceover: '别再花三十块买一杯了，这个机器一分钟出片。', onScreen: '一分钟' },
    { beat: '演示', startSec: 0, endSec: 0, voiceover: '放豆、按键、等一分钟，奶泡自己打。', onScreen: '' },
    { beat: '收尾', startSec: 0, endSec: 0, voiceover: '链接在评论区，今晚还有券。', onScreen: '' },
  ],
  storyboard: [
    { shotNo: 1, visual: '手把咖啡杯放下', camera: '近景', caption: '别再花三十块买一杯了' },
  ],
  stats: { beats: 3, shots: 1, voiceoverSec: 6.4, storyboardSec: 2, durationSec: 6.4 },
}

test('草稿 → 脚本：钩子与段落照搬，时长按模板语速档重算；只有分镜就是没脚本', async () => {
  const { draftProjectScript } = await agentProject()
  const built = draftProjectScript(draft, { pace: '快', totalSec: 18 })
  assert.equal(built.hook, draft.hook)
  assert.equal(built.structure.length, 3)
  assert.deepEqual(built.structure.map((beat) => beat.beat), ['钩子', '演示', '收尾'])
  assert.ok(built.structure[0].expectedSec > 0, '口播字数换成秒数')
  assert.ok(built.updatedAt, '带保存时间')

  assert.equal(draftProjectScript({ structure: [] }, {}), null, '没有段落的草稿写不进作品')
  assert.equal(draftProjectScript({ storyboard: draft.storyboard }, {}), null, '只有分镜也是没脚本')
  assert.equal(draftProjectScript(null), null)
})

test('写进跟随模板的作品：脚本变成它自己的版本，模板一个字不动', async () => {
  const { writeDraftToProject } = await agentProject()
  const before = await projectsModule().then((mod) => mod.getProject('prj_follow', me))
  assert.equal(before.script, null, '写之前是跟随模板')

  const result = await writeDraftToProject({ draft, projectId: 'prj_follow', user: me })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.project.version, 1, '写脚本不开新版')
  assert.equal(result.body.script.source, 'project', '从此是这条作品自己的版本')
  assert.equal(result.body.script.structure.length, 3)
  assert.equal(result.body.replaced.source, 'template')
  assert.equal(result.body.replaced.beats, 3, '换掉的是模板那 3 段，要能如实说出来')

  // 模板不动：别的作品还跟着模板走
  const templates = JSON.parse(fs.readFileSync(path.join(dir, 'templates.json'), 'utf8'))
  assert.equal(templates[0].structure.length, 3)
  assert.equal(templates[0].hook, '模板的钩子')
  const saved = await projectsModule().then((mod) => mod.getProject('prj_follow', me))
  assert.equal(saved.script.hook, draft.hook)
})

test('写进没有模板的作品（画布出生）：脚本落下来，不编模板也不编分镜', async () => {
  const { writeDraftToProject } = await agentProject()
  const result = await writeDraftToProject({ draft, projectId: 'prj_bare', user: me })
  assert.equal(result.status, 200)
  assert.equal(result.body.replaced.source, '', '之前一份脚本都没有')
  assert.equal(result.body.replaced.beats, 0)
  assert.equal(result.body.script.structure.length, 3)
  assert.equal(result.body.project.templateId, '', '不为了写脚本编一条模板出来')
  assert.equal(result.body.script.storyboard, undefined, '作品脚本里没有分镜这一栏')
})

test('覆盖已经改过的脚本：回执说清换掉了几段，旧口播不残留', async () => {
  const { writeDraftToProject } = await agentProject()
  const oneBeat = { ...draft, hook: '这次只有一个钩子', structure: [draft.structure[0]] }
  const result = await writeDraftToProject({ draft: oneBeat, projectId: 'prj_own', user: me })
  assert.equal(result.status, 200)
  assert.equal(result.body.replaced.source, 'project')
  assert.equal(result.body.replaced.beats, 4, '写之前它自己有 4 段')
  assert.equal(result.body.script.structure.length, 1, '是覆盖不是合并')
  assert.equal(result.body.script.hook, '这次只有一个钩子')
  const saved = await projectsModule().then((mod) => mod.getProject('prj_own', me))
  assert.equal(saved.script.structure.length, 1)
  assert.equal(saved.script.structure.some((beat) => beat.voiceover === '我自己写的口播'), false)
})

test('有画布就把复刻提示词一起换掉；不知道是不是用户填的素材就不碰', async () => {
  const { writeDraftToProject } = await agentProject()
  const result = await writeDraftToProject({ draft, projectId: 'prj_canvas', user: me })
  assert.equal(result.status, 200)
  assert.equal(result.body.canvas.synced, true)
  assert.equal(result.body.canvas.reason, 'synced')
  assert.equal(result.body.canvas.flowId, 'flow_rep')

  const flows = JSON.parse(fs.readFileSync(path.join(dir, 'flows.json'), 'utf8'))
  const flow = flows.find((item) => item.id === 'flow_rep')
  const llm = flow.nodes.find((node) => node.data.kind === 'llm')
  assert.ok(llm.data.config.systemPrompt.startsWith(AUTO_PREFIX), '还是我们生成的那一版格式')
  assert.match(llm.data.config.systemPrompt, /钩子 → 演示 → 收尾/)
  // 输入节点只在「里面还是旧钩子 / 模板名」时才换：这条作品没有模板、写之前也没有脚本，
  // 无法判断那句「旧钩子」是不是用户自己填的素材，所以不动它（宁可少改，不覆盖别人的字）
  const input = flow.nodes.find((node) => node.data.kind === 'input')
  assert.equal(input.data.config.text, '旧钩子')
})

test('同一份草稿再写一次：画布没变也不谎报「手改过」', async () => {
  const { writeDraftToProject } = await agentProject()
  const again = await writeDraftToProject({ draft, projectId: 'prj_canvas', user: me })
  assert.equal(again.status, 200)
  assert.equal(again.body.canvas.synced, true, '画布用的就是这份脚本')
  assert.equal(again.body.canvas.reason, 'synced', '不是 hand-edited：没变不等于被手改过')
})

test('提示词手改过：画布一个字不碰，回执如实写 hand-edited', async () => {
  const { writeDraftToProject } = await agentProject()
  const result = await writeDraftToProject({ draft, projectId: 'prj_hand', user: me })
  assert.equal(result.status, 200, '脚本本身仍然写进去')
  assert.equal(result.body.canvas.synced, false)
  assert.equal(result.body.canvas.reason, 'hand-edited')

  const flows = JSON.parse(fs.readFileSync(path.join(dir, 'flows.json'), 'utf8'))
  const flow = flows.find((item) => item.id === 'flow_hand')
  assert.equal(flow.nodes[0].data.config.systemPrompt, '我自己手写的提示词：按我的口吻来')
})

test('该拒的拒：没有作品、别人的作品、没有段落的草稿', async () => {
  const { writeDraftToProject } = await agentProject()

  const missing = await writeDraftToProject({ draft, projectId: '', user: me })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'PROJECT_REQUIRED')

  const unknown = await writeDraftToProject({ draft, projectId: 'prj_nope', user: me })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.code, 'PROJECT_NOT_FOUND')

  const notMine = await writeDraftToProject({ draft, projectId: 'prj_other', user: other })
  assert.equal(notMine.status, 200, '自己的作品写得进去')

  const stolen = await writeDraftToProject({ draft, projectId: 'prj_follow', user: other })
  assert.equal(stolen.status, 404, '别人的作品看不见也就写不进')

  const shotsOnly = await writeDraftToProject({
    draft: { ...draft, structure: [], stats: { ...draft.stats, beats: 0 } },
    projectId: 'prj_bare',
    user: me,
  })
  assert.equal(shotsOnly.status, 400)
  assert.equal(shotsOnly.body.code, 'DRAFT_NO_SCRIPT')
  assert.match(shotsOnly.body.error, /送到画布/)
})

test('接口：POST /api/agents/<id>/draft/project 是第三个出口，方法不对不猜', async () => {
  const { createAgentsRouter } = await import('../server/routes/agents.mjs')
  const { createAgent } = await import('../server/agents.mjs')
  const router = createAgentsRouter()
  const agent = await createAgent(
    {
      name: '草稿写手',
      category: '脚本分镜',
      role: '把选题写成脚本',
      systemPrompt: '你是脚本写手：按结构写口播，未知信息不要编，最后必须给 draft 块。',
    },
    me,
  )

  const call = async (method, pathname, body) => {
    const res = {
      status: 0,
      body: '',
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(chunk) {
        this.body = String(chunk ?? '')
      },
      write(chunk) {
        this.body += String(chunk ?? '')
        return true
      },
      writableEnded: false,
    }
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(payload) } }
    const url = new URL('http://localhost' + pathname)
    await router.handle(req, res, url, url.pathname)
    return { status: res.status, body: JSON.parse(res.body || '{}') }
  }

  const missing = await call('POST', '/api/agents/' + agent.id + '/draft/project', { draft })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'PROJECT_REQUIRED')

  const written = await call('POST', '/api/agents/' + agent.id + '/draft/project', { draft, projectId: 'prj_route' })
  assert.equal(written.status, 200)
  assert.equal(written.body.ok, true)
  assert.equal(written.body.project.id, 'prj_route')
  assert.equal(written.body.script.structure.length, 3)

  const noAgent = await call('POST', '/api/agents/agt_nope/draft/project', { draft, projectId: 'prj_route' })
  assert.equal(noAgent.status, 404)
  assert.match(noAgent.body.error, /智能体不存在/)

  const wrongMethod = await call('PUT', '/api/agents/' + agent.id + '/draft/project', { draft, projectId: 'prj_route' })
  assert.equal(wrongMethod.status, 405)
})
