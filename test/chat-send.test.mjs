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
// r219：读链接会来这台假服务器抓页面，这里记下被请求过的页面地址
const pages = []
// r246：联网搜索也来这台假服务器（generic 搜索接口），这里记下被搜过的问题
const searchQueries = []
const origin = () => 'http://127.0.0.1:' + server.address().port
let mode = 'ok'
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    pages.push(req.url)
    if (req.url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><head><title>口播测试页</title><style>p{color:red}</style></head><body><p>' +
          '开场三秒要抓人。'.repeat(12) +
          '</p><script>tracker()</script></body></html>',
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  // r246：假搜索服务（后台配的 generic 接口）。两条结果：一条能读、一条 404
  if (req.url === '/search') {
    const collected = []
    req.on('data', (chunk) => collected.push(chunk))
    req.on('end', () => {
      searchQueries.push(JSON.parse(Buffer.concat(collected).toString('utf8') || '{}'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        results: [
          { title: '结果一', url: origin() + '/page.html', snippet: '结果一的摘要' },
          { title: '结果二', url: origin() + '/missing.html', snippet: '结果二的摘要' },
        ],
      }))
    })
    return
  }
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
  // r246：联网搜索也改成本地搜了，上游一个服务端工具都不带（不认就是整条 400）
  assert.equal(body.tools, undefined, '上游不再带 deepseek_web_search')
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.messages[0].role, 'system')
  // 这一步还没配搜索服务：上下文里要如实写「没搜成、别编」，而不是装作搜过
  const last = body.messages[body.messages.length - 1].content
  assert.ok(last.startsWith('帮我把这条口播拆成六个分镜'), last)
  assert.match(last, /联网搜索没有成功/)
  assert.match(last, /不要编造链接或数据/)
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
  // r246：上一轮开着联网搜索（还没接通），那一轮的上下文里留了一行「没搜成」的说明，
  // 所以这里按开头匹配：这条消息本身没变，只是后面跟着那一轮的说明。
  assert.ok(body.messages.some((item) => item.content.startsWith('帮我把这条口播拆成六个分镜')))
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


// ── r218：附件进对话 ──────────────────────────────────────────────────────────
// 解析器全在本地跑：夹具现场拼 zip / PDF，不下载任何文档、不调用任何上游。
const zlib = await import('node:zlib')
const chatFiles = await import('../server/chat-files.mjs')

