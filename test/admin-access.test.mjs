// 后台管理版前端门禁（task-10）：形态判定与人绑定，地址栏和本机记忆都不能把普通账号带进后台。
// 纯函数用例，不挂浏览器：resolveEdition 只接收 search / stored / isAdmin 三个值。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EDITION_BY_ID, canAccessAdminRoute, resolveEdition } from '../src/editions.ts'

function resolve(overrides = {}) {
  return resolveEdition({ search: '', stored: null, isAdmin: false, ...overrides })
}

test('管理员：?edition=admin 能进后台', () => {
  assert.equal(resolve({ search: '?edition=admin', isAdmin: true }), 'admin')
  assert.equal(resolve({ search: 'edition=admin', isAdmin: true }), 'admin')
  assert.equal(resolve({ search: '?from=mail&edition=admin', isAdmin: true }), 'admin')
})

test('管理员：没有地址栏参数时沿用 vq.edition=admin 的记忆', () => {
  assert.equal(resolve({ stored: 'admin', isAdmin: true }), 'admin')
})

test('管理员：地址栏显式指定优先于本机记忆', () => {
  assert.equal(resolve({ search: '?edition=user', stored: 'admin', isAdmin: true }), 'user')
  assert.equal(resolve({ search: '?edition=admin', stored: 'user', isAdmin: true }), 'admin')
})

test('管理员：没有参数也没有记忆时仍是用户生产版', () => {
  assert.equal(resolve({ isAdmin: true }), 'user')
  assert.equal(resolve({ search: '?edition=judge', stored: 'judge', isAdmin: true }), 'user')
})

test('普通账号：?edition=admin 被忽略，停在用户生产版', () => {
  assert.equal(resolve({ search: '?edition=admin', isAdmin: false }), 'user')
  assert.equal(resolve({ search: '?from=mail&edition=admin', isAdmin: false }), 'user')
})

test('普通账号：本机残留 vq.edition=admin 也不能进后台', () => {
  assert.equal(resolve({ stored: 'admin', isAdmin: false }), 'user')
  assert.equal(resolve({ search: '?edition=admin', stored: 'admin', isAdmin: false }), 'user')
})

test('普通账号：本地缓存被改写成 user 或未知值时依旧落在用户版', () => {
  assert.equal(resolve({ stored: 'user', isAdmin: false }), 'user')
  assert.equal(resolve({ stored: 'superuser', isAdmin: false }), 'user')
})

test('无权限路由：非管理员访问 #/admin/* 一律拒绝，用户页面不受影响', () => {
  assert.equal(canAccessAdminRoute({ kind: 'admin', section: 'overview' }, false), false)
  assert.equal(canAccessAdminRoute({ kind: 'admin', section: 'keys' }, false), false)
  assert.equal(canAccessAdminRoute({ kind: 'page', page: 'overview' }, false), true)
  assert.equal(canAccessAdminRoute({ kind: 'page', page: 'projects' }, false), true)
})

test('管理员：后台路由照常放行', () => {
  assert.equal(canAccessAdminRoute({ kind: 'admin', section: 'overview' }, true), true)
  assert.equal(canAccessAdminRoute({ kind: 'admin', section: 'models' }, true), true)
})

test('后台导航仍是 12 项（门禁不删导航）', () => {
  assert.equal(EDITION_BY_ID.admin.nav.length, 12)
})
