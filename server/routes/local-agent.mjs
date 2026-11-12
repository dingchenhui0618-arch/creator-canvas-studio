// 本地工作区（桌面端）的模型入口。
// 桌面壳里跑的是本地 agent loop：工具调用、审批、记忆压缩都在本机；
// 这里只负责「用平台 Key 换一次补全」，这样密钥永远不进客户端安装包，
// 账号积分、限流、模型降级链也仍然只有服务端一处真源。
import { readBody, sendJson } from './_shared.mjs'
import { callTextModel, llmEnabled } from '../llm.mjs'
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, refund } from '../credits.mjs'
import { publicError } from '../public-error.mjs'
import { modelCatalog } from '../models.mjs'

const PREFIX = '/api/local-agent'
const MAX_MESSAGES = 24
const MAX_CHARS = 60000
const MAX_CONTENT = 12000

// 一轮对话 = 网关的一次「本地工作区」回合，含若干次补全（每步一次）。
// 只在该轮第一次调用时扣一次积分：桌面端每步一次补全，逐次扣费会和网页版对话的定价口径打架。
const turnCharges = new Map()

function rememberCharge(key, paid) {
  turnCharges.set(key, paid)
  if (turnCharges.size > 400) {
    for (const old of [...turnCharges.keys()].slice(0, 200)) turnCharges.delete(old)
  }
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '缺少 messages' }
  if (raw.length > MAX_MESSAGES) return { error: '对话条数超过上限（' + MAX_MESSAGES + ' 条），请新建一轮' }
  const messages = []
  let total = 0
  for (const item of raw) {
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'system' ? 'system' : 'user'
    const content = String(item?.content ?? '')
    if (!content.trim()) return { error: '有一条消息是空的' }
    if (content.length > MAX_CONTENT) return { error: '单条消息超过 ' + MAX_CONTENT + ' 字，请拆开' }
    total += content.length
    messages.push({ role, content })
  }
  if (total > MAX_CHARS) return { error: '这一轮上下文超过 ' + MAX_CHARS + ' 字，先在桌面端压缩历史再试' }
  return { messages }
}

export function createLocalAgentRouter() {
  return {
    prefix: PREFIX,
    async handle(req, res, url, pathname) {
      const user = currentUser(req)
      const rest = pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')

      if (rest === 'meta' && req.method === 'GET') {
        const catalog = modelCatalog()
        sendJson(res, 200, {
          ok: true,
          enabled: llmEnabled(),
          models: catalog.models.map((item) => item.id),
          defaultModel: catalog.models[0]?.id || config.llm.model,
          // 桌面端的循环参数也在这里给一份：界面上的「上限」不是写死的文案，是本机真正在用的值
          loop: { maxSteps: 8, maxToolOutput: 8000 },
        })
        return true
      }

      if (rest === 'complete' && req.method === 'POST') {
        if (!llmEnabled()) {
          sendJson(res, 503, { error: '服务端还没有配置模型凭证，本地工作区暂时用不了', code: 'NO_MODEL' })
          return true
        }
        const body = await readBody(req)
        const parsed = normalizeMessages(body.messages)
        if (parsed.error) {
          sendJson(res, 400, { error: parsed.error })
          return true
        }
        const turnId = String(body.turnId || '').trim()
        if (turnId.length < 6 || turnId.length > 80) {
          sendJson(res, 400, { error: '缺少 turnId：桌面端要为每一轮生成一个会话内唯一的标识' })
          return true
        }
        const maxTokens = Math.min(4000, Math.max(256, Number(body.maxTokens) || 1600))
        const key = user?.id ? user.id + ':' + turnId : 'anon:' + turnId
        const cached = turnCharges.get(key)
        const paid = cached || (user?.id ? charge(user.id, 'chat', { ref: '本地工作区' }) : { ok: true, cost: 0, balance: null })
        if (!paid.ok) {
          sendJson(res, 402, {
            error: '积分不足：本次对话需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
            code: 'CREDIT_INSUFFICIENT',
            balance: paid.balance,
            cost: paid.cost,
          })
          return true
        }
        try {
          const result = await callTextModel(parsed.messages, { maxTokens, log: (line) => console.log('[local-agent] ' + line) })
          if (user?.id && paid.cost > 0 && !cached) rememberCharge(key, paid)
          sendJson(res, 200, {
            ok: true,
            text: result.text,
            model: result.model,
            cost: paid.cost,
            balance: paid.balance,
            charged: Boolean(paid.cost > 0),
          })
        } catch (error) {
          // 这一步失败就退这一步的钱；缓存过的轮次不再重复退，避免同一次失败退两次
          if (user?.id && paid.cost > 0 && !cached) refund(user.id, 'chat', { ref: '本地工作区', amount: paid.cost })
          console.error('[local-agent] ' + (error?.stack || error?.message || error))
          sendJson(res, 502, {
            error: publicError(error, '模型这一步没有返回，稍后重试'),
            code: error?.code || 'MODEL_ERROR',
          })
        }
        return true
      }

      sendJson(res, 404, { error: 'not found' })
      return true
    },
  }
}
