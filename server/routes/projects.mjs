// /api/projects：作品（一条内容的主线对象）。
//
// 作品默认只存引用：脚本从模板读、画布在流程服务、评审按 projectId 关联。
// 唯一例外是脚本的 copy-on-write：作品页保存脚本才复制成作品自己的版本（project-script.mjs），
// 同时把画布里自动生成的复刻提示词换成新脚本——页面之间不能各说各话。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sendJson, readBody } from './_shared.mjs'
import { flowBrief, projectBrief } from '../project-briefs.mjs'
import { currentUser } from '../auth.mjs'
import { config } from '../config.mjs'
import { createTemplateFromProject, getTemplate, listTemplates, reuseTemplate } from '../templates.mjs'
import { projectTemplateReply, projectTemplateSpec } from '../project-template.mjs'
import { templateOrigin } from '../project-source.mjs'
import { createFlow, getFlow, listRunsByFlows } from '../flows.mjs'
import { normalizeProjectScript, scriptPace, scriptView } from '../project-script.mjs'
import { buildReplicateDraft } from '../script-draft.mjs'
import { syncCanvasScript } from '../project-canvas-sync.mjs'
import {
  listReviews,
  getReview,
  reviewCountsByProject,
  reviewSummaryByVersion,
  detachReviewsFromProject,
} from '../reviews.mjs'
import { projectDeliverable } from '../project-deliverable.mjs'
import { deliverablePrintHtml, printNoticeHtml } from '../project-deliverable-html.mjs'
import { packageNote, parseShotRange, setSheetHtml, setSheetModel } from '../project-set-sheet.mjs'
import { reviewImageRef, reviewSheetHtml, reviewSheetSelection } from '../project-review-sheet.mjs'
import { getShareVisits, getShareVisitsByKey } from '../share-visits.mjs'
import { shareBriefsByProject } from '../share-summary.mjs'
import { ackFor, dropAcksForProject, listAcks } from '../review-acks.mjs'
import { dropDecisionsForProject, listDecisions } from '../review-decisions.mjs'
import { decisionFor, decisionHistory, reviewsForVersion } from '../project-status.mjs'
import { projectListQuery } from '../project-list.mjs'
import { adoptCanvasForProject, createProjectFromCanvas } from '../project-canvas.mjs'
import { buildZip } from '../zip-store.mjs'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  bindProjectFlow,
  saveProjectScript,
  clearProjectScript,
  enableProjectShare,
  disableProjectShare,
  archiveProjectVersion,
  deleteProject,
  PROJECT_VERSION_LIMIT,
} from '../projects.mjs'

const ITEM = /^\/api\/projects\/([\w-]+)$/
const VERSIONS = /^\/api\/projects\/([\w-]+)\/versions$/
const SCRIPT = /^\/api\/projects\/([\w-]+)\/script$/
const CANVAS = /^\/api\/projects\/([\w-]+)\/canvas$/
const SHARE = /^\/api\/projects\/([\w-]+)\/share$/
// 作品「存成模板」：做完的这一版沉淀回模板库（脚本是这一版的，分镜沿用绑定模板的取景）
const TEMPLATE_FROM = /^\/api\/projects\/([\w-]+)\/template$/
const DELIVERABLE = /^\/api\/projects\/([\w-]+)\/deliverable$/
// 交付包：交付稿 + 现场页 + 帧图打成一个 zip，收件人解压就能看，不用登录
const DELIVERABLE_ZIP = /^\/api\/projects\/([\w-]+)\/deliverable\.zip$/
// 打印版不进 /api：它是在新标签里打开的 HTML，地址栏里那串会印在纸的页脚上
const DELIVERABLE_PRINT = /^\/print\/projects\/([\w-]+)\/deliverable$/
// 评审对照纸：评审把问题框在哪一块画面上，同一张 A4 里印出来（交付包里也有同一份）
const REVIEW_PRINT = /^\/print\/projects\/([\w-]+)\/review$/

// 详情 / 列表里的 project 只有一份形状（server/project-briefs.mjs）：
// 不带原始脚本、不带分享 token。画布归作品那条路（v0.9.29）回执也用同一份。

// 列表只给卡片要用的那几项：模板标题、流程名、评审计数
function templateBrief(template) {
  if (!template) return null
  return {
    id: template.id,
    title: template.title,
    kind: template.kind,
    contentType: template.contentType || '',
    durationSec: Number(template.durationSec) || 0,
    beats: Array.isArray(template.structure) ? template.structure.length : 0,
    shots: Array.isArray(template.storyboard) ? template.storyboard.length : 0,
  }
}

