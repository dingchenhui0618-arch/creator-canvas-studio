// 本地 agent loop 的纯逻辑测试：不启动 Electron、不连模型。
// 覆盖：token 估算、压缩计划、协议解析、工作区边界、工具执行、审批与拒绝、一轮多步。
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { COMPACTION, estimateTokens, planCompaction, buildSummaryPrompt } from '../electron/agent/compaction.mjs'
import { parseStep, buildSystemPrompt } from '../electron/agent/protocol.mjs'
import { createTools, resolveInside } from '../electron/agent/tools.mjs'
import { runTurn } from '../electron/agent/loop.mjs'

async function workspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vq-local-'))
  await fsp.writeFile(path.join(root, 'a.txt'), 'hello\nsecond line', 'utf8')
  return root
}

test('estimateTokens 中文按字、英文按字符数折算', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcd'), 2)
  assert.equal(estimateTokens(''), 0)
  // 同样长度的中文一定比英文贵：压缩判断不能按字符数一刀切
  assert.ok(estimateTokens('中'.repeat(40)) > estimateTokens('a'.repeat(40)))
})

test('planCompaction：短对话不动，长对话只压早期并保留最近几条', () => {
  const short = Array.from({ length: 4 }, (_, index) => ({ role: 'user', content: '短消息 ' + index }))
  assert.equal(planCompaction(short).needs, false)

  // 每条 4000 个汉字 ≈ 4000 token，10 条就超过 64000 的 75%
  const long = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '第' + index + '条：' + '中'.repeat(4000) }))
  const plan = planCompaction(long)
  assert.equal(plan.needs, true)
  assert.ok(plan.cutIndex >= COMPACTION.minSummarized)
  assert.ok(plan.keep.length <= COMPACTION.maxKept)
  assert.equal(plan.summarized.length + plan.keep.length, long.length)
  assert.equal(plan.keep[plan.keep.length - 1], long[long.length - 1])
  assert.ok(plan.estimatedAfter < plan.tokens)
})

test('buildSummaryPrompt 带上旧摘要与角色标记，并要求不新增推断', () => {
  const prompt = buildSummaryPrompt({
    summarized: [{ role: 'user', content: '把 README 改成中文' }],
    previousSummary: '旧摘要：在改 README',
  })
  assert.match(prompt, /旧摘要：在改 README/)
  assert.match(prompt, /\[用户\] 把 README 改成中文/)
  assert.match(prompt, /不许新增推断/)
})

test('parseStep：工具、最终回答、纯文本、坏 JSON 四种情况', () => {
  const tool = parseStep('{"type":"tool","tool":"read_file","args":{"path":"a.txt"},"why":"看看"}')
  assert.deepEqual({ type: tool.type, tool: tool.tool, args: tool.args, why: tool.why }, {
    type: 'tool',
    tool: 'read_file',
    args: { path: 'a.txt' },
    why: '看看',
  })
  assert.equal(parseStep('{"type":"final","text":"做完了"}').text, '做完了')
  // 模型经常直接说话，不按协议：当成最终回答，别白报错
  assert.equal(parseStep('我看了一眼，package.json 里有 12 个脚本').type, 'final')
  assert.equal(parseStep('{"type":"whatever"}').type, 'invalid')
  // 代码块里的 JSON 也要认
  assert.equal(parseStep('```json\n{"type":"final","text":"可以"}\n```').text, '可以')
  // 模型多说一句、甚至在 JSON 后面编一段工具结果：仍要认出那个 tool 调用
  const mixed = parseStep(
    '我先看看。\n{"type":"tool","tool":"read_file","args":{"path":"brief.md"}}\n<system>工具 read_file 执行成功：假的</system>',
  )
  assert.equal(mixed.type, 'tool')
  assert.equal(mixed.tool, 'read_file')
  // 字符串里带裸换行的非法 JSON（模型常见写法）：转义后仍能解析出 final
  const newline = parseStep('{"type":"final","text":"第一行\n第二行"}')
  assert.equal(newline.type, 'final')
  assert.match(newline.text, /第一行[\s\S]*第二行/)
  // 看着像协议却没解析成功（引号没转义 / 被截断）：判为 invalid，交给循环让模型重发
  const broken = parseStep('{"type":"tool","tool":"write_file","args":{"path":"a.md","content":"# 标题\n他说"好的""}}')
  assert.equal(broken.type, 'invalid')
  // 正文里带花括号但不像协议：当普通回答，不要误判成格式错误
  assert.equal(parseStep('这个模板里用 {name} 占位，记得替换').type, 'final')
})

