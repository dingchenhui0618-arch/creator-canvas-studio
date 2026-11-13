// 作品列表的筛选条件跟着标签页走（v0.9.43）。这一轮钉住三件事：
//   1. 点进作品再回来，搜索词与「在做 / 已交付」还在；关掉标签页就忘掉。
//   2. 存进去的东西一律当不可信：坏 JSON、怪字段、超长关键词都退回「全部、无关键词」。
//   3. 没有筛选时不留一条空记录；隐私模式下写不进去也不能把这一屏弄崩。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  EMPTY_PROJECTS_VIEW,
  projectsViewKey,
  readProjectsView,
  writeProjectsView,
} from '../src/domain/list-view.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

test('没存过就是「全部、无关键词」', () => {
  assert.deepEqual(readProjectsView(fakeStorage()), EMPTY_PROJECTS_VIEW)
  assert.deepEqual(readProjectsView(fakeStorage()), { keyword: '', bucket: 'all' })
})

test('存进去再读回来是同一份筛选；清空条件就把记录删掉', () => {
  const storage = fakeStorage()
  writeProjectsView(storage, { keyword: '收纳', bucket: 'delivered' })
  assert.deepEqual(readProjectsView(storage), { keyword: '收纳', bucket: 'delivered' })
  assert.ok(storage.map.has(projectsViewKey()))
  // 清空条件 = 不留一条空记录，下次读到的「没有」和「全部」是一回事
  writeProjectsView(storage, { keyword: '', bucket: 'all' })
  assert.equal(storage.map.has(projectsViewKey()), false)
  assert.deepEqual(readProjectsView(storage), EMPTY_PROJECTS_VIEW)
})

test('坏数据一律退回「全部、无关键词」，不让列表打不开', () => {
  assert.deepEqual(readProjectsView(fakeStorage({ [projectsViewKey()]: '{不是 JSON' })), EMPTY_PROJECTS_VIEW)
  assert.deepEqual(readProjectsView(fakeStorage({ [projectsViewKey()]: 'null' })), EMPTY_PROJECTS_VIEW)
  assert.deepEqual(readProjectsView(fakeStorage({ [projectsViewKey()]: '[]' })), EMPTY_PROJECTS_VIEW)
  // 字段类型不对：bucket 不认识的档、keyword 不是字符串，都要退回安全值
  const odd = fakeStorage({ [projectsViewKey()]: JSON.stringify({ keyword: 42, bucket: 'whatever' }) })
  assert.deepEqual(readProjectsView(odd), EMPTY_PROJECTS_VIEW)
  // 超长关键词截断到 80，不把整页搜索框撑爆
  const long = fakeStorage({ [projectsViewKey()]: JSON.stringify({ keyword: 'x'.repeat(500), bucket: 'active' }) })
  const view = readProjectsView(long)
  assert.equal(view.keyword.length, 80)
  assert.equal(view.bucket, 'active')
})

test('存储抛错时照常返回/不抛：隐私模式不该让这一屏崩掉', () => {
  const throwing = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('quota') },
    removeItem() { throw new Error('denied') },
  }
  assert.deepEqual(readProjectsView(throwing), EMPTY_PROJECTS_VIEW)
  assert.doesNotThrow(() => writeProjectsView(throwing, { keyword: '收纳', bucket: 'active' }))
})

test('作品列表接的是这一套：首屏读、条件变了就写，用的是 sessionStorage', () => {
  const page = read('src', 'pages', 'ProjectsPage.tsx')
  assert.match(page, /import \{ readProjectsView, writeProjectsView, type ProjectsView \} from '\.\.\/domain\/list-view'/)
  assert.match(page, /const \[savedView\] = useState<ProjectsView>\(\(\) => readProjectsView\(window\.sessionStorage\)\)/)
  assert.match(page, /const \[keyword, setKeyword\] = useState\(savedView\.keyword\)/)
  assert.match(page, /const \[bucket, setBucket\] = useState<ProjectBucket>\(savedView\.bucket\)/)
  assert.match(page, /writeProjectsView\(window\.sessionStorage, \{ keyword, bucket \}\)/)
})
