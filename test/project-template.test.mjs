import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 作品「存成模板」（v0.9.31）：做完的这一版沉淀回模板库，闭环最后一格。
// 这一组盯五条口径：
//   1. 存的是这一版的脚本 + 绑定模板的分镜文字；原片的作者、链接、互动数据、帧图一概不复制；
//   2. 作品与它绑定的模板一个字不动，也不开新版本；
//   3. 没脚本 / 没分镜就不落库，并且说清另一条路（画布里的「另存为模板」）；
//   4. 脚本还是模板那份时要先提醒：存出来会是一条几乎一样的模板，不假装那是新东西；
//   5. 看得见才存得下：别人的作品 404，方法与地址不对不猜。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-project-template-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'
const me = { id: 'u_a', name: 'A' }
const stranger = { id: 'u_c', name: 'C' }

const template = {
  id: 'tpl_coffee',
  ownerId: 'u_a',
  kind: 'replica',
  origin: 'ai',
  title: '咖啡 3 分钟',
  contentType: '口播',
  tags: ['咖啡', '测评'],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://example.com/v/1',
  sourceId: 'dy_1',
  author: '原片作者',
  publishedAt: '2026-11-01',
  stats: { plays: 100000, likes: 5000, collects: 900, comments: 120, shares: 40 },
  durationSec: 18,
  hook: '模板的钩子',
  structure: [
    { beat: '开场', startSec: 0, endSec: 3, voiceover: '模板第一句', onScreen: '三分钟' },
    { beat: '做法', startSec: 3, endSec: 8, voiceover: '模板第二句', onScreen: '' },
    { beat: '收尾', startSec: 8, endSec: 12, voiceover: '模板第三句', onScreen: '' },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 3, visual: '杯子放下', camera: '近景', caption: '模板第一句', audio: '', purpose: '', frameUrl: '/media/frames/tpl_coffee/a.jpg' },
    { shotNo: 2, startSec: 3, endSec: 8, visual: '按键出液', camera: '特写', caption: '模板第二句', audio: '', purpose: '', frameUrl: '/media/frames/tpl_coffee/b.jpg' },
  ],
  timing: { estimatedSec: 12, actualSec: 18, durationSec: 18, fit: 'loose', pace: '快', rate: 6.5625, overSec: 0, tight: 0, loose: 2 },
  analysis: { pacing: '快', reusableRules: [], viralPoints: [], targetAudience: '' },
  frames: [{ index: 0, t: 0, url: '/media/frames/tpl_coffee/a.jpg' }],
  video: { width: 1080, height: 1920, fps: 30, duration: 18 },
  reuseCount: 3,
  createdAt: at(1, 0),
  updatedAt: at(1, 0),
}

const projects = [
  // 已经改成自己的脚本：存的是这 4 段
  {
    id: 'prj_own',
    ownerId: 'u_a',
    title: '我改过的那条',
    templateId: template.id,
    flowId: '',
    version: 2,
    versions: [],
    status: 'active',
    script: {
      hook: '别再花三十块买一杯了',
      structure: [
        { beat: '钩子', startSec: 0, endSec: 3, voiceover: '别再花三十块买一杯了', onScreen: '三十块' },
        { beat: '演示', startSec: 3, endSec: 6, voiceover: '放豆、按键、等一分钟', onScreen: '' },
        { beat: '算账', startSec: 6, endSec: 9, voiceover: '一个月省下一台机器的钱', onScreen: '省 300' },
        { beat: '收尾', startSec: 9, endSec: 12, voiceover: '链接在评论区', onScreen: '' },
      ],
      updatedAt: at(2, 0),
    },
    createdAt: at(1, 1),
    updatedAt: at(2, 0),
  },
  // 跟着模板走、还没改过：存出来会跟原模板几乎一样，要先提醒
  {
    id: 'prj_follow',
    ownerId: 'u_a',
    title: '还没改的那条',
    templateId: template.id,
    flowId: '',
    version: 0,
    versions: [],
    status: 'active',
    createdAt: at(1, 2),
    updatedAt: at(1, 2),
  },
  // 照画布起的：没有模板，也就没有分镜
  {
    id: 'prj_bare_script',
    ownerId: 'u_a',
    title: '从画布起的、自己写了脚本的那条',
    templateId: '',
    flowId: '',
    version: 1,
    versions: [],
    status: 'active',
    script: {
      hook: '画布起步',
      structure: [{ beat: '一段', startSec: 0, endSec: 3, voiceover: '画布起步的一段', onScreen: '' }],
      updatedAt: at(2, 1),
    },
    createdAt: at(1, 3),
    updatedAt: at(2, 1),
  },
  // 既没有脚本也没有模板
  { id: 'prj_empty', ownerId: 'u_a', title: '空的那条', templateId: '', flowId: '', version: 0, versions: [], status: 'active', createdAt: at(1, 4), updatedAt: at(1, 4) },
  // 别人的作品
  { id: 'prj_other', ownerId: 'u_b', title: '别人的作品', templateId: template.id, flowId: '', version: 1, versions: [], status: 'active', createdAt: at(1, 5), updatedAt: at(1, 5) },
]

fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([template], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify([], null, 2), 'utf8')
fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify([], null, 2), 'utf8')

const specModule = () => import('../server/project-template.mjs')
const projectsModule = () => import('../server/projects.mjs')
const templatesModule = () => import('../server/templates.mjs')

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))

async function specFor(projectId, user = me) {
  const { projectTemplateSpec } = await specModule()
  const { getProject } = await projectsModule()
  const { getTemplate } = await templatesModule()
  const { scriptView } = await import('../server/project-script.mjs')
  const project = await getProject(projectId, user)
  const source = project?.templateId ? await getTemplate(project.templateId, user) : null
  const script = project ? scriptView(project, source) : null
  return { spec: projectTemplateSpec({ project, template: source, script }), project, source, script }
}

test('有脚本、有模板就能存：说的是这一版的段数与绑定模板的镜数', async () => {
  const { spec } = await specFor('prj_own')
  assert.equal(spec.status, 200)
  assert.equal(spec.body.beats, 4)
  assert.equal(spec.body.shots, 2)
  assert.equal(spec.body.sameAsTemplate, false)
  assert.equal(spec.body.title, '我改过的那条')
  assert.equal(spec.body.script.hook, '别再花三十块买一杯了')
  assert.equal(spec.body.source.id, 'tpl_coffee')
  assert.equal(spec.body.source.title, '咖啡 3 分钟')
})

test('脚本还是模板那份：能存，但先把「几乎一样」说出来', async () => {
  const { spec } = await specFor('prj_follow')
  assert.equal(spec.status, 200)
  assert.equal(spec.body.beats, 3)
  assert.equal(spec.body.sameAsTemplate, true)
})

test('该拒的拒：没有脚本 400、没有分镜 400（指到画布另存为模板）、别人的作品 404', async () => {
  const { projectTemplateSpec } = await specModule()

  const empty = await specFor('prj_empty')
  assert.equal(empty.spec.status, 400)
  assert.equal(empty.spec.body.code, 'SCRIPT_REQUIRED')

  const noShots = await specFor('prj_bare_script')
  assert.equal(noShots.spec.status, 400)
  assert.equal(noShots.spec.body.code, 'STORYBOARD_REQUIRED')
  assert.match(noShots.spec.body.error, /另存为模板/)

  const strangerProject = await specFor('prj_other', stranger)
  assert.equal(strangerProject.spec.status, 404)
  assert.equal(strangerProject.spec.body.code, 'PROJECT_NOT_FOUND')

  assert.equal(projectTemplateSpec().status, 404)
})

