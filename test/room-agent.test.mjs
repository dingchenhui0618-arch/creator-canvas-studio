// 平台智能体在房间里回话（r317 一期 1c）：谁回、回几轮、工具、扣费与失败退回。
//
// 这一组钉住的是「它会说话，但不乱说话、不乱花钱」：
//   - 一个平台智能体的房间接每一句；多个时只接被 @ 的；关掉自动接话就只剩 @；
//   - 连接器成员（codex / Claude 接进来的）不归平台管，永远不在这里被选中；
//   - 工具只开 templates.list 一个，其余六个调了也只回「还没开」，绝不假装执行；
//   - 一轮 1 积分，模型没答上来全额退回，并且把原因作为 state=error 的消息留在房间里。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-roomagent-'))
process.env.DATA_DIR = DATA_DIR
process.env.VQ_REQUIRE_AUTH = '1'
// 整个文件默认关掉「发消息自动回话」：路由级的触发用不到真实模型，
// 单测直接在 scheduleRoomReplies 里注入假模型（见最后一个用例）。
process.env.VQ_ROOM_AGENT = '0'

const auth = await import('../server/auth.mjs')
const rooms = await import('../server/rooms.mjs')
const { createAgent } = await import('../server/agents.mjs')
const { config } = await import('../server/config.mjs')
const credits = await import('../server/credits.mjs')
const tools = await import('../server/agent-tools.mjs')
const engine = await import('../server/room-agent.mjs')

const AT = String.fromCharCode(64)
const alice = auth.createUser({ email: 'roomagent' + AT + 'vq.test', password: 'Passw0rd!demo', name: '阿甲', kind: 'account' })
credits.grant(alice.id, 40, { note: '单测' })

const agentDefinition = await createAgent(
  {
    name: '房间助手',
    category: '内容复刻',
    role: '在房间里帮着对齐模板与结构',
    systemPrompt: '你是房间里的复刻助手，先看模板库再给结论。答不上来就说不确定。',
    model: 'deepseek-flash',
    temperature: 0.3,
    knowledge: ['不要编造数据'],
    tools: ['templates-read'],
  },
  alice,
)

function makeRoom(name = '验收房') {
  const room = rooms.createRoom({ userId: alice.id, name, memberName: '阿甲' })
  rooms.addAgentMember({ roomId: room.id, userId: alice.id, agent: agentDefinition })
  return rooms.requireRoom(room.id, alice.id).room
}

const fake = (texts) => {
  const calls = []
  const fn = async (messages, options) => {
    calls.push({ messages, options })
    const next = texts[Math.min(calls.length - 1, texts.length - 1)]
    if (next instanceof Error) throw next
    return { text: next, model: 'fake-model' }
  }
  fn.calls = calls
  return fn
}

// ── 工具清单：七个登记，只开一个 ────────────────────────────────────────

test('工具清单：登记七个，只有 templates.list 是开着的，而且它是只读', () => {
  const catalog = tools.toolCatalog()
  assert.equal(catalog.length, 7)
  const on = catalog.filter((tool) => tool.enabled)
  assert.equal(on.length, 1)
  assert.equal(on[0].id, 'templates.list')
  assert.equal(on[0].mode, 'read')
  // 没开的每个都要能说清为什么，不能只有一个 false
  for (const tool of catalog.filter((item) => !item.enabled)) assert.ok(tool.reason, tool.id + ' 没有原因')
})

test('工具清单：没接的工具调了只回「还没开」，不执行、不抛错', async () => {
  const outcome = await tools.runAgentTool({ id: 'media.image', args: { prompt: '一只猫' }, user: alice })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'TOOL_DISABLED')
  assert.match(outcome.text, /还没开/)
  const unknown = await tools.runAgentTool({ id: 'shell.exec', user: alice })
  assert.equal(unknown.code, 'TOOL_UNKNOWN')
})

test('工具清单：环境变量只能往下关，关掉之后连 tips 都不给模型', async () => {
  process.env.VQ_AGENT_TOOLS_DISABLE = 'templates.list'
  try {
    assert.equal(tools.enabledTools().length, 0)
    assert.equal(tools.toolPrompt(), '')
    const outcome = await tools.runAgentTool({ id: 'templates.list', user: alice })
    assert.equal(outcome.code, 'TOOL_DISABLED')
  } finally {
    delete process.env.VQ_AGENT_TOOLS_DISABLE
  }
  assert.equal(tools.enabledTools().length, 1)
})

