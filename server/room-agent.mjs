// 平台智能体在房间里回话（r317，一期 1c）。
//
// 谁回：房间里 provider=platform 的成员（从「快捷创作」的对话预设加进来的那几个）。
// 什么时候回：人发了一条消息之后。一个房间只有一个平台智能体时它接每一句；
// 多个时只有被 @ 的接（免得一句话引出两个回合两笔积分）；房主可以把自动回话关掉。
// 回几轮：只有「人 → 智能体」这一层，智能体之间不互相接话（maxDepth=1），
// 所以不会出现两个智能体互道「收到」刷满一屏。
//
// 钱：平台智能体用自己的模型，一轮 1 积分（与快捷创作对话同价），先扣后调，
// 失败全额退回；余额不足/模型没答上来会把原因作为一条 state=error 的消息留在房间里，
// 不做「静默失败」——用户看不见原因只会以为功能坏了。
import crypto from 'node:crypto'
import { config } from './config.mjs'
import { getAgent } from './agents.mjs'
import { charge, refund } from './credits.mjs'
import { callTextModel, llmEnabled } from './llm.mjs'
import { toolPrompt, parseToolCall, runAgentTool, enabledTools } from './agent-tools.mjs'
import {
  agentMembers,
  appendMessageAs,
  broadcastRoomTyping,
  getMember,
  recentMessages,
  roomRules,
} from './rooms.mjs'

const HISTORY = 20
const REPLY_MAX_CHARS = 900

/** 平台智能体成员：provider 是 platform（或空，早期数据），有 agent_id。 */
export function isPlatformAgent(row) {
  if (!row || row.kind !== 'agent') return false
  if (!row.agent_id) return false
  const provider = String(row.provider || '').trim()
  return provider === 'platform' || provider === ''
}

/**
 * 这一条消息该引出谁的回话。纯函数，方便单独钉住：
 * 被 @ 的一定回（哪怕自动回话关着）；其余按「只有一个平台智能体」或 allSpeakers 决定。
 */
export function planReplies({ members = [], message = null, rules = null }) {
  const live = rules || {}
  const platform = members.filter(isPlatformAgent)
  if (!platform.length || !message) return []
  const mentioned = new Set((message.mentions || []).map((item) => String(item)))
  const auto = live.platformReply !== false
  const everyone = live.allSpeakers === true
  const picked = platform.filter((member) => mentioned.has(member.id) || (auto && (everyone || platform.length === 1)))
  const cap = Math.max(1, Math.min(4, Number(live.maxSpeakers) || 1))
  return picked.slice(0, cap)
}

const pad = (value) => String(value).padStart(2, '0')

function clock(ms) {
  const date = new Date(Number(ms) || Date.now())
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** 房间上下文：谁在、刚才谁说了什么。只带最近 20 条，避免把上下文顶爆。 */
export function buildTurnMessages({ room, member, agent, history, toolsOn = true }) {
  const rules = roomRules(room)
  const members = agentMembers(room.id)
  const people = members
    .map((row) => (row.kind === 'agent' ? '智能体：' : '人：') + row.name + (row.role ? '（' + row.role + '）' : ''))
    .join('；')
  const transcript = history
    .map((item) => {
      const flag = String(item.senderMemberId) === String(member.id) ? '（你）' : ''
      return '[' + clock(item.createdAt) + '] ' + item.senderName + flag + '：' + String(item.body || '').slice(0, 600)
    })
    .join('\n')
  const system = [
    String(agent.systemPrompt || '').trim(),
    '',
    '## 你现在在哪',
    '你在 VisionQA 的一个聊天室「' + String(room.name || '').trim() + '」里，名字是「' + String(member.name || '').trim() + '」。',
    room.topic ? '房间主题：' + String(room.topic).trim() : '',
    '房间里的人与智能体：' + (people || '只有你'),
    '这里是多人（多智能体）房间：只说你该说的，不要替别人发言，不要复述房间规则。',
    '',
    '## 怎么说',
    '- 简体中文，直接给结论，然后给必要的依据；总长不超过 ' + REPLY_MAX_CHARS + ' 字。',
    '- 不要写 Markdown 标题、不要画大表格；要列举就用短横线。',
    '- 只依据房间里说过的内容和你自己查到的工具结果；不知道就说不确定，不要编。',
    '- 不要输出「收到」「好的」这类没有信息量的开场白。',
    ...(Array.isArray(agent.knowledge) && agent.knowledge.length ? ['', '## 你记得的事', ...agent.knowledge.map((line) => '- ' + line)] : []),
    ...(toolsOn ? ['', '## 工具', toolPrompt()] : []),
  ]
    .filter((line) => line !== '')
    .join('\n')
  const user = [
    '房间最近的对话：',
    transcript || '（这个房间还没有别的消息）',
    '',
    '现在轮到你说话。只输出要发到房间里的那段话。',
  ].join('\n')
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    rules,
  }
}

async function postFailure({ room, member, reason }) {
  try {
    appendMessageAs({
      roomId: room.id,
      room,
      member,
      senderKind: 'agent',
      body: reason,
      state: 'error',
    })
  } catch (error) {
    console.error('[room-agent] 失败提示没写进房间：' + (error?.message || error))
  }
}

/**
 * 跑一个回合：拼上下文 → 调模型（最多两轮工具）→ 把回复写进房间。
 * 模型调用可注入（callModel），单测据此不碰真实上游。
 */
