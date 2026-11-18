// 快捷创作对话（r214）：用本地假上游把「工具参数、上下文、扣费、失败退款」整条链跑一遍。
// 不调用真实 DeepSeek，不消耗任何额度。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-chat-send-'))
process.env.DATA_DIR = dir
process.env.VISION_API_KEY = 'test-key'
process.env.VQ_KEY_SECRET = 'test-secret-chat'
process.env.VQ_CREDIT_CHAT = '1'
process.env.VQ_REQUIRE_AUTH = '1'

const calls = []
let mode = 'ok'
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    calls.push(body)
    if (mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '上游炸了' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      model: 'deepseek-flash',
      choices: [{ message: { role: 'assistant', content: '收到，这一步就这样做。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/v1'
process.env.VISION_BASE_URL = base

const auth = await import('../server/auth.mjs')
const { sendChatMessage } = await import('../server/chat.mjs')
const { listConversations, getConversation } = await import('../server/chat-store.mjs')
const { balanceOf } = await import('../server/credits.mjs')

const user = auth.createUser({ email: 'chat@example.com', password: 'Passw0rd!demo', name: '对话测试' })

test.after(() => new Promise((resolve) => server.close(resolve)))

test('开联网搜索 / 读链接 / 思考模式：工具与 thinking 真的发到上游，回复落进会话', async () => {
  const result = await sendChatMessage(user, { content: '帮我把这条口播拆成六个分镜', tools: { search: true, readUrl: true, thinking: true } })
  assert.equal(result.reply.content, '收到，这一步就这样做。')
  assert.equal(result.cost, 1)
  const body = calls[calls.length - 1]
  assert.deepEqual(body.tools, [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }])
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[body.messages.length - 1].content, '帮我把这条口播拆成六个分镜')
  assert.equal(listConversations(user.id).length, 1)
  assert.equal(getConversation(user.id, result.conversation.id).messages.length, 2)
})

test('能力全关：不带 tools / thinking，但上下文仍带上一条', async () => {
  const first = listConversations(user.id)[0]
  const result = await sendChatMessage(user, { conversationId: first.id, content: '继续说' })
  const body = calls[calls.length - 1]
  assert.equal(body.tools, undefined)
  assert.equal(body.thinking, undefined)
  assert.ok(body.messages.length >= 4, '第二句要把上一轮问答一起带上，不能只带这一句')
  assert.ok(body.messages.some((item) => item.content === '帮我把这条口播拆成六个分镜'))
  assert.ok(result.conversation.messages.length >= 4)
})

test('上游失败：明确说积分已退回，余额回到原值，用户这句话仍留在会话里', async () => {
  const before = balanceOf(user.id)
  mode = 'fail'
  await assert.rejects(
    () => sendChatMessage(user, { content: '这次会失败' }),
    (error) => {
      assert.match(String(error.message), /积分已退回/)
      return true
    },
  )
  mode = 'ok'
  assert.equal(balanceOf(user.id), before)
})

test('别人的会话读不到、空消息 400', async () => {
  const other = auth.createUser({ email: 'chat2@example.com', password: 'Passw0rd!demo', name: '另一个' })
  const first = listConversations(user.id)[0]
  await assert.rejects(() => sendChatMessage(other, { conversationId: first.id, content: '偷看' }), (error) => error.code === 'CHAT_NOT_FOUND')
  await assert.rejects(() => sendChatMessage(user, { content: '   ' }), (error) => error.code === 'CHAT_EMPTY')
})
