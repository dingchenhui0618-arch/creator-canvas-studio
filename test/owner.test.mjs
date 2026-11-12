import test from 'node:test'
import assert from 'node:assert/strict'
import { canAccess, isAdmin, ownerStamp } from '../server/owner.mjs'

// 多账号隔离的底线：这几条一旦破了，A 就能删 B 的模板、读 B 的提示词。

const userA = { id: 'u_a', email: 'user-a', kind: 'user' }
const userB = { id: 'u_b', email: 'user-b', kind: 'user' }
const admin = { id: 'u_admin', email: 'boss', kind: 'admin' }

test('未登录不做隔离（本地演示）', () => {
  assert.equal(canAccess({ ownerId: 'u_a' }, null), true)
  assert.equal(canAccess(null, null), true)
})

test('普通账号只能看自己的', () => {
  assert.equal(canAccess({ ownerId: 'u_a' }, userA), true)
  assert.equal(canAccess({ ownerId: 'u_b' }, userA), false)
})

test('公共条目（没有归属）所有人都能看', () => {
  assert.equal(canAccess({ ownerId: '' }, userA), true)
  assert.equal(canAccess({ shared: true }, userB), true)
})

test('管理员看全部', () => {
  assert.equal(isAdmin(admin), true)
  assert.equal(isAdmin(userA), false)
  assert.equal(isAdmin(null), false)
  assert.equal(canAccess({ ownerId: 'u_b' }, admin), true)
})

test('新建条目带上归属；未登录留空', () => {
  assert.deepEqual(ownerStamp(userA), { ownerId: 'u_a' })
  assert.deepEqual(ownerStamp(null), {})
})
