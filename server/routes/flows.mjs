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
  loadRunGraph,
  newRunId,
  startFlowRun,
  markRunStarted,
  dropRunRecord,
  abandonRun,
  requestRunStop,
  resumePlanFor,
  previousRunOf,
  flowRevisionOf,
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
import { buildRunCompare, compareSideOf } from '../run-compare.mjs'

// /api/flows 与 /api/runs 共用一个 router：
// index.mjs 会按 prefix + extraPrefixes 分发，因此两个前缀都进到这里。
const FLOW_ITEM = /^\/api\/flows\/([\w-]+)$/
const FLOW_RUN = /^\/api\/flows\/([\w-]+)\/run$/
const FLOW_RESUME_PLAN = /^\/api\/flows\/([\w-]+)\/resume-plan$/
const RUN_ITEM = /^\/api\/runs\/([\w-]+)$/
const RUN_STOP = /^\/api\/runs\/([\w-]+)\/stop$/
const RUN_COMPARE = /^\/api\/runs\/([\w-]+)\/compare$/

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
  // 续跑只补「上次没付的那部分」：amount 由调用方按上次结算算好，普通运行仍走单价。
  const paid = charge(user.id, 'flow_run', {
    ref,
    ...(options.amount === undefined ? {} : { amount: options.amount }),
    meta: label ? { label } : null,
  })
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

      // 停止一条已经开跑的运行（v0.9.101）：排队阶段仍走「关连接退队」，这里只认 running。
      // 停止不是「立刻把记录改成失败」——先中止当前上游，让 runFlow 自己写完终态与结算，
      // 否则记录会先被写死、正在跑的节点返回后又把它覆盖掉。
      const runStopMatch = pathname.match(RUN_STOP)
      if (runStopMatch) {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: '只支持 POST' })
          return true
        }
        const run = await getRun(runStopMatch[1], user)
        if (!run) {
          notFound(res, '运行记录不存在')
          return true
        }
        if (run.ownerId && user?.id && run.ownerId !== user.id) {
          sendJson(res, 403, { error: '这条运行不属于当前账号' })
          return true
        }
        if (run.status !== 'running') {
          sendJson(res, 409, {
            ok: false,
            code: 'RUN_NOT_ACTIVE',
            error: run.status === 'queued' ? '这条运行还在排队：关掉这次请求就会退出排队，不会扣积分' : '这条运行已经结束',
          })
          return true
        }
        const stopped = requestRunStop(run.id, { reason: 'user' })
        if (!stopped.ok) {
          sendJson(res, 409, { ok: false, code: stopped.code, error: stopped.message })
          return true
        }
        sendJson(res, 200, { ok: true, id: run.id, status: 'stopping' })
        return true
      }

      // 运行对照（v0.9.110）：只读，不重跑、不扣费。默认找同一条画布更早的那一条；
      // 页面也可以点名 with=<runId>。两条必须同属一张画布，跨版画布不逐节点对照。
      const runCompareMatch = pathname.match(RUN_COMPARE)
      if (runCompareMatch) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: '只支持 GET' })
          return true
        }
        const run = await getRun(runCompareMatch[1], user)
        if (!run) {
          notFound(res, '运行记录不存在')
          return true
        }
        const withId = String(url.searchParams.get('with') || '').trim()
        let previous = null
        if (withId) {
          if (withId === run.id) {
            sendJson(res, 400, { error: '不能拿这条运行和它自己对照' })
            return true
          }
          previous = await getRun(withId, user)
          if (!previous) {
            notFound(res, '要对照的那条运行不存在')
            return true
          }
          if (previous.flowId !== run.flowId) {
            sendJson(res, 400, { error: '这两条运行不在同一张画布上（可能已经分版），不能逐节点对照' })
            return true
          }
          if (previous.status === 'running' || previous.status === 'queued') {
            sendJson(res, 409, { error: '要对照的那条运行还没跑完，等它结束再看' })
            return true
          }
        } else {
          previous = await previousRunOf(run, user)
        }
        if (!previous) {
          sendJson(res, 200, {
            ok: true,
            comparable: false,
            reason: '这是这张画布上最早的一条运行；再跑一次之后，这里会逐节点对照两次的结果。',
            current: compareSideOf(run),
          })
          return true
        }
        sendJson(res, 200, { ok: true, ...buildRunCompare(run, previous) })
        return true
      }

      const runItemMatch = pathname.match(RUN_ITEM)
      if (runItemMatch && req.method === 'GET') {
        const run = await getRun(runItemMatch[1], user)
        if (!run) {
          notFound(res, '运行记录不存在')
          return true
        }
        // 单条运行与列表同一口径：都带 project，页面不用两处判断。
        // 画布快照只在详情里带：列表一次 20 条，不把几十张节点的配置一起传下去。
        const projects = await listProjects(user)
        const graph = await loadRunGraph(run.id)
        sendJson(res, 200, {
          ...withRunProject([run], projectsByFlow(projects))[0],
          ...(graph ? { graph } : {}),
        })
        return true
      }

      // 续跑预检（v0.9.103）：只读，不扣费、不写记录。页面在抽屉里先问「改过画布后
      // 还有几个旧节点能复用、这次要补几个、补多少积分」，别拿旧记录的总数糊弄用户。
      const resumePlanMatch = pathname.match(FLOW_RESUME_PLAN)
      if (resumePlanMatch) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: '只支持 GET' })
          return true
        }
        const flow = await getFlow(resumePlanMatch[1], user)
        if (!flow) {
          notFound(res, '流程不存在')
          return true
        }
        const runId = String(url.searchParams.get('runId') || '')
        if (!runId) {
          sendJson(res, 400, { error: '缺少 runId：要问的是哪条运行' })
          return true
        }
        const source = await getRun(runId, user)
        if (!source) {
          notFound(res, '要接着跑的那条运行不存在')
          return true
        }
        if (source.flowId !== flow.id) {
          sendJson(res, 400, { error: '这条运行不是当前画布的，不能接着跑' })
          return true
        }
        try {
          const plan = resumePlanFor(source, flow, Number(config.credits.prices.flow_run) || 0)
          const { seed, ...body } = plan
          void seed
          sendJson(res, 200, { ok: true, ...body })
        } catch (error) {
          sendJson(res, error?.code === 'FLOW_CYCLE' ? 400 : 500, {
            error: publicError(error, '暂时算不出这次能复用几个节点'),
            code: error?.code || 'RESUME_PLAN_FAILED',
          })
        }
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
        const price = Number(config.credits.prices.flow_run) || 0
        // 续跑（v0.9.103）：按节点内容指纹逐个核对，只复用内容没变的旧结果；
        // 改过的节点和它的下游会重跑，没改的上游不再重复调上游、也不再重复收费。
        // 画布整体改过不再一刀切拒绝——拒绝的理由必须具体到「一个能复用的都没有」。
        let resume = null
        let resumeCost = null
        const resumeOf = String(body?.resumeOf || '')
        if (resumeOf) {
          const source = await getRun(resumeOf, user)
          if (!source) {
            notFound(res, '要接着跑的那条运行不存在')
            return true
          }
          if (source.flowId !== flow.id) {
            sendJson(res, 400, { error: '这条运行不是当前画布的，不能接着跑' })
            return true
          }
          let plan = null
          try {
            plan = resumePlanFor(source, flow, price)
          } catch (error) {
            sendJson(res, error?.code === 'FLOW_CYCLE' ? 400 : 500, {
              error: publicError(error, '暂时算不出这次能复用几个节点'),
              code: error?.code || 'RESUME_PLAN_FAILED',
            })
            return true
          }
          if (!plan.resumable) {
            sendJson(res, 409, {
              error: plan.reason,
              code: 'NOT_RESUMABLE',
              reused: plan.reused,
              rerun: plan.rerun,
            })
            return true
          }
          resume = { ...plan.seed, of: source.id }
          resumeCost = plan.cost
        }
        // 运行 id 先定、记录先落盘、再扣费：扣完立刻断电也留得下这条单，重启时按账本退。
        const runId = newRunId()
        // 有账号才会真的去排整机那条队：先落成「排队中」，排到、扣完费再翻「运行中」
        await startFlowRun(flow, runId, {
          cost: resume ? resumeCost : (user?.id ? price : 0),
          queued: Boolean(user?.id),
          resumeOf: resume?.of || '',
          reusedNodes: resume?.reusedCount || 0,
          billTotal: resume ? flow.nodes.length - resume.reusedCount : flow.nodes.length,
          flowRevision: flowRevisionOf(flow),
        })
        const paid = await beginRunCharge(res, user, runId, flow.name, {
          ticket: String(req.headers['x-vq-queue-ticket'] || ''),
          amount: resume ? resumeCost : undefined,
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
            // 页面被关掉 / 连接被 abort：停止这条运行，不要让它继续烧上游。
            // 只认「响应没写完就 close」——正常 runFlow 结束后 res.end() 也会触发 close。
            try {
              res.on('close', () => {
                if (!res.writableEnded) requestRunStop(runId, { reason: 'disconnect' })
              })
            } catch { /* 测试里的假响应没有 on */ }
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
              await runFlow(flow, { onEvent: write, credits: creditNote, runId, resume })
            } catch (error) {
              await abandonRun(runId, publicError(error, '运行失败，请稍后重试'))
              write({ type: 'run-error', error: publicError(error, '运行失败，请稍后重试'), code: error?.code || 'FLOW_RUN_FAILED' })
            }
            res.end()
            return true
          }
          const run = await runFlow(flow, { credits: creditNote, runId, resume })
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