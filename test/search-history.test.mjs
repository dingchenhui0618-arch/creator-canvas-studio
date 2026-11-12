import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-search-'))
process.env.DATA_DIR = dir

const h = await import('../server/search-history.mjs')
const userA = { id: 'u_a' }
const userB = { id: 'u_b' }
const search = (user, keyword, extra = {}) => h.recordSearch({ user, platform: 'all', keyword, range: '', sort: 'likes', total: 10, ...extra })

test('只记登录账号，关键词为空不记', async () => {
  assert.equal(await search(null, '猫咪'), null)
  assert.equal(await search(userA, '   '), null)
  assert.equal((await h.listSearchHistory(userA)).length, 0)
})

test('相同条件重搜只更新时间，不新增一条', async () => {
  const first = await search(userA, '猫咪')
  await new Promise((resolve) => setTimeout(resolve, 5))
  const again = await search(userA, '猫咪')
  assert.equal(again.id, first.id)
  const list = await h.listSearchHistory(userA)
  assert.equal(list.length, 1)
  assert.ok(list[0].at >= first.at)
})

test('账号之间互不可见', async () => {
  await search(userB, '狗狗')
  const forA = await h.listSearchHistory(userA)
  assert.ok(!forA.some((entry) => entry.keyword === '狗狗'))
})

test('收藏能切换，且排在前面；清空不带走收藏', async () => {
  await search(userA, '收藏我')
  const list = await h.listSearchHistory(userA)
  const target = list.find((entry) => entry.keyword === '收藏我')
  const starred = await h.toggleSearchFavorite(userA, target.id)
  assert.equal(starred.favorite, true)
  const ordered = await h.listSearchHistory(userA)
  assert.equal(ordered[0].keyword, '收藏我')

  const cleared = await h.clearSearchHistory(userA)
  assert.ok(cleared.removed > 0)
  const kept = await h.listSearchHistory(userA)
  assert.deepEqual(kept.map((entry) => entry.keyword), ['收藏我'])

  await h.toggleSearchFavorite(userA, target.id)
  assert.equal((await h.clearSearchHistory(userA)).removed, 1)
  assert.equal((await h.listSearchHistory(userA)).length, 0)
})

test('非收藏最多留 40 条，越旧的先丢', async () => {
  for (let index = 0; index < 45; index += 1) await search(userB, '词' + index)
  const all = await h.listSearchHistory(userB, 100)
  assert.equal(all.length, 40)
  assert.equal(all[0].keyword, '词44')
  assert.equal(all[all.length - 1].keyword, '词5')
})

test('界面一次最多给 14 条', async () => {
  const page = await h.listSearchHistory(userB)
  assert.equal(page.length, 14)
})

test('收藏的条目不会被 40 条上限挤掉', async () => {
  const list = await h.listSearchHistory(userB, 100)
  const target = list[list.length - 1]
  await h.toggleSearchFavorite(userB, target.id)
  for (let index = 0; index < 45; index += 1) await search(userB, '新词' + index)
  const after = await h.listSearchHistory(userB, 100)
  assert.ok(after.some((entry) => entry.id === target.id), '收藏的那条还在')
  assert.equal(after.filter((entry) => !entry.favorite).length, 40)
})
