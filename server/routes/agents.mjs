import { readBody, sendJson } from './_shared.mjs'
import {
  AGENT_CATEGORIES,
  AGENT_TOOLS,
  agentStats,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  recordRun,
  updateAgent,
} from '../agents.mjs'
import { OUTPUT_TYPES, availableModels, chatWithAgent } from '../agentChat.mjs'
import { config, visionEnabled } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, refund } from '../credits.mjs'
import { enter, leave } from '../gate.mjs'
import { publicError } from '../public-error.mjs'

const PREFIX = '/api/agents'

function methodNotAllowed(res, allowed) {
  sendJson(res, 405, { error: '只支持 ' + allowed + ' 方法' })
}

function agentError(res, error) {
  const status = Number(error?.httpStatus) || Number(error?.status) || 500
  if (status >= 500) console.error('[agents] ' + (error?.stack || error?.message || error))
  const body = {
    // 生产界面只讲产品语言：模型名、上游状态和逐条尝试明细保留在内部环境与日志里
    error: publicError(error, '智能体暂时不可用，请稍后重试'),
    code: error?.code || 'AGENT_ERROR',
    suggestion: error?.suggestion || '',
  }
  if (config.ui.mode === 'internal') {
    body.model = error?.model || ''
    body.upstreamStatus = error?.upstreamStatus || null
    body.attempted = Array.isArray(error?.attempted) ? error.attempted : []
  }
  sendJson(res, status, body)
}

export function createAgentsRouter() {
  return {
    prefix: PREFIX,
    async handle(req, res, url, pathname) {
      try {
        const user = currentUser(req)
        const rest = pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
        const segments = rest ? rest.split('/') : ['']

        // 列表 / 元数据 / 新建
        if (segments.length === 1 && segments[0] === '') {
          if (req.method === 'GET') {
            const category = url.searchParams.get('category') || ''
            const items = await listAgents({ q: url.searchParams.get('q') || '', category }, user)
            const stats = await agentStats(user)
            const models = availableModels()
            sendJson(res, 200, {
              items,
              total: stats.total,
              runs: stats.runs,
              byCategory: stats.byCategory,
              categories: AGENT_CATEGORIES,
              tools: AGENT_TOOLS,
              models,
              defaultModel: models[0] || '',
              outputTypes: OUTPUT_TYPES.map((item) => ({ id: item.id, label: item.label })),
              vision: { enabled: visionEnabled() },
            })
            return true
          }
          if (req.method === 'POST') {
            const body = await readBody(req)
            const agent = await createAgent(body, user)
            sendJson(res, 201, agent)
            return true
          }
          methodNotAllowed(res, 'GET / POST')
          return true
        }

        const id = segments[0]
        const action = segments[1]

        // 对话：POST /api/agents/:id/chat
        if (segments.length === 2 && action === 'chat') {
          if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST')
            return true
          }
          const agent = await getAgent(id, user)
          if (!agent) {
            sendJson(res, 404, { error: '智能体不存在：' + id })
            return true
          }
          const body = await readBody(req)
          const message = String(body.message || '').trim()
          if (!message) {
            sendJson(res, 400, { error: '请先输入要它做的事' })
            return true
          }
          if (message.length > 4000) {
            sendJson(res, 400, { error: '消息超过 4000 字，请拆成几段再试' })
            return true
          }
          const outputType = String(body.outputType || OUTPUT_TYPES[0].id)
          if (!OUTPUT_TYPES.some((item) => item.id === outputType)) {
            sendJson(res, 400, { error: '不支持的输出类型：' + outputType + '（可选：' + OUTPUT_TYPES.map((item) => item.id).join(' / ') + '）' })
            return true
          }
          const count = Number(body.count ?? 1)
          if (count !== 1) {
            sendJson(res, 400, { error: '当前每次只生成 1 条回复，数量固定为 1' })
            return true
          }
          const requested = String(body.model || agent.model || '').trim()
          const allowed = new Set([...availableModels(), agent.model].filter(Boolean))
          if (requested && !allowed.has(requested)) {
            sendJson(res, 400, { error: '模型 ' + requested + ' 不在可用列表', models: [...allowed] })
            return true
          }
          // 对话按次扣积分：先扣后调，失败退款；同一账号默认最多 2 个对话在跑
          const limit = Number(config.credits.concurrency.chat || 0)
          if (user?.id && !enter(user.id, 'chat', limit)) {
            sendJson(res, 429, { error: '这个账号还有对话在跑，等它结束再试', code: 'CONCURRENCY_LIMIT', limit })
            return true
          }
          const paid = user?.id ? charge(user.id, 'chat', { ref: agent.name }) : { ok: true, cost: 0, balance: null }
          if (!paid.ok) {
            if (user?.id) leave(user.id, 'chat')
            sendJson(res, 402, {
              error: '积分不足：本次对话需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
              code: 'CREDIT_INSUFFICIENT',
              balance: paid.balance,
              cost: paid.cost,
              needed: paid.needed,
            })
            return true
          }
          let result
          try {
            result = await chatWithAgent({
              agent,
              message,
              outputType,
              model: requested || agent.model,
              history: Array.isArray(body.history) ? body.history : [],
              log: (line) => console.log('[agents] ' + line),
            })
          } catch (error) {
            // 模型调用失败：退积分，不让失败也扣钱
            if (user?.id && paid.cost > 0) refund(user.id, 'chat', { ref: agent.name, amount: paid.cost })
            throw error
          } finally {
            if (user?.id) leave(user.id, 'chat')
          }
          const updated = await recordRun(agent.id, { model: result.model })
          sendJson(res, 200, {
            credits: { cost: paid.cost, balance: paid.balance },
            reply: result.reply,
            model: result.model,
            latencyMs: result.latencyMs,
            usage: result.usage || null,
            attempted: result.attempted,
            memory: result.memory || { turns: 0, messages: 0 },
            outputType,
            agent: updated
              ? { id: updated.id, name: updated.name, runCount: updated.runCount, lastRunAt: updated.lastRunAt }
              : { id: agent.id, name: agent.name, runCount: (agent.runCount || 0) + 1, lastRunAt: new Date().toISOString() },
          })
          return true
        }

        // 单个智能体：GET / PATCH / DELETE
        if (segments.length === 1) {
          if (req.method === 'GET') {
            const agent = await getAgent(id, user)
            if (!agent) {
              sendJson(res, 404, { error: '智能体不存在：' + id })
              return true
            }
            sendJson(res, 200, agent)
            return true
          }
          if (req.method === 'PATCH' || req.method === 'PUT') {
            const body = await readBody(req)
            if (!(await getAgent(id, user))) {
              sendJson(res, 404, { error: '智能体不存在：' + id })
              return true
            }
            const agent = await updateAgent(id, body)
            if (!agent) {
              sendJson(res, 404, { error: '智能体不存在：' + id })
              return true
            }
            sendJson(res, 200, agent)
            return true
          }
          if (req.method === 'DELETE') {
            if (!(await getAgent(id, user))) {
              sendJson(res, 404, { error: '智能体不存在：' + id })
              return true
            }
            const done = await deleteAgent(id)
            if (!done) {
              sendJson(res, 404, { error: '智能体不存在：' + id })
              return true
            }
            sendJson(res, 200, { ok: true, id })
            return true
          }
          methodNotAllowed(res, 'GET / PATCH / DELETE')
          return true
        }

        sendJson(res, 404, { error: '未知的智能体接口：' + req.method + ' ' + pathname })
        return true
      } catch (error) {
        agentError(res, error)
        return true
      }
    },
  }
}
