// 退出登录 / 换账号时清掉本机痕迹（v0.9.89）。这一组钉住四件事：
//   1. 内容是痕迹的（对话历史、画布 id、检索词、筛选词）都清掉，返回清单；
//   2. 前缀扫得到（历史键将来带版本号）；
//   3. 这台机器的设置（模型、形态、引导看过没）不动；
//   4. 隐私模式、单个键删不掉、没有遍历能力——都不能把退出这条路卡住。
import test from 'node:test'
import assert from 'node:assert/strict'
import { clearLocalResidue, RESIDUE_LOCAL_KEYS, RESIDUE_SESSION_KEYS } from '../src/auth/local-residue.ts'

function fakeStorage(entries = {}, { iterable = true, stuck = [] } = {}) {
  const map = new Map(Object.entries(entries))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    removeItem: (key) => {
      if (stuck.includes(key)) throw new Error('read-only key')
      map.delete(key)
    },
    get length() { return iterable ? map.size : undefined },
    key: iterable ? (index) => Array.from(map.keys())[index] ?? null : undefined,
    keys: () => Array.from(map.keys()),
  }
}

test('点名的键都清掉：对话历史、画布 id、检索词、三个列表的筛选词', () => {
  const local = fakeStorage({ 'vq:agents:history:v1': '[{"role":"user"}]', 'vq:bdcCanvas': 'canvas_123', 'vq.model': 'gpt-6.1-sol' })
  const session = fakeStorage({ 'vq.radar.lastSearch.v1': '{"keyword":"收纳"}', 'vq_projects_view:v1': '{}', 'vq_templates_view:v1': '{}', 'vq_runs_view:v1': '{}' })
  const removed = clearLocalResidue(local, session)
  assert.deepEqual(local.keys(), ['vq.model'], '偏好键不该被清')
  assert.deepEqual(session.keys(), [])
  for (const key of RESIDUE_LOCAL_KEYS) assert.ok(removed.includes(key), '应清：' + key)
  for (const key of RESIDUE_SESSION_KEYS) assert.ok(removed.includes(key), '应清：' + key)
  assert.equal(removed.length, RESIDUE_LOCAL_KEYS.length + RESIDUE_SESSION_KEYS.length)
})

test('前缀扫得到：历史键换版本号也清（不靠一份写死的清单）', () => {
  const local = fakeStorage({ 'vq:agents:history:v2': '[]', 'vq:agents:history:device-2': '[]', 'vq:agents:prompt-draft': 'keep?' })
  const removed = clearLocalResidue(local, null)
  assert.deepEqual(local.keys(), ['vq:agents:prompt-draft'], '不在前缀里的不动')
  assert.deepEqual(removed.sort(), ['vq:agents:history:device-2', 'vq:agents:history:v2'])
})

test('这台机器的设置留着：模型偏好、形态开关、引导看过没', () => {
  const local = fakeStorage({ 'vq.model': 'm', 'vq.edition': 'admin', 'vq_welcome_seen:u_123': '1' })
  const removed = clearLocalResidue(local, null)
  assert.deepEqual(removed, [])
  assert.equal(local.keys().length, 3)
})

test('存储用不了（隐私模式）时返回空清单，不抛', () => {
  assert.deepEqual(clearLocalResidue(null, null), [])
  assert.deepEqual(clearLocalResidue(undefined, undefined), [])
})

test('没有遍历能力也不影响：点名的键照样清，扫不到的只是前缀那批', () => {
  const local = fakeStorage({ 'vq:bdcCanvas': 'canvas_1', 'vq:agents:history:v1': '[]', 'vq:agents:history:v7': '[]' }, { iterable: false })
  const removed = clearLocalResidue(local, null)
  assert.deepEqual(local.keys(), ['vq:agents:history:v7'], '没有 key() 就扫不到前缀键，点名的照样清')
  assert.deepEqual(removed.sort(), ['vq:agents:history:v1', 'vq:bdcCanvas'])
})

test('单个键删不掉不该拦住其它键，也不抛', () => {
  const local = fakeStorage({ 'vq:bdcCanvas': 'c1', 'vq:agents:history:v1': '[]' }, { stuck: ['vq:bdcCanvas'] })
  const removed = clearLocalResidue(local, null)
  assert.deepEqual(removed, ['vq:agents:history:v1'])
  assert.deepEqual(local.keys(), ['vq:bdcCanvas'])
})

test('幂等：第二次跑没有可清的，返回空清单', () => {
  const local = fakeStorage({ 'vq:bdcCanvas': 'c1' })
  assert.deepEqual(clearLocalResidue(local, null), ['vq:bdcCanvas'])
  assert.deepEqual(clearLocalResidue(local, null), [])
})
