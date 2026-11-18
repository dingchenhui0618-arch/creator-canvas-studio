// 窄屏「这是一个桌面工作台」提示（r224）：第一次显示、点 × 后不再显示、记不住时宁可再显示。
import assert from 'node:assert/strict'
import test from 'node:test'
import { MOBILE_NOTE_KEY, browserFlagStore, dismissMobileNote, mobileNoteVisible } from '../src/domain/mobile-note.ts'

function fakeStore(initial) {
  const map = new Map(initial ? Object.entries(initial) : [])
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
  }
}

test('没记过就显示；点 × 之后同一次浏览器不再显示', () => {
  const store = fakeStore()
  assert.equal(mobileNoteVisible(store), true, '第一次进来应该看得见')
  assert.equal(dismissMobileNote(store), true)
  assert.equal(store.map.get(MOBILE_NOTE_KEY), '1')
  assert.equal(mobileNoteVisible(store), false, '点过 × 之后不该再顶一条')
})

test('记的是浏览器级标记，不是按账号：换账号也仍然藏着', () => {
  const store = fakeStore({ [MOBILE_NOTE_KEY]: '1' })
  assert.equal(mobileNoteVisible(store), false)
  // 另一个账号登录后仍是同一个 store —— 提示不重来
  assert.equal(mobileNoteVisible(store), false)
})

test('别的值不算记住：只有 1 才藏（写入被截断或清空时照常显示）', () => {
  assert.equal(mobileNoteVisible(fakeStore({ [MOBILE_NOTE_KEY]: '0' })), true)
  assert.equal(mobileNoteVisible(fakeStore({ [MOBILE_NOTE_KEY]: '' })), true)
  assert.equal(mobileNoteVisible(fakeStore({ [MOBILE_NOTE_KEY]: 'yes' })), true)
})

test('localStorage 写不进去（隐私模式）时不报错，并且下次仍然显示', () => {
  const throwing = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('SecurityError')
    },
  }
  assert.equal(mobileNoteVisible(throwing), true)
  assert.equal(dismissMobileNote(throwing), false)
})

test('没有 store（Node / 无 window）时：显示，且不假装关掉了', () => {
  assert.equal(mobileNoteVisible(null), true)
  assert.equal(dismissMobileNote(null), false)
  assert.equal(browserFlagStore(), null, 'Node 里没有 window，应返回 null')
})
