// 快捷创作对话的存储（r214）：会话、消息、上下文取舍。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-chat-'))
process.env.DATA_DIR = dir

const { CHAT_LIMITS, contextMessages, createConversation, deleteConversation, getConversation, listConversations, saveConversation, titleFrom } =
  await import('../server/chat-store.mjs')

test('新建会话：落进列表、消息为空、标题默认「新对话」', () => {
  const conv = createConversation('u1', {})
  assert.match(conv.id, /^c[0-9a-z]+$/i)
  const list = listConversations('u1')
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '新对话')
  assert.equal(getConversation('u1', conv.id).messages.length, 0)
})

test('存一条消息：标题、预览、条数都跟着更新；换账号看不到', () => {
  const conv = createConversation('u2', { title: titleFrom('把这条口播拆成六个分镜') })
  const saved = saveConversation('u2', {
    ...conv,
    messages: [
      { role: 'user', content: '把这条口播拆成六个分镜', at: Date.now() },
      { role: 'assistant', content: '第一镜：…', at: Date.now() },
    ],
  })
  assert.equal(saved.messages.length, 2)
  const list = listConversations('u2')
  assert.equal(list[0].title, '把这条口播拆成六个分镜')
  assert.equal(list[0].messageCount, 2)
  assert.match(list[0].preview, /第一镜/)
  assert.equal(listConversations('u3').length, 0)
})

test('上下文带最近 N 条，不是只带上一句；超字数从最早的开始丢，但保留最后一条', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'm' + index }))
  const picked = contextMessages(rows, 5, 1000)
  assert.equal(picked.length, 5)
  assert.equal(picked[picked.length - 1].content, 'm39')
  assert.equal(picked[0].content, 'm35')
  const tight = contextMessages([{ role: 'user', content: 'a'.repeat(2000) }, { role: 'assistant', content: 'b'.repeat(2000) }, { role: 'user', content: '最新一句' }], 30, 1000)
  assert.deepEqual(tight.map((row) => row.content), ['最新一句'])
  assert.deepEqual(contextMessages([{ role: 'user', content: '   ' }]), [])
})

test('坏会话 id、别的账号的会话都读不到；删除后列表也清掉', () => {
  const conv = createConversation('u4', {})
  assert.equal(getConversation('u4', 'not-a-real-id'), null)
  assert.equal(getConversation('u5', conv.id), null)
  assert.equal(deleteConversation('u4', conv.id), true)
  assert.equal(getConversation('u4', conv.id), null)
  assert.equal(listConversations('u4').length, 0)
})

test('会话最多 30 条：超过时先删最老的一条，不会无限长', () => {
  for (let index = 0; index < CHAT_LIMITS.MAX_CONVERSATIONS + 3; index += 1) {
    createConversation('u6', { title: '会话 ' + index })
  }
  const list = listConversations('u6')
  assert.equal(list.length, CHAT_LIMITS.MAX_CONVERSATIONS)
  assert.equal(list[0].title, '会话 ' + (CHAT_LIMITS.MAX_CONVERSATIONS + 2))
})

test('会话满了要腾位置时必须说出来：回传被挪掉的是哪一条，且它的文件真的没了（r247）', () => {
  const user = 'u7'
  const made = []
  for (let index = 0; index < CHAT_LIMITS.MAX_CONVERSATIONS; index += 1) {
    made.push(createConversation(user, { title: '老会话 ' + index }))
  }
  // 还没满：不该有任何东西被挪走
  assert.equal(made.every((conv) => !conv.retired), true)
  const oldest = made[0]
  const extra = createConversation(user, { title: '第十一条' })
  assert.deepEqual(extra.retired, { id: oldest.id, title: '老会话 0' })
  assert.equal(getConversation(user, oldest.id), null)
  assert.equal(listConversations(user).length, CHAT_LIMITS.MAX_CONVERSATIONS)
  // retired 是这次响应里的提示，不该被当成会话自己的字段写进文件
  assert.equal(getConversation(user, extra.id).retired, undefined)
})