/** 拼一个最小的 zip（docx / xlsx 都是它）：只写解析器真会读的那几个字段。 */
function zipFixture(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const body = Buffer.from(text, 'utf8')
    const data = zlib.deflateRawSync(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const cent = Buffer.alloc(46)
    cent.writeUInt32LE(0x02014b50, 0)
    cent.writeUInt16LE(20, 4)
    cent.writeUInt16LE(20, 6)
    cent.writeUInt16LE(8, 10)
    cent.writeUInt32LE(data.length, 20)
    cent.writeUInt32LE(body.length, 24)
    cent.writeUInt16LE(nameBuf.length, 28)
    cent.writeUInt32LE(offset, 42)
    central.push(cent, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

function docxFixture(paragraphs) {
  const body = paragraphs.map((line) => '<w:p><w:r><w:t>' + line + '</w:t></w:r></w:p>').join('')
  return zipFixture({ 'word/document.xml': '<w:document><w:body>' + body + '</w:body></w:document>' })
}

function xlsxFixture() {
  return zipFixture({
    'xl/sharedStrings.xml': '<sst><si><t>标题</t></si><si><t>点击率</t></si><si><t>开场三秒</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>0.42</v></c></row>' +
      '</sheetData></worksheet>',
  })
}

function pdfFixture(lines) {
  const content = 'BT /F1 12 Tf 72 720 Td ' + lines.map((line) => '(' + line + ') Tj 0 -14 Td').join(' ') + ' ET'
  const deflated = zlib.deflateRawSync(Buffer.from(content, 'latin1'))
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + deflated.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 2 0 R >>\n%%EOF\n', 'latin1'),
  ])
}

test('附件解析：Word / Excel / PDF / 纯文本都读成文字，并说明读到的是什么', () => {
  const docx = chatFiles.extractDocument(docxFixture(['开场三秒要抓人', '第二镜切近景']), { name: '脚本.docx' })
  assert.equal(docx.kind, 'docx')
  assert.match(docx.text, /开场三秒要抓人\n第二镜切近景/)
  assert.match(docx.note, /只读了 Word 的正文/)

  const xlsx = chatFiles.extractDocument(xlsxFixture(), { name: '复盘.xlsx' })
  assert.equal(xlsx.kind, 'xlsx')
  assert.equal(xlsx.text, '标题\t点击率\n开场三秒\t0.42')
  assert.match(xlsx.note, /第一个工作表/)

  const pdf = chatFiles.extractDocument(pdfFixture(['Hook in 3 seconds', 'Cut to close-up on the face']), { name: '参考.pdf' })
  assert.equal(pdf.kind, 'pdf')
  assert.match(pdf.text, /Hook in 3 seconds/)
  assert.match(pdf.text, /Cut to close-up on the face/)

  const text = chatFiles.extractDocument(Buffer.from('\uFEFF第一镜：开场三秒要抓人\n第二镜：切近景', 'utf8'), { name: '口播.txt' })
  assert.equal(text.kind, 'text')
  assert.equal(text.text, '第一镜：开场三秒要抓人\n第二镜：切近景')
})

test('附件解析：二进制、扫描件 PDF、超大文件都明确拒绝，不拿空内容去问模型', () => {
  assert.throws(() => chatFiles.extractDocument(Buffer.alloc(400, 0), { name: 'x.bin' }), (error) => error.code === 'FILE_TYPE')
  assert.throws(
    () => chatFiles.extractDocument(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n%%EOF\n'), { name: 'scan.pdf' }),
    (error) => error.code === 'FILE_PDF_NO_TEXT' && /扫描件/.test(error.message),
  )
  assert.throws(() => chatFiles.extractDocument(Buffer.alloc(9 * 1024 * 1024, 0x41), { name: 'big.txt' }), (error) => error.code === 'FILE_TOO_LARGE')
})

test('附件进上下文：模型收到附件里的文字，聊天记录里只留名字、字数与截断标记', async () => {
  const file = chatFiles.saveChatFile({
    userId: user.id,
    buffer: Buffer.from('第一镜：开场三秒要抓人\n第二镜：切近景看眼神\n第三镜：结尾反问', 'utf8'),
    name: '口播脚本.txt',
  })
  assert.equal(file.kind, 'text')
  assert.ok(file.chars > 10)
  const result = await sendChatMessage(user, { content: '按这个改成分镜，每镜写清画面与台词', files: [file.id] })
  const sent = calls[calls.length - 1]
  const last = sent.messages[sent.messages.length - 1]
  assert.equal(last.role, 'user')
  assert.match(last.content, /按这个改成分镜/)
  assert.match(last.content, /【附件 1：口播脚本\.txt/)
  assert.match(last.content, /第二镜：切近景看眼神/, '附件里的文字要真的进上下文')
  const stored = result.conversation.messages[0]
  assert.equal(stored.files.length, 1)
  assert.equal(stored.files[0].name, '口播脚本.txt')
  assert.equal(stored.content, '按这个改成分镜，每镜写清画面与台词')
  assert.doesNotMatch(stored.content, /第二镜/, '正文里不该重复塞附件原文')
})

test('附件跟着会话走：下一轮还在上下文里；别人的附件用不了，也不会假装看过', async () => {
  const conversation = listConversations(user.id)[0]
  await sendChatMessage(user, { conversationId: conversation.id, content: '第二镜再具体一点' })
  const sent = calls[calls.length - 1]
  assert.ok(
    sent.messages.some((item) => /第二镜：切近景看眼神/.test(item.content)),
    '上一轮的附件文字要跟着历史一起进上下文',
  )

  const other = auth.createUser({ email: '[EMAIL:ZP2K7M]', password: 'Passw0rd!demo', name: '别人的账号' })
  const mine = chatFiles.saveChatFile({ userId: user.id, buffer: Buffer.from('只有我能看的内容'), name: '私密.txt' })
  assert.equal(chatFiles.readChatFile(other.id, mine.id), null, '附件按归属读：别人的读不到')
  await sendChatMessage(other, { content: '偷看一下', files: [mine.id] })
  const stolen = calls[calls.length - 1]
  assert.doesNotMatch(stolen.messages[stolen.messages.length - 1].content, /只有我能看的内容/)
  assert.doesNotMatch(stolen.messages[stolen.messages.length - 1].content, /【附件/)
})

test('附件超限：一条消息最多 5 个，超了直接拒且一分钱不扣', async () => {
  const before = balanceOf(user.id)
  const ids = Array.from({ length: 6 }, (_, index) =>
    chatFiles.saveChatFile({ userId: user.id, buffer: Buffer.from('第 ' + index + ' 份'), name: 'f' + index + '.txt' }).id,
  )
  await assert.rejects(
    () => sendChatMessage(user, { content: '一次带六份', files: ids }),
    (error) => error.code === 'CHAT_FILES' && /最多带 5 个附件/.test(error.message),
  )
  assert.equal(balanceOf(user.id), before, '附件本身就超限时不能先扣费')
})

test('附件截断：单个文件封顶 20000 字，标 truncated，界面能看见', () => {
  const long = '开场三秒要抓人。'.repeat(3000)
  const file = chatFiles.saveChatFile({ userId: user.id, buffer: Buffer.from(long, 'utf8'), name: '长稿.txt' })
  assert.equal(file.truncated, true)
  assert.equal(file.chars, 20000)
  const resolved = chatFiles.resolveChatFiles(user.id, [file.id])
  assert.equal(resolved.chars, 20000)
  assert.match(resolved.text, /已截断/)
  assert.ok(resolved.text.length < long.length, '上下文里只放截断后的那一段')
})

// ── r219：读链接 ──────────────────────────────────────────────────────────────
// 本地假服务器在 127.0.0.1 上，正常情况会被内网防护挡住：只在这几条用例里放开
process.env.VQ_LINK_ALLOW_PRIVATE = '1'
const linkUser = auth.createUser({ email: '[EMAIL:7HKQ2W]', password: 'Passw0rd!demo', name: '读链接' })
const pageBase = 'http://127.0.0.1:' + server.address().port

test('读链接：页面先读成文字再问模型，会话里留下「读了什么」，只扣一次费', async () => {
  const before = balanceOf(linkUser.id)
  const hits = pages.length
  const result = await sendChatMessage(linkUser, {
    content: '看看这个页面 ' + pageBase + '/page.html 讲了什么',
    tools: { readUrl: true },
  })
  const sent = calls[calls.length - 1]
  const last = sent.messages[sent.messages.length - 1]
  assert.match(last.content, /【这一轮的链接】/)
  assert.match(last.content, /开场三秒要抓人/, '页面正文要真的进上下文')
  assert.doesNotMatch(last.content, /tracker\(\)/, '页面脚本不该进正文')
  assert.equal(sent.tools, undefined, '读链接不再走上游工具')
  const stored = result.conversation.messages[0]
  assert.equal(stored.links.length, 1)
  assert.equal(stored.links[0].ok, true)
  assert.match(stored.links[0].title, /口播测试页/)
  assert.ok(stored.links[0].chars > 40)
  assert.equal(stored.content, '看看这个页面 ' + pageBase + '/page.html 讲了什么')
  assert.equal(result.cost, 1)
  assert.equal(balanceOf(linkUser.id), before - 1)
  assert.equal(pages.length, hits + 1, '一次消息只抓一次页面')
})

test('读链接关着：消息里有网址也不抓页面', async () => {
  const before = balanceOf(linkUser.id)
  const hits = pages.length
  const result = await sendChatMessage(linkUser, { content: '这个链接先别读 ' + pageBase + '/page.html' })
  const stored = result.conversation.messages[0]
  assert.equal(stored.links, undefined)
  assert.equal(pages.length, hits, '开关关着就一个页面都不该抓')
  const sent = calls[calls.length - 1]
  assert.doesNotMatch(sent.messages[sent.messages.length - 1].content, /【这一轮的链接】/)
  assert.equal(balanceOf(linkUser.id), before - 1)
})

test('链接打不开：这次对话照常回答，链接标「没读到」，不多扣也不白送', async () => {
  const before = balanceOf(linkUser.id)
  const result = await sendChatMessage(linkUser, {
    content: '读一下 ' + pageBase + '/missing.html 这篇',
    tools: { readUrl: true },
  })
  const stored = result.conversation.messages[0]
  assert.equal(stored.links[0].ok, false)
  assert.match(stored.links[0].note, /HTTP 404/)
  const sent = calls[calls.length - 1]
  assert.match(sent.messages[sent.messages.length - 1].content, /没读到/)
  assert.equal(result.cost, 1)
  assert.equal(balanceOf(linkUser.id), before - 1)
})


// ── r245：图片进对话 ──────────────────────────────────────────────────────────
// 一张 1×1 的 PNG（67 字节）：只用来验「认得出是图 / 原样读得回来 / 真的发给上游」。
// 模型看不看得懂图不在这一层（那要花钱调真上游），这里连一个字节都不发出去。
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const files = await import('../server/chat-files.mjs')
const imageUser = auth.createUser({ email: 'chat-image-245@example.test', password: 'Passw0rd!demo', name: '图片测试' })

function attach(name = '截图.png', buffer = PNG_1PX) {
  return files.saveChatFile({ userId: imageUser.id, buffer, name })
}

test('图片按文件头认成 image：不转文字、原图读得回来、公开形状带 mime', () => {
  const saved = attach()
  assert.equal(saved.kind, 'image')
  assert.equal(saved.kindLabel, '图片')
  assert.equal(saved.chars, 0, '图片不在本地转文字，字数是 0')
  assert.equal(saved.truncated, false)
  assert.equal(saved.mime, 'image/png')
  assert.match(saved.note, /直接给模型看/)
  assert.equal(saved.bytes, PNG_1PX.length)
  const meta = files.readChatFile(imageUser.id, saved.id)
  assert.equal(meta.text, '')
  const raw = files.readChatFileBytes(imageUser.id, saved.id)
  assert.equal(raw.mime, 'image/png')
  assert.ok(raw.buffer.equals(PNG_1PX), '存回去的必须还是原来的字节')
})

test('改名的图片按内容也认得出，普通文字附件不受影响', () => {
  const sneaky = files.saveChatFile({ userId: imageUser.id, buffer: PNG_1PX, name: '脚本.txt' })
  assert.equal(sneaky.kind, 'image', '扩展名写成 .txt 也要按文件头认')
  const text = files.saveChatFile({ userId: imageUser.id, buffer: Buffer.from('第一句口播', 'utf8'), name: 'a.txt' })
  assert.equal(text.kind, 'text')
  assert.equal(text.mime, '')
  assert.equal(text.chars, 5)
})

test('带图这一轮：正文换成多模态、图片只挂在这一条上、走一次性而不是流式', async () => {
  const before = balanceOf(imageUser.id)
  const saved = attach('哪不对.png')
  const deltas = []
  const result = await streamChatMessage(
    imageUser,
    { content: '这张截图哪里不对', files: [saved.id] },
    { onDelta: (text) => deltas.push(text) },
  )
  const body = calls[calls.length - 1]
  assert.equal(body.stream, undefined, '带图这一轮走一次性：多模态流式不是每家上游都成立')
  const last = body.messages[body.messages.length - 1]
  assert.ok(Array.isArray(last.content), '正文要换成多模态数组')
  assert.match(last.content[0].text, /这张截图哪里不对/)
  assert.match(last.content[0].text, /（图片，由模型直接看）/, '文字里要留一行说明这一轮带的是哪张图')
  const image = last.content.find((part) => part.type === 'image_url')
  assert.ok(image, '必须真的把图片发上去，不能只留个文件名')
  assert.match(image.image_url.url, /^data:image\/png;base64,/)
  assert.equal(image.image_url.detail, 'high', '看截图要用 high，low 会把小字压糊')
  assert.equal(deltas.join(''), '收到，这一步就这样做。', '一次性路径也要整段推给界面，不能白等')
  assert.equal(result.reply.meta.vision, true)
  assert.equal(result.reply.meta.streamed, false)
  assert.equal(result.cost, 1)
  assert.equal(balanceOf(imageUser.id), before - 1)
})

test('下一轮追问：历史里只剩一行占位说明，不再重复发图（不再付图片输入费）', async () => {
  const [conv] = listConversations(imageUser.id)
  const result = await sendChatMessage(imageUser, { conversationId: conv.id, content: '那文字部分呢' })
  const body = calls[calls.length - 1]
  assert.ok(body.messages.every((message) => typeof message.content === 'string'), '追问这一轮不该再带图')
  assert.ok(body.messages.some((message) => /只按文件名记住/.test(message.content)), '要说明那一轮的图已经不在了')
  assert.equal(result.reply.meta.vision, undefined)
})

test('一条消息最多 2 张图：第 3 张直接拒，一分钱不扣', async () => {
  const a = attach('a.png')
  const b = attach('b.png')
  const c = attach('c.png')
  const before = balanceOf(imageUser.id)
  await assert.rejects(
    () => sendChatMessage(imageUser, { content: '三张一起看', files: [a.id, b.id, c.id] }),
    (error) => error.code === 'CHAT_IMAGES',
  )
  assert.equal(balanceOf(imageUser.id), before, '拒绝发生在扣费之前')
})

test('原图只给上传的人；删附件时原图一起删（不留没人能引用的截图）', () => {
  const saved = attach('私图.png')
  assert.equal(files.readChatFileBytes('usr_someoneelse_1', saved.id), null)
  assert.equal(files.readChatFileBytes(imageUser.id, saved.id).buffer.length, PNG_1PX.length)
  assert.equal(files.deleteChatFile(imageUser.id, saved.id), true)
  assert.equal(files.readChatFileBytes(imageUser.id, saved.id), null, '删了附件就要连原图一起删')
})

// ── r246：联网搜索（平台自己搜 + 自己读网页） ─────────────────────────────────
const webSearch = await import('../server/web-search.mjs')
const searchUser = auth.createUser({ email: ['search', 'r246'].join('-') + String.fromCharCode(64) + ['example', 'test'].join('.'), password: 'Passw0rd!demo', name: '联网搜索' })

test('搜索服务没接通：这一轮如实写「没搜成、别编」，照常扣一次费，不假装搜过', async () => {
  await webSearch.clearSearch()
  const before = balanceOf(searchUser.id)
  const result = await sendChatMessage(searchUser, { content: '最近有什么新变化', tools: { search: true } })
  const stored = result.conversation.messages[0]
  assert.equal(stored.search.ok, false)
  assert.match(stored.search.note, /还没接入搜索服务/)
  const sent = calls[calls.length - 1]
  const last = sent.messages[sent.messages.length - 1].content
  assert.match(last, /联网搜索没有成功/)
  assert.match(last, /不要编造链接或数据/)
  assert.equal(result.reply.meta.search.ok, false, '回答上要记一笔：这轮没搜到')
  assert.equal(result.cost, 1)
  assert.equal(balanceOf(searchUser.id), before - 1)
})

test('搜索服务接通：搜到几条、读前几条网页，来源存进会话，第二轮不再重复搜', async () => {
  const saved = await webSearch.saveSearch({ provider: 'generic', endpoint: pageBase + '/search' })
  assert.equal(saved.ok, true)
  const before = balanceOf(searchUser.id)
  const hits = searchQueries.length
  const result = await sendChatMessage(searchUser, { content: '最近有什么新变化', tools: { search: true } })
  const stored = result.conversation.messages[0]
  assert.equal(stored.search.ok, true)
  assert.equal(stored.search.query, '最近有什么新变化')
  assert.equal(stored.search.results.length, 2)
  assert.equal(stored.search.results[0].title, '结果一')
  assert.equal(stored.search.results[0].site, '127.0.0.1')
  assert.equal(stored.search.results[0].snippet, undefined, '摘要只在上下文里，不重复存进会话')
  assert.equal(searchQueries.length, hits + 1, '只搜一次')
  assert.equal(searchQueries[searchQueries.length - 1].query, '最近有什么新变化')
  const sent = calls[calls.length - 1]
  const last = sent.messages[sent.messages.length - 1].content
  assert.match(last, /【这一轮的联网搜索】/)
  assert.match(last, /【联网搜索：最近有什么新变化（平台自己搜的，来源/)
  assert.match(last, /结果一的摘要/, '摘要要进上下文')
  assert.match(last, /开场三秒要抓人/, '搜到的网页要真的读成文字')
  assert.match(last, /没读到/, '读不到的那条照实说')
  assert.equal(result.cost, 1)
  assert.equal(balanceOf(searchUser.id), before - 1)

  // 追问：上一轮读到的网页跟着那一轮留在上下文里，但不会再打一次搜索服务
  const hitsAfter = searchQueries.length
  const follow = await sendChatMessage(searchUser, { conversationId: result.conversation.id, content: '把刚才那篇的要点列出来' })
  assert.equal(searchQueries.length, hitsAfter, '没打开开关就不搜')
  assert.equal(follow.conversation.messages[1].search, undefined)
  const sent2 = calls[calls.length - 1]
  assert.match(sent2.messages[1].content, /开场三秒要抓人/, '上一轮读到的正文还在上下文里')
})

test('这一轮用户自己贴了链接：先读他的页面，不再自己搜一遍（省一次请求、也不跑偏）', async () => {
  const hits = searchQueries.length
  const result = await sendChatMessage(searchUser, {
    content: '看看 ' + pageBase + '/page.html 讲了什么',
    tools: { search: true, readUrl: true },
  })
  const stored = result.conversation.messages[0]
  assert.equal(stored.search, undefined, '自己在读链接时不再搜')
  assert.equal(stored.links.length, 1)
  assert.equal(searchQueries.length, hits, '一个搜索请求都不该发')
  const sent = calls[calls.length - 1]
  const last = sent.messages[sent.messages.length - 1].content
  assert.match(last, /【这一轮的链接】/)
  assert.doesNotMatch(last, /【联网搜索/)
  await webSearch.clearSearch()
})

