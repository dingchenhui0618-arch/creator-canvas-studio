// 快捷创作对话（r214）：会话 CRUD + 一次发送。契约见 docs/quick-create-deepseek-2026-11-18.md。
import { readBody, sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { createConversation, deleteConversation, getConversation, listConversations } from '../chat-store.mjs'
import { sendChatMessage, streamChatMessage } from '../chat.mjs'
import { CHAT_FILE_LIMITS, deleteChatFile, listChatFiles, publicChatFile, readChatFile, readChatFileBytes, saveChatFile } from '../chat-files.mjs'
import { readBinaryBody } from '../body-reader.mjs'
import { publicError, refusalResponse } from '../public-error.mjs'
import { searchView } from '../web-search.mjs'

// 会话 / 消息 / 流式三条路径：最后一段 stream 是可选的（r217）
const CONV = /^\/api\/chat\/conversations\/([A-Za-z0-9_-]{6,40})(\/messages(\/stream)?)?$/
// 附件：/api/chat/files 上传（原始字节）、列表；/:id 读取与删除（r218）；/:id/raw 取原图（r245）
const FILE_ONE = /^\/api\/chat\/files\/([A-Za-z0-9_]{6,40})$/
const FILE_RAW = /^\/api\/chat\/files\/([A-Za-z0-9_]{6,40})\/raw$/

function sendRefusal(res, error) {
  const mapped = refusalResponse(error)
  if (!mapped) return false
  sendJson(res, mapped.status, { ok: false, ...mapped.body })
  return true
}

// SSE：每个事件都是 data: <JSON>，前端按行拆。正文里有换行，所以不能裸写文本。
function sseWrite(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n')
  } catch {
    /* 客户端已经断开：写失败不用管，后面 await 会收到 abort */
  }
}