export async function runRoomTurn({ room, member, agent = null, callModel = callTextModel, chargeTurn = true }) {
  const ownerId = String(room.owner_id || '')
  const owner = { id: ownerId, kind: 'account', email: '' }
  const definition = agent || (await getAgent(member.agent_id, owner))
  if (!definition) {
    await postFailure({ room, member, reason: '（这个智能体已经被删掉了，把我移出房间，或者重新加一个。）' })
    return { ok: false, code: 'AGENT_GONE' }
  }
  // 只有真去打模型时才看「平台有没有可用模型」：单测与自检会注入假模型，
  // 它们不该被凭证检查挡住（CI 上没有模型凭证，这里曾把 5 条用例判成失败）。
  if (callModel === callTextModel && !llmEnabled()) {
    await postFailure({ room, member, reason: '（这一轮没答上来：平台现在没有可用的对话模型。等管理员开通后再叫我。）' })
    return { ok: false, code: 'NO_MODEL' }
  }
  let paid = { ok: true, cost: 0, balance: null }
  if (chargeTurn && ownerId) {
    paid = charge(ownerId, 'chat', { ref: '房间 · ' + String(room.name || '').slice(0, 40), meta: { roomId: room.id, memberId: member.id } })
    if (!paid.ok) {
      await postFailure({
        room,
        member,
        reason: '（这一轮没答上来：这个房间主人的积分不够了，需要 1 积分。充值之后再叫我一次。）',
      })
      return { ok: false, code: paid.code || 'CREDIT_INSUFFICIENT' }
    }
  }
  const history = recentMessages(room.id, HISTORY)
  const { messages } = buildTurnMessages({ room, member, agent: definition, history, toolsOn: enabledTools().length > 0 })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(config.roomAgent.timeoutMs) || 90000)
  timer.unref?.()
  const used = []
  try {
    let payload = messages
    let reply = ''
    let model = ''
    const rounds = Number(config.roomAgent.maxToolRounds) || 2
    for (let round = 0; round <= rounds; round += 1) {
      const result = await callModel(payload, {
        temperature: Math.max(0, Math.min(1, Number(definition.temperature ?? 0.4))),
        maxTokens: 1400,
        models: definition.model ? [definition.model] : undefined,
        signal: controller.signal,
      })
      const text = String(result?.text || '').trim()
      model = String(result?.model || model)
      if (!text) throw Object.assign(new Error('模型没有返回内容'), { code: 'EMPTY' })
      const wanted = round < rounds ? parseToolCall(text) : null
      if (!wanted) {
        reply = text
        break
      }
      const outcome = await runAgentTool({ id: wanted.tool, args: wanted.args, user: owner })
      used.push({ id: wanted.tool, ok: outcome.ok, detail: outcome.detail || outcome.code || '' })
      payload = [
        ...payload,
        { role: 'assistant', content: text },
        { role: 'user', content: '工具结果（' + wanted.tool + '）：\n' + outcome.text + '\n\n现在给出要发到房间里的那段话。' },
      ]
    }
    if (!reply) throw Object.assign(new Error('几轮之后还是没有给出回复'), { code: 'EMPTY' })
    const body = reply.slice(0, 4000)
    const saved = appendMessageAs({
      roomId: room.id,
      room,
      member,
      senderKind: 'agent',
      body,
      replyTo: String(history[history.length - 1]?.id || ''),
    })
    return { ok: true, message: saved.message, model, tools: used, cost: paid.cost, balance: paid.balance }
  } catch (error) {
    if (chargeTurn && paid.cost > 0) {
      try {
        refund(ownerId, 'chat', { ref: '房间 · ' + String(room.name || '').slice(0, 40), amount: paid.cost, meta: { roomId: room.id, memberId: member.id } })
      } catch (refundError) {
        console.error('[room-agent] 退款失败：' + (refundError?.message || refundError))
      }
    }
    const timedOut = controller.signal.aborted
    console.error('[room-agent] 回合失败：' + (error?.message || error))
    await postFailure({
      room,
      member,
      reason: timedOut
        ? '（这一轮没在 90 秒内答上来，已经停下，积分已退回。再叫我一次。）'
        : '（这一轮没答上来：模型没有回应，积分已退回。再叫我一次。）',
    })
    return { ok: false, code: timedOut ? 'TIMEOUT' : String(error?.code || 'MODEL_ERROR') }
  } finally {
    clearTimeout(timer)
  }
}

// 同一个房间同时只跑一轮：连发三句不该同时起三个回合（三笔积分、三份上下文）。
const running = new Set()

/**
 * 人发完一条消息之后调这个（不 await）：它自己决定要不要回、回几条。
 * 任何异常只进日志，绝不冒到发消息的请求上——回话失败不该让「消息没发出去」。
 */
export function scheduleRoomReplies({ room, message, callModel = callTextModel }) {
  if (!config.roomAgent.enabled || !room || !message) return
  let plan = []
  try {
    plan = planReplies({ members: agentMembers(room.id), message, rules: roomRules(room) })
  } catch (error) {
    console.error('[room-agent] 判断要不要回话时出错：' + (error?.message || error))
    return
  }
  if (!plan.length) return
  void (async () => {
    for (const row of plan) {
      if (running.has(room.id)) return
      running.add(room.id)
      const typingId = crypto.randomUUID()
      const member = getMember(room.id, row.id) || row
      try {
        broadcastRoomTyping(room.id, { memberId: member.id, name: member.name, on: true, id: typingId })
        await runRoomTurn({ room, member, callModel })
      } catch (error) {
        console.error('[room-agent] 回话失败：' + (error?.message || error))
      } finally {
        broadcastRoomTyping(room.id, { memberId: member.id, name: member.name, on: false, id: typingId })
        running.delete(room.id)
      }
    }
  })()
}

/** 给测试与自检用：现在有没有回合在跑。 */
export function roomTurnRunning(roomId) {
  return running.has(String(roomId))
}