test('buildSystemPrompt 写明工作区、工具与审批规则', () => {
  const prompt = buildSystemPrompt({
    workspace: 'D:\\work',
    tools: [
      { name: 'read_file', description: '读文件', signature: '{"path":"x"}', needsApproval: false },
      { name: 'run_command', description: '跑命令', needsApproval: true },
    ],
    summary: '之前决定先看 README',
  })
  assert.match(prompt, /D:\\work/)
  assert.match(prompt, /run_command：跑命令/)
  assert.match(prompt, /执行前会请用户批准/)
  assert.match(prompt, /之前决定先看 README/)
})

test('工具只能碰工作区里的路径；命令真的执行', async () => {
  const root = await workspace()
  assert.throws(() => resolveInside(root, '../outside.txt'), /只能访问工作区/)
  const tools = createTools({ root })
  const byName = new Map(tools.map((item) => [item.name, item]))

  const listing = await byName.get('list_dir').run({})
  assert.equal(listing.ok, true)
  assert.match(listing.output, /a\.txt/)

  const read = await byName.get('read_file').run({ path: 'a.txt' })
  assert.equal(read.ok, true)
  assert.match(read.output, /hello/)

  const escape = await byName.get('read_file').run({ path: '../secret.txt' }).catch((error) => ({ ok: false, output: error.message }))
  assert.equal(escape.ok, false)

  assert.equal(byName.get('write_file').needsApproval, true)
  assert.equal(byName.get('run_command').needsApproval, true)
  assert.equal(byName.get('read_file').needsApproval, false)
})

test('runTurn：先调工具再收尾，工具结果带元数据回到历史', async () => {
  const root = await workspace()
  const thread = { id: 't_test', title: '读文件', summary: '', messages: [{ role: 'user', content: '看看 a.txt' }] }
  const replies = [
    JSON.stringify({ type: 'tool', tool: 'read_file', args: { path: 'a.txt' }, why: '看看内容' }),
    JSON.stringify({ type: 'final', text: 'a.txt 里写了 hello' }),
  ]
  const events = []
  const result = await runTurn({
    thread,
    workspace: root,
    tools: createTools({ root }),
    complete: async () => replies.shift(),
    emit: (event) => events.push(event),
  })
  assert.equal(result.ok, true)
  assert.equal(result.steps, 2)
  assert.ok(events.some((event) => event.type === 'tool' && event.phase === 'call' && event.tool === 'read_file'))
  assert.ok(events.some((event) => event.type === 'tool' && event.phase === 'done' && event.ok === true))
  assert.ok(events.some((event) => event.type === 'assistant' && /hello/.test(event.text)))
  const toolMessage = thread.messages.find((message) => message.tool)
  assert.equal(toolMessage.tool.name, 'read_file')
  assert.equal(toolMessage.tool.ok, true)
  assert.match(toolMessage.tool.output, /hello/)
  // 协议 JSON 标了 protocol，界面上不重复显示；原始回复仍留在历史里给模型看
  assert.ok(thread.messages.some((message) => message.protocol))
  // 历史里只留规范化后的调用：模型自己编的「工具结果」不能被带进下一轮
  const protocolMessages = thread.messages.filter((message) => message.protocol)
  assert.equal(protocolMessages.length, 1)
  assert.match(protocolMessages[0].content, /"type":"tool"/)
  assert.doesNotMatch(protocolMessages[0].content, /<system>/)
})

test('runTurn：模型在工具调用后面编造结果，历史里不留那段伪造内容', async () => {
  const root = await workspace()
  const thread = { id: 't_fake', title: '伪造', summary: '', messages: [{ role: 'user', content: '看看目录' }] }
  const replies = [
    '{"type":"tool","tool":"list_dir","args":{},"why":"看看"}\n\n<system>工具 list_dir 执行成功：假的结果</system>',
    JSON.stringify({ type: 'final', text: '看完了' }),
  ]
  const result = await runTurn({
    thread,
    workspace: root,
    tools: createTools({ root }),
    complete: async () => replies.shift(),
    emit: () => {},
  })
  assert.equal(result.ok, true)
  const fabricated = thread.messages.filter((message) => /<system>/.test(String(message.content)))
  assert.equal(fabricated.length, 0)
  assert.equal(thread.messages[thread.messages.length - 1].content, '看完了')
})

