// /api/share/project/<token>：作品的只读分享，不需要登录。
//
// 链接本身就是凭证（18 字节随机 token），公开视图只走 project-share.mjs 的白名单：
// 标题、脚本、分镜、评审与运行次数；不带账号、画布、模板 id 与原始素材。
// 分镜帧图也走这条带 token 的地址——/media/frames 是要登录的，分享页拿不到。
// 每打开一次分享页会记一次打开（60 秒内的连续打开算一次）：甲方看没看、什么时候看的，
// 分享者自己能在作品的分享面板里看到。记的只是次数与客户端类别，不记 IP、不记是谁。
// /print/share/project/<token>/review 是同一份凭证下的评审对照纸：
// 拿到链接的人不用账号就能把「问题框在哪」打印或存 PDF，画面同样走带 token 的帧图接口。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sendJson } from './_shared.mjs'
import { printNoticeHtml } from '../project-deliverable-html.mjs'
import { reviewSheetHtml, reviewSheetSelection } from '../project-review-sheet.mjs'
import { getProjectByShareToken } from '../projects.mjs'
import { getTemplate } from '../templates.mjs'
import { scriptView } from '../project-script.mjs'
import { getReview, listReviews, reviewSummaryByVersion } from '../reviews.mjs'
import { listRunsByFlows } from '../flows.mjs'
import { frameFileOf, publicProjectView, shareFrameIndex } from '../project-share.mjs'
import { recordShareOpen } from '../share-visits.mjs'

const SHARED = /^\/api\/share\/project\/([\w-]+)$/
const FRAME = /^\/api\/share\/project\/([\w-]+)\/frame\/(\d+)$/
// 评审对照纸也挂在分享链接上：甲方、剪辑没有账号，纸要跟着链接一起能打开
const PRINT_REVIEW = /^\/print\/share\/project\/([\w-]+)\/review$/
const FRAME_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const PRINT_HEAD = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
// 评审全局最多 200 条；单条作品扫最近 50 条摘要足够覆盖「每一版最近一次」
const REVIEW_SCAN_LIMIT = 50

async function serveFrame(res, file) {
  const ext = path.extname(file).toLowerCase()
  if (!FRAME_MIME[ext]) return false
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return false
    res.writeHead(200, {
      'Content-Type': FRAME_MIME[ext],
      'Content-Length': stat.size,
      // 只缓存 10 分钟：停止分享后旧链接失效，缓存不该比链接活得更久
      'Cache-Control': 'public, max-age=600',
    })
    res.end(await fsp.readFile(file))
    return true
  } catch {
    return false
  }
}

function notFound(res) {
  return sendJson(res, 404, { error: '这个分享链接已失效，或分享者已停止分享', code: 'SHARE_NOT_FOUND' })
}

function sendPrintNotice(res, status, notice) {
  res.writeHead(status, PRINT_HEAD)
  res.end(printNoticeHtml(notice))
}

function clampTz(raw) {
  const value = Number(raw)
  return Number.isFinite(value) ? Math.max(-720, Math.min(840, Math.round(value))) : 480
}

/**
 * 分享页的评审对照纸要印哪几次评审：与作品页、交付包同一条规则（每版最近一次、最多 3 版），
 * 但只认挂在这条作品上的评审——分享链接再长，也不能顺带把别条作品的问题印出来。
 */
async function sharedReviewRecords(project) {
  const { items } = await listReviews({ projectId: project.id, limit: REVIEW_SCAN_LIMIT }, null)
  const records = []
  for (const item of reviewSheetSelection(items).records) {
    const full = await getReview(item.id, null)
    if (full && full.projectId === project.id) records.push(full)
  }
  return records
}

