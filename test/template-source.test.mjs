import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 模板来源的第二排筛选（v0.9.33）：模板库现在有五条入口（发现 / 作品 / 智能体 / 画布 / 改编），
// 官方示例再单独一类。这一组盯四件事：
//   1. 一张卡片只属于一个来源，优先级写在 templateSource 里，卡片标签与胶囊共用它；
//   2. 列表按来源筛，且仍然只给当前账号看得见的那几条；
//   3. 来源的条数按全库算（切来源不让其它胶囊变小），类型与「待解析」跟着来源算；
//   4. 认不出来的来源不静默退化成「全部」——否则链接写错一个 key，用户看到整整一库还以为筛过了。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-template-source-'))
process.env.DATA_DIR = dir
fs.mkdirSync(path.join(dir, 'frames'), { recursive: true })

const make = (id, patch = {}) => ({
  id,
  kind: 'replica',
  title: id,
  contentType: '口播',
  tags: ['测试'],
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/' + id,
  sourceId: id,
  author: '作者',
  publishedAt: '2026-11-01',
  stats: { likes: 10, comments: 2, shares: 1, collects: 3 },
  durationSec: 20,
  hook: '钩子',
  hookType: '反差',
  structure: [],
  storyboard: [],
  timing: null,
  analysis: { pacing: '中', viralPoints: [], reusableRules: [], targetAudience: '' },
  frames: [],
  cover: '',
  video: { width: 1080, height: 1920, fps: 30, duration: 20 },
  origin: 'ai',
  reuseCount: 0,
  ownerId: 'u_a',
  createdAt: '2026-11-' + String(10 + (id.length % 10)).padStart(2, '0') + 'T00:00:00.000Z',
  ...patch,
})

fs.writeFileSync(
  path.join(dir, 'templates.json'),
  JSON.stringify(
    [
      make('tpl_radar_parsed', { contentType: '口播' }),
      make('tpl_radar_saved', { kind: 'saved', origin: 'manual', contentType: '待解析' }),
      make('tpl_agent', { kind: 'agent', origin: 'agent', agentName: '小红书操盘手', contentType: '脚本' }),
      make('tpl_flow', { kind: 'flow', origin: 'canvas', contentType: '工作流' }),
      make('tpl_adapted', { kind: 'adapted', origin: 'adapted', adaptedFrom: 'tpl_radar_parsed', contentType: '口播' }),
      make('tpl_project', {
        kind: 'adapted',
        origin: 'project',
        projectId: 'prj_x',
        projectTitle: '毛衣折叠收纳法',
        projectVersion: 2,
        contentType: '家居',
      }),
      make('tpl_shared', { shared: true, ownerId: '' }),
      make('tpl_other', { kind: 'agent', origin: 'agent', ownerId: 'u_b', contentType: '脚本' }),
      make('tpl_deleted', { deletedAt: '2026-11-01T00:00:00.000Z' }),
    ],
    null,
    2,
  ),
  'utf8',
)

const t = await import('../server/templates.mjs')
const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }

test('一张卡片只属于一个来源：作品 / 智能体 / 画布 / 改编 / 官方示例 / 发现', () => {
  assert.equal(t.templateSource({ kind: 'replica', origin: 'ai' }), 'radar')
  assert.equal(t.templateSource({ kind: 'saved', origin: 'manual' }), 'radar')
  assert.equal(t.templateSource({ kind: 'agent' }), 'agent')
  assert.equal(t.templateSource({ kind: 'flow' }), 'canvas')
  assert.equal(t.templateSource({ kind: 'adapted', origin: 'adapted' }), 'adapted')
  // 作品沉淀的模板 kind 仍是 adapted，靠 origin / projectId 认出来
  assert.equal(t.templateSource({ kind: 'adapted', origin: 'project' }), 'project')
  assert.equal(t.templateSource({ kind: 'adapted', projectId: 'prj_x' }), 'project')
  // 官方示例优先：它是运营给的样例，不冒充「我发现的」
  assert.equal(t.templateSource({ kind: 'replica', origin: 'ai', shared: true }), 'shared')
  // v0.9.2 之前没有 kind 的老条目都是雷达检索的结果
  assert.equal(t.templateSource({}), 'radar')
  assert.equal(t.templateSource(null), 'radar')
})

