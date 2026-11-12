import assert from 'node:assert/strict'
import test from 'node:test'

// 作品页「来源」面板：原片是谁、有没有原片，全按这条模板的事实说。
// 这一组盯：有链接才算原片、画布/智能体来的如实说没有、老数据不编、互动数全 0 时不冒充「互动 0」。

const { originStats, templateOrigin } = await import('../server/project-source.mjs')

const radar = (patch = {}) => ({
  kind: 'replica',
  platform: 'douyin',
  platformLabel: '抖音',
  sourceUrl: 'https://www.douyin.com/video/7300000000000000000',
  author: '收纳研究所',
  publishedAt: '2026-11-01T10:00:00.000Z',
  stats: { plays: 1200000, likes: 88000, comments: 1200, shares: 300, collects: 41000 },
  ...patch,
})

test('有链接的模板就是原片：平台、作者、互动数一起带出来', () => {
  const origin = templateOrigin(radar())
  assert.equal(origin.kind, 'original')
  assert.equal(origin.platformLabel, '抖音')
  assert.equal(origin.author, '收纳研究所')
  assert.equal(origin.url, 'https://www.douyin.com/video/7300000000000000000')
  assert.deepEqual(origin.stats, { plays: 1200000, likes: 88000, comments: 1200, shares: 300, collects: 41000 })
})

test('只存了链接的待解析条目（saved）照样有原片，作者空着就空着', () => {
  const origin = templateOrigin(radar({ kind: 'saved', author: '', stats: {} }))
  assert.equal(origin.kind, 'original')
  assert.equal(origin.author, '')
  assert.equal(origin.stats, null, '一件互动都没有时不要编一个 0')
})

test('画布另存、智能体草稿：没有原片，如实说没有，也不带链接', () => {
  const canvas = templateOrigin({ kind: 'flow', platform: 'canvas', platformLabel: '画布', sourceUrl: '' })
  assert.equal(canvas.kind, 'canvas')
  assert.equal(canvas.url, '')
  assert.equal(canvas.author, '')
  assert.equal(canvas.stats, null)

  const agent = templateOrigin({ kind: 'agent', platform: 'agent', platformLabel: '智能体', sourceUrl: '' })
  assert.equal(agent.kind, 'agent')
  assert.equal(agent.url, '')
})

test('老数据没有来源信息就不显示这一块（不拿模板标题当视频标题）', () => {
  assert.equal(templateOrigin(null), null)
  assert.equal(templateOrigin({ kind: 'adapted', platform: 'douyin', title: '一条改编版' }), null)
  assert.equal(templateOrigin({ kind: 'replica', platform: '', sourceUrl: '   ' }), null)
})

test('互动数只认正数：负数、字符串垃圾、缺失一律当 0，全 0 时整块是 null', () => {
  assert.equal(originStats(null), null)
  assert.equal(originStats({}), null)
  assert.equal(originStats({ likes: -5, comments: 'abc' }), null)
  assert.deepEqual(originStats({ likes: '12', comments: 3.6 }), {
    plays: 0, likes: 12, comments: 4, shares: 0, collects: 0,
  })
})