// 作品页要渲染脚本与分镜：只取这几项，不把抽帧与视频元数据整包丢过去
function templateDetail(template) {
  if (!template) return null
  return {
    ...templateBrief(template),
    hook: template.hook || '',
    hookType: template.hookType || '',
    platformLabel: template.platformLabel || '',
    structure: template.structure || [],
    storyboard: template.storyboard || [],
    timing: template.timing || null,
    cover: template.thumb || template.cover || '',
    reuseCount: Number(template.reuseCount) || 0,
    // 这条模板「从哪来」：原片链接、作者与互动数（画布/智能体来的如实说没有原片）
    origin: templateOrigin(template),
  }
}

/**
 * 作品详情：作品页与交付稿导出读同一个函数，避免两处口径分叉。
 * 运行归集要跨版本：当前版 + 归档版的画布一起查，开新版之后旧版的运行记录仍在作品里。
 */
async function projectDetailView(project, user, { snapshots = false } = {}) {
  const projectFlows = [project.flowId, ...project.versions.map((entry) => entry.flowId)].filter(Boolean)
  const [template, flow, reviews, versionCounts, runData, acks] = await Promise.all([
    project.templateId ? getTemplate(project.templateId, user) : null,
    project.flowId ? getFlow(project.flowId, user) : null,
    listReviews({ projectId: project.id, limit: 20 }, user),
    reviewSummaryByVersion(project.id, user),
    listRunsByFlows(projectFlows, { limit: 20 }, user),
    listAcks(user),
  ])
  // 归档的旧版本只存了 flowId：这里顺手确认画布还在，已删掉的版本按钮要禁用而不是点开报错。
  // 页面只要「这一版几段脚本」；交付稿要跟上一版对比，才把快照与节点一起带上（snapshots）。
  const versions = await Promise.all(project.versions.map(async (entry) => {
    const archived = entry.flowId ? await getFlow(entry.flowId, user) : null
    const snapshot = entry.script || null
    return {
      n: entry.n,
      flowId: entry.flowId,
      name: entry.name,
      archivedAt: entry.archivedAt,
      available: Boolean(archived),
      nodes: Array.isArray(archived?.nodes) ? archived.nodes.length : 0,
      // 开新版时存下的脚本快照：这里只给段数，正文只在导出时带
      scriptBeats: Array.isArray(snapshot?.structure) ? snapshot.structure.length : 0,
      scriptSource: snapshot?.source || '',
      ...(snapshots ? { scriptSnapshot: snapshot, nodeList: archived?.nodes || null } : {}),
    }
  }))
  const versionOfFlow = new Map()
  for (const entry of project.versions) versionOfFlow.set(entry.flowId, entry.n)
  if (project.flowId) versionOfFlow.set(project.flowId, project.version)
  // 画布被删掉之后运行记录仍在（历史不该跟着消失），但「打开画布」要禁用而不是点开报错。
  // 注意这里必须放在 versions 算好之后再建：顺序反了就是一个 ReferenceError（0.2.3 生产实测踩到）。
  const liveFlows = new Set(versions.filter((entry) => entry.available).map((entry) => entry.flowId))
  if (flow) liveFlows.add(flow.id)
  const runs = runData.items.map((run) => ({
    ...run,
    version: versionOfFlow.get(run.flowId) || 0,
    available: liveFlows.has(run.flowId),
  }))
  const runCounts = {}
  for (const [flowId, amount] of Object.entries(runData.byFlow)) {
    const version = versionOfFlow.get(flowId) || 0
    runCounts[version] = (runCounts[version] || 0) + Number(amount)
  }
  const flowView = flowBrief(flow)
  // 人工复核：这条作品名下的拍板记录，加上「管当前这一版最近一次评审」的那条。
  // 状态胶囊、下一步、交付稿与两张纸都读同一处判断——人拍过板就不再拿模型的「需人工确认」当结论。
  const decisions = (await listDecisions(user))
    .filter((entry) => entry.projectId === project.id)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const currentReview = reviewsForVersion(versionCounts, project.version)
  const decision = decisionFor(decisions, currentReview.lastAt)
  // 历史列表与状态胶囊读同一份判断：每条拍板带一个 state（管这一版 / 这一版重评过 / 早先那一版），
  // 页面只负责把三个词写成人话，不自己再算一遍「还算不算数」（v0.9.26）
  const decisionLog = decisionHistory(decisions, { version: project.version, reviewAt: currentReview.lastAt })
  // 「已看过」也按「哪一版、哪一次评审」认：作品页要能原地显示看过 / 撤销，
  // 但看过的只是待办，胶囊与下一步一句都不动。
  const ack = ackFor(acks, { projectId: project.id, version: project.version, reviewAt: currentReview.lastAt })
  // 分享面板要显示「链接被打开过几次」：只在作品详情里带上，列表接口不返回 token 与打开记录
  // 历史链接同理：token 清掉之后地址打不开，但那一轮被打开过几次还能回看（v0.9.11）
  const [share, shareHistory] = await Promise.all([
    project.share ? getShareVisits(project.share.token).then((visits) => ({ ...project.share, visits })) : null,
    Promise.all(
      (project.shareHistory || []).map(async (entry) => ({
        createdAt: entry.createdAt,
        closedAt: entry.closedAt,
        // 只给统计，不给记录键：键虽然打不开链接，也没有给出去的理由
        visits: await getShareVisitsByKey(entry.key),
      })),
    ),
  ])
  // 这条作品沉淀过哪几条模板（v0.9.31）：模板那边记着 projectId，这里现算，作品不存副本。
  // 作品删掉之后模板还在（它已经是一条独立模板了），所以只按 id 反查，不要求作品还活着。
  const templateSaves = (await listTemplates({}, user))
    .filter((entry) => entry.projectId === project.id)
    .map((entry) => ({ id: entry.id, title: entry.title, createdAt: entry.createdAt, beats: (entry.structure || []).length, shots: (entry.storyboard || []).length }))
    .slice(0, 5)
  return {
    project: projectBrief(project),
    // 作品页的分享面板读这里：列表接口不返回 token
    share,
    // 沉淀出去的模板：作品页写「已存成模板 N 条」，刷新还在
    templateSaves,
    // 以前开过的链接：按停用时间倒序，每条带那一轮的打开次数与最近一次
    shareHistory,
    template: templateDetail(template),
    // 节点本身只在导出时带上：页面上十几版节点一起传过去没有用，还拖慢首屏
    flow: snapshots && flowView ? { ...flowView, nodeList: flow.nodes } : flowView,
    // 作品页的脚本：自己的版本优先（source: project），否则跟随模板
    script: scriptView(project, template),
    reviews: reviews.items,
    // 拍板记录按时间倒序（纸要按版次各印各的，胶囊只用其中管当前这一版的那条）
    decisions: decisionLog,
    decision,
    // 当前这一版看过了没有：对不上就是 null（评出新结论或开了新版自动作废）
    ack,
    versions,
    versionCounts,
    runs,
    runTotal: runData.total,
    runCounts,
  }
}