test('落库：kind 仍是 adapted、来源记成 project；分镜文字照抄，原片帧图与作者链接不复制', async () => {
  const { createTemplateFromProject } = await templatesModule()
  const { project, source, script } = await specFor('prj_own')
  const saved = await createTemplateFromProject({ source, project, script, title: '咖啡机一分钟出片', user: me })
  assert.ok(saved)
  assert.equal(saved.kind, 'adapted')
  assert.equal(saved.origin, 'project')
  assert.equal(saved.adaptedFrom, 'tpl_coffee')
  assert.equal(saved.projectId, 'prj_own')
  assert.equal(saved.projectTitle, '我改过的那条')
  assert.equal(saved.projectVersion, 2)
  assert.equal(saved.title, '咖啡机一分钟出片')
  assert.equal(saved.structure.length, 4)
  assert.equal(saved.structure[0].voiceover, '别再花三十块买一杯了')
  assert.equal(saved.storyboard.length, 2)
  assert.equal(saved.storyboard[0].visual, '杯子放下')
  assert.equal(saved.storyboard[0].frameUrl, '', '原片帧图不跟着走')
  assert.equal(saved.author, '', '作者是原片的，不是这一版的')
  assert.equal(saved.sourceUrl, '')
  assert.deepEqual(saved.stats, {})
  // 平台与作者属于原片：新模板两个都留空，卡片脚注只说「来自作品」
  assert.equal(saved.platformLabel, '')
  assert.equal(saved.platform, 'douyin')
  assert.equal(saved.ownerId, 'u_a')
  assert.equal(saved.reuseCount, 0)
})

test('模板与作品都不动：原模板 3 段 2 镜、作品还停在第 2 版，模板库只多一条', async () => {
  const saved = readJson('templates.json')
  assert.equal(saved.length, 2)
  const source = saved.find((item) => item.id === 'tpl_coffee')
  assert.equal(source.structure.length, 3)
  assert.equal(source.storyboard.length, 2)
  assert.equal(source.storyboard[0].frameUrl, '/media/frames/tpl_coffee/a.jpg', '原模板的帧图原位不动')
  const project = readJson('projects.json').find((item) => item.id === 'prj_own')
  assert.equal(project.version, 2)
  assert.equal(project.script.structure.length, 4)
})

test('再存一条是另一条独立模板：不覆盖上一份', async () => {
  const { createTemplateFromProject } = await templatesModule()
  const { project, source, script } = await specFor('prj_own')
  const again = await createTemplateFromProject({ source, project, script, title: '', user: me })
  assert.ok(again)
  assert.equal(again.title, '我改过的那条', '没给标题就用作品名')
  const list = readJson('templates.json')
  assert.equal(list.length, 3)
  assert.equal(new Set(list.map((item) => item.id)).size, 3)
})

test('第二道闸：没有段落或没有分镜，落库函数自己也不写', async () => {
  const { createTemplateFromProject } = await templatesModule()
  const { project, source, script } = await specFor('prj_own')
  assert.equal(await createTemplateFromProject({ source, project, script: { structure: [] } , user: me }), null)
  assert.equal(await createTemplateFromProject({ source: { ...source, storyboard: [] }, project, script, user: me }), null)
  assert.equal(readJson('templates.json').length, 3, '两次都没落库')
})

test('接口：POST /api/projects/<id>/template 存得住；别人的作品 404；GET 405', async () => {
  const { createProjectsRouter } = await import('../server/routes/projects.mjs')
  const router = createProjectsRouter()
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

  const saved = await call('POST', '/api/projects/prj_follow/template', { title: '还没改的那条沉淀版' })
  assert.equal(saved.status, 201)
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.template.title, '还没改的那条沉淀版')
  assert.equal(saved.body.template.projectId, 'prj_follow')
  assert.equal(saved.body.template.beats, 3)
  assert.equal(saved.body.template.shots, 2)
  assert.equal(saved.body.sameAsTemplate, true, '脚本没改过，回执也要说实话')

  const rejected = await call('POST', '/api/projects/prj_bare_script/template', {})
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'STORYBOARD_REQUIRED')

  const missing = await call('POST', '/api/projects/prj_nope/template', {})
  assert.equal(missing.status, 404)

  const wrongMethod = await call('GET', '/api/projects/prj_follow/template')
  assert.equal(wrongMethod.status, 405)

  const detail = await call('GET', '/api/projects/prj_follow')
  assert.equal(detail.status, 200)
  assert.equal(detail.body.templateSaves.length, 1, '作品详情带得出沉淀过的模板')
  assert.equal(detail.body.templateSaves[0].title, '还没改的那条沉淀版')
})
