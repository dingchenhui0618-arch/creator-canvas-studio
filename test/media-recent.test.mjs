import test from 'node:test'
import assert from 'node:assert/strict'
import { RECENT_PAGE_SIZE, mergeRecentTasks } from '../src/domain/media-recent.ts'

function task(id, extra = {}) {
  return {
    id,
    kind: 'image',
    status: 'succeeded',
    prompt: '任务 ' + id,
    model: 'gpt-image-2',
    ratio: '1:1',
    size: '1024x1024',
    duration: null,
    resolution: '',
    progress: null,
    createdAt: '2026-11-18T03:00:00.000Z',
    updatedAt: '2026-11-18T03:00:00.000Z',
    finishedAt: '2026-11-18T03:00:00.000Z',
    error: '',
    file: { mime: 'image/png', bytes: 1024 },
    downloadUrl: '/api/media/tasks/' + id + '/file',
    credits: { cost: 5, balance: 100, refunded: false, refundedAt: null },
    ...extra,
  }
}
const ids = (list) => list.map((item) => item.id)

test('没翻过页就整页替换，列表长度跟着服务端走', () => {
  const shown = [task('a'), task('b')]
  const incoming = [task('c'), task('d')]
  assert.deepEqual(ids(mergeRecentTasks(shown, incoming, false)), ['c', 'd'])
})

test('翻过页之后刷新只补新任务：新任务插到最前，翻出来的旧行一条不掉', () => {
  const shown = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => task(id))
  const incoming = [task('h'), task('a')]
  const next = mergeRecentTasks(shown, incoming, true)
  assert.deepEqual(ids(next), ['h', 'a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.equal(next.length, shown.length + 1)
})

test('翻过页之后刷新会就地更新已经显示的那一行，位置不变', () => {
  const shown = [task('a'), task('b', { status: 'processing', file: null, downloadUrl: '', credits: { cost: 5, balance: 90, refunded: false, refundedAt: null } })]
  const incoming = [task('b', { status: 'failed', error: '上游超时', file: null, downloadUrl: '', credits: { cost: 5, balance: 95, refunded: true, refundedAt: '2026-11-18T03:01:00.000Z' } })]
  const next = mergeRecentTasks(shown, incoming, true)
  assert.deepEqual(ids(next), ['a', 'b'])
  assert.equal(next[1].status, 'failed')
  assert.equal(next[1].error, '上游超时')
  assert.equal(next[1].credits.refunded, true)
})

test('翻过页也不会把同一条又插一遍', () => {
  const shown = [task('a'), task('b'), task('c')]
  const next = mergeRecentTasks(shown, [task('a'), task('b')], true)
  assert.deepEqual(ids(next), ['a', 'b', 'c'])
})

test('刷新回来什么都没有时，翻出来的清单原样留着', () => {
  const shown = [task('a'), task('b')]
  const next = mergeRecentTasks(shown, [], true)
  assert.equal(next, shown)
})

test('一页永远是 6 条，不跟着翻页长大（接口单次上限 24 条）', () => {
  assert.equal(RECENT_PAGE_SIZE, 6)
  assert.ok(RECENT_PAGE_SIZE <= 24)
})
