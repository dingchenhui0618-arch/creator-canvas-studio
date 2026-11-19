import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 还没有这份文件（ENOENT）= 空库：部署第一天、新装一套都是这个状态，
// 不能因此报「数据读不出来」。这一组确认缺失文件仍然正常起步，也不会被误判成损坏。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-store-missing-'))
process.env.DATA_DIR = dir

const templates = await import('../server/templates.mjs')
const projects = await import('../server/projects.mjs')
const flows = await import('../server/flows.mjs')

const me = { id: 'u_a', name: 'A', email: 'a@b.c' }

test('没有 templates.json：空库，不报错', async () => {
  assert.deepEqual(await templates.listTemplates({}, me), [])
  const stats = await templates.templateStats(me)
  assert.equal(stats.total, 0)
})

test('没有 projects.json：空库，新建第一条正常落盘', async () => {
  assert.deepEqual(await projects.listProjects(me), [])
  const created = await projects.createProject({ title: '第一条作品' }, me)
  assert.equal(created.title, '第一条作品')
  const list = await projects.listProjects(me)
  assert.deepEqual(list.map((item) => item.id), [created.id])
})

test('没有 flows.json / runs.json：空库，建一条工作流正常', async () => {
  assert.deepEqual(await flows.listFlows(me), [])
  const flow = await flows.createFlow({ name: '第一条工作流' }, me)
  assert.ok(flow && flow.id)
  assert.equal((await flows.listFlows(me)).length, 1)
})