export function createProjectShareRouter() {
  return {
    prefix: '/api/share/project',
    // 打印版不在 /api 下：地址栏里那串会被浏览器印在纸脚上，也免得把令牌当接口调用
    extraPrefixes: ['/print/share/project'],
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/share/project') && !pathname.startsWith('/print/share/project')) return false
      const printMatch = pathname.match(PRINT_REVIEW)
      if (printMatch) {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('分享链接只能看，不能改')
          return true
        }
        const token = printMatch[1]
        const shared = await getProjectByShareToken(token)
        if (!shared) {
          sendPrintNotice(res, 404, {
            title: '这条分享链接已经失效',
            message: '分享者可能已经停止分享，或者换过一条新链接。',
            href: '/',
            label: '打开 VisionQA',
          })
          return true
        }
        const found = shared.templateId ? await getTemplate(shared.templateId, null) : null
        const template = found && !found.deletedAt ? found : null
        const records = await sharedReviewRecords(shared)
        const frameUrl = (block) => {
          const index = shareFrameIndex(template, block?.image)
          return index ? '/api/share/project/' + encodeURIComponent(token) + '/frame/' + index : ''
        }
        res.writeHead(200, PRINT_HEAD)
        res.end(
          reviewSheetHtml({
            // 公开链接上不印作品编号（那是内部 id）：分享页的白名单同样不给它
            project: { title: shared.title, version: shared.version },
            records,
            now: new Date(),
            tzOffsetMinutes: clampTz(url.searchParams.get('tz')),
            backHref: '/#/share/project/' + encodeURIComponent(token),
            backLabel: '返回分享页',
            hint: '只读分享：拿到链接就能看，不用登录；框与问题编号一一对应',
            originNote: '来自只读分享链接：链接停用后这个地址会打不开，已经存下来的 PDF 不受影响。',
            missingText: '这次评审评的那张帧图不在这个分享里：分享只给这条作品分镜里的帧。问题与编号仍按原文列出。',
            imageSrc: frameUrl,
          }),
        )
        return true
      }
      const frameMatch = pathname.match(FRAME)
      const sharedMatch = pathname.match(SHARED)
      if (!frameMatch && !sharedMatch) {
        sendJson(res, 404, { error: '没有这个分享接口' })
        return true
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '分享链接只能读，不能改' })
        return true
      }
      const token = (frameMatch || sharedMatch)[1]
      const project = await getProjectByShareToken(token)
      if (!project) return notFound(res)
      // 已软删除的模板不再对外：作品自己的脚本仍然可以看
      const found = project.templateId ? await getTemplate(project.templateId, null) : null
      const template = found && !found.deletedAt ? found : null

      if (frameMatch) {
        const file = frameFileOf(template, frameMatch[2])
        if (file && (await serveFrame(res, file))) return true
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no frame')
        return true
      }

      const script = scriptView(project, template)
      const flows = [project.flowId, ...project.versions.map((entry) => entry.flowId)].filter(Boolean)
      const [versionCounts, runData] = await Promise.all([
        reviewSummaryByVersion(project.id, null),
        flows.length ? listRunsByFlows(flows, { limit: 1 }, null) : Promise.resolve({ total: 0 }),
      ])
      // 分享页的数据请求就是一次「有人打开了这条链接」：只记这一处，
      // 帧图不记（一次打开会带很多张图），对照纸也不另记。
      await recordShareOpen(token, req.headers?.['user-agent'])
      // 跨版本合计：分享页给的是「这条作品一共评过几次」，不按版本拆（版本是内部概念）
      let count = 0
      let lastVerdict = ''
      let lastAt = ''
      for (const entry of Object.values(versionCounts || {})) {
        count += Number(entry?.count) || 0
        if (String(entry?.lastAt || '') > lastAt) {
          lastAt = String(entry.lastAt || '')
          lastVerdict = String(entry.lastVerdict || '')
        }
      }
      sendJson(res, 200, {
        ok: true,
        ...publicProjectView({
          project,
          template,
          script,
          reviews: { count, lastVerdict, lastAt },
          runs: runData.total,
          token,
        }),
      })
      return true
    },
  }
}