test('列表按来源筛，且只给当前账号看得见的那几条', async () => {
  const ids = async (params, user) => (await t.listTemplates(params, user)).map((item) => item.id).sort()
  assert.deepEqual(await ids({ source: 'project' }, userA), ['tpl_project'])
  assert.deepEqual(await ids({ source: 'agent' }, userA), ['tpl_agent'])
  assert.deepEqual(await ids({ source: 'canvas' }, userA), ['tpl_flow'])
  assert.deepEqual(await ids({ source: 'adapted' }, userA), ['tpl_adapted'])
  // 官方示例属于所有人，但它只算「官方示例」这一格，不再同时出现在「发现」里
  assert.deepEqual(await ids({ source: 'shared' }, userA), ['tpl_shared'])
  assert.deepEqual(await ids({ source: 'radar' }, userA), ['tpl_radar_parsed', 'tpl_radar_saved'])
  // 别人的智能体模板不在我的「智能体」里
  assert.deepEqual(await ids({ source: 'agent' }, userB), ['tpl_other'])
  // 每条列表项自带 source，卡片标签不用自己再推一遍
  const list = await t.listTemplates({ source: 'project' }, userA)
  assert.equal(list[0].source, 'project')
})

test('来源条数按全库算，类型与「待解析」跟着来源算', async () => {
  const all = await t.templateStats(userA)
  assert.equal(all.total, 7, '七个可见条目：删除的与别人的不算')
  const counted = Object.fromEntries(all.sources.map((entry) => [entry.key, entry.count]))
  assert.deepEqual(counted, { radar: 2, project: 1, agent: 1, canvas: 1, adapted: 1, shared: 1 })
  assert.equal(
    all.sources.reduce((sum, entry) => sum + entry.count, 0),
    all.total,
    '每个来源的条数加起来正好是全库：同一张卡片不会被两个来源各算一次',
  )
  assert.equal(all.pending, 1, '全库还有一条只存了链接的')

  const scoped = await t.templateStats(userA, { source: 'project' })
  assert.equal(scoped.total, 7, '切来源不改全库总数')
  assert.deepEqual(scoped.byType, { 家居: 1 }, '类型标签只列这个来源里真有的类型')
  assert.equal(scoped.pending, 0, '作品来源下没有待解析条目')
  assert.deepEqual(
    scoped.sources.map((entry) => entry.count),
    all.sources.map((entry) => entry.count),
    '切来源不让别的胶囊数字变小',
  )
})

test('认不出来的来源交回 unknown，由接口回 400 而不是静默退化成全部', () => {
  assert.deepEqual(t.parseTemplateSource('radar'), { source: 'radar', unknown: '' })
  assert.deepEqual(t.parseTemplateSource(' RADAR '), { source: 'radar', unknown: '' }, '大小写与空格宽容')
  assert.deepEqual(t.parseTemplateSource(''), { source: '', unknown: '' })
  assert.deepEqual(t.parseTemplateSource(null), { source: '', unknown: '' })
  assert.deepEqual(t.parseTemplateSource('bogus'), { source: '', unknown: 'bogus' })
  // 文案里给出的可用值是这几个 key，写死在这里防止两边漂移
  assert.deepEqual(t.TEMPLATE_SOURCES.map((entry) => entry.key), ['radar', 'project', 'agent', 'canvas', 'adapted', 'shared'])
  assert.deepEqual(t.TEMPLATE_SOURCES.map((entry) => entry.label), ['发现', '作品', '智能体', '画布', '改编', '官方示例'])
})
