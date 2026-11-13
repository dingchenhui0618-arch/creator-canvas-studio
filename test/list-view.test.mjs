// 列表筛选条件跟着标签页走（v0.9.43 作品列表 / v0.9.44 模板库与运行记录）。这一轮钉住四件事：
//   1. 离开再回来，条件还在；关掉标签页就忘掉；清空条件就把记录删掉（不留一条空记录）。
//   2. 存进去的东西一律当不可信：坏 JSON、怪字段、超长关键词都退回默认。
//   3. 记下来的「只看这块画布」在画布被删 / 换账号后自动退回「全部流程」，读到清单失败时先不动它。
//   4. 三张列表各存各的键，页面真的接上了这一套；工作台待办清单故意不记。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  EMPTY_PROJECTS_VIEW,
  EMPTY_RUNS_VIEW,
  EMPTY_TEMPLATES_VIEW,
  projectsViewKey,
  readProjectsView,
  readRunsView,
  readTemplatesView,
  resolveFlowFilter,
  runsViewKey,
  templatesViewKey,
  writeProjectsView,
  writeRunsView,
  writeTemplatesView,
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

const throwing = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('quota') },
  removeItem() { throw new Error('denied') },
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

test('模板库：搜索词、类型、来源一字不差地回来；清空条件删键', () => {
  const storage = fakeStorage()
  assert.deepEqual(readTemplatesView(storage), EMPTY_TEMPLATES_VIEW)
  writeTemplatesView(storage, { keyword: '收纳', type: '家居收纳', source: 'radar' })
  assert.deepEqual(readTemplatesView(storage), { keyword: '收纳', type: '家居收纳', source: 'radar' })
  assert.ok(storage.map.has(templatesViewKey()))
  writeTemplatesView(storage, { keyword: '', type: '全部', source: '' })
  assert.equal(storage.map.has(templatesViewKey()), false)
  assert.deepEqual(readTemplatesView(storage), EMPTY_TEMPLATES_VIEW)
})

test('模板库的坏数据退回「全部」：类型认不出、字段不是字符串、关键词超长', () => {
  const key = templatesViewKey()
  assert.deepEqual(readTemplatesView(fakeStorage({ [key]: 'not json' })), EMPTY_TEMPLATES_VIEW)
  assert.deepEqual(readTemplatesView(fakeStorage({ [key]: JSON.stringify({ keyword: 7, type: 3, source: [] }) })), EMPTY_TEMPLATES_VIEW)
  // 类型被后台改名后留下的旧分类：读回来仍是那句话，页面按「全部」渲染（activeType 兜底）
  assert.deepEqual(readTemplatesView(fakeStorage({ [key]: JSON.stringify({ type: '' }) })), { keyword: '', type: '全部', source: '' })
  const long = readTemplatesView(fakeStorage({ [key]: JSON.stringify({ keyword: 'y'.repeat(400), source: 'z'.repeat(400) }) }))
  assert.equal(long.keyword.length, 80)
  assert.equal(long.source.length, 80)
})

test('运行记录：搜索词、流程、状态回来；清空筛选删键；坏状态退回全部', () => {
  const storage = fakeStorage()
  assert.deepEqual(readRunsView(storage), EMPTY_RUNS_VIEW)
  writeRunsView(storage, { keyword: '毛衣', flowId: 'flow_demo', status: 'success' })
  assert.deepEqual(readRunsView(storage), { keyword: '毛衣', flowId: 'flow_demo', status: 'success' })
  assert.ok(storage.map.has(runsViewKey()))
  writeRunsView(storage, { keyword: '', flowId: '', status: '' })
  assert.equal(storage.map.has(runsViewKey()), false)

  const key = runsViewKey()
  assert.deepEqual(readRunsView(fakeStorage({ [key]: JSON.stringify({ status: 'weird', flowId: 5 }) })), EMPTY_RUNS_VIEW)
  assert.deepEqual(readRunsView(fakeStorage({ [key]: '{' })), EMPTY_RUNS_VIEW)
  assert.doesNotThrow(() => writeRunsView(throwing, { keyword: 'a', flowId: 'b', status: 'error' }))
  assert.deepEqual(readRunsView(throwing), EMPTY_RUNS_VIEW)
})

test('记下来的流程被删了：退回「全部流程」，但清单没读到时不抹掉', () => {
  assert.equal(resolveFlowFilter('', ['flow_a'], true), '')
  // 清单还没读到 / 读失败：先信记下来的那个，别为一次网络抖动把筛选清掉
  assert.equal(resolveFlowFilter('flow_a', [], false), 'flow_a')
  assert.equal(resolveFlowFilter('flow_a', ['flow_a', 'flow_b'], true), 'flow_a')
  // 读到了，但里面没有这块画布：按「全部流程」算，不停在一份永远空的列表上
  assert.equal(resolveFlowFilter('flow_gone', ['flow_a'], true), '')
})

test('三张列表各存各的键，互不覆盖', () => {
  const keys = [projectsViewKey(), templatesViewKey(), runsViewKey()]
  assert.deepEqual(keys, ['vq_projects_view:v1', 'vq_templates_view:v1', 'vq_runs_view:v1'])
  assert.equal(new Set(keys).size, 3)
})

test('模板库与运行记录接的是这一套；工作台待办清单故意不记', () => {
  const templates = read('src', 'pages', 'TemplateLibraryPage.tsx')
  assert.match(templates, /import \{ readTemplatesView, writeTemplatesView, type TemplatesView \} from '\.\.\/domain\/list-view'/)
  assert.match(templates, /useState<TemplatesView>\(\(\) => readTemplatesView\(window\.sessionStorage\)\)/)
  assert.match(templates, /const \[keyword, setKeyword\] = useState\(savedView\.keyword\)/)
  assert.match(templates, /writeTemplatesView\(window\.sessionStorage, \{ keyword, type, source \}\)/)

  const runs = read('src', 'pages', 'RunsPage.tsx')
  assert.match(runs, /import \{ readRunsView, resolveFlowFilter, writeRunsView, type RunsView \} from '\.\.\/domain\/list-view'/)
  assert.match(runs, /useState<RunsView>\(\(\) => readRunsView\(window\.sessionStorage\)\)/)
  assert.match(runs, /const activeFlowId = resolveFlowFilter\(flowId, flows\.map\(\(flow\) => flow\.id\), flowsLoaded\)/)
  assert.match(runs, /writeRunsView\(window\.sessionStorage, \{ keyword, flowId: activeFlowId, status \}\)/)

  // 工作台是一张待办清单：留着昨天的筛选会把等你改的作品藏起来，所以它不读写这套记忆
  const overview = read('src', 'pages', 'OverviewPage.tsx')
  assert.doesNotMatch(overview, /domain\/list-view/)
  assert.doesNotMatch(overview, /vq_review_queue_view/)
})
