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
import { draftToScript, normalizeDraft } from '../agent-draft.mjs'
import { writeDraftToProject } from '../agent-project.mjs'
import { createTemplateFromDraft } from '../templates.mjs'
import { createFlow } from '../flows.mjs'
import { buildReplicateDraft } from '../script-draft.mjs'
import { clearAgentRuns, listAgentRuns, recordAgentRun } from '../agent-history.mjs'
import { config, visionEnabled } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, refund } from '../credits.mjs'
import { enter, leave } from '../gate.mjs'
import { publicError } from '../public-error.mjs'
import { preferenceModel } from '../preferences.mjs'
import { modelCatalog } from '../models.mjs'
import { modelServiceState, noteModelFailure, noteModelSuccess } from '../service-state.mjs'

const PREFIX = '/api/agents'

function methodNotAllowed(res, allowed) {
  sendJson(res, 405, { error: '只支持 ' + allowed + ' 方法' })
}

function agentError(res, error) {
  const status = Number(error?.httpStatus) || Number(error?.status) || 500
  if (status >= 500) console.error('[agents] ' + (error?.stack || error?.message || error))
  const body = {
    // 生产界面只讲产品语言：模型名、上游状态、建议原文和逐条尝试明细都留在内部环境与日志里。
    // 建议原文里会出现 .env、VISION_*、127.0.0.1、模型名，生产环境不能返回，否则界面「建议」一行会直接把它显示出来。
    error: publicError(error, '智能体暂时不可用，请稍后重试'),
    code: error?.code || 'AGENT_ERROR',
  }
  if (config.ui.mode === 'internal') {
    body.suggestion = error?.suggestion || ''
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
          const conversationId = String(body.conversationId || '').slice(0, 80)
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
          // 请求显式指定 > 账号级首选模型（顶栏切换）> 智能体绑定的模型
          // 顶栏是工作区的全局默认；每次对话里的模型胶囊仍可单独覆盖
          const requested = String(body.model || preferenceModel(user?.id) || agent.model || '').trim()
          // 顶栏清单里的模型都允许传：视觉专用模型不在文本链里时，llm.mjs 会按既有降级链继续，不会 400
          const allowed = new Set([...availableModels(), agent.model, ...modelCatalog().models.map((item) => item.id)].filter(Boolean))
          if (requested && !allowed.has(requested)) {
            sendJson(res, 400, { error: '模型 ' + requested + ' 不在可用列表', models: [...allowed] })
            return true
          }
          // 已知模型服务不可用（额度不足 / 凭证失效）：直接说明，不先扣再退。
          // 这类故障换候选模型也没用，省掉一次注定失败的调用与一笔退款流水。
          const provider = modelServiceState()
          if (!provider.available) {
            sendJson(res, 503, {
              error: provider.message,
              code: 'MODEL_UNAVAILABLE',
              retryAfterSec: provider.retryAfterSec,
              ...(config.ui.mode === 'internal' ? { detail: provider.internalDetail, upstream: provider.upstreamMessage } : {}),
            })
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
          const startedAt = Date.now()
          try {
            result = await chatWithAgent({
              agent,
              message,
              outputType,
              model: requested || agent.model,
              history: Array.isArray(body.history) ? body.history : [],
              user,
              log: (line) => console.log('[agents] ' + line),
            })
            // 成功即恢复：管理员充值或换 key 后不需要重启，下一次调用成功就清掉状态
            noteModelSuccess()
          } catch (error) {
            // 额度 / 凭证这类账号级故障记下来：健康检查与下一次对话都按「不可用」处理
            noteModelFailure(error, requested || agent.model)
            // 模型调用失败：退积分，不让失败也扣钱；失败也留一条运行记录，界面能看到原因与退款
            if (user?.id && paid.cost > 0) refund(user.id, 'chat', { ref: agent.name, amount: paid.cost })
            try {
              await recordAgentRun({
                agent,
                user,
                status: 'error',
                message,
                outputType,
                conversationId,
                latencyMs: Date.now() - startedAt,
                error: publicError(error, '智能体暂时不可用，请稍后重试'),
                credits: { cost: paid.cost, balance: paid.balance, refunded: paid.cost > 0 },
                tools: error.tools || null,
              })
            } catch {
              // 历史写入失败不影响把上游错误返回给界面
            }
            throw error
          } finally {
            if (user?.id) leave(user.id, 'chat')
          }
          const updated = await recordRun(agent.id, { model: result.model })
          let run = null
          try {
            run = await recordAgentRun({
              agent,
              user,
              status: 'success',
              message,
              reply: result.reply,
              model: result.model,
              outputType,
              latencyMs: result.latencyMs,
              credits: { cost: paid.cost, balance: paid.balance, refunded: false },
              tools: result.tools,
              conversationId,
            })
          } catch (error) {
            // 历史落库失败不该把已经成功的回复变成 500，日志里留痕即可
            console.error('[agents] 运行历史写入失败：' + (error?.message || error))
          }
          sendJson(res, 200, {
            credits: { cost: paid.cost, balance: paid.balance },
            reply: result.reply,
            model: result.model,
            latencyMs: result.latencyMs,
            usage: result.usage || null,
            attempted: result.attempted,
            tools: result.tools || { used: [], artifacts: [], skipped: [] },
            // 结构化草稿：正文之外的机器可读版本，界面据此给出「存为模板 / 送到画布」两个出口
            draft: result.draft || null,
            run: run ? { id: run.id, createdAt: run.createdAt, credits: run.credits } : null,
            memory: result.memory || { turns: 0, messages: 0 },
            outputType,
            agent: updated
              ? { id: updated.id, name: updated.name, runCount: updated.runCount, lastRunAt: updated.lastRunAt }
              : { id: agent.id, name: agent.name, runCount: (agent.runCount || 0) + 1, lastRunAt: new Date().toISOString() },
          })
          return true
        }

        // 结构化草稿的三个出口：存为模板 / 送到画布 / 写进作品。
        // 草稿由服务端重新整理一遍（不信任客户端回传的形状），三个出口都不扣积分：
        // 这里没有模型调用，只是在用户点下去之后把「可以继续用的东西」真的落库。
        if (
          segments.length === 3 &&
          action === 'draft' &&
          (segments[2] === 'template' || segments[2] === 'canvas' || segments[2] === 'project')
        ) {
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
          const draft = normalizeDraft(body.draft)
          if (!draft) {
            sendJson(res, 400, { error: '这份结果里没有脚本段落或分镜，没法继续用', code: 'DRAFT_EMPTY' })
            return true
          }
          if (segments[2] === 'project') {
            // 写进作品：只写脚本（钩子 + 段落），分镜留在草稿里——要镜头就走「送到画布」。
            const result = await writeDraftToProject({ draft, projectId: body.projectId, user })
            sendJson(res, result.status, result.body)
            return true
          }
          if (segments[2] === 'template') {
            const template = await createTemplateFromDraft({ draft, agent, user })
            if (!template) {
              sendJson(res, 400, { error: '草稿为空，没有可保存的段落', code: 'DRAFT_EMPTY' })
              return true
            }
            sendJson(res, 201, {
              template: {
                id: template.id,
                title: template.title,
                contentType: template.contentType,
                platformLabel: template.platformLabel,
                beats: template.structure.length,
                shots: template.storyboard.length,
                durationSec: template.durationSec,
              },
            })
            return true
          }
          const description = '来自智能体 ' + agent.name + ' · ' + draft.stats.beats + ' 段 / ' + draft.stats.shots + ' 镜'
          const flow = await createFlow(
            buildReplicateDraft({ script: draftToScript(draft), name: draft.title, description }),
            user,
          )
          sendJson(res, 201, { flow: { id: flow.id, name: flow.name, nodes: flow.nodes.length } })
          return true
        }

        // 运行历史：GET 分页读取；DELETE 清空这个智能体的历史
        if (segments.length === 2 && action === 'history') {
          const agent = await getAgent(id, user)
          if (!agent) {
            sendJson(res, 404, { error: '智能体不存在：' + id })
            return true
          }
          if (req.method === 'GET') {
            const history = await listAgentRuns(id, {
              limit: url.searchParams.get('limit') || 20,
              offset: url.searchParams.get('offset') || 0,
            })
            sendJson(res, 200, {
              ...history,
              agent: {
                id: agent.id,
                name: agent.name,
                runCount: agent.runCount || 0,
                lastRunAt: agent.lastRunAt || null,
                lastModel: agent.lastModel || '',
              },
            })
            return true
          }
          if (req.method === 'DELETE') {
            const removed = await clearAgentRuns(id)
            sendJson(res, 200, { ok: true, removed })
            return true
          }
          methodNotAllowed(res, 'GET / DELETE')
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