export function createChatRouter() {
  return {
    prefix: '/api/chat',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/chat')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { ok: false, code: 'LOGIN_REQUIRED', error: '请先登录' })
        return true
      }

      // 搜索服务通没通（r246）：界面据此决定「联网搜索」开关能不能点，以及点了会怎样。
      // 只回「有没有」，Key 一律不出现在这个响应里。
      if (pathname === '/api/chat/search' && req.method === 'GET') {
        const view = await searchView()
        sendJson(res, 200, {
          ok: true,
          configured: view.configured,
          providerLabel: view.providerLabel,
          note: view.configured ? '' : '平台还没接入搜索服务：想让我看具体网页，把链接发来（记得打开「读链接」）',
        })
        return true
      }

      // ── 附件（r218） ─────────────────────────────────────────────────────
      if (pathname === '/api/chat/files') {
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, items: listChatFiles(user.id), limits: CHAT_FILE_LIMITS })
          return true
        }
        if (req.method === 'POST') {
          // 文件名走 header（百分号编码）：原始字节上传不解析 multipart，附件名只能借 header 带进来
          let name = ''
          try {
            name = decodeURIComponent(String(req.headers['x-file-name'] || ''))
          } catch {
            name = ''
          }
          try {
            const buffer = await readBinaryBody(req, { maxBytes: CHAT_FILE_LIMITS.bytes })
            const file = saveChatFile({ userId: user.id, buffer, name })
            sendJson(res, 200, { ok: true, file })
            return true
          } catch (error) {
            if (sendRefusal(res, error)) return true
            throw error
          }
        }
        sendJson(res, 405, { ok: false, code: 'CHAT_METHOD', error: '这个接口不支持 ' + req.method })
        return true
      }

      // 原图（r245）：缩略图与「我发的是哪一张」都靠它。只给归属账号，只发 image/*，
      // 并带 nosniff——这里绝不允许被当成 html 渲染。
      const rawMatched = pathname.match(FILE_RAW)
      if (rawMatched) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, code: 'CHAT_METHOD', error: '这个接口不支持 ' + req.method })
          return true
        }
        const raw = readChatFileBytes(user.id, rawMatched[1])
        if (!raw) {
          sendJson(res, 404, { ok: false, code: 'FILE_NOT_FOUND', error: '这张图已经不在了' })
          return true
        }
        res.writeHead(200, {
          'Content-Type': raw.mime,
          'Content-Length': raw.buffer.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(raw.buffer)
        return true
      }

      const fileMatched = pathname.match(FILE_ONE)
      if (fileMatched) {
        const fileId = fileMatched[1]
        if (req.method === 'GET') {
          const meta = readChatFile(user.id, fileId)
          if (!meta) {
            sendJson(res, 404, { ok: false, code: 'FILE_NOT_FOUND', error: '这个附件已经不在了' })
            return true
          }
          // 读给自己看：让用户能确认「平台读到的到底是什么字」，而不是只能信我们
          sendJson(res, 200, { ok: true, file: publicChatFile(meta), text: meta.text })
          return true
        }
        if (req.method === 'DELETE') {
          const removed = deleteChatFile(user.id, fileId)
          sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, code: 'FILE_NOT_FOUND', error: '这个附件已经不在了' })
          return true
        }
        sendJson(res, 405, { ok: false, code: 'CHAT_METHOD', error: '这个接口不支持 ' + req.method })
        return true
      }

      if (pathname === '/api/chat/conversations' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, items: listConversations(user.id) })
        return true
      }

      if (pathname === '/api/chat/conversations' && req.method === 'POST') {
        const conv = createConversation(user.id, {})
        sendJson(res, 200, { ok: true, conversation: conv })
        return true
      }

      const matched = pathname.match(CONV)
      if (!matched) {
        sendJson(res, 404, { ok: false, code: 'CHAT_ROUTE', error: '未知的对话接口：' + req.method + ' ' + pathname })
        return true
      }
      const id = matched[1]
      const isMessages = Boolean(matched[2])
      const isStream = Boolean(matched[3])

      if (!isMessages && req.method === 'GET') {
        const conv = getConversation(user.id, id)
        if (!conv) {
          sendJson(res, 404, { ok: false, code: 'CHAT_NOT_FOUND', error: '这条对话已经不在了' })
          return true
        }
        sendJson(res, 200, { ok: true, conversation: conv })
        return true
      }

      if (!isMessages && req.method === 'DELETE') {
        const removed = deleteConversation(user.id, id)
        sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, code: 'CHAT_NOT_FOUND', error: '这条对话已经不在了' })
        return true
      }

      if (isStream) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'CHAT_METHOD', error: '这个接口不支持 ' + req.method })
          return true
        }
        const body = await readBody(req)
        // 用户按「停止」= 客户端断开连接：这里立刻中止上游，交给 streamChatMessage 退款。
        const controller = new AbortController()
        let finished = false
        res.on('close', () => {
          if (!finished) controller.abort()
        })
        res.on('error', () => {
          /* 断开时的 ECONNRESET 不用上报 */
        })
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          // nginx 默认会把 SSE 攒在缓冲里，这一行让它立刻透传（线上 /api/ 另有 proxy_buffering off）
          'X-Accel-Buffering': 'no',
        })
        res.flushHeaders?.()
        sseWrite(res, 'open', { ok: true })
        // 思考模式首字可能要几十秒：每 15 秒一个注释心跳，别让中间层把连接当空闲掐掉
        const heartbeat = setInterval(() => {
          if (finished) return
          try {
            res.write(': ping\n\n')
          } catch {
            /* 断开就等 await 收尾 */
          }
        }, 15000)
        try {
          const result = await streamChatMessage(
            user,
            { ...body, conversationId: id },
            {
              signal: controller.signal,
              onDelta: (piece) => {
                if (piece) sseWrite(res, 'delta', { text: piece })
              },
            },
          )
          finished = true
          sseWrite(res, 'done', { ok: true, ...result })
          res.end()
        } catch (error) {
          finished = true
          sseWrite(res, 'error', {
            ok: false,
            code: error?.code || 'CHAT_UPSTREAM',
            // 流式与非流式同一套口径（r263）：上游英文报文、模型型号、平台配置名都不原样交给用户
            error: publicError(error, '这次没有回上来'),
            ...(error?.stopped ? { stopped: true } : {}),
            ...(error?.balance != null ? { balance: error.balance } : {}),
            ...(error?.needed != null ? { needed: error.needed } : {}),
          })
          res.end()
        } finally {
          clearInterval(heartbeat)
        }
        return true
      }

      if (isMessages && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const result = await sendChatMessage(user, { ...body, conversationId: id })
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, error?.status || 502, {
            ok: false,
            code: error?.code || 'CHAT_UPSTREAM',
            error: publicError(error, '这次没有回上来'),
            ...(error?.detail ? { detail: error.detail } : {}),
            ...(error?.balance != null ? { balance: error.balance } : {}),
            ...(error?.needed != null ? { needed: error.needed } : {}),
          })
        }
        return true
      }

      sendJson(res, 405, { ok: false, code: 'CHAT_METHOD', error: '这个接口不支持 ' + req.method })
      return true
    },
  }
}
