// 无限画布归属（r214）：先到先得、管理员看全部、无主画布不给普通账号。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-canvas-owner-'))
process.env.DATA_DIR = dir

const { assignCanvas, canvasOwnerId, claimCanvas, visibleCanvases } = await import('../server/canvas-owner.mjs')

const admin = { id: 'u-admin', kind: 'admin' }
const mark = { id: 'u-mark', kind: 'account' }
const ning = { id: 'u-ning', kind: 'account' }
const canvases = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]

test('先到先得：第二个人不能把别人的画布抢走', () => {
  const first = claimCanvas('c1', mark.id, 'board-open')
  assert.equal(first.ok, true)
  assert.equal(first.claimed, true)
  const second = claimCanvas('c1', ning.id, 'board-open')
  assert.equal(second.claimed, false)
  assert.equal(second.ownerId, mark.id)
  assert.equal(canvasOwnerId('c1'), mark.id)
})

test('普通账号只看自己认领过的；无主的老画布只有管理员看得到', () => {
  claimCanvas('c2', ning.id, 'create')
  assert.deepEqual(visibleCanvases(mark, canvases).map((item) => item.id), ['c1'])
  assert.deepEqual(visibleCanvases(ning, canvases).map((item) => item.id), ['c2'])
  assert.deepEqual(visibleCanvases(admin, canvases).map((item) => item.id), ['c1', 'c2', 'c3'])
})

test('管理员可以改派，但普通账号不行', () => {
  const moved = assignCanvas('c1', admin.id, 'admin')
  assert.equal(moved.claimed, false)
  assert.equal(canvasOwnerId('c1'), mark.id)
  assert.equal(claimCanvas('c3', admin.id, 'admin').ok, true)
  assert.equal(canvasOwnerId('c3'), admin.id)
})

test('非法 id 不写盘', () => {
  assert.equal(claimCanvas('../etc/passwd', mark.id).ok, false)
  assert.equal(canvasOwnerId('../etc/passwd'), '')
})
