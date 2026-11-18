// 快捷创作对话（r214 建立，r217 加流式）：用本地假上游把「工具参数、上下文、扣费、失败退款」
// 以及流式回答（逐段吐字 / 上游不认流式时降级 / 半路断开退款 / 用户停止 / 余额不足 / 长度截断）
// 整条链跑一遍。不调用真实 DeepSeek，不消耗任何额度。
//
// 为什么流式用例并在这个文件里、而不是新开一个 test 文件：本机只剩 1.2GB 空闲内存，
// 整套测试已经贴着上限跑，多开一个测试进程会让 media-gen 那几条「慢上游」用例假失败
// （r217 实测：单开文件 18/18 全绿，全量并发时 5 条误报）。同一个假上游服务两种协议，也不重复搭。
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
    // 只拒流式请求：一次性请求照常成功，才能验证「降级之后仍然拿到答案」
    if (mode === 'reject-stream' && body.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stream is not supported by this model' } }))
      return
    }
    if (body.stream) {
      const pieces = mode === 'slow' ? ['第一段', '第二段', '第三段', '第四段', '第五段'] : ['第一段', '第二段', '第三段']
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      let index = 0
      const tick = () => {
        if (res.destroyed) return
        if (index >= pieces.length) {
          if (mode === 'midfail') {
            res.destroy()
            return
          }
          const finish = mode === 'truncate' ? 'length' : 'stop'
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] }) + '\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[index] } }] }) + '\n\n')
        index += 1
        setTimeout(tick, mode === 'slow' ? 120 : 5)
      }
      tick()
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
const { sendChatMessage, streamChatMessage } = await import('../server/chat.mjs')
const { listConversations, getConversation } = await import('../server/chat-store.mjs')
const { balanceOf, charge } = await import('../server/credits.mjs')

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
// ── r217：流式回答 ────────────────────────────────────────────────────────────
const streamUser = auth.createUser({ email: '[EMAIL:6NGQ6B]', password: 'Passw0rd!demo', name: '流式测试' })

test('流式逐段吐字：回调按顺序拿到正文，最后一次带整条会话与余额，扣 1 积分', async () => {
  const before = balanceOf(streamUser.id)
  const deltas = []
  const result = await streamChatMessage(streamUser, { content: '把这条口播拆成六个分镜' }, { onDelta: (text) => deltas.push(text) })
  assert.equal(deltas.join(''), '第一段第二段第三段', '逐段回调拼起来应等于整段回答')
  assert.equal(result.reply.content, '第一段第二段第三段')
  assert.equal(result.reply.meta.streamed, true)
  assert.equal(result.cost, 1)
  assert.equal(balanceOf(streamUser.id), before - 1)
  const body = calls[calls.length - 1]
  assert.equal(body.stream, true, '流式一定要真的带 stream:true 上去')
  assert.equal(body.messages[body.messages.length - 1].content, '把这条口播拆成六个分镜')
  assert.equal(getConversation(streamUser.id, result.conversation.id).messages.length, 2)
})

test('上游不认流式（400）：退回一次性回答，整段一次性推给界面，仍然只扣一次费', async () => {
  const before = balanceOf(streamUser.id)
  const deltas = []
  mode = 'reject-stream'
  const result = await streamChatMessage(streamUser, { content: '换个方式再答一次' }, { onDelta: (text) => deltas.push(text) })
  mode = 'ok'
  assert.equal(result.fellBack, true)
  assert.equal(result.reply.content, '收到，这一步就这样做。')
  assert.deepEqual(deltas, ['收到，这一步就这样做。'])
  assert.equal(balanceOf(streamUser.id), before - 1, '降级不能变成扣两次')
})

