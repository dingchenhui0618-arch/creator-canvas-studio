import { sendJson, readBody } from './_shared.mjs'
import { reviewVisual, reviewStatus } from '../review.mjs'
import { saveReview, listReviews, getReview } from '../reviews.mjs'
import { reviewQueue, reviewQueueRow } from '../review-queue.mjs'
import { reviewCandidatesFor } from '../review-candidates.mjs'
import { ackReview, unackReview } from '../review-acks.mjs'
import { saveDecision, clearDecision, clearDecisions, DECISION_KINDS } from '../review-decisions.mjs'
import { getProject, listProjects } from '../projects.mjs'
import { projectsById, withReviewProject } from '../review-ownership.mjs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { charge, refund } from '../credits.mjs'
import { quotaRefusal } from '../quota.mjs'
import { enter, leave } from '../gate.mjs'
import { admit, capacityFor } from '../waterline.mjs'
import { publicError } from '../public-error.mjs'
import { modelServiceState, noteModelFailure, noteModelSuccess } from '../service-state.mjs'

const MEDIA_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

// 本地媒体文件（模板库帧图）→ 字节
async function readLocalMedia(mediaPath) {
  const absolute = path.join(config.dataDir, mediaPath.replace(/^\/+/, ''))
  const normalized = path.normalize(absolute)
  if (!normalized.startsWith(path.normalize(config.dataDir))) throw new Error('非法路径')
  const bytes = await fsp.readFile(normalized)
  return { bytes, mime: MEDIA_MIME[path.extname(normalized).toLowerCase()] || 'image/jpeg' }
}

const REVIEW_ITEM = /^\/api\/reviews\/([\w-]+)$/
const ACK_ITEM = /^\/api\/reviews\/ack\/([\w-]+)$/
const DECISION_ITEM = /^\/api\/reviews\/decision\/([\w-]+)$/