// 交付稿的内容只组装一次：Markdown 文件与 A4 打印稿读同一份，
// 不会出现「文件里一个时间、纸上另一个时间」。
async function deliverablePayload(project, user, tzOffsetMinutes) {
  // 交付稿要写「每一版和上一版比改了什么」：快照与节点只有导出时才取
  const detail = await projectDetailView(project, user, { snapshots: true })
  // 评审全文（含问题与修正建议）只在导出时读一次：详情列表里不带这几十 KB。
  // 版本 0 是版本划分之前记的评审，按页面同一套规则折进 v1，否则老作品会显示「记录没读到」。
  const latest = detail.reviews.find((item) => Math.max(1, Math.round(Number(item.version) || 0)) === project.version) || null
  const review = latest ? await getReview(latest.id, user) : null
  // detail 一起带出去：交付包的现场页要同一份脚本与分镜，不必再读一遍作品
  return { ...projectDeliverable(detail, { review, tzOffsetMinutes }), detail }
}

// 打印版出错时也给一张纸：这个地址是在新标签里打开的，吐一段 JSON 会让人以为页面坏了。
const PRINT_HEAD = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
}

function sendPrintNotice(res, status, notice) {
  res.writeHead(status, PRINT_HEAD)
  res.end(printNoticeHtml(notice))
}

/**
 * 交付包里的帧图：只认分镜里记下的那一份 /media/frames/<模板 id>/<文件名>，
 * 落地成 shot-03.jpg 这种按镜头编号命名的文件，收件人对着现场页就找得到。
 * 读不到的不补、不猜：集合里没有它，现场页那一镜就写「没存帧图」。
 */
async function storyboardFrames(template) {
  const shots = Array.isArray(template?.storyboard) ? template.storyboard : []
  if (!template?.id || !shots.length) return []
  const out = []
  const seen = new Set()
  for (const [index, shot] of shots.entries()) {
    const matched = String(shot?.frameUrl || '').match(/^\/media\/frames\/([\w-]+)\/([\w.-]+)$/)
    if (!matched || matched[1] !== template.id) continue
    const name = 'shot-' + String(Number(shot.shotNo) || index + 1).padStart(2, '0') + '.jpg'
    if (seen.has(name)) continue
    try {
      const data = await fsp.readFile(path.join(config.framesDir, template.id, matched[2]))
      seen.add(name)
      // templateId/file 只为「评审评的是不是这一张」服务：是同一张就复用这个文件，不再复制一份
      out.push({ name, data, templateId: matched[1], file: matched[2] })
    } catch {
      // 抽帧目录被清过（模板回收站 / 过期清理）：这一镜没有图，别拿别的帧顶
    }
  }
  return out
}

