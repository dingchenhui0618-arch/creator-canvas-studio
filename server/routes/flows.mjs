import { sendJson, readBody, notFound } from './_shared.mjs'
import { listFlows, getFlow, createFlow, updateFlow, deleteFlow, runFlow, listRuns, getRun, NODE_KINDS, TOOLS, REVIEW_PROFILES } from '../flows.mjs'
import { currentUser } from '../auth.mjs'
import { config } from '../config.mjs'
import { listProjects } from '../projects.mjs'
import { projectsByFlow, projectFlowsMatching, withRunProject } from '../run-ownership.mjs'
import { charge, refund, balanceOf } from '../credits.mjs'
import { enter, leave } from '../gate.mjs'
import { publicError } from '../public-error.mjs'

// /api/flows 与 /api/runs 共用一个 router：
// index.mjs 会按 prefix + extraPrefixes 分发，因此两个前缀都进到这里。
const FLOW_ITEM = /^\/api\/flows\/([\w-]+)$/
const FLOW_RUN = /^\/api\/flows\/([\w-]+)\/run$/
const RUN_ITEM = /^\/api\/runs\/([\w-]+)$/

function isOwnPath(pathname) {
  return (
    pathname === '/api/flows' ||
    pathname.startsWith('/api/flows/') ||
    pathname === '/api/runs' ||
    pathname.startsWith('/api/runs/')
  )
}

function sendStreamHead(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  })
}

// 画布整条流程按次扣积分：先扣后跑，跑挂了全额退回，和检索/复刻/评审同一套账。
// 未登录（本地演示）时 charge 返回匿名结果，不扣费也不限流。
function beginRunCharge(res, user, ref) {
  if (!user?.id) return { cost: 0, balance: null, refund: () => {}, release: () => {} }
  const max = Number(config.credits.concurrency.flow_run || 0)
  if (max && !enter(user.id, 'flow_run', max)) {
    sendJson(res, 429, {
      error: '这个账号还有一条流程在跑，等它结束再试',
      code: 'CONCURRENCY_LIMIT',
      limit: max,
    })
    return null
  }
  const paid = charge(user.id, 'flow_run', { ref })
  if (!paid.ok) {
    leave(user.id, 'flow_run')
    sendJson(res, 402, {
      error: '积分不足：本次需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
      code: 'CREDIT_INSUFFICIENT',
      balance: paid.balance,
      cost: paid.cost,
      needed: paid.needed,
    })
    return null
  }
  let refunded = false
  return {
    cost: paid.cost,
    balance: paid.balance,
    refund: () => {
      if (refunded || paid.cost <= 0) return
      refunded = true
      refund(user.id, 'flow_run', { ref, amount: paid.cost })
    },
    release: () => leave(user.id, 'flow_run'),
  }
}