test('工具调用：只认一行 JSON，普通回复、坏 JSON、没有 tool 键都不算调用', () => {
  assert.equal(tools.parseToolCall('我先看看你的模板库。'), null)
  assert.equal(tools.parseToolCall('{ 这不是 json }'), null)
  assert.equal(tools.parseToolCall('{"args":{"limit":3}}'), null)
  assert.deepEqual(tools.parseToolCall('{"tool":"templates.list","args":{"limit":3}}'), { tool: 'templates.list', args: { limit: 3 } })
  assert.deepEqual(tools.parseToolCall('```json\n{"tool":"templates.list"}\n```'), { tool: 'templates.list', args: {} })
})

test('templates.list：只读、条数有上限、空库说的是人话', async () => {
  const outcome = await tools.runAgentTool({ id: 'templates.list', args: { limit: 999 }, user: alice })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.id, 'templates.list')
  assert.match(outcome.text, /模板库现在是空的/)
})

// ── 谁该回话 ────────────────────────────────────────────────────────────

const row = (id, extra = {}) => ({ id, kind: 'agent', agent_id: 'agt_x', name: id, provider: 'platform', ...extra })
const human = { id: 'h1', kind: 'human', name: '阿甲', provider: '' }
const message = (mentions = []) => ({ id: 'ms_1', seq: 1, mentions })

test('谁回：一个平台智能体接每一句，多个只接被 @ 的', () => {
  const one = engine.planReplies({ members: [human, row('a1')], message: message(), rules: { platformReply: true } })
  assert.deepEqual(one.map((item) => item.id), ['a1'])
  const many = engine.planReplies({ members: [human, row('a1'), row('a2')], message: message(), rules: { platformReply: true } })
  assert.deepEqual(many, [])
  const at = engine.planReplies({ members: [human, row('a1'), row('a2')], message: message(['a2']), rules: { platformReply: true } })
  assert.deepEqual(at.map((item) => item.id), ['a2'])
})

test('谁回：关掉自动接话只剩 @，allSpeakers 也要受 maxSpeakers 封顶', () => {
  const off = engine.planReplies({ members: [human, row('a1')], message: message(), rules: { platformReply: false } })
  assert.deepEqual(off, [])
  const offAt = engine.planReplies({ members: [human, row('a1')], message: message(['a1']), rules: { platformReply: false } })
  assert.deepEqual(offAt.map((item) => item.id), ['a1'])
  const all = engine.planReplies({
    members: [human, row('a1'), row('a2')],
    message: message(),
    rules: { platformReply: true, allSpeakers: true, maxSpeakers: 1 },
  })
  assert.equal(all.length, 1)
})

test('谁回：接进来的连接器不归平台管，永远不会被选中', () => {
  const connector = { id: 'a9', kind: 'agent', agent_id: 'agt_x', name: 'codex', provider: 'codex' }
  const plan = engine.planReplies({ members: [human, connector], message: message(), rules: { platformReply: true } })
  assert.deepEqual(plan, [])
})

// ── 一个回合 ────────────────────────────────────────────────────────────

test('回话：一轮扣 1 积分、消息落成智能体发的、replyTo 指向人那句话', async () => {
  const room = makeRoom('回话房')
  const before = credits.balanceOf(alice.id)
  const human1 = rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '帮我看下模板库最近有什么' })
  const member = rooms.agentMembers(room.id)[0]
  const callModel = fake(['我先读一遍模板库再回你。'])
  const result = await engine.runRoomTurn({ room, member, agent: agentDefinition, callModel })
  assert.equal(result.ok, true)
  assert.equal(result.cost, 1)
  assert.equal(credits.balanceOf(alice.id), before - 1)
  assert.equal(result.message.senderKind, 'agent')
  assert.equal(result.message.state, 'ok')
  assert.equal(result.message.body, '我先读一遍模板库再回你。')
  assert.equal(result.message.replyTo, human1.message.id)
  assert.equal(callModel.calls.length, 1)
  // 上下文里有人说的那句话，也有「你现在在哪」与工具说明
  const system = callModel.calls[0].messages[0].content
  const user = callModel.calls[0].messages[1].content
  assert.match(system, /验收房|回话房/)
  assert.match(system, /templates\.list/)
  assert.match(user, /帮我看下模板库最近有什么/)
})

test('回话：模型要工具就先执行再回答，工具结果进上下文、不写进房间', async () => {
  const room = makeRoom('工具房')
  const human1 = rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '模板库里有几条' })
  const member = rooms.agentMembers(room.id)[0]
  const callModel = fake(['{"tool":"templates.list","args":{"limit":3}}', '模板库现在是空的，先去爆款雷达存一条。'])
  const result = await engine.runRoomTurn({ room, member, agent: agentDefinition, callModel })
  assert.equal(result.ok, true)
  assert.equal(callModel.calls.length, 2)
  assert.deepEqual(result.tools.map((item) => item.id), ['templates.list'])
  assert.equal(result.tools[0].ok, true)
  assert.equal(result.message.body, '模板库现在是空的，先去爆款雷达存一条。')
  assert.equal(result.message.body.indexOf('{"tool"'), -1)
  const second = callModel.calls[1].messages.map((item) => item.content).join('\n')
  assert.match(second, /工具结果（templates\.list）/)
  assert.equal(result.message.replyTo, human1.message.id)
})