test('流式半路断开：明确说积分已退回，余额回到原值，用户这句话仍留在会话里', async () => {
  const before = balanceOf(streamUser.id)
  const deltas = []
  mode = 'midfail'
  await assert.rejects(
    () => streamChatMessage(streamUser, { content: '这次会半路断掉' }, { onDelta: (text) => deltas.push(text) }),
    (error) => {
      assert.match(String(error.message), /积分已退回/)
      return true
    },
  )
  mode = 'ok'
  assert.ok(deltas.length > 0, '断开前已经吐出去的字不该被抹掉')
  assert.equal(balanceOf(streamUser.id), before, '失败必须全额退回')
  const conv = listConversations(streamUser.id).find((item) => item.preview.includes('半路断掉'))
  assert.ok(conv, '用户这句话要留在会话里')
  assert.equal(getConversation(streamUser.id, conv.id).messages.length, 1, '没有回答就别塞一条空的')
})

test('用户按停止：中止上游、退款、不落半截回答', async () => {
  const before = balanceOf(streamUser.id)
  const controller = new AbortController()
  let first = ''
  mode = 'slow'
  await assert.rejects(
    () =>
      streamChatMessage(streamUser, { content: '写到一半我按停止' }, {
        signal: controller.signal,
        onDelta: (text) => {
          first += text
          if (!controller.signal.aborted) controller.abort()
        },
      }),
    (error) => {
      assert.equal(error.code, 'CHAT_ABORTED')
      assert.equal(error.stopped, true)
      assert.match(String(error.message), /积分已退回/)
      return true
    },
  )
  mode = 'ok'
  assert.equal(first, '第一段', '停止前只收到了第一段')
  assert.equal(balanceOf(streamUser.id), before, '停止按未计费处理')
  const conv = listConversations(streamUser.id).find((item) => item.preview.includes('写到一半'))
  assert.equal(getConversation(streamUser.id, conv.id).messages.length, 1, '停止不保存半截回答')
})

test('余额不足：一个字节都不发给上游，直接说余额不够', async () => {
  const poor = auth.createUser({ email: '[EMAIL:GF3JX2]', password: 'Passw0rd!demo', name: '没积分' })
  charge(poor.id, 'chat', { ref: '测试清空余额', amount: balanceOf(poor.id) })
  const sent = calls.length
  await assert.rejects(() => streamChatMessage(poor, { content: '有钱再说' }), (error) => {
    assert.equal(error.code, 'CREDIT_INSUFFICIENT')
    assert.equal(error.status, 402)
    return true
  })
  assert.equal(calls.length, sent, '余额不够就不该打上游')
})

test('finish_reason=length 但正文有了：回答保留，并标成截断', async () => {
  mode = 'truncate'
  const result = await streamChatMessage(streamUser, { content: '写一篇特别长的' }, {})
  mode = 'ok'
  assert.equal(result.truncated, true)
  assert.equal(result.reply.meta.finishReason, 'length')
  assert.ok(result.reply.content.length > 0)
})

test('先建空会话再发第一句：标题取这句的开头，不会一直叫「新对话」', async () => {
  const created = (await import('../server/chat-store.mjs')).createConversation(streamUser.id, {})
  assert.equal(created.title, '新对话')
  await streamChatMessage(streamUser, { conversationId: created.id, content: '把这支 15 秒广告的开头改成反问句' }, {})
  const row = listConversations(streamUser.id).find((item) => item.id === created.id)
  assert.match(row.title, /把这支 15 秒广告/, '标题应该来自第一句，实际是 ' + row.title)
  // 第二句不能再改标题：否则标题会跟着最后一句乱跳
  await streamChatMessage(streamUser, { conversationId: created.id, content: '再来一版' }, {})
  assert.equal(listConversations(streamUser.id).find((item) => item.id === created.id).title, row.title)
})

test('流式与非流式共用一条会话：前面流式的回答会在下一轮的上下文里', async () => {
  const first = listConversations(streamUser.id)[0]
  const result = await sendChatMessage(streamUser, { conversationId: first.id, content: '用老接口接着问' })
  const body = calls[calls.length - 1]
  assert.ok(body.messages.some((item) => item.content === '第一段第二段第三段'), '上一轮流式回答要带进上下文')
  assert.equal(result.cost, 1)
})

