import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHUNK_RELOAD_MAX_ATTEMPTS,
  CHUNK_RELOAD_WINDOW_MS,
  chunkFailureFile,
  decideChunkReload,
  isChunkLoadFailure,
  readChunkReloadState,
} from '../src/domain/chunk-reload.ts'

// 生产 client-errors 里 11-12 留下的原话，用来钉住「哪些异常算取不到页面文件」。
const PROD_MESSAGE =
  'Failed to fetch dynamically imported module: https://visionqa.wavisionai.cn/assets/CanvasPage-0jg1TZvw.js'

test('isChunkLoadFailure：认得浏览器与打包器的原话', () => {
  const error = new TypeError(PROD_MESSAGE)
  assert.equal(isChunkLoadFailure(error), true)
  assert.equal(isChunkLoadFailure('Failed to fetch dynamically imported module: /assets/AgentsPage-DBgB6OJ9.js'), true)
  assert.equal(isChunkLoadFailure('Importing a module script failed.'), true)
  assert.equal(isChunkLoadFailure('error loading dynamically imported module'), true)
  assert.equal(isChunkLoadFailure('Unable to preload CSS for /assets/x.css'), true)
  assert.equal(isChunkLoadFailure('Loading chunk 42 failed.'), true)
  const chunkError = new Error('boom')
  chunkError.name = 'ChunkLoadError'
  assert.equal(isChunkLoadFailure(chunkError), true)
})

test('isChunkLoadFailure：普通渲染错误、空值一律不算', () => {
  assert.equal(isChunkLoadFailure(new TypeError("Cannot read properties of undefined (reading 'map')")), false)
  assert.equal(isChunkLoadFailure(new Error('HTTP 500')), false)
  assert.equal(isChunkLoadFailure(null), false)
  assert.equal(isChunkLoadFailure(undefined), false)
  assert.equal(isChunkLoadFailure(''), false)
})

test('decideChunkReload：第一次撞上就重载一次', () => {
  const decision = decideChunkReload({ state: null, now: 1_000_000, online: true })
  assert.equal(decision.reload, true)
  assert.equal(decision.reason, 'first')
  assert.deepEqual(decision.state, { at: 1_000_000, attempts: 1 })
})

test('decideChunkReload：同一次发版里第二次还允许重载，第三次停手', () => {
  const first = decideChunkReload({ state: null, now: 1_000_000, online: true })
  const second = decideChunkReload({ state: first.state, now: 1_000_000 + 4000, online: true })
  assert.equal(second.reload, true)
  assert.equal(second.reason, 'retry')
  assert.equal(second.state.attempts, 2)
  assert.equal(second.state.attempts, CHUNK_RELOAD_MAX_ATTEMPTS)
  const third = decideChunkReload({ state: second.state, now: 1_000_000 + 8000, online: true })
  assert.equal(third.reload, false)
  assert.equal(third.reason, 'loop')
  assert.deepEqual(third.state, second.state, '不再重载时不要把记录改坏')
})

test('decideChunkReload：过了窗口就重新算一波，不会被上一次卡死', () => {
  const later = 1_000_000 + CHUNK_RELOAD_WINDOW_MS + 1
  const decision = decideChunkReload({ state: { at: 1_000_000, attempts: CHUNK_RELOAD_MAX_ATTEMPTS }, now: later, online: true })
  assert.equal(decision.reload, true)
  assert.equal(decision.reason, 'first')
  assert.deepEqual(decision.state, { at: later, attempts: 1 })
})

test('decideChunkReload：断网不重载，时钟回拨按新的一波算', () => {
  const offline = decideChunkReload({ state: null, now: 1_000_000, online: false })
  assert.equal(offline.reload, false)
  assert.equal(offline.reason, 'offline')
  assert.equal(offline.state, null)
  const skew = decideChunkReload({ state: { at: 2_000_000, attempts: 2 }, now: 1_000_000, online: true })
  assert.equal(skew.reload, true)
  assert.equal(skew.reason, 'first')
})

test('readChunkReloadState：坏数据当没有，不抛', () => {
  assert.equal(readChunkReloadState(null), null)
  assert.equal(readChunkReloadState(''), null)
  assert.equal(readChunkReloadState('not json'), null)
  assert.equal(readChunkReloadState('[]'), null)
  assert.equal(readChunkReloadState('{"at":"x","attempts":1}'), null)
  assert.equal(readChunkReloadState('{"at":0,"attempts":1}'), null)
  assert.equal(readChunkReloadState('{"at":1000,"attempts":0}'), null)
  assert.deepEqual(readChunkReloadState('{"at":1000,"attempts":2}'), { at: 1000, attempts: 2 })
})

test('chunkFailureFile：只回文件名，不回整条地址', () => {
  assert.equal(chunkFailureFile(new TypeError(PROD_MESSAGE)), 'assets/CanvasPage-0jg1TZvw.js')
  assert.equal(chunkFailureFile(new Error('Importing a module script failed.')), '')
})