export function createFlowsRouter() {
  return {
    prefix: '/api/flows',
    extraPrefixes: ['/api/runs'],
    async handle(req, res, url, pathname) {
      if (!isOwnPath(pathname)) return false
      const user = currentUser(req)

      // 节点类型与工具的元信息，前端 inspector 用它渲染下拉框
      if (pathname === '/api/flows/meta' && req.method === 'GET') {
        sendJson(res, 200, { nodeKinds: NODE_KINDS, tools: TOOLS, reviewProfiles: REVIEW_PROFILES })
        return true
      }

      if (pathname === '/api/flows' && req.method === 'GET') {
        const items = await listFlows(user)
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      if (pathname === '/api/flows' && req.method === 'POST') {
        const body = await readBody(req)
        const flow = await createFlow(body, user)
        sendJson(res, 201, flow)
        return true
      }

      if (pathname === '/api/runs' && req.method === 'GET') {
        // 每条运行顺手挂上「是哪条作品的第几版」：运行自己只记 flowId，作品那侧记着画布指针。
        // 关键词同时按作品名找：运行里的画布名可以改（也可能是「画布 3」），作品名才是人认得的。
        const projects = await listProjects(user)
        const keyword = url.searchParams.get('q') || ''
        const result = await listRuns({
          flowId: url.searchParams.get('flowId') || '',
          status: url.searchParams.get('status') || '',
          q: keyword,
          flowIds: projectFlowsMatching(projects, keyword),
          ownerId: url.searchParams.get('ownerId') || '',
          limit: url.searchParams.get('limit') || 20,
          offset: url.searchParams.get('offset') || 0,
        }, user)
        sendJson(res, 200, { ...result, items: withRunProject(result.items, projectsByFlow(projects)) })
        return true
      }

      const runItemMatch = pathname.match(RUN_ITEM)
      if (runItemMatch && req.method === 'GET') {
        const run = await getRun(runItemMatch[1], user)
        if (!run) {
          notFound(res, '运行记录不存在')
          return true
        }
        // 单条运行与列表同一口径：都带 project，页面不用两处判断
        const projects = await listProjects(user)
        sendJson(res, 200, withRunProject([run], projectsByFlow(projects))[0])
        return true
      }

      const runMatch = pathname.match(FLOW_RUN)
      if (runMatch) {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: '只支持 POST' })
          return true
        }
        const flow = await getFlow(runMatch[1], user)
        if (!flow) {
          notFound(res, '流程不存在')
          return true
        }
        if (!flow.nodes.length) {
          sendJson(res, 400, { error: '流程里没有节点，先拖入节点再运行' })
          return true
        }
        const body = await readBody(req)
        const paid = beginRunCharge(res, user, flow.name)
        if (!paid) return true
        const creditNote = paid.cost > 0 ? { cost: paid.cost } : null
        try {
          if (body.stream) {
            sendStreamHead(res)
            const write = (event) => {
              if (res.writableEnded) return
              // 结束时把余额和退款结论一起推给前端，运行抽屉不用再额外请求
              if (event.type === 'run-end') {
                if (event.run?.status === 'error') paid.refund()
                const withCredits = event.run?.credits
                  ? { ...event.run, credits: { ...event.run.credits, balance: balanceOf(user?.id) } }
                  : event.run
                res.write(JSON.stringify({ ...event, run: withCredits }) + '\n')
                return
              }
              res.write(JSON.stringify(event) + '\n')
            }
            try {
              const record = await runFlow(flow, { onEvent: write, credits: creditNote })
              if (record.status === 'error') paid.refund()
            } catch (error) {
              paid.refund()
              write({ type: 'run-error', error: publicError(error, '运行失败，请稍后重试'), code: error?.code || 'FLOW_RUN_FAILED' })
            }
            res.end()
            return true
          }
          const run = await runFlow(flow, { credits: creditNote })
          if (run.status === 'error') paid.refund()
          sendJson(res, 200, {
            ...run,
            credits: run.credits ? { ...run.credits, balance: balanceOf(user?.id) } : null,
          })
        } catch (error) {
          // 抛到这里说明连运行记录都没建起来（例如有环），不收费
          paid.refund()
          const status = error?.code === 'FLOW_CYCLE' ? 400 : 500
          sendJson(res, status, { error: publicError(error, '运行失败，请稍后重试'), code: error?.code || 'FLOW_RUN_FAILED' })
        } finally {
          paid.release()
        }
        return true
      }

      const itemMatch = pathname.match(FLOW_ITEM)
      if (itemMatch) {
        const id = itemMatch[1]
        if (req.method === 'GET') {
          const flow = await getFlow(id, user)
          if (!flow) {
            notFound(res, '流程不存在')
            return true
          }
          sendJson(res, 200, flow)
          return true
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req)
          if (!(await getFlow(id, user))) {
            notFound(res, '流程不存在')
            return true
          }
          const updated = await updateFlow(id, body)
          if (!updated) {
            notFound(res, '流程不存在')
            return true
          }
          sendJson(res, 200, updated)
          return true
        }
        if (req.method === 'DELETE') {
          if (!(await getFlow(id, user))) {
            notFound(res, '流程不存在')
            return true
          }
          const removed = await deleteFlow(id)
          sendJson(res, removed ? 200 : 404, { ok: removed })
          return true
        }
        res.setHeader('Allow', 'GET,PATCH,DELETE')
        sendJson(res, 405, { error: '不支持的方法' })
        return true
      }

      if (pathname === '/api/flows') {
        res.setHeader('Allow', 'GET,POST')
        sendJson(res, 405, { error: '不支持的方法' })
        return true
      }
      notFound(res, '未知的画布接口')
      return true
    },
  }
}
