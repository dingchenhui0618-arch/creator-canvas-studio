import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 回收站过期清理不靠定时任务：列回收站时顺手把 30 天前的条目连同抽帧一起清掉。
// 这个文件单独起一个进程，让模块缓存从磁盘里读到一条「早就过期」的记录。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-trash-'))
process.env.DATA_DIR = dir
const frames = path.join(dir, 'frames')
fs.mkdirSync(path.join(frames, 'tpl_old'), { recursive: true })
fs.mkdirSync(path.join(frames, 'tpl_new'), { recursive: true })
fs.writeFileSync(path.join(frames, 'tpl_old', 'frame-00.jpg'), 'x')
fs.writeFileSync(path.join(frames, 'tpl_new', 'frame-00.jpg'), 'x')

const day = 24 * 60 * 60 * 1000
const entry = (id, daysAgo) => ({
  id,
  kind: 'replica',
  title: id,
  ownerId: 'u_a',
  deletedAt: new Date(Date.now() - daysAgo * day).toISOString(),
  frames: [{ index: 0, t: 0, url: '/media/frames/' + id + '/frame-00.jpg' }],
  createdAt: new Date().toISOString(),
})
fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([entry('tpl_old', 31), entry('tpl_new', 2)]), 'utf8')

const t = await import('../server/templates.mjs')

test('列回收站时清掉超过 30 天的条目与抽帧，保留未过期的', async () => {
  const trash = await t.listTrash({ id: 'u_a' })
  assert.deepEqual(trash.map((item) => item.id), ['tpl_new'])
  assert.equal(fs.existsSync(path.join(frames, 'tpl_old')), false, '过期条目的抽帧目录要一起删')
  assert.equal(fs.existsSync(path.join(frames, 'tpl_new')), true)
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'templates.json'), 'utf8'))
  assert.deepEqual(all.map((item) => item.id), ['tpl_new'], '过期条目已经从存储里消失')
})