/**
 * 评审对照纸要印的那几次评审：每一版取最近一次，最多 3 版（与纸上同一套口径）。
 * 列表给的是摘要，正文（问题与框）按 id 再读一次——纸上要框，就需要那几条坐标。
 */
async function reviewSheetRecords(detail, user) {
  // 挑哪几次评审由 reviewSheetSelection 决定：分享页的对照纸也走同一条规则，两处不会各印一套
  const selection = reviewSheetSelection(detail?.reviews)
  const records = []
  for (const item of selection.records) {
    const full = await getReview(item.id, user)
    if (full) records.push(full)
  }
  return records
}

export function createProjectsRouter() {
  return {
    prefix: '/api/projects',
    // 打印版走 /print/projects/*：地址栏里那串会被浏览器印在纸的页脚上，不能带 /api
    extraPrefixes: ['/print/projects'],
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/projects') && !pathname.startsWith('/print/projects')) return false
      const user = currentUser(req)

      // 交付稿的 A4 打印版：同一份 Markdown 排成一张纸，打印（存 PDF）交给浏览器。
      // 排版与内容是服务端给的，打印对话框里纸张已经写死 A4，用户只需要按一下。
      const printPath = pathname.match(DELIVERABLE_PRINT)
      if (printPath && req.method === 'GET') {
        // 与其它接口同一套：生产必须登录；本地演示（VQ_REQUIRE_AUTH=0）不认人但照常可用，
        // 否则本地打开打印页只会看到一张「登录已过期」，没法验收排版。
        if (!user && config.auth.requireAuth) {
          sendPrintNotice(res, 401, {
            title: '登录已过期',
            message: '这个打印页要用你的登录态取数据：回到作品页再点一次「打印稿」，或者先登录。',
            href: '/#/login',
            label: '去登录',
          })
          return true
        }
        const printable = await getProject(printPath[1], user)
        if (!printable) {
          sendPrintNotice(res, 404, {
            title: '作品不在了',
            message: '这条作品可能已经被删除。回作品列表看看还在不在。',
            href: '/#/projects',
            label: '回作品列表',
          })
          return true
        }
        const rawPrintTz = Number(url.searchParams.get('tz'))
        const printTz = Number.isFinite(rawPrintTz) ? Math.max(-720, Math.min(840, Math.round(rawPrintTz))) : 480
        // ?only=script 是现场页：只印脚本 + 分镜（带原片帧图），评审与逐版对照留在交付稿里
        if (String(url.searchParams.get('only') || '') === 'script') {
          const detail = await projectDetailView(printable, user)
          // ?shots=2-4,7 只印这几镜（现场一天只拍其中几镜）；写法不认就印全部，纸不是表单，不拿报错拦人
          const shotCount = Array.isArray(detail.template?.storyboard) ? detail.template.storyboard.length : 0
          res.writeHead(200, PRINT_HEAD)
          res.end(
            setSheetHtml({
              project: printable,
              script: detail.script,
              template: detail.template,
              projectId: printable.id,
              onlyShots: parseShotRange(url.searchParams.get('shots'), shotCount),
              generatedAt: new Date().toISOString(),
              tzOffsetMinutes: printTz,
            }),
          )
          return true
        }
        const { markdown } = await deliverablePayload(printable, user, printTz)
        res.writeHead(200, PRINT_HEAD)
        res.end(deliverablePrintHtml({ markdown, projectId: printable.id, title: printable.title }))
        return true
      }

      // 评审对照纸：评审把每条问题框在当时的画面上，框上的编号对到右边的问题列表。
      // 交付包里的「评审对照页.html」是同一份渲染，只是画面改成走包里的帧图。
      const reviewPrintPath = pathname.match(REVIEW_PRINT)
      if (reviewPrintPath && req.method === 'GET') {
        if (!user && config.auth.requireAuth) {
          sendPrintNotice(res, 401, {
            title: '登录已过期',
            message: '这个打印页要用你的登录态取数据：回到作品页再点一次「评审对照」，或者先登录。',
            href: '/#/login',
            label: '去登录',
          })
          return true
        }
        const printable = await getProject(reviewPrintPath[1], user)
        if (!printable) {
          sendPrintNotice(res, 404, {
            title: '作品不在了',
            message: '这条作品可能已经被删除。回作品列表看看还在不在。',
            href: '/#/projects',
            label: '回作品列表',
          })
          return true
        }
        const rawReviewTz = Number(url.searchParams.get('tz'))
        const reviewTz = Number.isFinite(rawReviewTz) ? Math.max(-720, Math.min(840, Math.round(rawReviewTz))) : 480
        const detail = await projectDetailView(printable, user)
        const records = await reviewSheetRecords(detail, user)
        res.writeHead(200, PRINT_HEAD)
        res.end(
          reviewSheetHtml({
            project: printable,
            records,
            // 哪一版谁拍过板要印在纸上：纸脚写「不是人工复核」只在真的没人复核时成立
            decisions: detail.decisions,
            now: new Date(),
            tzOffsetMinutes: reviewTz,
            projectId: printable.id,
          }),
        )
        return true
      }

      // 生产必须登录；本地演示（VQ_REQUIRE_AUTH=0）沿用模板/评审的做法：不认人但照常可用。
      if (!user && config.auth.requireAuth) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }

      if (pathname === '/api/projects' && req.method === 'GET') {
        const [projects, reviews, decisions] = await Promise.all([
          listProjects(user),
          reviewCountsByProject(user),
          listDecisions(user),
        ])
        // 卡片上的状态胶囊要认得人工拍板：按作品分一次组，别在循环里 repeated 过滤
        const decisionsByProject = new Map()
        for (const entry of decisions) {
          const bucket = decisionsByProject.get(entry.projectId)
          if (bucket) bucket.push(entry)
          else decisionsByProject.set(entry.projectId, [entry])
        }
        // 运行归集：所有作品名下（含归档版本）的画布一次取回来，卡片上就能写「跑过几次」。
        // byFlow 把运行次数按画布分组，跨版本加总才有意义——只取一条记录，这里只要计数。
        const projectFlows = projects.flatMap((project) => [project.flowId, ...project.versions.map((entry) => entry.flowId)])
        const runAgg = projectFlows.filter(Boolean).length ? await listRunsByFlows(projectFlows, { limit: 1 }, user) : { byFlow: {} }
        // 卡片上的分享状态：只挂一条摘要（还在分享吗、几轮、打开几次），token 与每轮明细都不出这个接口
        const shareBriefs = await shareBriefsByProject(projects)
        const items = []
        for (const project of projects) {
          const template = project.templateId ? await getTemplate(project.templateId, user) : null
          const counters = reviews[project.id] || { count: 0, lastVerdict: '', lastAt: '', versions: {} }
          const runs = [project.flowId, ...project.versions.map((entry) => entry.flowId)]
            .reduce((sum, flowId) => sum + (flowId ? runAgg.byFlow[flowId] || 0 : 0), 0)
          items.push({
            ...projectBrief(project),
            template: templateBrief(template),
            // 总数给「评过几次」，按版本的分组给状态胶囊判断当前这一版
            reviews: { count: counters.count, lastVerdict: counters.lastVerdict, lastAt: counters.lastAt },
            versionCounts: counters.versions || {},
            // 管当前这一版最近一次评审的那条拍板；没有就是 null
            decision: decisionFor(
              decisionsByProject.get(project.id),
              reviewsForVersion(counters.versions || {}, project.version).lastAt,
            ),
            runs: { count: runs },
            share: shareBriefs.get(project.id) || null,
          })
        }
        // 搜什么、筛什么都在 project-list.mjs 里算：分面计数与真正筛出来的行同一口径
        const listed = projectListQuery(items, {
          q: url.searchParams.get('q') || '',
          state: url.searchParams.get('state') || 'all',
        })
        sendJson(res, 200, { ok: true, ...listed })
        return true
      }

      if (pathname === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req)
        // 从画布建作品（v0.9.29）：空白画布跑出来的东西也该能变成一条作品。
        // 这条路没有模板，脚本在作品页现写，画布已经在了所以一出生就是 v1。
        if (String(body.flowId || '')) {
          const result = await createProjectFromCanvas({
            flowId: String(body.flowId),
            title: String(body.title || ''),
            user,
          })
          sendJson(res, result.status, result.body)
          return true
        }
        const templateId = String(body.templateId || '')
        if (!templateId) {
          sendJson(res, 400, {
            error: '作品要么从一条模板开始，要么从一块画布开始：先选模板或选画布',
            code: 'TEMPLATE_REQUIRED',
          })
          return true
        }
        const template = await getTemplate(templateId, user)
        if (!template) {
          sendJson(res, 404, { error: '模板不存在或不属于当前账号' })
          return true
        }
        if (template.kind === 'saved' || (!template.structure?.length && !template.storyboard?.length)) {
          sendJson(res, 400, { error: '这条模板还没解析出脚本与分镜，先解析再建作品', code: 'TEMPLATE_UNPARSED' })
          return true
        }
        const project = await createProject(
          { title: String(body.title || template.title || '').slice(0, 80), templateId: template.id },
          user,
        )
        sendJson(res, 201, { ok: true, project })
        return true
      }

      const canvasPath = pathname.match(CANVAS)
      // 画布归作品（v0.9.29）：把一块已经跑过的画布接到这条作品上。
      // 一接上，这块画布以前的运行与之后的评审就都落进这条作品——运行记录那边也能「归到作品」。
      if (canvasPath && req.method === 'PUT') {
        const body = await readBody(req)
        const result = await adoptCanvasForProject({ projectId: canvasPath[1], flowId: String(body.flowId || ''), user })
        sendJson(res, result.status, result.body)
        return true
      }

      // 作品页开画布：第一张画布用这条作品现在的脚本生成，不再绕到模板库的 apply
      if (canvasPath && req.method === 'POST') {
        const project = await getProject(canvasPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        // 已经有画布就直接回去：重复点「开画布」不该生成第二张
        const existing = project.flowId ? await getFlow(project.flowId, user) : null
        if (existing) {
          sendJson(res, 200, { ok: true, created: false, project: projectBrief(project), flow: flowBrief(existing) })
          return true
        }
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        const script = scriptView(project, template)
        if (!script) {
          sendJson(res, 409, {
            error: '这条作品还没有脚本：先在作品页写一条脚本，或从模板库挑一条已解析的模板',
            code: 'SCRIPT_REQUIRED',
          })
          return true
        }
        const flow = await createFlow(buildReplicateDraft({ template: template || {}, script, name: project.title }), user)
        const bound = await bindProjectFlow(project.id, flow.id, user)
        if (!bound) {
          sendJson(res, 409, { error: '画布建好了但没绑上作品：检查这条作品是否还在', code: 'BIND_FAILED' })
          return true
        }
        if (template) await reuseTemplate(template.id)
        sendJson(res, 201, { ok: true, created: true, project: projectBrief(bound), flow: flowBrief(flow) })
        return true
      }

      // 作品页直接改脚本：第一次保存把模板脚本复制成作品自己的版本（copy-on-write），
      // 再把画布里自动生成的复刻提示词换成新脚本。模板不动，别的作品也不动。
      const scriptPath = pathname.match(SCRIPT)
      if (scriptPath && req.method === 'PUT') {
        const project = await getProject(scriptPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        const body = await readBody(req)
        const script = normalizeProjectScript(body, {
          pace: scriptPace(template),
          totalSec: Number(template?.durationSec) || 0,
        })
        if (!script) {
          sendJson(res, 400, { error: '脚本至少要留一段有内容的话：段落名、口播或屏幕字写一个', code: 'SCRIPT_EMPTY' })
          return true
        }
        const prevHook = String(project.script?.hook || template?.hook || '')
        const saved = await saveProjectScript(project.id, script, user)
        if (!saved) {
          sendJson(res, 409, { error: '脚本没有保存成功：作品可能刚被删掉，刷新再试', code: 'SCRIPT_SAVE_FAILED' })
          return true
        }
        const canvas = await syncCanvasScript(saved, template, script, prevHook, user)
        sendJson(res, 200, { ok: true, project: projectBrief(saved), script: scriptView(saved, template), canvas })
        return true
      }

      if (scriptPath && req.method === 'DELETE') {
        const project = await getProject(scriptPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        const prevHook = String(project.script?.hook || template?.hook || '')
        const cleared = await clearProjectScript(project.id, user)
        if (!cleared) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const view = scriptView(cleared, template)
        // 回到模板脚本时画布也跟着回去；模板已被删掉就只清作品这边
        const canvas = view
          ? await syncCanvasScript(cleared, template, view, prevHook, user)
          : { synced: false, flowId: cleared.flowId || '', reason: 'no-script' }
        sendJson(res, 200, { ok: true, project: projectBrief(cleared), script: view, canvas })
        return true
      }

      // 作品「存成模板」（v0.9.31）：把这一版做完的脚本 + 沿用绑定模板的分镜沉淀回模板库。
      // 模板库从此不只有「发现里抄来的」与「智能体写的」，还有自己做完沉淀下来的。
      const templateFromPath = pathname.match(TEMPLATE_FROM)
      if (templateFromPath && req.method === 'POST') {
        const project = await getProject(templateFromPath[1], user)
        const template = project?.templateId ? await getTemplate(project.templateId, user) : null
        const script = project ? scriptView(project, template) : null
        const spec = projectTemplateSpec({ project, template, script })
        if (spec.status !== 200) {
          sendJson(res, spec.status, spec.body)
          return true
        }
        const body = await readBody(req)
        const saved = await createTemplateFromProject({
          source: template,
          project,
          script: spec.body.script,
          title: String(body?.title || '').trim(),
          user,
        })
        if (!saved) {
          sendJson(res, 409, {
            error: '模板没存成功：这条作品的脚本或分镜刚好被清掉了，刷新再试',
            code: 'TEMPLATE_SAVE_FAILED',
          })
          return true
        }
        sendJson(res, 201, {
          ok: true,
          template: projectTemplateReply({ template: saved, project, script }),
          sameAsTemplate: spec.body.sameAsTemplate,
        })
        return true
      }

      if (templateFromPath) {
        sendJson(res, 405, { error: '存成模板用 POST：别的写法不改任何东西', code: 'METHOD_NOT_ALLOWED' })
        return true
      }

      // 作品级只读分享：发给没有账号的人看脚本与分镜。
      // 今天只做「开 / 停」两件事：token 存在作品上，停止即清掉，旧链接当场失效。
      const sharePath = pathname.match(SHARE)
      if (sharePath && req.method === 'POST') {
        const project = await getProject(sharePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const result = await enableProjectShare(project.id, user)
        if (!result) {
          sendJson(res, 409, { error: '分享链接没开成功：作品可能刚被删掉，刷新再试', code: 'SHARE_FAILED' })
          return true
        }
        sendJson(res, 200, { ok: true, token: result.token, createdAt: result.createdAt, share: { token: result.token, createdAt: result.createdAt } })
        return true
      }

      if (sharePath && req.method === 'DELETE') {
        const done = await disableProjectShare(sharePath[1], user)
        if (done === null) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, { ok: true, share: null })
        return true
      }

      // 开一版新的：复制当前画布（节点与连线都在），旧画布归档成 vN，作品指向新画布
      const versionPath = pathname.match(VERSIONS)
      if (versionPath && req.method === 'POST') {
        const project = await getProject(versionPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        if (!project.flowId) {
          sendJson(res, 409, { error: '这条作品还没有画布：先把第一版画布开出来，再往上开新版本', code: 'NO_CANVAS' })
          return true
        }
        if (project.version >= PROJECT_VERSION_LIMIT) {
          sendJson(res, 409, {
            error: '一条作品最多保留 ' + PROJECT_VERSION_LIMIT + ' 个版本；先交付这一条，再开新的作品',
            code: 'VERSION_LIMIT',
          })
          return true
        }
        const current = await getFlow(project.flowId, user)
        if (!current) {
          sendJson(res, 409, { error: '这条作品绑定的画布不见了；先重新开一张画布，再版本化', code: 'FLOW_MISSING' })
          return true
        }
        const nextNo = project.version + 1
        const copy = await createFlow({
          name: (project.title || current.name).slice(0, 48) + ' v' + nextNo,
          description: current.description || '',
          nodes: current.nodes,
          edges: current.edges,
        }, user)
        // 归档这一版的脚本：脚本只有一份（作品级），不留快照，历史版本当时说了什么就再也查不到了
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        const updated = await archiveProjectVersion(project.id, {
          flowId: copy.id,
          prevName: current.name,
          script: scriptView(project, template),
        }, user)
        if (!updated) {
          sendJson(res, 409, { error: '开新版本没有成功：这一版没有归档，作品仍然指向原来的画布', code: 'VERSION_FAILED' })
          return true
        }
        sendJson(res, 201, { ok: true, project: updated, flow: flowBrief(copy) })
        return true
      }

      // 交付稿：把这条作品压成一份 Markdown 附件（脚本、分镜、评审结论、版本、运行）。
      // 只读、不扣积分；tz 是导出人所在的时区偏移（分钟，东经为正），稿子里的时间按它写。
      const deliverablePath = pathname.match(DELIVERABLE)
      if (deliverablePath && req.method === 'GET') {
        const project = await getProject(deliverablePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const rawTz = Number(url.searchParams.get('tz'))
        const tz = Number.isFinite(rawTz) ? Math.max(-720, Math.min(840, Math.round(rawTz))) : 480
        const { fileName, markdown } = await deliverablePayload(project, user, tz)
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          // 中文文件名走 RFC 5987：老浏览器读不到 filename* 时退回 ASCII 的名字，不会得到一个空文件名
          'Content-Disposition':
            'attachment; filename="visionqa-deliverable-' + project.id + '.md"; filename*=UTF-8\'\'' + encodeURIComponent(fileName),
          'Cache-Control': 'no-store',
        })
        res.end(markdown)
        return true
      }

      // 交付包：一份 .zip（交付稿 + 现场页 + 原片帧图），解压就能看，不用登录也不用联网。
      // 适合发给不在系统里的人（剪辑、拍摄、甲方）：他们拿到的是一整套，不是几份对不上号的附件。
      const zipPath = pathname.match(DELIVERABLE_ZIP)
      if (zipPath && req.method === 'GET') {
        const project = await getProject(zipPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const rawZipTz = Number(url.searchParams.get('tz'))
        const zipTz = Number.isFinite(rawZipTz) ? Math.max(-720, Math.min(840, Math.round(rawZipTz))) : 480
        const { fileName, markdown, detail } = await deliverablePayload(project, user, zipTz)
        const frames = await storyboardFrames(detail.template)
        const now = new Date()
        const sheet = setSheetHtml({
          project,
          script: detail.script,
          template: detail.template,
          frameBase: 'frames/',
          availableFrames: new Set(frames.map((frame) => frame.name)),
          offline: true,
          generatedAt: now.toISOString(),
          tzOffsetMinutes: zipTz,
        })
        // 评审对照页：评审评过的那张画面如果就是分镜里的帧，直接复用包里那一份；
        // 不是（另一条模板的帧）才复制进来。读不到就照实写「不在这份产物里」，不拿别的图顶。
        const reviewRecords = await reviewSheetRecords(detail, user)
        const packagedFrames = new Map(frames.map((frame) => [frame.templateId + '/' + frame.file, frame.name]))
        const reviewImages = new Map()
        const reviewExtras = []
        for (const record of reviewRecords) {
          const image = reviewImageRef(record.source)
          if (!image) continue
          const packagedName = packagedFrames.get(image.templateId + '/' + image.file)
          if (packagedName) {
            reviewImages.set(record.id, 'frames/' + packagedName)
            continue
          }
          try {
            const data = await fsp.readFile(path.join(config.framesDir, image.templateId, image.file))
            const name = '评审/对照-' + String(reviewExtras.length + 1).padStart(2, '0') + '.jpg'
            reviewExtras.push({ name, data })
            reviewImages.set(record.id, name)
          } catch {
            // 帧图被清理过（模板回收站 / 过期清理）：这张纸只印问题与编号
          }
        }
        const reviewSheet = reviewRecords.length
          ? reviewSheetHtml({
              project,
              records: reviewRecords,
              decisions: detail.decisions,
              now,
              tzOffsetMinutes: zipTz,
              offline: true,
              imageSrc: (block) => reviewImages.get(block.id) || '',
              imageNote: (block) => {
                const source = reviewImages.get(block.id)
                if (!source) return ''
                return source.startsWith('frames/')
                  ? '画面：交付包里是 ' + source
                  : '画面：这张不在分镜帧里，跟着这张纸放在 ' + source
              },
            })
          : ''
        const note = packageNote({
          model: setSheetModel({ project, script: detail.script, template: detail.template }),
          generatedAt: now.toISOString(),
          tzOffsetMinutes: zipTz,
          frameCount: frames.length,
          reviewSheetCount: reviewRecords.length,
        })
        const archive = buildZip(
          [
            { name: fileName, data: Buffer.from(markdown, 'utf8') },
            { name: '现场页.html', data: Buffer.from(sheet, 'utf8') },
            ...(reviewSheet ? [{ name: '评审对照页.html', data: Buffer.from(reviewSheet, 'utf8') }] : []),
            { name: '说明.txt', data: Buffer.from(note, 'utf8') },
            ...frames.map((frame) => ({ name: 'frames/' + frame.name, data: frame.data })),
            ...reviewExtras,
          ],
          { mtime: now },
        )
        const zipName = fileName.replace(/\.md$/i, '') + '-交付包.zip'
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition':
            'attachment; filename="visionqa-deliverable-' + project.id + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(zipName),
          'Content-Length': String(archive.length),
          'Cache-Control': 'no-store',
        })
        res.end(archive)
        return true
      }

      const item = pathname.match(ITEM)
      if (item && req.method === 'GET') {
        const project = await getProject(item[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, { ok: true, ...(await projectDetailView(project, user)) })
        return true
      }

      if (item && req.method === 'PATCH') {
        const body = await readBody(req)
        if ('flowId' in body && body.flowId) {
          const flow = await getFlow(String(body.flowId), user)
          if (!flow) {
            sendJson(res, 404, { error: '要绑定的画布不存在', code: 'FLOW_NOT_FOUND' })
            return true
          }
        }
        const patch = {}
        if ('title' in body) {
          const title = String(body.title || '').trim().slice(0, 80)
          if (!title) {
            sendJson(res, 400, { error: '作品名不能是空的', code: 'TITLE_REQUIRED' })
            return true
          }
          patch.title = title
        }
        if ('status' in body) patch.status = String(body.status || '')
        if ('flowId' in body) patch.flowId = String(body.flowId || '')
        const project = await updateProject(item[1], patch, user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, { ok: true, project })
        return true
      }

      if (item && req.method === 'DELETE') {
        const removed = await deleteProject(item[1], user)
        if (!removed) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        // 评审记录留着当历史，但不再挂在已删除的作品上
        const detached = await detachReviewsFromProject(removed.id)
        // 「已看过」是待办上的便利贴：作品没了，便利贴一起撕掉
        const droppedAcks = await dropAcksForProject(removed.id)
        // 人拍板是这条作品的结论，作品没了也不该留在盘上冒充别的作品的记录
        const droppedDecisions = await dropDecisionsForProject(removed.id)
        sendJson(res, 200, { ok: true, removed: { id: removed.id, detachedReviews: detached, droppedAcks, droppedDecisions } })
        return true
      }

      sendJson(res, 404, { error: '未知的作品接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}