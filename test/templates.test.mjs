import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 模板库是整文件读改写的存储：这一组测试盯住三条真出过问题或出过亏损的行为
// —— 软删除/回收站、编辑快照、只读分享的白名单与撤销。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-templates-'))
process.env.DATA_DIR = dir
fs.mkdirSync(path.join(dir, 'frames'), { recursive: true })

const frame = (id) => ({ index: 0, t: 0, url: '/media/frames/' + id + '/frame-00.jpg' })
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
  structure: [{ beat: '开场', startSec: 0, endSec: 3, voiceover: '一句话', onScreen: '', purpose: '抓住' }],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 3, frameIndex: 0, frameUrl: '/media/frames/' + id + '/frame-00.jpg', visual: '画面', camera: '近景', caption: '', audio: '', purpose: '' },
  ],
  timing: { estimatedSec: 3, actualSec: 3, durationSec: 20, fit: 'ok', overSec: 0, tight: 0, loose: 0 },
  analysis: { pacing: '中', viralPoints: ['爆点'], reusableRules: ['规则'], targetAudience: '人' },
  frames: [frame(id)],
  cover: '',
  video: { width: 1080, height: 1920, fps: 30, duration: 20 },
  origin: 'ai',
  reuseCount: 0,
  createdAt: new Date(Date.now() - 1000).toISOString(),
  ...patch,
})

fs.writeFileSync(
  path.join(dir, 'templates.json'),
  JSON.stringify([make('tpl_a', { ownerId: 'u_a' }), make('tpl_b', { ownerId: 'u_b' }), make('tpl_shared', { ownerId: '', shared: true })], null, 2),
  'utf8',
)

const t = await import('../server/templates.mjs')
const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }
const admin = { id: 'u_admin', name: 'admin', kind: 'admin' }

test('列表按归属隔离，公共条目大家都能看', async () => {
  const mine = await t.listTemplates({}, userA)
  assert.deepEqual(mine.map((item) => item.id).sort(), ['tpl_a', 'tpl_shared'])
  const other = await t.listTemplates({}, userB)
  assert.ok(!other.some((item) => item.id === 'tpl_a'))
  const all = await t.listTemplates({}, admin)
  assert.equal(all.length, 3)
})

test('统计只数未删除条目，工作流不混进已解析', async () => {
  const stats = await t.templateStats(userA)
  assert.equal(stats.total, 2)
  assert.equal(stats.parsed, 2)
  assert.equal(stats.saved, 0)
})

test('软删除进回收站，列表与统计都不再算它', async () => {
  const deleted = await t.deleteTemplate('tpl_a', userA)
  assert.ok(deleted.deletedAt)
  const list = await t.listTemplates({}, userA)
  assert.ok(!list.some((item) => item.id === 'tpl_a'))
  const trash = await t.listTrash(userA)
  assert.deepEqual(trash.map((item) => item.id), ['tpl_a'])
  assert.equal((await t.templateStats(userA)).total, 1)
  // 已经删过的不能再删一次
  assert.equal(await t.deleteTemplate('tpl_a', userA), null)
})

test('别人的模板删不掉（归属校验）', async () => {
  assert.equal(await t.deleteTemplate('tpl_b', userA), null)
  assert.ok((await t.getTemplate('tpl_b', userB)) !== null)
})

test('恢复回到列表；彻底删除才真的消失', async () => {
  const restored = await t.restoreTemplate('tpl_a', userA)
  assert.equal(restored.deletedAt, undefined)
  assert.ok((await t.listTemplates({}, userA)).some((item) => item.id === 'tpl_a'))
  await t.deleteTemplate('tpl_a', userA)
  assert.equal(await t.purgeTemplate('tpl_a', userA), true)
  assert.equal(await t.getTemplate('tpl_a', userA), null)
  assert.equal((await t.listTrash(userA)).length, 0)
})

test('编辑只在受管字段真变了时留快照，最多 10 版', async () => {
  await t.updateTemplate('tpl_shared', { tags: ['测试'] }, admin)
  assert.equal((await t.listTemplateVersions('tpl_shared', admin)).length, 0, '没改内容不该留版本')

  await t.updateTemplate('tpl_shared', { title: '第二版' }, admin)
  let versions = await t.listTemplateVersions('tpl_shared', admin)
  assert.equal(versions.length, 1)
  assert.equal(versions[0].values.title, 'tpl_shared')

  for (let index = 0; index < 12; index += 1) {
    await t.updateTemplate('tpl_shared', { title: '第' + (index + 3) + '版' }, admin)
  }
  versions = await t.listTemplateVersions('tpl_shared', admin)
  assert.equal(versions.length, 10, '最多留 10 版')
  const oldest = versions[versions.length - 1]
  const restored = await t.restoreTemplateVersion('tpl_shared', oldest.id, admin)
  assert.equal(restored.title, oldest.values.title)
  assert.equal((await t.listTemplateVersions('tpl_shared', admin)).length, 10, '回滚本身也留一版，仍然封顶 10')
})

test('分享链接：生成、查到、撤销、换新 token', async () => {
  const first = await t.enableTemplateShare('tpl_b', userB)
  assert.ok(first.token.length >= 20)
  assert.ok(!/[+/=]/.test(first.token), 'base64url 不该带 + / =')
  const found = await t.getSharedTemplate(first.token)
  assert.equal(found.id, 'tpl_b')

  assert.equal(await t.disableTemplateShare('tpl_b', userB), true)
  assert.equal(await t.getSharedTemplate(first.token), null)

  const second = await t.enableTemplateShare('tpl_b', userB)
  assert.notEqual(second.token, first.token, '重新开启要换新 token')
  // 别人不能给别人开分享
  assert.equal(await t.enableTemplateShare('tpl_b', userA), null)
})

test('公开视图逐字段白名单，帧图与分镜都换成带 token 的地址', async () => {
  const share = await t.enableTemplateShare('tpl_shared', admin)
  const item = await t.getSharedTemplate(share.token)
  const view = t.publicTemplateView(item, share.token)
  for (const key of ['ownerId', 'versions', 'deletedAt', 'shareToken', 'blueprint', 'shareBy']) {
    assert.equal(key in view, false, key + ' 不该出现在公开视图里')
  }
  assert.equal(view.id, 'tpl_shared')
  assert.equal(view.frames[0].url, '/api/share/' + share.token + '/frame/0')
  assert.equal(view.storyboard[0].frameUrl, '/api/share/' + share.token + '/frame/0')
  assert.equal(view.cover, '', '没有封面就不给地址')
  assert.ok(view.sharedAt)
  assert.equal(await t.getSharedTemplate('short'), null, '过短的 token 直接拒绝')
})

test('进回收站的条目，分享链接同时失效', async () => {
  const share = await t.enableTemplateShare('tpl_b', userB)
  await t.deleteTemplate('tpl_b', userB)
  assert.equal(await t.getSharedTemplate(share.token), null)
  await t.restoreTemplate('tpl_b', userB)
  assert.ok(await t.getSharedTemplate(share.token), '恢复后原链接恢复可用（token 没被清掉）')
})