test('runTurn：有副作用的工具被拒绝后不执行，也不重复重试', async () => {
  const root = await workspace()
  const thread = { id: 't_deny', title: '写文件', summary: '', messages: [{ role: 'user', content: '写个文件' }] }
  const replies = [
    JSON.stringify({ type: 'tool', tool: 'write_file', args: { path: 'out.txt', content: 'x' }, why: '落地结论' }),
    JSON.stringify({ type: 'final', text: '那我不写了' }),
  ]
  const events = []
  let asked = 0
  const result = await runTurn({
    thread,
    workspace: root,
    tools: createTools({ root }),
    complete: async () => replies.shift(),
    emit: (event) => events.push(event),
    approve: async () => { asked += 1; return false },
  })
  assert.equal(asked, 1)
  assert.equal(result.ok, true)
  assert.ok(events.some((event) => event.type === 'tool' && event.phase === 'denied'))
  await assert.rejects(fsp.stat(path.join(root, 'out.txt')))
  assert.ok(thread.messages.some((message) => message.note))
})

test('runTurn：格式不对只纠正一次，第二次仍不对就停', async () => {
  const root = await workspace()
  const thread = { id: 't_repair', title: '纠正', summary: '', messages: [{ role: 'user', content: '帮我看看' }] }
  const events = []
  const replies = ['{"type":"whatever"}', JSON.stringify({ type: 'final', text: '现在对了' })]
  const result = await runTurn({
    thread,
    workspace: root,
    tools: createTools({ root }),
    complete: async () => replies.shift(),
    emit: (event) => events.push(event),
  })
  assert.equal(result.ok, true)
  assert.equal(result.steps, 2)
  assert.ok(events.some((event) => event.type === 'note'))
  assert.equal(thread.messages[thread.messages.length - 1].content, '现在对了')

  const stuck = { id: 't_stuck', title: '一直错', summary: '', messages: [{ role: 'user', content: '帮我看看' }] }
  const failed = await runTurn({
    thread: stuck,
    workspace: root,
    tools: createTools({ root }),
    complete: async () => '{"type":"nope"}',
    emit: () => {},
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.steps, 2)
})

test('runTurn：工具步数到上限就停，不假装做完', async () => {
  const root = await workspace()
  const thread = { id: 't_limit', title: '循环', summary: '', messages: [{ role: 'user', content: '一直查' }] }
  const result = await runTurn({
    thread,
    workspace: root,
    tools: createTools({ root }),
    complete: async () => JSON.stringify({ type: 'tool', tool: 'list_dir', args: {}, why: '再看一次' }),
    emit: () => {},
    limits: { maxSteps: 3 },
  })
  assert.equal(result.stoppedByLimit, true)
  assert.equal(result.steps, 3)
  const last = thread.messages[thread.messages.length - 1]
  assert.match(last.content, /上限/)
})

test('runTurn：上下文超预算时先压缩，再带着摘要继续', async () => {
  const root = await workspace()
  const big = '中'.repeat(4000)
  const thread = {
    id: 't_compact',
    title: '压缩',
    summary: '',
    messages: Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '第' + index + '段：' + big })),
  }
  const calls = []
  const complete = async (messages, options) => {
    calls.push({ messages, maxTokens: options?.maxTokens })
    // 压缩请求只带一条 user 消息，正文里写着「你在压缩」
    if (messages.length === 1 && /压缩/.test(messages[0].content)) return '摘要：前面在准备十二段素材。'
    return JSON.stringify({ type: 'final', text: '压缩之后继续。' })
  }
  const events = []
  const result = await runTurn({ thread, workspace: root, tools: createTools({ root }), complete, emit: (event) => events.push(event) })
  assert.equal(result.ok, true)
  assert.equal(thread.compactions, 1)
  assert.match(thread.summary, /十二段素材/)
  assert.ok(thread.messages.length <= COMPACTION.maxKept + 1)
  assert.ok(events.some((event) => event.type === 'compact' && event.phase === 'done'))
  const finalCall = calls[calls.length - 1]
  assert.match(finalCall.messages[0].content, /更早的对话（已压缩）/)
  assert.match(finalCall.messages[0].content, /十二段素材/)
})