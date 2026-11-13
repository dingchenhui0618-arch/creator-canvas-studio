// 素材来源与下架通道（v0.9.82，C4）。这一组盯住四件事：
//   1) 公共模板的体检只数「公共 + 没删」的条目，回的是计数与平台分布，不是标题与链接；
//   2) 出处闸：平台素材没有原作品地址就不能发布进公共库，画布 / 智能体自己的模板不受限；
//   3) 「未指名具体条目」的下架申请能进队列（target.kind = material），后台按举报处理；
//   4) 页面上的「已处理下架」来自举报队列的真实状态，不是写死的 0。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-sources-'))
process.env.VQ_KEY_SECRET = 'test-secret-sources'

// 先落一份模板库，再 import：templates.mjs 第一次读盘时才会建缓存。
fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
fs.writeFileSync(
  path.join(process.env.DATA_DIR, 'templates.json'),
  JSON.stringify([
    {
      id: 'tpl_pub1',
      kind: 'replica',
      shared: true,
      platform: 'douyin',
      platformLabel: '抖音',
      sourceUrl: 'https://www.douyin.com/video/1001',
      author: '作者甲',
      cover: 'https://cdn.example/1.jpg',
      storyboard: [{ shot: 1 }, { shot: 2 }],
      createdAt: '2026-11-02T09:00:00.000Z',
    },
    {
      id: 'tpl_pub2',
      kind: 'saved',
      shared: true,
      platform: 'douyin',
      sourceUrl: 'https://www.douyin.com/video/1002',
      author: '',
      cover: '',
      storyboard: [],
      createdAt: '2026-11-05T09:00:00.000Z',
    },
    {
      id: 'tpl_pub3',
      kind: 'saved',
      shared: true,
      platform: 'xiaohongshu',
      sourceUrl: 'https://www.xiaohongshu.com/explore/abc',
      author: '作者乙',
      cover: 'https://cdn.example/3.jpg',
      storyboard: [],
      createdAt: '2026-11-07T09:00:00.000Z',
    },
    // 私有模板、删掉的公共模板都不该进体检
    {
      id: 'tpl_mine',
      kind: 'replica',
      platform: 'douyin',
      sourceUrl: 'https://www.douyin.com/video/2001',
      author: '作者丙',
      storyboard: [{ shot: 1 }],
      createdAt: '2026-11-08T09:00:00.000Z',
    },
    {
      id: 'tpl_gone',
      kind: 'saved',
      shared: true,
      deletedAt: '2026-11-09T09:00:00.000Z',
      platform: 'douyin',
      sourceUrl: 'https://www.douyin.com/video/3001',
      author: '作者丁',
      createdAt: '2026-11-09T09:00:00.000Z',
    },
  ]),
  'utf8',
)

const templates = await import('../server/templates.mjs')
const reports = await import('../server/reports.mjs')
const sources = await import('../server/sources.mjs')

test('公共模板体检：只数公共且未删的条目，给平台分布与出处覆盖率', async () => {
  const stats = await templates.publicSourceStats()
  assert.equal(stats.total, 3, '私有条目与被删的公共模板都不进体检')
  assert.deepEqual(
    stats.platforms.map((row) => [row.key, row.label, row.count]),
    [
      ['douyin', '抖音', 2],
      ['xiaohongshu', '小红书', 1],
    ],
  )
  assert.equal(stats.withSourceUrl, 3, '三条都留着原作品地址')
  assert.equal(stats.withAuthor, 2, '其中一条没有作者名')
  assert.equal(stats.withCover, 2)
  assert.equal(stats.parsed, 1, '只有一条解析过（有分镜）')
  assert.equal(stats.linkOnly, 2)
  assert.equal(stats.addedFrom, '2026-11-02')
  assert.equal(stats.addedTo, '2026-11-07')
  // 只回计数：标题、作者、链接一个都不许出现在这份数据里
  const serialized = JSON.stringify(stats)
  assert.ok(!serialized.includes('douyin.com'), '体检数据里不能带原作品链接')
  assert.ok(!serialized.includes('作者甲'), '体检数据里不能带作者名')
})

test('出处闸：没有原作品地址的平台素材不能进公共模板，画布 / 智能体不受限', () => {
  const blocked = templates.publicPublishBlocked({ kind: 'saved', sourceUrl: '', platform: 'douyin' })
  assert.match(blocked, /原作品地址/)
  assert.ok(templates.publicPublishBlocked({ kind: 'saved', sourceUrl: 'https://x/1', platform: 'douyin' }) === '')
  // 有了地址但没有平台名也拦：来源页要按平台写清楚
  assert.match(templates.publicPublishBlocked({ kind: 'replica', sourceUrl: 'https://x/1', platform: '' }), /平台/)
  // 画布 / 智能体自己产出的模板本来就没有原片
  assert.equal(templates.publicPublishBlocked({ kind: 'flow', sourceUrl: '' }), '')
  assert.equal(templates.publicPublishBlocked({ kind: 'agent', sourceUrl: '' }), '')
  assert.equal(templates.publicPublishBlocked(null), '')
  // 一次提交里同时补链接并打开发布：按保存后的样子判断，应当放行（v0.9.82 自测踩到的坑）
  const empty = { id: 'tpl_x', kind: 'saved', sourceUrl: '', platform: 'douyin' }
  assert.match(templates.publicPublishBlocked(empty, { shared: true }), /原作品地址/)
  assert.equal(templates.publicPublishBlocked(empty, { sourceUrl: 'https://x/1', shared: true }), '')
})

test('未指名具体条目的下架申请也能进队列（material），后台数得到', async () => {
  const created = await reports.createReport({
    target: { kind: 'material', id: 'sources-index', title: '素材来源页 · 未指名具体条目' },
    category: 'copyright',
    detail: '抖音上那条 11 月发布的片子是我拍的，标题里带「通勤」两个字。',
    contact: 'copyright@example.com',
    ip: '10.9.9.9',
  })
  assert.equal(created.ok, true)
  assert.equal(created.report.target.kind, 'material', 'material 不能被兜底成 template')
  assert.equal(created.report.status, 'open')

  // 同一个人同一分钟内再交一次：合并计数，不刷队列
  const again = await reports.createReport({
    target: { kind: 'material', id: 'sources-index', title: '素材来源页 · 未指名具体条目' },
    category: 'copyright',
    detail: '补一句：原片链接 https://www.douyin.com/video/1001',
    ip: '10.9.9.9',
  })
  assert.equal(again.duplicate, true)
  assert.equal(again.report.count, 2)
})

test('页面上的「已处理下架」来自举报队列状态：驳回不算，下架才算', async () => {
  const open = (await reports.listReports({ status: 'open' })).items[0]
  const dismissed = await reports.createReport({
    target: { kind: 'template', id: 'tpl_pub2', title: '待解析的一条' },
    category: 'other',
    detail: '随手举报一下，内容没问题',
    ip: '10.9.9.8',
  })
  await reports.resolveReport(dismissed.report.id, { action: 'dismiss', note: '误报' })
  let summary = await sources.sourcesSummary()
  assert.equal(summary.takedown.handled, 0, '驳回不动「已处理下架」')
  assert.equal(summary.public.total, 3)

  await reports.resolveReport(open.id, { action: 'takedown', note: '已核对授权' })
  summary = await sources.sourcesSummary()
  assert.equal(summary.takedown.handled, 1)
  assert.equal(summary.ok, true)
  assert.ok(summary.at, '带生成时间，页面能说明数字是什么时候数的')
})