export function createReviewRouter() {
  return {
    prefix: '/api/review',
    extraPrefixes: ['/api/reviews'],
    async handle(req, res, url, pathname) {
      const user = currentUser(req)

      // 评审历史：列表与详情都按账号隔离（管理员可见全部）
      if (pathname === '/api/reviews' && req.method === 'GET') {
        const result = await listReviews({
          limit: url.searchParams.get('limit') || 20,
          offset: url.searchParams.get('offset') || 0,
          verdict: url.searchParams.get('verdict') || '',
          projectId: url.searchParams.get('projectId') || '',
          orphan: url.searchParams.get('orphan') === '1',
        }, user)
        // 评审只记 projectId，作品标题现算：作品改名后历史评审跟着改口，不用回写两百条记录
        const byId = projectsById(await listProjects(user))
        const projects = result.facets.projects.map((entry) => ({
          id: entry.id,
          title: byId.get(entry.id)?.title || '未命名作品',
          count: entry.count,
        }))
        sendJson(res, 200, {
          ...result,
          items: withReviewProject(result.items, byId),
          facets: { ...result.facets, projects },
        })
        return true
      }
      // 评审队列：还等你改的作品（当前这一版最近一次结论是需人工确认 / 不通过）。
      // 必须排在 /api/reviews/<id> 之前，否则 queue 会被当成一条评审 id。
      if (pathname === '/api/reviews/queue' && req.method === 'GET') {
        // 两种找法（v0.9.25）：时间范围按那次评审的时间限、关键字只搜作品标题；不传就是全部
        const queue = await reviewQueue(user, {
          limit: url.searchParams.get('limit') || 6,
          // 翻页（v0.9.27）：从第几条往后取；不传就是第一页
          offset: url.searchParams.get('offset') || 0,
          range: url.searchParams.get('range') || 'all',
          q: url.searchParams.get('q') || '',
        })
        sendJson(res, 200, { ok: true, ...queue })
        return true
      }
      // 评审候选（v0.9.37）：评审页首屏先问「评哪条作品的哪一版」，不再让人从模板首帧里挑。
      // 只读现算，不检索、不扣积分；口径全在 review-candidates.mjs 与 project-status.mjs 两处。
      // 必须排在 /api/reviews/<id> 之前，否则 candidates 会被当成一条评审 id。
      if (pathname === '/api/reviews/candidates') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return true
        }
        // 生产必须登录；本地演示（VQ_REQUIRE_AUTH=0）与评审历史同一套：不认人但照常可用
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '未登录', loginRequired: true })
          return true
        }
        const candidates = await reviewCandidatesFor(user, {
          limit: url.searchParams.get('limit') || undefined,
        })
        sendJson(res, 200, { ok: true, ...candidates })
        return true
      }
      // 「已看过」：这条评审人看过了、这一版先不改，从待办里拿掉。
      // 不改结论、不改作品状态、不扣积分；记的是「哪一版哪一次评审」，评出新结论会自动回到待办。
      if (pathname === '/api/reviews/ack' && req.method === 'POST') {
        const body = await readBody(req)
        const projectId = body.projectId ? String(body.projectId).slice(0, 40) : ''
        if (!projectId) {
          sendJson(res, 400, { error: '要说清是哪条作品', code: 'PROJECT_REQUIRED' })
          return true
        }
        const row = await reviewQueueRow(projectId, user)
        if (!row) {
          sendJson(res, 409, {
            error: '这条现在没有等你处理的评审：结论是通过、已经交付，或者这一版还没评过',
            code: 'NO_PENDING_REVIEW',
          })
          return true
        }
        const ack = await ackReview({ projectId, version: row.version, reviewAt: row.at, verdict: row.verdict }, user)
        sendJson(res, 200, { ok: true, ack, row })
        return true
      }
      const ackItem = pathname.match(ACK_ITEM)
      if (ackItem && req.method === 'DELETE') {
        const removed = await unackReview(ackItem[1], user)
        sendJson(res, 200, { ok: true, removed })
        return true
      }
      // 人工复核：人看过证据后拍板「这一版能发 / 不能发」。
      // 与已看过的区别：已看过只把待办挪开，结论不动；拍板是人的结论，会盖过模型结论出现在胶囊、下一步与纸上。
      // 落库仍不改评审记录本身：模型写了什么还是什么，人这一层单独记。不扣积分。
      if (pathname === '/api/reviews/decision' && req.method === 'POST') {
        const body = await readBody(req)
        const projectId = body.projectId ? String(body.projectId).slice(0, 40) : ''
        if (!projectId) {
          sendJson(res, 400, { error: '要说清是哪条作品', code: 'PROJECT_REQUIRED' })
          return true
        }
        const decision = String(body.decision || '')
        if (!DECISION_KINDS.includes(decision)) {
          sendJson(res, 400, { error: '拍板只有「通过」和「不通过」两种', code: 'DECISION_INVALID' })
          return true
        }
        const row = await reviewQueueRow(projectId, user)
        if (!row) {
          sendJson(res, 409, {
            error: '这条现在没有等你拍板的评审：结论是通过、已经交付，或者这一版还没评过',
            code: 'NO_PENDING_REVIEW',
          })
          return true
        }
        const record = await saveDecision({
          projectId,
          // 版次与评审时间都由服务端现算：界面上的时间只用来显示，不参与记账
          version: row.version,
          reviewAt: row.at,
          verdict: row.verdict,
          decision,
          note: body.note ? String(body.note).slice(0, 80) : '',
        }, user)
        sendJson(res, 200, { ok: true, decision: record, row })
        return true
      }
      const decisionItem = pathname.match(DECISION_ITEM)
      if (decisionItem && req.method === 'DELETE') {
        // 带 reviewAt 就只撤那一次评审的拍板（作品页的「撤销这一版」）；
        // 不带就整条作品的记录清掉（清空记录走这里，老调用的行为不变）
        const reviewAt = url.searchParams.get('reviewAt') || ''
        const removed = reviewAt ? await clearDecision(decisionItem[1], reviewAt, user) : await clearDecisions(decisionItem[1], user)
        sendJson(res, 200, { ok: true, removed, scope: reviewAt ? 'review' : 'project' })
        return true
      }
      const reviewItem = pathname.match(REVIEW_ITEM)
      if (reviewItem && req.method === 'GET') {
        const record = await getReview(reviewItem[1], user)
        if (!record) {
          sendJson(res, 404, { error: '评审记录不存在' })
          return true
        }
        sendJson(res, 200, withReviewProject([record], projectsById(await listProjects(user)))[0])
        return true
      }

      if (pathname === '/api/review/health') {
        sendJson(res, 200, await reviewStatus())
        return true
      }
      if (pathname === '/api/review' && req.method === 'POST') {
        const body = await readBody(req)
        // 从作品页发起的评审：先确认作品还在，再扣积分——不能收完钱才发现记不进任何作品
        const projectId = body.projectId ? String(body.projectId) : ''
        // 作品的第几版：评审落库时按当前版本记账，多版本对照才不会串
        let projectVersion = 0
        if (projectId) {
          const scopedProject = await getProject(projectId, user)
          if (!scopedProject) {
            sendJson(res, 404, { error: '这次评审要记入的作品不见了，评审没有开始，也未扣积分', code: 'PROJECT_NOT_FOUND' })
            return true
          }
          projectVersion = scopedProject.version
        }
        // 已知模型服务不可用（额度 / 凭证）：直接说明，不先扣再退
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
        // 内存到红线时不接这一单（不扣积分、不调模型）；水位偏紧时评审只放一条并行。
        const water = admit('review')
        if (!water.ok) {
          sendJson(res, water.status, water.body)
          return true
        }
        // 评审按次扣积分：先扣后调，失败退款
        const limit = capacityFor('review', Number(config.credits.concurrency.review || 0), water.level)
        if (user?.id && !enter(user.id, 'review', limit)) {
          sendJson(res, 429, { error: '这个账号还有评审在跑，等它结束再试', code: 'CONCURRENCY_LIMIT', limit })
          return true
        }
        const paid = user?.id ? charge(user.id, 'review', { ref: body.intent ? String(body.intent).slice(0, 60) : '视觉评审' }) : { ok: true, cost: 0, balance: null }
        if (!paid.ok) {
          if (user?.id) leave(user.id, 'review')
          if (paid.code === 'MONTHLY_QUOTA') {
            const refusal = quotaRefusal(paid)
            sendJson(res, refusal.status, refusal.body)
            return true
          }
          sendJson(res, 402, {
            error: '积分不足：本次评审需要 ' + paid.cost + ' 积分，当前余额 ' + paid.balance + ' 积分',
            code: 'CREDIT_INSUFFICIENT',
            balance: paid.balance,
            cost: paid.cost,
            needed: paid.needed,
          })
          return true
        }
        try {
          let imageBytes
          let mime = 'image/jpeg'
          if (body.media) {
            const local = await readLocalMedia(String(body.media))
            imageBytes = local.bytes
            mime = local.mime
          }
          const result = await reviewVisual({
            imageUrl: body.imageUrl ? String(body.imageUrl) : undefined,
            imageBytes,
            mime,
            intent: body.intent ? String(body.intent).slice(0, 300) : '',
            log: (message) => console.log('[review] ' + message),
            // 作品页发起的评审要能在成本页按作品回看：作品 id 只用于计量，不写进评审结论
            projectId,
            ref: projectId ? 'project:' + projectId : '',
          })
          // 插件服务出结论时没有用到平台模型，不清除模型侧状态
          if (result.mode === 'local-model') noteModelSuccess()
          const source = body.media
            ? { kind: 'template', label: body.label || body.intent || '', media: body.media }
            : { kind: body.imageUrl ? 'url' : 'unknown', label: body.label || body.intent || '', imageUrl: body.imageUrl || '' }
          const saved = await saveReview({
            user,
            source,
            intent: body.intent ? String(body.intent).slice(0, 300) : '',
            result,
            credits: { cost: paid.cost, balance: paid.balance },
            projectId,
            version: projectVersion,
          })
          sendJson(res, 200, { ...result, reviewId: saved.id, credits: { cost: paid.cost, balance: paid.balance } })
        } catch (error) {
          noteModelFailure(error)
          if (user?.id && paid.cost > 0) refund(user.id, 'review', { amount: paid.cost, ref: '评审失败退款' })
          console.error('[review] ' + (error?.stack || error?.message || error))
          sendJson(res, 500, { error: publicError(error, '评审服务暂时不可用，积分已退回') })
        } finally {
          if (user?.id) leave(user.id, 'review')
        }
        return true
      }
      sendJson(res, 404, { error: 'review route not found' })
      return true
    },
  }
}
