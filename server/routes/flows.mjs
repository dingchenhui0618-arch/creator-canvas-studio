import { sendJson, readBody, notFound } from './_shared.mjs'
import { listFlows, getFlow, createFlow, updateFlow, deleteFlow, runFlow, listRuns, getRun, NODE_KINDS, TOOLS, REVIEW_PROFILES } from '../flows.mjs'

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

export function createFlowsRouter() {
  return {
    prefix: '/api/flows',
    extraPrefixes: ['/api/runs'],
    async handle(req, res, url, pathname) {
      if (!isOwnPath(pathname)) return false

      // 节点类型与工具的元信息，前端 inspector 用它渲染下拉框
      if (pathname === '/api/flows/meta' && req.method === 'GET') {
        sendJson(res, 200, { nodeKinds: NODE_KINDS, tools: TOOLS, reviewProfiles: REVIEW_PROFILES })
        return true
      }

      if (pathname === '/api/flows' && req.method === 'GET') {
        const items = await listFlows()
        sendJson(res, 200, { items, total: items.length })
        return true
      }

      if (pathname === '/api/flows' && req.method === 'POST') {
        const body = await readBody(req)
        const flow = await createFlow(body)
        sendJson(res, 201, flow)
        return true
      }

      if (pathname === '/api/runs' && req.method === 'GET') {
        const result = await listRuns({
          flowId: url.searchParams.get('flowId') || '',
          limit: url.searchParams.get('limit') || 20,
        })
        sendJson(res, 200, result)
        return true
      }

      const runItemMatch = pathname.match(RUN_ITEM)
      if (runItemMatch && req.method === 'GET') {
        const run = await getRun(runItemMatch[1])
        if (!run) {
          notFound(res, '运行记录不存在')
          return true
        }
        sendJson(res, 200, run)
        return true
      }

      const runMatch = pathname.match(FLOW_RUN)
      if (runMatch) {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: '只支持 POST' })
          return true
        }
        const flow = await getFlow(runMatch[1])
        if (!flow) {
          notFound(res, '流程不存在')
          return true
        }
        if (!flow.nodes.length) {
          sendJson(res, 400, { error: '流程里没有节点，先拖入节点再运行' })
          return true
        }
        const body = await readBody(req)
        if (body.stream) {
          sendStreamHead(res)
          const write = (event) => {
            if (!res.writableEnded) res.write(JSON.stringify(event) + '\n')
          }
          try {
            await runFlow(flow, { onEvent: write })
          } catch (error) {
            write({ type: 'run-error', error: String(error?.message || error), code: error?.code || 'FLOW_RUN_FAILED' })
          }
          res.end()
          return true
        }
        try {
          const run = await runFlow(flow)
          sendJson(res, 200, run)
        } catch (error) {
          const status = error?.code === 'FLOW_CYCLE' ? 400 : 500
          sendJson(res, status, { error: String(error?.message || error), code: error?.code || 'FLOW_RUN_FAILED' })
        }
        return true
      }

      const itemMatch = pathname.match(FLOW_ITEM)
      if (itemMatch) {
        const id = itemMatch[1]
        if (req.method === 'GET') {
          const flow = await getFlow(id)
          if (!flow) {
            notFound(res, '流程不存在')
            return true
          }
          sendJson(res, 200, flow)
          return true
        }
        if (req.method === 'PATCH') {
          const body = await readBody(req)
          const updated = await updateFlow(id, body)
          if (!updated) {
            notFound(res, '流程不存在')
            return true
          }
          sendJson(res, 200, updated)
          return true
        }
        if (req.method === 'DELETE') {
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
