import test from 'node:test'
import assert from 'node:assert/strict'
import { clearUnsaved, setUnsaved, shouldAskBeforeLeave, unsavedNote } from '../src/domain/unsaved-guard.ts'

// 写到一半跳走这件事（r270）：三处编辑面共用一套登记，拦的位置在路由。
// 这里钉住判定本身：只认自己那一条；地址没变不拦、变了才拦。
// 「navigate 真的把跳转挂住了」由浏览器端到端验（路由模块的 import 不带扩展名，
// node 直接加载不了；为了一个单测去改全仓 import 风格不划算）。

test('没有登记就不拦', () => {
  setUnsaved(null)
  assert.equal(unsavedNote(), null)
  assert.equal(shouldAskBeforeLeave(Boolean(unsavedNote()), 'page:overview', 'page:radar'), false)
})

test('登记了、地址也换了 → 拦', () => {
  setUnsaved({ owner: 'project-script', message: '这条作品的脚本改了还没保存' })
  assert.equal(shouldAskBeforeLeave(Boolean(unsavedNote()), 'page:projects:p1', 'page:overview'), true)
})

test('登记了、但只是同一条地址自己回写 → 不拦', () => {
  // 画布页保存后补 runId、页内补查询串都走这条：拦了会把人卡在自己页上
  setUnsaved({ owner: 'canvas-flow', message: '工作流没保存成功' })
  assert.equal(shouldAskBeforeLeave(Boolean(unsavedNote()), 'page:canvas:flow:f1', 'page:canvas:flow:f1'), false)
})

test('只清自己那一条：后挂的页面清不掉先挂的', () => {
  setUnsaved({ owner: 'agent-editor', message: '对话预设没保存' })
  clearUnsaved('project-script')
  assert.equal(unsavedNote()?.owner, 'agent-editor')
  clearUnsaved('agent-editor')
  assert.equal(unsavedNote(), null)
})

test('登记的消息原样取回：不在这一层改写文案', () => {
  const message = '这条作品的脚本改了还没保存，现在离开就丢了。'
  setUnsaved({ owner: 'project-script', message })
  assert.equal(unsavedNote()?.message, message)
  setUnsaved(null)
})
