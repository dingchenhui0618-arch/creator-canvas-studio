import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 存储读不出来的处理（r265）：这些文件都是「整份读、改一条、整份写回」。
// 以前读失败一律当空库——页面显示「一条都没有」，用户随手新建一条，整份内容就被覆盖掉了。
// 这一组盯三件事：
//   1. 文件坏了要报错，不能装作空库；
//   2. 报错期间不许写回（写回 = 拿一条覆盖整份，数据白丢）；
//   3. 文件修好以后自动恢复，不需要重启。
// ENOENT（还没有这份文件）仍然是空库，那是部署第一天的正常状态，见 store-missing.test.mjs。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-store-corrupt-'))
process.env.DATA_DIR = dir

const corrupt = (name) => fs.writeFileSync(path.join(dir, name), '{ "broken": ', 'utf8')
for (const name of ['templates.json', 'projects.json', 'flows.json', 'runs.json']) corrupt(name)
const before = Object.fromEntries(
  ['templates.json', 'projects.json', 'flows.json', 'runs.json'].map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]),
)

const templates = await import('../server/templates.mjs')
const projects = await import('../server/projects.mjs')
const flows = await import('../server/flows.mjs')

const me = { id: 'u_a', name: 'A', email: 'a@b.c' }
const isStoreError = (error) => error?.code === 'STORE_UNREADABLE' && /数据读不出来/.test(error.message)

test('模板库读不出来：报错而不是空库', async () => {
  await assert.rejects(() => templates.listTemplates({}, me), isStoreError)
  await assert.rejects(() => templates.templateStats(me), isStoreError)
})

test('模板库读不出来时保存被拒：文件一个字节都不动', async () => {
  await assert.rejects(
    () => templates.saveTemplateFromItem({ item: { url: 'https://www.douyin.com/video/123' }, user: me }),
    isStoreError,
  )
  assert.equal(fs.readFileSync(path.join(dir, 'templates.json'), 'utf8'), before['templates.json'])
})

test('作品库读不出来：列作品报错、新建作品被拒', async () => {
  await assert.rejects(() => projects.listProjects(me), isStoreError)
  await assert.rejects(() => projects.createProject({ title: '新作品' }, me), isStoreError)
  assert.equal(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'), before['projects.json'])
})

test('工作流与运行记录同一条规矩', async () => {
  await assert.rejects(() => flows.listFlows(me), isStoreError)
  await assert.rejects(() => flows.createFlow({ name: '新工作流' }, me), isStoreError)
  assert.equal(fs.readFileSync(path.join(dir, 'flows.json'), 'utf8'), before['flows.json'])
})

test('文件修好以后自动恢复，不用重启', async () => {
  fs.writeFileSync(
    path.join(dir, 'templates.json'),
    JSON.stringify([
      {
        id: 'tpl_x',
        kind: 'replica',
        title: '恢复过来的模板',
        contentType: '口播',
        ownerId: 'u_a',
        createdAt: '2026-11-19T00:00:00.000Z',
      },
    ], null, 2),
    'utf8',
  )
  const list = await templates.listTemplates({}, me)
  assert.deepEqual(list.map((item) => item.id), ['tpl_x'])
  // 恢复后写操作也回来了（作品库也一起修好）
  fs.writeFileSync(path.join(dir, 'projects.json'), '[]', 'utf8')
  const created = await projects.createProject({ title: '文件修好后的新作品' }, me)
  assert.ok(created.id.startsWith('prj_'))
})