test('回话：模型要一个没开的工具，只把「还没开」交回去，不许自己演', async () => {
  const room = makeRoom('越权房')
  rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '直接给我出一张图' })
  const member = rooms.agentMembers(room.id)[0]
  const callModel = fake(['{"tool":"media.image","args":{"prompt":"猫"}}', '出图这个工具还没开，先在快捷创作里点生成吧。'])
  const result = await engine.runRoomTurn({ room, member, agent: agentDefinition, callModel })
  assert.equal(result.ok, true)
  assert.equal(result.tools[0].ok, false)
  const second = callModel.calls[1].messages.map((item) => item.content).join('\n')
  assert.match(second, /这个工具还没开：生成图片/)
})

test('失败：模型没答上来就退款，并把原因作为 state=error 留在房间里', async () => {
  const room = makeRoom('失败房')
  rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '在吗' })
  const member = rooms.agentMembers(room.id)[0]
  const before = credits.balanceOf(alice.id)
  const callModel = fake([new Error('upstream 500')])
  const result = await engine.runRoomTurn({ room, member, agent: agentDefinition, callModel })
  assert.equal(result.ok, false)
  assert.equal(credits.balanceOf(alice.id), before, '失败必须全额退回')
  const page = rooms.listMessages({ roomId: room.id, userId: alice.id })
  const failed = page.items.filter((item) => item.state === 'error')
  assert.equal(failed.length, 1)
  assert.match(failed[0].body, /积分已退回/)
  assert.equal(failed[0].senderName, member.name)
})

test('失败：没积分就不调模型，也不留一条「答上来了」的假消息', async () => {
  const room = makeRoom('空钱包房')
  rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '在吗' })
  const member = rooms.agentMembers(room.id)[0]
  const balance = credits.balanceOf(alice.id)
  credits.charge(alice.id, 'chat', { amount: balance })
  try {
    const callModel = fake(['不该被调用'])
    const result = await engine.runRoomTurn({ room, member, agent: agentDefinition, callModel })
    assert.equal(result.ok, false)
    assert.equal(callModel.calls.length, 0)
    const page = rooms.listMessages({ roomId: room.id, userId: alice.id })
    assert.equal(page.items.filter((item) => item.state === 'error').length, 1)
    assert.equal(page.items.filter((item) => item.state === 'ok' && item.senderKind === 'agent').length, 0)
  } finally {
    credits.grant(alice.id, balance, { note: '单测恢复' })
  }
})

// ── 安排回话（路由那一段的入口）────────────────────────────────────────

test('安排：自动回话关着时什么都不做（止血开关）', async () => {
  const room = makeRoom('止血房')
  const human1 = rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '在吗' })
  const callModel = fake(['不该被调用'])
  engine.scheduleRoomReplies({ room, message: human1.message, callModel })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(callModel.calls.length, 0)
  assert.equal(engine.roomTurnRunning(room.id), false)
})

test('安排：打开之后点一次名，真的落一条智能体消息，并且先广播「正在写」', async () => {
  const room = makeRoom('安排房')
  const events = []
  const unsubscribe = rooms.subscribeRoom(room.id, (event) => events.push(event))
  const human1 = rooms.appendMessage({ roomId: room.id, userId: alice.id, body: '开始吧' })
  const callModel = fake(['好，我先读模板库。'])
  config.roomAgent.enabled = true
  try {
    engine.scheduleRoomReplies({ room, message: human1.message, callModel })
    // 等回合跑完（假模型立即返回，这里只等微任务与写库）
    for (let i = 0; i < 100 && engine.roomTurnRunning(room.id); i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    for (let i = 0; i < 100; i += 1) {
      const page = rooms.listMessages({ roomId: room.id, userId: alice.id })
      if (page.items.some((item) => item.senderKind === 'agent')) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  } finally {
    config.roomAgent.enabled = false
    unsubscribe()
  }
  const page = rooms.listMessages({ roomId: room.id, userId: alice.id })
  const replies = page.items.filter((item) => item.senderKind === 'agent')
  assert.equal(replies.length, 1)
  assert.equal(replies[0].body, '好，我先读模板库。')
  const typing = events.filter((event) => event.type === 'typing')
  assert.equal(typing.length, 2, '开始一次、收尾一次')
  assert.equal(typing[0].on, true)
  assert.equal(typing[1].on, false)
  assert.equal(typing[0].memberId, replies[0].senderMemberId)
})
