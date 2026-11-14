import { sendJson, readBody, notFound } from './_shared.mjs'
import {
  listFlows,
  getFlow,
  createFlow,
  updateFlow,
  deleteFlow,
  runFlow,
  listRuns,
  getRun,
  newRunId,
  startFlowRun,
  markRunStarted,
  dropRunRecord,
  abandonRun,
  NODE_KINDS,
  TOOLS,
  REVIEW_PROFILES,
} from '../flows.mjs'
import { currentUser } from '../auth.mjs'
import { config } from '../config.mjs'
import { listProjects } from '../projects.mjs'
import { projectsByFlow, projectFlowsMatching, withRunProject, withFlowProject } from '../run-ownership.mjs'
import { charge, balanceOf } from '../credits.mjs'
import { quotaRefusal } from '../quota.mjs'
import { enter, leave } from '../gate.mjs'
import { admitWaiting, capacityFor, queueView, watchClientGone } from '../waterline.mjs'
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

// 画布整条流程按次扣积分：先扣后跑，跑挂了 / 被重启打断全额退回，和检索/复刻/评审同一套账。
// 扣费单据 ref = 运行 id（不是画布名）：账本、运行记录、恢复退款三处说同一件事。
// 未登录（本地演示）时 charge 返回匿名结果，不扣费也不限流。
// v0.9.96：名额满时先进整机的排队位（默认 60 秒 / 4 条），排到才占名额、才扣费；排队期间不花钱、不跑流程。
async function beginRunCharge(res, user, ref, label = '', options = {}) {
  if (!user?.id) return { cost: 0, balance: null, queue: null, release: () => {} }
  // 画布运行要下载并分析多张图，是这里最重的一条：内存到红线就不接（不扣积分、不调上游）。
  const water = await admitWaiting('flow_run', {
    ticket: options.ticket,
    // 只认响应侧：请求体已经读完，req.destroyed 现在是 true（见 waterline.watchClientGone）
    isAborted: watchClientGone(res),
  })
  if (!water.ok) {
    // 客户端已经断开：不写响应、不占名额、不扣积分（票在 admitWaiting 的 finally 里退掉了）
    if (water.aborted) {
      try { res.destroy?.() } catch { /* 已经断了 */ }
      return null
    }
    sendJson(res, water.status, water.body)
    return null
  }
  // 排到了：名次与等了多久一起带出去——脚本看响应头，运行抽屉看流里的第一条事件
  const queued = water.position ? { position: water.position, waitedMs: water.waitedMs } : null
  if (queued) {
    res.setHeader('X-VQ-Queue-Position', String(queued.position))
    res.setHeader('X-VQ-Queue-Waited-Ms', String(queued.waitedMs))
  }
  // 名额是 admitWaiting 占的（v0.9.78：跨进程租约），扣费失败这条路径要先还回去
  const releaseAdmission = () => { try { water.lease.release() } catch { /* 还名额不该影响响应 */ } }
  const max = capacityFor('flow_run', Number(config.credits.concurrency.flow_run || 0), water.level)
  if (max && !enter(user.id, 'flow_run', max)) {
    releaseAdmission()
    sendJson(res, 429, {
      error: '这个账号还有一条流程在跑，等它结束再试',
      code: 'CONCURRENCY_LIMIT',
      limit: max,
    })
    return null
  }
  const paid = charge(user.id, 'flow_run', { ref, meta: label ? { label } : null })
  if (!paid.ok) {
    releaseAdmission()
    leave(user.id, 'flow_run')
    if (paid.code === 'MONTHLY_QUOTA') {
      const refusal = quotaRefusal(paid)
      sendJson(res, refusal.status, refusal.body)
      return null
    }
    sendJson(res, 402, {
      error: '积分不足：本次需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
      code: 'CREDIT_INSUFFICIENT',
      balance: paid.balance,
      cost: paid.cost,
      needed: paid.needed,
    })
    return null
  }
  return {
    cost: paid.cost,
    balance: paid.balance,
    // 排过队才有这一项：运行抽屉据此在结论里写「排队 N 秒后开始」
    queue: queued,
    release: () => { leave(user.id, 'flow_run'); releaseAdmission() },
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

      // 画布也挂上它属于哪条作品的第几版：画布页据此写「在帮《X》· 第 N 版」并给入口。
      // 与运行记录同一张索引（projectsByFlow）、同一个 ref，三处说同一件事。
      const projectOf = async (items) => {
        const byFlow = projectsByFlow(await listProjects(user))
        return withFlowProject(items, byFlow)
      }

      if (pathname === '/api/flows' && req.method === 'GET') {
        const items = await projectOf(await listFlows(user))
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      if (pathname === '/api/flows' && req.method === 'POST') {
        const body = await readBody(req)
        const flow = await createFlow(body, user)
        // 新建的流程还没归任何作品：带上 project: null，前端不必区分「没有这个字段」和「没归谁」
        sendJson(res, 201, { ...flow, project: null })
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

      // 排队位这一刻的样子（v0.9.96）：页面在等的时候拿票号问「我第几、等了多久」。
      // 只读；票号是凭据、只进不出，聚合数仍是整机口径（与画布出图 / 评审同一条队、同一份实现）。
      if (pathname === '/api/runs/queue' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...queueView('flow_run', url.searchParams.get('ticket') || '') })
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
        // 运行 id 先定、记录先落盘、再扣费：扣完立刻断电也留得下这条单，重启时按账本退。
        const runId = newRunId()
        // 有账号才会真的去排整机那条队：先落成「排队中」，排到、扣完费再翻「运行中」
        await startFlowRun(flow, runId, {
          cost: user?.id ? Number(config.credits.prices.flow_run) || 0 : 0,
          queued: Boolean(user?.id),
        })
        const paid = await beginRunCharge(res, user, runId, flow.name, {
          ticket: String(req.headers['x-vq-queue-ticket'] || ''),
        })
        if (!paid) {
          // 并发闸门 / 积分不足：钱没扣、运行也不会发生，占位记录撤掉
          await dropRunRecord(runId)
          return true
        }
        const creditNote = paid.cost > 0 ? { cost: paid.cost } : null
        // 钱已经扣了：记录必须马上从「排队中」翻过来，否则进程此刻被杀，启动恢复会把它当没花钱的单撤掉
        await markRunStarted(runId)
        try {
          if (body.stream) {
            sendStreamHead(res)
            // 排过队就先推一条「我从第几位等到开跑」：页面不用再自己算，运行结论也说得清
            if (paid.queue) {
              res.write(JSON.stringify({ type: 'run-queue', position: paid.queue.position, waitedMs: paid.queue.waitedMs }) + '\n')
            }
            const write = (event) => {
              if (res.writableEnded) return
              // 结束时把余额和退款结论一起推给前端，运行抽屉不用再额外请求
              if (event.type === 'run-end') {
                const withCredits = event.run?.credits
                  ? { ...event.run, credits: { ...event.run.credits, balance: balanceOf(user?.id) } }
                  : event.run
                res.write(JSON.stringify({ ...event, run: withCredits }) + '\n')
                return
              }
              res.write(JSON.stringify(event) + '\n')
            }
            try {
              // 失败 / 中断的退款在 runFlow 收尾时按账本退一次，这里不再重复退
              await runFlow(flow, { onEvent: write, credits: creditNote, runId })
            } catch (error) {
              await abandonRun(runId, publicError(error, '运行失败，请稍后重试'))
              write({ type: 'run-error', error: publicError(error, '运行失败，请稍后重试'), code: error?.code || 'FLOW_RUN_FAILED' })
            }
            res.end()
            return true
          }
          const run = await runFlow(flow, { credits: creditNote, runId })
          sendJson(res, 200, {
            ...run,
            credits: run.credits ? { ...run.credits, balance: balanceOf(user?.id) } : null,
            ...(paid.queue ? { queue: paid.queue } : {}),
          })
        } catch (error) {
          // 抛到这里说明运行没跑起来（例如有环）：记录标失败、按账本退钱
          await abandonRun(runId, publicError(error, '运行失败，请稍后重试'))
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
          sendJson(res, 200, (await projectOf([flow]))[0])
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
          // 保存回来的画布同样带着作品：前端把这条替换进列表时不会把「在帮哪条作品」丢掉
          sendJson(res, 200, (await projectOf([updated]))[0])
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