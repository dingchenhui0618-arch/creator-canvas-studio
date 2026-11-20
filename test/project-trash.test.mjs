import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 作品回收站（v0.9.253）：删掉的作品 30 天内能原样放回去。
// 这一组盯住四件容易做错的事：
//   1) 删完不在作品列表里，但进得了回收站（不是一删到底，也不是删了还留在列表里）；
//   2) 恢复把删除时一起收走的评审、已看过、拍板按原样放回来（只回一条空壳作品等于没恢复）；
//   3) 别人的作品恢复不了，也看不见；
//   4) 过期条目在读回收站时自动清掉，不靠人记得来点「彻底删除」。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-project-trash-'))
process.env.DATA_DIR = dir

const oldStamp = '2026-01-01T00:00:00.000Z'
fs.writeFileSync(
  path.join(dir, 'templates.json'),
  JSON.stringify([
    { id: 'tpl_a', kind: 'replica', title: '模板', hook: '钩子', structure: [], storyboard: [], frames: [], ownerId: 'u_a', createdAt: oldStamp },
  ]),
  'utf8',
)
// 40 天前删掉的一条：按 30 天规则，读回收站时它就该消失
fs.writeFileSync(
  path.join(dir, 'projects-trash.json'),
  JSON.stringify([
    { id: 'trash_old', project: { id: 'prj_old', title: '很久以前删的', ownerId: 'u_a', version: 0 }, deletedAt: oldStamp },
  ]),
  'utf8',
)

const p = await import('../server/projects.mjs')
const r = await import('../server/reviews.mjs')
const acks = await import('../server/review-acks.mjs')
const decisions = await import('../server/review-decisions.mjs')

const userA = { id: 'u_a', name: 'A' }
const userB = { id: 'u_b', name: 'B' }

let projectId = ''
let reviewAt = ''

test('回收站里超过 30 天的条目，读一次就清掉', async () => {
  const trash = await p.listProjectTrash(userA)
  assert.deepEqual(trash.map((item) => item.id), [], '过期条目不该还出现在列表里')
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'projects-trash.json'), 'utf8'))
  assert.deepEqual(onDisk, [], '过期条目要真的从盘上删掉，不能只是列表里不显示')
})

test('删作品进回收站：作品列表里没有了，回收站里带着件数', async () => {
  const project = await p.createProject({ title: '要删的作品', templateId: 'tpl_a' }, userA)
  projectId = project.id
  const review = await r.saveReview({ user: userA, projectId, version: 1, result: { verdict: 'fail' } })
  reviewAt = review.createdAt
  await acks.ackReview({ projectId, version: 1, reviewAt, verdict: 'fail' }, userA)
  await decisions.saveDecision({ projectId, version: 1, reviewAt, verdict: 'fail', decision: 'pass', note: '再改一次' }, userA)

  const removed = await p.deleteProject(projectId, userA)
  assert.equal(removed.project.id, projectId)
  assert.equal(removed.trash.days, 30, '保留天数由服务端给，界面不写死')
  assert.equal(await p.getProject(projectId, userA), null, '删掉的作品不能还能打开')
  assert.deepEqual((await p.listProjects(userA)).map((item) => item.id), [])

  const trash = await p.listProjectTrash(userA)
  assert.equal(trash.length, 1)
  assert.equal(trash[0].title, '要删的作品')
  assert.equal(trash[0].reviews, 1, '回收站要说清会带回几条评审')
  assert.equal(trash[0].acks, 1)
  assert.equal(trash[0].decisions, 1)
})

test('删掉的评审还留在评审库，只是不再挂在作品上', async () => {
  const attached = await r.listReviews({ limit: 10, projectId }, userA)
  assert.equal(attached.total, 0)
  const orphans = await r.listReviews({ limit: 10, orphan: true }, userA)
  assert.equal(orphans.total, 1, '评审是历史，作品删了也不能跟着消失')
})

test('恢复：作品、评审、已看过、拍板一起回到原样', async () => {
  const back = await p.restoreProject(projectId, userA)
  assert.equal(back.status, 200)
  assert.equal(back.project.id, projectId)
  assert.deepEqual(back.restored, { reviews: 1, acks: 1, decisions: 1 })
  assert.deepEqual((await p.listProjects(userA)).map((item) => item.id), [projectId])
  const attached = await r.listReviews({ limit: 10, projectId }, userA)
  assert.equal(attached.total, 1, '评审要挂回这条作品')
  assert.equal((await acks.listAcks(userA)).filter((item) => item.projectId === projectId).length, 1)
  assert.equal((await decisions.listDecisions(userA)).filter((item) => item.projectId === projectId).length, 1)
  assert.deepEqual(await p.listProjectTrash(userA), [], '恢复过的条目要从回收站里拿掉')
})

test('已经恢复过的作品不会重复插入', async () => {
  const again = await p.restoreProject(projectId, userA)
  assert.equal(again.status, 404, '回收站里没有它了')
  assert.equal((await p.listProjects(userA)).length, 1)
})

test('别人的作品删了既看不见也恢复不了', async () => {
  const other = await p.createProject({ title: '别人的作品', templateId: 'tpl_a' }, userB)
  await p.deleteProject(other.id, userB)
  assert.deepEqual(await p.listProjectTrash(userA), [], '看不见别人回收站里的东西')
  assert.equal((await p.restoreProject(other.id, userA)).status, 403)
  assert.equal((await p.purgeProject(other.id, userA)).status, 403)
  // 主人自己可以
  assert.equal((await p.restoreProject(other.id, userB)).status, 200)
})

test('彻底删除：回收站里没有了，之后也恢复不了', async () => {
  await p.deleteProject(projectId, userA)
  assert.equal((await p.purgeProject(projectId, userA)).status, 200)
  assert.deepEqual(await p.listProjectTrash(userA), [])
  assert.equal((await p.restoreProject(projectId, userA)).status, 404)
  assert.equal(await p.getProject(projectId, userA), null)
})
