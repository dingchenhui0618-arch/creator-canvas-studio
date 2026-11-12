import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 评审 ↔ 作品：视觉评审页的历次评审要回答「这条结论记在哪条作品的第几版」。
// 这一组盯：索引只带 id 与标题（不带评审正文与凭证）、普通评审写 null、
// 作品被删之后审查记录如实认不出来、逐条挂载只加一个字段，以及真实评审存储里的
// projectId 能被认回来、作品改名后历史评审跟着改口。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-review-ownership-'))
process.env.DATA_DIR = dir

const project = (id, title, ownerId = 'u_a', version = 1) => ({ id, ownerId, title, version })

const projects = [project('prj_fold', '毛衣折叠收纳法', 'u_a', 2), project('prj_open', '春季新品开箱')]

const review = (id, projectId = '', version = 0, ownerId = 'u_a') => ({
  id,
  ownerId,
  projectId,
  version,
  intent: id,
  source: { kind: 'url', label: id, imageUrl: 'https://example.com/a.jpg' },
  result: { verdict: 'pass', summary: '看起来可以', observations: [] },
  createdAt: '2026-11-13T08:00:00.000Z',
})

fs.writeFileSync(
  path.join(dir, 'reviews.json'),
  JSON.stringify([review('rev_fold', 'prj_fold', 2), review('rev_plain')], null, 2),
  'utf8',
)
fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2), 'utf8')

const { projectsById, reviewProjectRef, withReviewProject } = await import('../server/review-ownership.mjs')
const { listReviews, saveReview, detachReviewsFromProject } = await import('../server/reviews.mjs')

const me = { id: 'u_a' }

test('作品 id → 引用：只带 id 与标题，没名字的补「未命名作品」，坏数据跳过', () => {
  const byId = projectsById(projects)
  assert.deepEqual(byId.get('prj_fold'), { id: 'prj_fold', title: '毛衣折叠收纳法' })
  assert.deepEqual(Object.keys(byId.get('prj_fold') || {}).sort(), ['id', 'title'], '不带评审正文、画布指针与分享凭证')
  assert.deepEqual(projectsById([{ id: 'prj_none' }]).get('prj_none'), { id: 'prj_none', title: '未命名作品' })
  assert.equal(projectsById([null, {}, { title: '没有 id' }]).size, 0, '没有 id 的作品进不了索引')
  assert.equal(projectsById().size, 0, '没有作品时是空索引')
  assert.equal(reviewProjectRef(byId, 'prj_gone'), null)
  assert.equal(reviewProjectRef(byId, ''), null)
})

test('逐条挂作品：普通评审与作品已删都是 null，原记录一个字都不动', () => {
  const byId = projectsById(projects)
  const input = [review('rev_fold', 'prj_fold', 2), review('rev_plain'), review('rev_gone', 'prj_gone', 1)]
  const out = withReviewProject(input, byId)
  assert.equal(out.length, 3)
  assert.deepEqual(out[0].project, { id: 'prj_fold', title: '毛衣折叠收纳法' })
  assert.equal(out[1].project, null, '普通评审没记入作品')
  assert.equal(out[2].project, null, '作品被删掉后认不出来（评审本身还在）')
  assert.equal(out[0].version, 2, '版次留在原来的字段上，不塞进 project')
  assert.equal('project' in input[0], false, '不改传进来的数组')
  assert.deepEqual(withReviewProject(), [])
})

test('真实评审记录：存下的 projectId 认得回来，作品改名后历史评审跟着改口', async () => {
  const saved = await saveReview({
    user: me,
    source: { kind: 'template', label: '毛衣首帧' },
    intent: '首帧评审',
    result: { verdict: 'needs_review', summary: '', observations: [] },
    projectId: 'prj_fold',
    version: 2,
  })
  assert.equal(saved.projectId, 'prj_fold')

  const page = await listReviews({ limit: 10 }, me)
  const line = withReviewProject(page.items, projectsById(projects)).find((item) => item.id === saved.id)
  assert.deepEqual(line.project, { id: 'prj_fold', title: '毛衣折叠收纳法' })
  assert.equal(line.version, 2, '评审发生在第 2 版')

  const renamed = withReviewProject(page.items, projectsById([{ id: 'prj_fold', title: '毛衣折叠收纳法（改过名）' }]))
  assert.equal(renamed.find((item) => item.id === saved.id).project.title, '毛衣折叠收纳法（改过名）', '标题现算，不回写历史记录')
})

test('作品被删掉：评审保留，但不再挂在任何作品上', async () => {
  const detached = await detachReviewsFromProject('prj_fold')
  assert.ok(detached >= 1)
  const page = await listReviews({ limit: 10 }, me)
  const mine = page.items.filter((item) => !item.projectId).map((item) => item.id)
  assert.ok(mine.includes('rev_fold'), '老的关联被卸掉')
  const line = withReviewProject(page.items, projectsById(projects)).find((item) => item.id === 'rev_fold')
  assert.equal(line.project, null)
  assert.equal(line.projectId, '', '盘上不再留指向已删作品的 id')
})
