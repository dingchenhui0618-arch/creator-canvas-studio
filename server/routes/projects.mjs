// /api/projects：作品（一条内容的主线对象）。
//
// 作品默认只存引用：脚本从模板读、工作流在流程服务、评审按 projectId 关联。
// 唯一例外是脚本的 copy-on-write：作品页保存脚本才复制成作品自己的版本（project-script.mjs），
// 同时把工作流里自动生成的复刻提示词换成新脚本——页面之间不能各说各话。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sendJson, readBody } from './_shared.mjs'
import { flowBrief, projectBrief } from '../project-briefs.mjs'
import { currentUser, isAdmin } from '../auth.mjs'
import { denyWorkflowBeta, workflowBetaAllowed } from '../workflow-beta.mjs'
import { normalizeShotNo, planRunAttach, runShotImages, shotFrameBlock } from '../project-shots.mjs'
import { config } from '../config.mjs'
import { createTemplateFromProject, getTemplate, listTemplates, reuseTemplate } from '../templates.mjs'
import { projectTemplateReply } from '../project-template.mjs'
import { projectTemplateReady } from '../project-template-ready.mjs'
import { templateOrigin } from '../project-source.mjs'
import { createFlow, getFlow, getRun, hasRunGraph, listRunsByFlows } from '../flows.mjs'
import { runAssetPath } from '../flow-image.mjs'
import { projectFlowIds } from '../run-ownership.mjs'
import { saveShotFrame, sweepProjectShotFrames } from '../shot-frame-store.mjs'
import { publicError } from '../public-error.mjs'
import { normalizeProjectScript, scriptPace, scriptView } from '../project-script.mjs'
import { versionBaseChangesOf, versionChangesOf } from '../version-diff.mjs'
import { versionCompareView } from '../project-compare.mjs'
import { buildReplicateDraft } from '../script-draft.mjs'
import { normalizeAssetRef } from '../asset-ref.mjs'
import { syncCanvasScript } from '../project-canvas-sync.mjs'
import {
  listReviews,
  getReview,
  reviewCountsByProject,
  reviewSpend,
  reviewSummaryByVersion,
} from '../reviews.mjs'
import { projectDeliverable } from '../project-deliverable.mjs'
import { projectSpendDetail } from '../project-spend.mjs'
import { deliverablePrintHtml, printNoticeHtml } from '../project-deliverable-html.mjs'
import { packageNote, parseShotRange, setSheetHtml, setSheetModel } from '../project-set-sheet.mjs'
import { reviewImageRef, reviewSheetHtml, reviewSheetSelection } from '../project-review-sheet.mjs'
import { compareSheetHtml } from '../project-compare-sheet.mjs'
import { packageVerifyHtml, VERIFY_PAGE_NAME } from '../package-verify-page.mjs'
import { getShareVisits, getShareVisitsByKey } from '../share-visits.mjs'
// 回执链接被打开过几次（v0.9.145）：收包人那一侧不登录，只能靠这条地址本身记
import { getReceiptVisits, recordReceiptOpen } from '../receipt-visits.mjs'
import { shareBriefsByProject } from '../share-summary.mjs'
import { ackFor, listAcks } from '../review-acks.mjs'
import { listDecisions } from '../review-decisions.mjs'
import { decisionFor, decisionHistory, reviewsForVersion } from '../project-status.mjs'
import { projectListQuery } from '../project-list.mjs'
import { canStartProject } from '../origin-entry.mjs'
import { adoptCanvasForProject, createProjectFromCanvas } from '../project-canvas.mjs'
import { buildZip, safeEntryName } from '../zip-store.mjs'
import { storyboardFrames } from '../project-frames.mjs'
import {
  deliveriesWithDisk,
  hashDeliveryPackage,
  newDeliveryPackageId,
  openDeliveryPackage,
  packageIntegrity,
  readDeliveryPackage,
  saveDeliveryPackage,
} from '../delivery-packages.mjs'
import { readAuditReport } from '../package-audits.mjs'
// 收据对账（v0.9.136）：只解析、只比对，不重打包、不联网
import { checkReceipt, RECEIPT_MAX_CHARS } from '../receipt-check.mjs'
import {
  MAX_ENTRY_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_VERIFY_BYTES,
  compareManifest,
  entryKind,
  entryMime,
  findZipEntry,
  readZipDirectoryAt,
  readZipEntryAt,
  verifyZipAt,
} from '../zip-read.mjs'
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  bindProjectFlow,
  saveProjectScript,
  setProjectShotFrame,
  setProjectShotFrames,
  saveDeliveryReceipt,
  saveDeliveryReminder,
  saveDeliveryResend,
  saveDeliveryRelink,
  saveDeliveryWaitClose,
  deliveryReceiptLink,
  issueDeliveryReceiptToken,
  findReceiptLink,
  findRetiredReceiptLink,
  noteRetiredReceiptLinkHit,
  saveReceiptByToken,
  saveDeliveryAck,
  saveDeliveryRecipient,
  RECIPIENT_LIMIT,
  saveDeliveryReply,
  deliveryReplyLength,
  REPLY_LIMIT,
  newReceiptToken,
  clearProjectScript,
  enableProjectShare,
  setProjectShareCompare,
  disableProjectShare,
  archiveProjectVersion,
  deleteProject,
  listProjectTrash,
  purgeProject,
  restoreProject,
  PROJECT_TRASH_DAYS,
  PROJECT_VERSION_LIMIT,
} from '../projects.mjs'

const ITEM = /^\/api\/projects\/([\w-]+)$/
// 这一版某一镜的画面（v0.9.161）：POST 挂一张、传空撤销
const SHOT_FRAME = /^\/api\/projects\/([\w-]+)\/shots\/(\d+)$/
// 把一次运行按分镜画出来的图一次贴回这条作品的分镜（r278）
const SHOT_FROM_RUN = /^\/api\/projects\/([\w-]+)\/shots\/from-run$/
// 作品的花费明细（v0.9.66）：合计在详情里，明细单独取，点开才读
const SPEND = /^\/api\/projects\/([\w-]+)\/spend$/
const VERSIONS = /^\/api\/projects\/([\w-]+)\/versions$/
// 某一版的脚本快照（v0.9.114）：开新版时存下的原文，只读、只给这一版
const VERSION_SCRIPT = /^\/api\/projects\/([\w-]+)\/versions\/(\d+)\/script$/
// 任意两版对照（v0.9.117）：只读，不写版本、不改工作流、不扣积分
const VERSION_COMPARE = /^\/api\/projects\/([\w-]+)\/versions\/compare$/
const SCRIPT = /^\/api\/projects\/([\w-]+)\/script$/
const CANVAS = /^\/api\/projects\/([\w-]+)\/canvas$/
const SHARE = /^\/api\/projects\/([\w-]+)\/share$/
// 作品「存成模板」：做完的这一版沉淀回模板库（脚本是这一版的，分镜沿用绑定模板的取景）
const TEMPLATE_FROM = /^\/api\/projects\/([\w-]+)\/template$/
const DELIVERABLE = /^\/api\/projects\/([\w-]+)\/deliverable$/
// 交付包：交付稿 + 现场页 + 评审对照 + 两版对照 + 帧图打成一个 zip，收件人解压就能看，不用登录
const DELIVERABLE_ZIP = /^\/api\/projects\/([\w-]+)\/deliverable\.zip$/
// 交付时封存的那一份（v0.9.125）：按作品 + 交付记录编号取，不按「今天重打一份」
const DELIVERY_PACKAGE = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})$/
// 盘上这一份还对不对（v0.9.128）：只读，流式重算 SHA-256 与档案比；不缓存、不写盘、不修文件
const DELIVERY_PACKAGE_CHECK = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/check$/
// 包里那份（v0.9.129）：读封存包自己的目录、按条目名取一条内容；只读，不解压到磁盘、不写文件
const DELIVERY_PACKAGE_CONTENT = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/content$/
// 封存包巡检报告（v0.9.132）：定时任务每天验一遍，这里只读它写下的那份结论
const PACKAGE_AUDITS = /^\/api\/projects\/([\w-]+)\/package-audits$/
const DELIVERY_PACKAGE_ENTRY = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/content\/(.+)$/
// 整包体检（v0.9.130）：逐条解开、重算 CRC32，按偏移读，内存里最多一条；只读、不缓存、不写盘
const DELIVERY_PACKAGE_VERIFY = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/verify$/
// 收据对账（v0.9.136）：把收包人发回的那段收据贴进来，跟这一条封存包的哈希比一遍；写的是核对结论，不动包
const DELIVERY_RECEIPT = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/receipt$/
// 回执链接（v0.9.137）：发一条免登录的地址给收包人，让他自己把收据贴回来。
// 这一支只是「发行 / 换一枚 token」，收据本身仍写进同一条交付记录。
const DELIVERY_RECEIPT_LINK = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/receipt-link$/
// 催一句（v0.9.144）：还没收到回执的那一条，记下「催过」并把回执链接还回来
const DELIVERY_REMINDER = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/reminder$/
// 再发一次链接（v0.9.146）：链接一次都没被打开过时，把同一条地址重新发出去，另记一个数
const DELIVERY_RESEND = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/resend$/
// 换一条新链接（v0.9.147）：同一条地址发到两次还没被打开之后，换一枚新 token，旧地址立刻失效
const DELIVERY_RELINK = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/relink$/
// 这一条是给谁的（v0.9.152）：发件人写一个称呼，工作台那一行与他要复制出去的那段话都跟着它走。
// 称呼只留在发件人这一侧：不进包、不进公开回执页（拿着链接的人不需要知道发件人怎么称呼别人）。
const DELIVERY_RECIPIENT = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/recipient$/
// 不再等这一份的回执（v0.9.158）：发件人自己把这一份收口，工作台不再把它算进「还没回来」。
// 只改这一条交付记录上的一个时间：不碰包、不碰回执、不碰链接与被打开的次数。
const DELIVERY_WAIT_CLOSE = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/wait-close$/
const DELIVERY_REPLY = /^\/api\/projects\/([\w-]+)\/delivery-packages\/([0-9a-f]{16})\/reply$/
// 收包人那一侧（v0.9.137）：token 就是凭证，不带登录态；GET 看这是哪一份、POST 把收据贴上去
const PUBLIC_RECEIPT = /^\/api\/receipts\/([0-9a-f]{16})$/
// 收包人点一下「收到了」（v0.9.151）：验完之前他手上只有这一句话可以告诉发件人
const PUBLIC_RECEIPT_ACK = /^\/api\/receipts\/([0-9a-f]{16})\/ack$/
// 打印版不进 /api：它是在新标签里打开的 HTML，地址栏里那串会印在纸的页脚上
const DELIVERABLE_PRINT = /^\/print\/projects\/([\w-]+)\/deliverable$/
// 评审对照纸：评审把问题框在哪一块画面上，同一张 A4 里印出来（交付包里也有同一份）
const REVIEW_PRINT = /^\/print\/projects\/([\w-]+)\/review$/
// 两版对照纸（v0.9.121）：把弹窗里的 v2 → v3 排成 A4，打印 / 存 PDF 带走
const COMPARE_PRINT = /^\/print\/projects\/([\w-]+)\/versions\/compare$/

// 详情 / 列表里的 project 只有一份形状（server/project-briefs.mjs）：
// 不带原始脚本、不带分享 token。工作流归作品那条路（v0.9.29）回执也用同一份。

// 工作流 beta（r313）：工作流是从作品里长出来的能力，先把作品侧收住。
// 读：当这条作品从来没挂过工作流——flowBrief 置空、版本行上的工作流指针抹掉，库里的历史值不删；
// 写：拒绝替普通账号新建或绑定工作流。作品自己的脚本、分镜、评审与交付都不依赖工作流，照旧可用。
const workflowHidden = (user) => !workflowBetaAllowed(user)

/** 作品简报去掉工作流指针：flowId 与版本行上的 flowId 置空（历史值仍在库里，只是不再下发）。 */
function briefWithoutWorkflow(brief) {
  const versions = Array.isArray(brief?.versions) ? brief.versions : []
  return {
    ...brief,
    flowId: '',
    versions: versions.map((entry) => ({ ...entry, flowId: '' })),
  }
}

/**
 * 详情里的一行版本：工作流相关的指针、可用状态、节点数与工作流名一并抹掉；脚本快照照旧保留。
 * 名字换成中性的「第 N 版」——归档名就是当时那块工作流的名字，不能从这里漏出去。
 */
function versionWithoutWorkflow(entry) {
  const { nodeList: _nodeList, ...rest } = entry || {}
  return { ...rest, flowId: '', name: '第 ' + Number(entry?.n || 0) + ' 版', available: false, nodes: 0 }
}

/** 运行摘要去掉工作流指针与节点输出：普通账号只看得到「跑过几次、成没成、花了多少」。 */
function runWithoutWorkflow(run) {
  const { flowId: _flowId, flowName: _flowName, nodes: _nodes, output: _output, ...rest } = run || {}
  return rest
}

/** 脚本保存的回执里会带「同步到了哪块工作流」：普通账号只留同步结论，不给 flowId。 */
function canvasWithoutWorkflow(canvas) {
  return canvas ? { ...canvas, flowId: '' } : canvas
}

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
    // 平台代号（douyin / xiaohongshu …）：分镜提示词靠它决定写「竖屏 9:16」还是「横屏 16:9」，
    // 与开工作流时服务端拼出图节点用的是同一个字段（r277）。
    platform: String(template.platform || '').trim(),
    structure: template.structure || [],
    storyboard: template.storyboard || [],
    timing: template.timing || null,
    cover: template.thumb || template.cover || '',
    reuseCount: Number(template.reuseCount) || 0,
    // 这条模板「从哪来」：原片链接、作者与互动数（工作流/智能体来的如实说没有原片）
    origin: templateOrigin(template),
  }
}

/**
 * 作品详情：作品页与交付稿导出读同一个函数，避免两处口径分叉。
 * 运行归集要跨版本：当前版 + 归档版的工作流一起查，开新版之后旧版的运行记录仍在作品里。
 */
async function projectDetailView(project, user, { snapshots = false } = {}) {
  // 工作流 beta（r313）：普通账号的详情里没有工作流——flowBrief 给 null、版本行的指针与节点数抹掉。
  // 运行归集仍按库里真实的 flowId 算（花费与次数是作品自己的账），只是工作流本身不再露出来。
  const hideFlow = workflowHidden(user)
  const projectFlows = [project.flowId, ...project.versions.map((entry) => entry.flowId)].filter(Boolean)
  const [template, flow, reviews, reviewCost, versionCounts, runData, acks] = await Promise.all([
    project.templateId ? getTemplate(project.templateId, user) : null,
    // 普通账号连工作流都不读：读侧抹字段是最后一道，这里先不取，少一条可能漏出去的路
    !hideFlow && project.flowId ? getFlow(project.flowId, user) : null,
    listReviews({ projectId: project.id, limit: 20 }, user),
    // 花费要算全部评审，不能只按上面那 20 条摘要：翻过页的老评审也是花过的钱
    reviewSpend(project.id, user),
    reviewSummaryByVersion(project.id, user),
    listRunsByFlows(projectFlows, { limit: 20 }, user),
    listAcks(user),
  ])
  // 归档的旧版本只存了 flowId：这里顺手确认工作流还在，已删掉的版本按钮要禁用而不是点开报错。
  // 页面只要「这一版几段脚本」；交付稿要跟上一版对比，才把快照与节点一起带上（snapshots）。
  // 「省了几版」那一层始终留在服务端：节点数组只用来算版本行的一句话，不塞进响应。
  const versionRecords = await Promise.all(project.versions.map(async (entry) => {
    const archived = !hideFlow && entry.flowId ? await getFlow(entry.flowId, user) : null
    const snapshot = entry.script || null
    return {
      n: entry.n,
      // 这一版是从哪一版复制来的：0 表示接着上一版改
      basedOn: entry.basedOn || 0,
      nodes: archived?.nodes || null,
      script: snapshot,
      view: {
        n: entry.n,
        flowId: entry.flowId,
        name: entry.name,
        archivedAt: entry.archivedAt,
        // 来源跟着版本走：归档之后仍然知道 v4 是从 v1 回来的（v0.9.116）
        basedOn: entry.basedOn || 0,
        available: Boolean(archived),
        nodes: Array.isArray(archived?.nodes) ? archived.nodes.length : 0,
        // 开新版时存下的脚本快照：这里只给段数，正文只在导出时带
        scriptBeats: Array.isArray(snapshot?.structure) ? snapshot.structure.length : 0,
        scriptSource: snapshot?.source || '',
        ...(snapshots ? { scriptSnapshot: snapshot, nodeList: archived?.nodes || null } : {}),
      },
    }
  }))
  const versions = versionRecords.map((item) => item.view)
  // 版本行上的「比上一版改了什么」：工作流按节点配置、脚本按快照，口径与交付稿同一份实现。
  // 当前版也要算（v3 相对 v2 改了什么），所以把当前工作流与脚本一起放进来；
  // base 是「以旧版为底」的那一版用来对账的底座，普通版本为 0，仍按上一版算。
  const currentScript = scriptView(project, template)
  const versionRowsForDiff = [
    ...versionRecords.map((item) => ({ n: item.n, nodes: item.nodes, script: item.script, base: item.basedOn })),
    // 普通账号只比脚本：节点给 null，一句话里就不会拼出「工作流多 1 个」这种字眼（口径仍是同一份实现）
    ...(project.version > 0 && (hideFlow || project.flowId)
      ? [{
          n: project.version,
          nodes: hideFlow ? null : (flow?.nodes || null),
          script: currentScript,
          base: project.basedOn || 0,
        }]
      : []),
  ]
  const versionChanges = versionChangesOf(versionRowsForDiff)
  // 回退版跟底座对账（v0.9.116）：老前端继续只读 versionChanges，标签仍写「比上一版」；
  // 新前端优先读这一份，把标签换成真正的底座，不会把「回到 v1 后没动」误读成「比 v3 少两段」。
  const versionBaseChanges = versionBaseChangesOf(versionRowsForDiff)
  const versionOfFlow = new Map()
  for (const entry of project.versions) versionOfFlow.set(entry.flowId, entry.n)
  if (project.flowId) versionOfFlow.set(project.flowId, project.version)
  // 工作流被删掉之后运行记录仍在（历史不该跟着消失），但「打开工作流」要禁用而不是点开报错。
  // 注意这里必须放在 versions 算好之后再建：顺序反了就是一个 ReferenceError（0.2.3 生产实测踩到）。
  const liveFlows = new Set(versions.filter((entry) => entry.available).map((entry) => entry.flowId))
  if (flow) liveFlows.add(flow.id)
  // 工作流被删掉的运行：只要当时留下过快照，就还能只读回看。
  // 这里只 stat 文件、不把快照塞进列表；available 仍表示「现在能不能打开工作流」。
  const runs = await Promise.all(runData.items.map(async (run) => {
    const available = !hideFlow && liveFlows.has(run.flowId)
    return {
      // 普通账号：历史运行只留「跑过几次、成没成、花了多少」，工作流指针与节点输出一概不给
      ...(hideFlow ? runWithoutWorkflow(run) : run),
      version: versionOfFlow.get(run.flowId) || 0,
      available,
      // 快照里是当时的节点与输出：看不到工作流的人也不该被指过去
      hasSnapshot: !hideFlow && !available ? await hasRunGraph(run.id) : false,
    }
  }))
  const runCounts = {}
  for (const [flowId, amount] of Object.entries(runData.byFlow)) {
    const version = versionOfFlow.get(flowId) || 0
    runCounts[version] = (runCounts[version] || 0) + Number(amount)
  }
  // 这条作品上花掉的积分（v0.9.65）：评审记录自己记着成本，运行记录跨版本按工作流归集，
  // 退过款的那次运行不算（钱已经回去了，再算一遍等于把退回的钱又花一次）。
  // 检索、复刻与智能体对话记在账号上：账本里没有作品，不硬摊过来。
  const runCredits = projectFlows.reduce((sum, flowId) => sum + Number(runData.creditsByFlow?.[flowId] || 0), 0)
  const spend = {
    unit: config.credits.unit,
    total: Number(reviewCost.credits) + runCredits,
    reviews: { count: Number(reviewCost.count) || 0, credits: Number(reviewCost.credits) || 0 },
    runs: { count: Number(runData.total) || 0, credits: runCredits },
    lastAt: [reviewCost.lastAt, runs[0]?.startedAt].filter(Boolean).sort().pop() || '',
  }
  const flowView = hideFlow ? null : flowBrief(flow)
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
  // 盘上还在不在（v0.9.128）：每条封存包只 stat 一次，作品页不用点开就能知道包还在不在。
  // 只加一个 disk 字段，档案里的字节数与哈希原样不动。
  const projectView = projectBrief(project)
  // 回执链接被打开过几次（v0.9.145）：只挂在「发链接时已经开始记」的那几条上——
  // 升级前发的链接没有发出时间，说「还没被打开」就是瞎猜。列表接口不给这一项。
  const projectDeliveries = await Promise.all(
    (await deliveriesWithDisk(project.id, projectView.deliveries || [])).map(async (delivery) =>
      delivery.receiptToken && delivery.receiptLinkAt
        ? { ...delivery, visits: await getReceiptVisits(delivery.receiptToken) }
        : delivery,
    ),
  )
  const projectBody = { ...projectView, deliveries: projectDeliveries }
  return {
    project: hideFlow ? briefWithoutWorkflow(projectBody) : projectBody,
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
    script: currentScript,
    reviews: reviews.items,
    // 拍板记录按时间倒序（纸要按版次各印各的，胶囊只用其中管当前这一版的那条）
    decisions: decisionLog,
    decision,
    // 当前这一版看过了没有：对不上就是 null（评出新结论或开了新版自动作废）
    ack,
    versions: hideFlow ? versions.map(versionWithoutWorkflow) : versions,
    versionCounts,
    // 版本行的一句话（v0.9.114）：键是版次，值写「比上一版改了什么」；比不了就没有这一项
    versionChanges,
    // 以旧版为底的那一版跟底座对账（v0.9.116）：{ '4': { base: 1, text: '工作流与脚本都没动' } }
    versionBaseChanges,
    runs,
    runTotal: runData.total,
    runCounts,
    // 这条作品花了多少积分：合计、评审与运行各多少、最近一次是什么时候
    spend,
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

/**
 * 打一份交付包（v0.9.125 抽成函数）：下载时现打与「标记交付」时封存读同一份实现，
 * 不会出现「刚交的包」和「点下载拿到的包」内容不一样。
 */
async function buildProjectDeliveryArchive(project, user, tzOffsetMinutes) {
  const { fileName, markdown, detail } = await deliverablePayload(project, user, tzOffsetMinutes)
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
    tzOffsetMinutes,
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
        tzOffsetMinutes,
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
  // 两版对照页（v0.9.122）：交付包是给「没有账号的人」的一整套，
  // 这一版改了什么也该在里面，而不是只活在作品页弹窗。只打当前版与上一版：
  // 包里对应的是「这次交出去的东西」，不是一条作品的完整版本史。
  let compareSheet = ''
  let compareSheetPair = null
  if (project.version >= 2) {
    const baseNo = project.version - 1
    const built = await versionCompareView(project, user, baseNo, project.version, { hideWorkflow: workflowHidden(user) })
    if (built.ok) {
      compareSheet = compareSheetHtml({
        project,
        compare: built.view,
        now,
        tzOffsetMinutes,
        // 包里没有作品页可回：不印「返回作品」这类会点到 file:// 死链接的入口；
        // 品牌图也换成文字，离线打开不欠一张破图
        projectId: '',
        offline: true,
      })
      compareSheetPair = { base: baseNo, target: project.version }
    }
  }
  const zipName = fileName.replace(/\.md$/i, '') + '-交付包.zip'
  const note = packageNote({
    model: setSheetModel({ project, script: detail.script, template: detail.template }),
    generatedAt: now.toISOString(),
    tzOffsetMinutes,
    frameCount: frames.length,
    reviewSheetCount: reviewRecords.length,
    compareSheet: compareSheetPair,
  })
  const entries = [
    { name: fileName, data: Buffer.from(markdown, 'utf8') },
    { name: '现场页.html', data: Buffer.from(sheet, 'utf8') },
    ...(reviewSheet ? [{ name: '评审对照页.html', data: Buffer.from(reviewSheet, 'utf8') }] : []),
    ...(compareSheet ? [{ name: '两版对照页.html', data: Buffer.from(compareSheet, 'utf8') }] : []),
    { name: '说明.txt', data: Buffer.from(note, 'utf8') },
    ...frames.map((frame) => ({ name: 'frames/' + frame.name, data: frame.data })),
    ...reviewExtras,
  ]
  // 校验页（v0.9.133）：收包人拿到的不是一句「请相信我们」，而是一张能自己算一遍的纸。
  // 清单只记上面这些条目：这一页没法记自己的哈希，所以它生成之后再插进包里（说明.txt 后面）。
  const verifyPage = packageVerifyHtml({
    project: { id: project.id, title: project.title, version: project.version },
    zipName,
    entries,
    generatedAt: now.toISOString(),
    tzOffsetMinutes,
  })
  const noteIndex = entries.findIndex((entry) => entry.name === '说明.txt')
  entries.splice(noteIndex + 1, 0, { name: VERIFY_PAGE_NAME, data: Buffer.from(verifyPage, 'utf8') })

  const archive = buildZip(entries, { mtime: now })
  // 包内清单跟包一起落进交付记录（v0.9.126）：名字走 safeEntryName，和 zip 里的条目一致；
  // 大小按实际写进去的字节算，界面不用再猜。
  const files = entries.map((entry) => ({
    name: safeEntryName(entry.name),
    bytes: Buffer.isBuffer(entry.data) ? entry.data.length : Buffer.byteLength(String(entry.data ?? ''), 'utf8'),
  }))
  return { archive, fileName, zipName, now, files }
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
    extraPrefixes: ['/print/projects', '/api/receipts'],
    async handle(req, res, url, pathname) {
      if (
        !pathname.startsWith('/api/projects') &&
        !pathname.startsWith('/print/projects') &&
        !pathname.startsWith('/api/receipts')
      ) {
        return false
      }
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

      // 两版对照纸（v0.9.121）：与弹窗同一份取数，排成 A4 带走。
      const comparePrintPath = pathname.match(COMPARE_PRINT)
      if (comparePrintPath && req.method === 'GET') {
        if (!user && config.auth.requireAuth) {
          sendPrintNotice(res, 401, {
            title: '登录已过期',
            message: '这个打印页要用你的登录态取数据：回到作品页打开「两版对照」，再点「打印对照」，或者先登录。',
            href: '/#/login',
            label: '去登录',
          })
          return true
        }
        const printable = await getProject(comparePrintPath[1], user)
        if (!printable) {
          sendPrintNotice(res, 404, {
            title: '作品不在了',
            message: '这条作品可能已经被删除。回作品列表看看还在不在。',
            href: '/#/projects',
            label: '回作品列表',
          })
          return true
        }
        const baseNo = Number(url.searchParams.get('base'))
        const targetNo = Number(url.searchParams.get('target'))
        const valid = (n) => Number.isInteger(n) && n >= 1 && n <= printable.version
        if (!valid(baseNo) || !valid(targetNo) || baseNo === targetNo) {
          sendPrintNotice(res, 400, {
            title: '这两版对不上',
            message: '对照纸要选两个不同的版本，且都在 1 到 v' + printable.version + ' 之间。回作品页重新选一次。',
            href: '/#/projects/' + encodeURIComponent(printable.id),
            label: '回作品页',
          })
          return true
        }
        const built = await versionCompareView(printable, user, baseNo, targetNo, { hideWorkflow: workflowHidden(user) })
        if (!built.ok) {
          sendPrintNotice(res, 404, {
            title: '有一版没有归档记录',
            message: '这条作品没有 v' + built.missing + ' 的归档记录，没法印这张对照纸。回作品页看看还在不在。',
            href: '/#/projects/' + encodeURIComponent(printable.id),
            label: '回作品页',
          })
          return true
        }
        const rawCompareTz = Number(url.searchParams.get('tz'))
        const compareTz = Number.isFinite(rawCompareTz) ? Math.max(-720, Math.min(840, Math.round(rawCompareTz))) : 480
        res.writeHead(200, PRINT_HEAD)
        res.end(
          compareSheetHtml({
            project: printable,
            compare: built.view,
            now: new Date(),
            tzOffsetMinutes: compareTz,
            projectId: printable.id,
          }),
        )
        return true
      }

      // 生产必须登录；本地演示（VQ_REQUIRE_AUTH=0）沿用模板/评审的做法：不认人但照常可用。
      // /api/receipts（v0.9.137）是收包人的回执链接：那一侧本来就没有账号，
      // 它由自己那条带 token 的分支处理，不能在这道门就 401。
      if (!pathname.startsWith('/api/receipts') && !user && config.auth.requireAuth) {
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
        // 运行归集：所有作品名下（含归档版本）的工作流一次取回来，卡片上就能写「跑过几次」。
        // byFlow 把运行次数按工作流分组，跨版本加总才有意义——只取一条记录，这里只要计数。
        const projectFlows = projects.flatMap((project) => [project.flowId, ...project.versions.map((entry) => entry.flowId)])
        const runAgg = projectFlows.filter(Boolean).length
          ? await listRunsByFlows(projectFlows, { limit: 1 }, user)
          : { byFlow: {}, creditsByFlow: {} }
        // 卡片上的分享状态：只挂一条摘要（还在分享吗、几轮、打开几次），token 与每轮明细都不出这个接口
        const shareBriefs = await shareBriefsByProject(projects)
        const items = []
        for (const project of projects) {
          const template = project.templateId ? await getTemplate(project.templateId, user) : null
          const counters = reviews[project.id] || { count: 0, credits: 0, lastVerdict: '', lastAt: '', versions: {} }
          const ownFlows = [project.flowId, ...project.versions.map((entry) => entry.flowId)].filter(Boolean)
          const runs = ownFlows.reduce((sum, flowId) => sum + (runAgg.byFlow[flowId] || 0), 0)
          const runCredits = ownFlows.reduce((sum, flowId) => sum + Number(runAgg.creditsByFlow?.[flowId] || 0), 0)
          items.push({
            ...projectBrief(project),
            template: templateBrief(template),
            // 总数给「评过几次」，按版本的分组给状态胶囊判断当前这一版
            reviews: { count: counters.count, lastVerdict: counters.lastVerdict, lastAt: counters.lastAt },
            versionCounts: counters.versions || {},
            // 卡片上的花费与作品页同一套口径（评审 + 工作流运行，退款不算）
            spend: {
              unit: config.credits.unit,
              total: Number(counters.credits || 0) + runCredits,
              reviews: { count: counters.count, credits: Number(counters.credits || 0) },
              runs: { count: runs, credits: runCredits },
            },
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
        // 工作流 beta（r313）：列表里同样没有工作流指针（flowId 与版本行），作品自己的字段一个不少。
        const okItems = workflowHidden(user) ? listed.items.map(briefWithoutWorkflow) : listed.items
        sendJson(res, 200, { ok: true, ...listed, items: okItems })
        return true
      }

      if (pathname === '/api/projects' && req.method === 'POST') {
        const body = await readBody(req)
        // 从工作流建作品（v0.9.29）：空白工作流跑出来的东西也该能变成一条作品。
        // 这条路没有模板，脚本在作品页现写，工作流已经在了所以一出生就是 v1。
        if (String(body.flowId || '')) {
          // 工作流 beta（r313）：从工作流建作品的前提是「手里有一块工作流」，普通账号没有这条路。
          // 判断排在建作品 / 读工作流之前，不留下建了一半的记录。
          if (workflowHidden(user)) return denyWorkflowBeta(res)
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
            error: '作品要么从一条模板开始，要么从一块工作流开始：先选模板或选工作流',
            code: 'TEMPLATE_REQUIRED',
          })
          return true
        }
        const template = await getTemplate(templateId, user)
        if (!template) {
          sendJson(res, 404, { error: '模板不存在或不属于当前账号' })
          return true
        }
        // 能不能开作品只在这个函数里判断：界面上的「开成作品」也读它，不各写一份（v0.9.39）
        if (!canStartProject(template)) {
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
      // 工作流归作品（v0.9.29）：把一块已经跑过的工作流接到这条作品上。
      // 一接上，这块工作流以前的运行与之后的评审就都落进这条作品——运行记录那边也能「归到作品」。
      if (canvasPath && req.method === 'PUT') {
        // 工作流 beta（r313）：绑定 Project.flowId 等于「用工作流」，非管理员一律拒，且排在读作品之前。
        if (workflowHidden(user)) return denyWorkflowBeta(res)
        const body = await readBody(req)
        const result = await adoptCanvasForProject({ projectId: canvasPath[1], flowId: String(body.flowId || ''), user })
        sendJson(res, result.status, result.body)
        return true
      }

      // 作品页开工作流：第一张工作流用这条作品现在的脚本生成，不再绕到模板库的 apply
      if (canvasPath && req.method === 'POST') {
        // 工作流 beta（r313）：这条入口会替作品建一块新工作流，非管理员不许再新建（排在读作品 / 写盘之前）。
        if (workflowHidden(user)) return denyWorkflowBeta(res)
        const project = await getProject(canvasPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        // 已经有工作流就直接回去：重复点「开工作流」不该生成第二张
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
        // 分镜出图节点继承作品挂的参考资产：带上「我的商品图 / 我的脸」，
        // 跑一次工作流画出来的每一镜才是我的东西，而不是凭空重画一张。
        const flow = await createFlow(
          buildReplicateDraft({ template: template || {}, script, name: project.title, assetRef: project.assetRef }),
          user,
        )
        const bound = await bindProjectFlow(project.id, flow.id, user)
        if (!bound) {
          sendJson(res, 409, { error: '工作流建好了但没绑上作品：检查这条作品是否还在', code: 'BIND_FAILED' })
          return true
        }
        if (template) await reuseTemplate(template.id)
        sendJson(res, 201, { ok: true, created: true, project: projectBrief(bound), flow: flowBrief(flow) })
        return true
      }

      // 作品页直接改脚本：第一次保存把模板脚本复制成作品自己的版本（copy-on-write），
      // 再把工作流里自动生成的复刻提示词换成新脚本。模板不动，别的作品也不动。
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
        // 工作流 beta（r313）：同步照旧做（脚本是核心功能），但回执里不带 flowId。
        const hideFlow = workflowHidden(user)
        sendJson(res, 200, {
          ok: true,
          project: hideFlow ? briefWithoutWorkflow(projectBrief(saved)) : projectBrief(saved),
          script: scriptView(saved, template),
          canvas: hideFlow ? canvasWithoutWorkflow(canvas) : canvas,
        })
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
        // 回到模板脚本时工作流也跟着回去；模板已被删掉就只清作品这边
        const canvas = view
          ? await syncCanvasScript(cleared, template, view, prevHook, user)
          : { synced: false, flowId: cleared.flowId || '', reason: 'no-script' }
        const hideFlow = workflowHidden(user)
        sendJson(res, 200, {
          ok: true,
          project: hideFlow ? briefWithoutWorkflow(projectBrief(cleared)) : projectBrief(cleared),
          script: view,
          canvas: hideFlow ? canvasWithoutWorkflow(canvas) : canvas,
        })
        return true
      }

      // 作品「存成模板」（v0.9.31）：把这一版做完的脚本 + 沿用绑定模板的分镜沉淀回模板库。
      // 模板库从此不只有「发现里抄来的」与「智能体写的」，还有自己做完沉淀下来的。
      const templateFromPath = pathname.match(TEMPLATE_FROM)
      if (templateFromPath && req.method === 'POST') {
        const project = await getProject(templateFromPath[1], user)
        // 判断与评审页那个「存成模板」出口同一处（project-template-ready.mjs），两边不会各说一套
        const { spec, script, template } = await projectTemplateReady(project, user)
        if (spec.status !== 200) {
          sendJson(res, spec.status, spec.body)
          return true
        }
        // 沉淀时把这一版最近一次的评审结论一起记下来（r252）：模板库要能说清「这条是评过什么存下来的」。
        // 口径与作品页状态胶囊、拍板一致（reviewsForVersion），不为这个数另算一套。
        const counters = (await reviewCountsByProject(user))[project.id]
        const latest = reviewsForVersion(counters?.versions || {}, Number(project.version) || 0)
        const body = await readBody(req)
        const saved = await createTemplateFromProject({
          source: template,
          project,
          script: spec.body.script,
          title: String(body?.title || '').trim(),
          user,
          review: { verdict: latest.lastVerdict, at: latest.lastAt, issues: latest.issues },
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
      // 「开 / 停 / 是否带两版对照」三件事：token 存在作品上，停止即清掉，旧链接当场失效；
      // 对照开关不改 token，已经发出去的链接继续有效。
      const sharePath = pathname.match(SHARE)
      if (sharePath && req.method === 'POST') {
        const project = await getProject(sharePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        // 开分享的请求体是可选的：没有 body 的调用（脚本、测试）照旧按“不带对照”处理。
        // 真实 HTTP 请求是可读流；不是流时不要为了一个可选字段把它读挂。
        const body = req && typeof req[Symbol.asyncIterator] === 'function' ? await readBody(req) : null
        if (body?.compare !== undefined && typeof body.compare !== 'boolean') {
          sendJson(res, 400, { error: 'compare 只能是 true 或 false', code: 'SHARE_COMPARE_INVALID' })
          return true
        }
        const result = await enableProjectShare(project.id, user, { compare: body?.compare === true })
        if (!result) {
          sendJson(res, 409, { error: '分享链接没开成功：作品可能刚被删掉，刷新再试', code: 'SHARE_FAILED' })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          token: result.token,
          createdAt: result.createdAt,
          share: { token: result.token, createdAt: result.createdAt, compare: result.compare === true },
        })
        return true
      }

      // 已经开着分享时切换对照纸：只改一个布尔字段，不换 token、不碰作品内容
      if (sharePath && req.method === 'PATCH') {
        const project = await getProject(sharePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const body = await readBody(req)
        if (typeof body?.compare !== 'boolean') {
          sendJson(res, 400, { error: '要明确写 compare: true 或 false', code: 'SHARE_COMPARE_INVALID' })
          return true
        }
        if (!project.share) {
          sendJson(res, 409, { error: '还没开分享：先开一条链接，再决定带不带两版对照', code: 'SHARE_NOT_OPEN' })
          return true
        }
        const result = await setProjectShareCompare(project.id, user, body.compare)
        if (!result) {
          sendJson(res, 409, { error: '分享对照没切换成功：刷新再试', code: 'SHARE_COMPARE_FAILED' })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          share: { token: result.token, createdAt: result.createdAt, compare: result.compare === true },
        })
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

      // 开一版新的：复制当前工作流（节点与连线都在），旧工作流归档成 vN，作品指向新工作流
      const versionPath = pathname.match(VERSIONS)
      if (versionPath && req.method === 'POST') {
        // 工作流 beta（r313）：开新版是作品的核心动作，普通账号照常允许——只是不再顺带复制工作流
        // （hideFlow 分支：作品原来指着的那块原样留在库里、不再下发，新一版没有工作流指针）。
        // 判权在这一行定死，下面读盘、建工作流之前都用同一个口径。
        const hideFlow = workflowHidden(user)
        const project = await getProject(versionPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        // 没有工作流也能开版（普通账号）：只进版次；管理员那条路仍要求先有工作流可复制
        if (!hideFlow && !project.flowId) {
          sendJson(res, 409, { error: '这条作品还没有工作流：先把第一版工作流开出来，再往上开新版本', code: 'NO_CANVAS' })
          return true
        }
        if (project.version >= PROJECT_VERSION_LIMIT) {
          sendJson(res, 409, {
            error: '一条作品最多保留 ' + PROJECT_VERSION_LIMIT + ' 个版本；先交付这一条，再开新的作品',
            code: 'VERSION_LIMIT',
          })
          return true
        }
        // 普通账号不读工作流：判权之后就不再碰它，节点一个都不取
        const current = hideFlow ? null : await getFlow(project.flowId, user)
        if (!hideFlow && !current) {
          sendJson(res, 409, { error: '这条作品绑定的工作流不见了；先重新开一张工作流，再版本化', code: 'FLOW_MISSING' })
          return true
        }
        const nextNo = project.version + 1
        // 以旧版为底（v0.9.115）：from 指向一条更早的归档版本，复制它的工作流与脚本。
        // 不传 from 就是原来的「从当前版往上一版」——两条路都先把当前版归档，历史不动。
        const body = await readBody(req)
        const rawFrom = body?.from
        const from = rawFrom === undefined || rawFrom === null || rawFrom === '' ? 0 : Number(rawFrom)
        if (from) {
          if (!Number.isInteger(from) || from < 1 || from >= project.version) {
            sendJson(res, 400, {
              error: '只能以更早的版本为底：from 必须是 1 到 ' + (project.version - 1) + ' 之间的整数',
              code: 'VERSION_FROM_INVALID',
            })
            return true
          }
        }
        let sourceFlow = null
        let nextScript = null
        if (from) {
          const source = project.versions.find((entry) => entry.n === from)
          if (!source) {
            sendJson(res, 404, { error: '这条作品没有 v' + from + ' 的归档记录', code: 'VERSION_FROM_MISSING' })
            return true
          }
          if (!source.script) {
            sendJson(res, 409, {
              error: hideFlow
                ? 'v' + from + ' 开版时没有存脚本快照：没法整版回到当时，只能在那一版上重写'
                : 'v' + from + ' 开版时没有存脚本快照：没法整版回到当时，只能打开那一版工作流手动改',
              code: 'VERSION_SCRIPT_MISSING',
            })
            return true
          }
          if (!hideFlow) {
            sourceFlow = await getFlow(source.flowId, user)
            if (!sourceFlow) {
              sendJson(res, 409, {
                error: 'v' + from + ' 的工作流已经被删除：没法以它为底再开一版',
                code: 'VERSION_FLOW_MISSING',
              })
              return true
            }
          }
          nextScript = source.script
        }
        // 归档这一版的脚本：脚本只有一份（作品级），开版时存一份快照，历史版本当时说了什么还能查
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        if (hideFlow) {
          // 普通账号：只归档脚本快照、版次 +1，一块新工作流都不建，库里旧数据一个字节不动。
          // 版本行的名字也不写工作流名：普通账号那边看不到工作流，别从版本行漏出去。
          const updated = await archiveProjectVersion(project.id, {
            prevName: '第 ' + project.version + ' 版',
            script: scriptView(project, template),
            ...(nextScript ? { nextScript } : {}),
            basedOn: from,
            keepFlow: true,
          }, user)
          if (!updated) {
            sendJson(res, 409, { error: '开新版本没有成功：这一版没有归档，作品仍然停在原来的版本', code: 'VERSION_FAILED' })
            return true
          }
          sendJson(res, 201, {
            ok: true,
            project: briefWithoutWorkflow(projectBrief(updated)),
            ...(from ? { basedOn: from } : {}),
          })
          return true
        }
        const copy = await createFlow(sourceFlow ? {
          name: ((project.title || sourceFlow.name).slice(0, 40) + ' v' + nextNo + ' · 以 v' + from + ' 为底').slice(0, 60),
          description: '以 v' + from + ' 的工作流和脚本为底重新开的一版',
          nodes: sourceFlow.nodes,
          edges: sourceFlow.edges,
        } : {
          name: (project.title || current.name).slice(0, 48) + ' v' + nextNo,
          description: current.description || '',
          nodes: current.nodes,
          edges: current.edges,
        }, user)
        const updated = await archiveProjectVersion(project.id, {
          flowId: copy.id,
          prevName: current.name,
          script: scriptView(project, template),
          ...(nextScript ? { nextScript } : {}),
          // 来源写进这一版：刷新、归档之后都还知道它是从哪一版回来的
          basedOn: from,
        }, user)
        if (!updated) {
          sendJson(res, 409, { error: '开新版本没有成功：这一版没有归档，作品仍然指向原来的工作流', code: 'VERSION_FAILED' })
          return true
        }
        sendJson(res, 201, { ok: true, project: updated, flow: flowBrief(copy), ...(from ? { basedOn: from } : {}) })
        return true
      }

      // 任意两版对照（v0.9.117）：只读。方向是 base → target，两版都能从归档或当前版取。
      // 工作流与脚本各读各的：当前版读现在的，归档版读快照；哪一侧读不到就如实说，不拿别的版本顶替。
      const comparePath = pathname.match(VERSION_COMPARE)
      if (comparePath && req.method === 'GET') {
        const project = await getProject(comparePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const baseNo = Number(url.searchParams.get('base'))
        const targetNo = Number(url.searchParams.get('target'))
        const valid = (n) => Number.isInteger(n) && n >= 1 && n <= project.version
        if (!valid(baseNo) || !valid(targetNo)) {
          sendJson(res, 400, {
            error: '对照的版次不对：base 与 target 都必须是 1 到 ' + project.version + ' 之间的整数',
            code: 'VERSION_COMPARE_INVALID',
          })
          return true
        }
        if (baseNo === targetNo) {
          sendJson(res, 400, { error: '两版对照要选两个不同的版本', code: 'VERSION_COMPARE_SAME' })
          return true
        }
        const built = await versionCompareView(project, user, baseNo, targetNo, { hideWorkflow: workflowHidden(user) })
        if (!built.ok) {
          sendJson(res, 404, { error: '这条作品没有 v' + built.missing + ' 的归档记录', code: 'VERSION_COMPARE_MISSING' })
          return true
        }
        sendJson(res, 200, { ok: true, ...built.view })
        return true
      }

      // 某一版的脚本快照（v0.9.114）：只读，不扣费、不改任何东西。
      // 当前版直接读作品现在的脚本；归档版只读开新版时存下的那一份，不拿现在的脚本冒充。
      const versionScriptPath = pathname.match(VERSION_SCRIPT)
      if (versionScriptPath && req.method === 'GET') {
        const project = await getProject(versionScriptPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const n = Number(versionScriptPath[2])
        if (!Number.isInteger(n) || n <= 0) {
          sendJson(res, 400, { error: '版本号不对：必须是 1 起的整数' })
          return true
        }
        if (n === project.version) {
          const template = project.templateId ? await getTemplate(project.templateId, user) : null
          const script = scriptView(project, template)
          sendJson(res, 200, {
            ok: true,
            n,
            current: true,
            name: '',
            archivedAt: '',
            script,
            reason: script ? '' : '这一版还没写脚本',
          })
          return true
        }
        const archived = project.versions.find((entry) => entry.n === n)
        if (!archived) {
          sendJson(res, 404, { error: '这条作品没有 v' + n })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          n,
          current: false,
          name: workflowHidden(user) ? '第 ' + n + ' 版' : archived.name,
          archivedAt: archived.archivedAt,
          script: archived.script || null,
          reason: archived.script ? '' : '这一版开版时还没有脚本快照：当时的口播找不回来了',
        })
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

      // 交付包：一份 .zip（交付稿 + 现场页 + 评审对照 + 两版对照 + 原片帧图），解压就能看，不用登录也不用联网。
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
        const { archive, zipName } = await buildProjectDeliveryArchive(project, user, zipTz)
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

      // 巡检报告（v0.9.132）：定时任务把盘上每个封存包验一遍后写下的结论。
      // 只读这一份报告；没巡检过就如实说「还没巡检」，不拿今天的临时体检冒充满意。
      const packageAudits = pathname.match(PACKAGE_AUDITS)
      if (packageAudits) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '巡检报告只能读，不能修改' })
          return true
        }
        const project = await getProject(packageAudits[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const report = await readAuditReport()
        const packages = (report?.packages || [])
          .filter((item) => item && item.projectId === project.id)
          .map((item) => ({
            deliveryId: String(item.deliveryId || ''),
            version: Number(item.version) || 0,
            state: String(item.state || ''),
            ok: Boolean(item.ok),
            total: Number(item.total) || 0,
            passed: Number(item.passed) || 0,
            skipped: Number(item.skipped) || 0,
            failed: Array.isArray(item.failed) ? item.failed : [],
            bytes: Number(item.bytes) || 0,
            readBytes: Number(item.readBytes) || 0,
            ms: Number(item.ms) || 0,
          }))
        sendJson(res, 200, {
          ok: true,
          at: report?.at || '',
          checked: packages.length,
          problems: packages.filter((item) => !item.ok).length,
          packages,
        })
        return true
      }

      // 交付时封存的那一份（v0.9.125）：只读、按作品登录态取；没有包的老记录明确说 404，
      // 不拿今天现打的包冒充「当初交出去的那一份」。
      const packagePath = pathname.match(DELIVERY_PACKAGE)
      if (packagePath) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '交付包只能下载，不能修改' })
          return true
        }
        const project = await getProject(packagePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const delivery = (project.deliveries || []).find((entry) => entry.id === packagePath[2] && entry.package)
        if (!delivery) {
          sendJson(res, 404, { error: '这一条交付没有封存包，或者包已经不在了' })
          return true
        }
        const archive = await readDeliveryPackage(project.id, delivery.id)
        if (!archive) {
          sendJson(res, 404, { error: '封存的交付包不在了；作品页还能按今天的样子重新打一份' })
          return true
        }
        const fileName = delivery.package.fileName || 'VisionQA-交付包.zip'
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition':
            'attachment; filename="visionqa-delivery-' + project.id + '-v' + delivery.version + '.zip"; filename*=UTF-8\'\'' + encodeURIComponent(fileName),
          'Content-Length': String(archive.length),
          // 封存时的 SHA-256：解压前可以先核对「还是不是当初那一份」
          'X-VQ-Package-SHA256': delivery.package.sha256,
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex',
        })
        res.end(archive)
        return true
      }

      // 盘上这一份还对不对（v0.9.128）：只读，流式重算 SHA-256 与档案比。
      // 不缓存结果：要的就是「现在」这一份；不清文件、不改档案、不写盘。
      const packageCheck = pathname.match(DELIVERY_PACKAGE_CHECK)
      if (packageCheck) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '封存包只能核对，不能修改' })
          return true
        }
        const project = await getProject(packageCheck[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const delivery = (project.deliveries || []).find((entry) => entry.id === packageCheck[2] && entry.package)
        if (!delivery) {
          sendJson(res, 404, { error: '这一条交付没有封存包，或者包已经不在了' })
          return true
        }
        const actual = await hashDeliveryPackage(project.id, delivery.id)
        const integrity = packageIntegrity(delivery.package, actual)
        sendJson(res, 200, {
          ok: integrity.ok,
          state: integrity.state,
          checkedAt: new Date().toISOString(),
          expected: { sha256: delivery.package.sha256 || '', bytes: Number(delivery.package.bytes) || 0 },
          actual: actual ? { sha256: actual.sha256, bytes: actual.bytes } : null,
        })
        return true
      }

      // 包里那份（v0.9.129）：直接读封存包自己的目录，不只看档案里记的那份清单。
      // 只读：不缓存、不解压到磁盘、不写任何文件；包仍只认登录态，也没有公开地址。
      const packageContent = pathname.match(DELIVERY_PACKAGE_CONTENT)
      if (packageContent) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '封存包的内容只能读，不能修改' })
          return true
        }
        const project = await getProject(packageContent[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const delivery = (project.deliveries || []).find((entry) => entry.id === packageContent[2] && entry.package)
        if (!delivery) {
          sendJson(res, 404, { error: '这一条交付没有封存包，或者包已经不在了' })
          return true
        }
        const handle = await openDeliveryPackage(project.id, delivery.id)
        if (!handle) {
          sendJson(res, 404, { error: '盘上那份封存包不在了；包内清单还能看档案里记的那一份' })
          return true
        }
        // 按偏移读：只读尾部与中央目录这一小段，不把整包读进内存（v0.9.131）
        let directory
        try {
          if (handle.size > MAX_PACKAGE_BYTES) {
            sendJson(res, 413, {
              error: '这个包超过 ' + Math.round(MAX_PACKAGE_BYTES / (1024 * 1024)) + ' MB，太大了不能在这里读目录；下载下来再看',
            })
            return true
          }
          directory = readZipDirectoryAt(handle.fd, handle.size)
        } finally {
          await handle.close()
        }
        if (!directory) {
          sendJson(res, 200, {
            ok: false,
            state: 'unreadable',
            error: '包里的目录读不出来：可能被截断，或者尾部被改过',
          })
          return true
        }
        // 档案里记过清单才比较：老包没记过，不把整包说成「多出来的」
        const manifest = delivery.package.files?.length ? compareManifest(directory.entries, delivery.package.files) : null
        sendJson(res, 200, {
          ok: true,
          state: 'ok',
          readAt: new Date().toISOString(),
          bytes: handle.size,
          readBytes: directory.readBytes,
          entries: directory.entries.map((entry) => ({
            name: entry.name,
            bytes: entry.bytes,
            kind: entryKind(entry.name),
          })),
          manifest,
        })
        return true
      }

      // 收据对账（v0.9.136）：收包人把校验页给出的收据发回来，发件人贴进作品页对一遍。
      // 只读收据文字与档案里的包元数据，写一条核对结论；不重打包、不解压、不联网。
      const receiptPath = pathname.match(DELIVERY_RECEIPT)
      if (receiptPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '收据只能用 POST 贴进来，不能读也不能改' })
          return true
        }
        // 核对结果挂在别人的交付记录上：必须要他自己的作品；本地演示（VQ_REQUIRE_AUTH=0）不认人
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到作品页再贴一次' })
          return true
        }
        const project = await getProject(receiptPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const delivery = (project.deliveries || []).find((entry) => entry.id === receiptPath[2] && entry.package)
        if (!delivery) {
          sendJson(res, 404, { error: '这一条交付没有封存包，没有可比的哈希' })
          return true
        }
        const body = await readBody(req)
        const text = String(body?.text ?? '')
        if (!text.trim()) {
          sendJson(res, 400, { error: '要贴一段收据：{"text": "VisionQA …核对 …"}', code: 'RECEIPT_REQUIRED' })
          return true
        }
        if (text.length > RECEIPT_MAX_CHARS) {
          sendJson(res, 413, { error: '这段太长了（超过 ' + RECEIPT_MAX_CHARS + ' 字）：只贴收据那几行', code: 'RECEIPT_TOO_LONG' })
          return true
        }
        const check = checkReceipt({ text, delivery })
        if (!check.parsed) {
          sendJson(res, 422, { error: check.error, code: 'RECEIPT_UNREADABLE' })
          return true
        }
        const saved = await saveDeliveryReceipt(
          project.id,
          delivery.id,
          {
            at: new Date().toISOString(),
            state: check.state,
            summary: check.summary,
            problems: check.problems,
            checks: check.checks,
            claimed: check.claimed,
            // 这张是发件人替他贴的：收包人自己贴回来的走下面那条 token 接口，记 'link'
            via: 'you',
          },
          user,
        )
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付记录不在了，刷新一下再试' })
          return true
        }
        sendJson(res, 200, {
          ok: check.state === 'match',
          state: check.state,
          summary: check.summary,
          problems: check.problems,
          checks: check.checks,
          receipt: saved.delivery.receipt,
        })
        return true
      }

      // 回执链接（v0.9.137）：档案里复制一条地址发出去，收包人打开就能自己贴收据。
      // 换一枚 token 就是让旧地址立刻失效；不换的时候只是把已有的那枚还回去。
      const receiptLinkPath = pathname.match(DELIVERY_RECEIPT_LINK)
      if (receiptLinkPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '回执链接只能用 POST 生成或换一条' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到作品页再复制链接' })
          return true
        }
        const body = await readBody(req)
        const issued = await issueDeliveryReceiptToken(receiptLinkPath[1], receiptLinkPath[2], user, {
          rotate: body?.rotate === true,
        })
        if (!issued) {
          sendJson(res, 404, { error: '这一条交付没有封存包，发不了回执链接' })
          return true
        }
        if (issued.capped) {
          sendJson(res, 409, {
            error:
              '这一条已经换过 ' +
              issued.count +
              ' 次地址都没被打开：再换一条也一样，先问他一句，或者换个收件人',
            code: 'LINK_ROTATE_LIMIT',
          })
          return true
        }
        sendJson(res, 200, { ok: true, token: issued.token, rotated: issued.rotated })
        return true
      }

      // 催一句（v0.9.144）：收包人一直没贴收据时，工作台那一行点一下就记下这一次，
      // 并把回执链接还回来拼成一段能直接发的话。只给登录着的发件人；已经贴过回执的不再催。
      const reminderPath = pathname.match(DELIVERY_REMINDER)
      if (reminderPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '催一句只能用 POST：它要在档案里记下这一次' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到工作台再点一次' })
          return true
        }
        const saved = await saveDeliveryReminder(reminderPath[1], reminderPath[2], user)
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付没有封存包，没有要等回来的回执' })
          return true
        }
        if (saved.already) {
          sendJson(res, 409, { error: '这一份已经贴过回执了，不用再催', code: 'RECEIPT_ALREADY' })
          return true
        }
        if (saved.missingLink) {
          sendJson(res, 409, {
            error: '这一版还没有回执链接：到作品页那一版点「生成回执链接」，再来催',
            code: 'NO_RECEIPT_LINK',
          })
          return true
        }
        sendJson(res, 200, { ok: true, token: saved.token, at: saved.at, count: saved.count })
        return true
      }

      // 不再等这一份的回执（v0.9.158）：发件人自己把这一份收口——客户口头说过了、当面看过、
      // 或者这版本来就作废了。只在这条交付记录上记一个时间：不碰包、不碰回执、不碰链接。
      // 之后他要是把收据贴回来，照常记；已经贴过收据的不给收口（等的事已经结束）。
      const waitClosePath = pathname.match(DELIVERY_WAIT_CLOSE)
      if (waitClosePath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '不再等只能用 POST：它要在档案里记下这一刻' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到作品页再点一次' })
          return true
        }
        const body = await readBody(req)
        // 缺省是「不再等」；只有明确写 closed:false 才是「继续等」——一个撤销要说明白
        const saved = await saveDeliveryWaitClose(waitClosePath[1], waitClosePath[2], body?.closed !== false, user)
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付没有封存包，没有要等回来的回执' })
          return true
        }
        if (saved.already) {
          sendJson(res, 409, { error: '这一份已经有回执了，不用再收口', code: 'RECEIPT_ALREADY' })
          return true
        }
        sendJson(res, 200, { ok: true, closed: saved.closed === true, at: saved.at })
        return true
      }

      // 再发一次链接（v0.9.146）：这条地址一次都没被打开过时，发件人把它重新发出去。
      // 与催一句分开记：催是在问「验没验」，重发是在问「收没收到」，回到那一行上是两个不同的数。
      const resendPath = pathname.match(DELIVERY_RESEND)
      if (resendPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '再发一次只能用 POST：它要在档案里记下这一次' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到工作台再点一次' })
          return true
        }
        const saved = await saveDeliveryResend(resendPath[1], resendPath[2], user)
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付没有封存包，没有可再发的回执链接' })
          return true
        }
        if (saved.already) {
          sendJson(res, 409, { error: '这一份已经贴过回执了，不用再发链接', code: 'RECEIPT_ALREADY' })
          return true
        }
        if (saved.missingLink) {
          sendJson(res, 409, {
            error: '这一版还没有回执链接：到作品页那一版点「生成回执链接」，再来发',
            code: 'NO_RECEIPT_LINK',
          })
          return true
        }
        sendJson(res, 200, { ok: true, token: saved.token, at: saved.at, count: saved.count })
        return true
      }

      // 换一条新链接（v0.9.147）：同一条地址又发过两次还是没人打开，说明问题不在「他忘了」——
      // 这时候换一枚新 token，旧地址立刻失效，打开次数与重发次数都从零算起。
      // 三种情况不换：已经贴过回执（问都问到了，换地址只会把已到手的证据弄丢方向）、
      // 这条地址被打开过（对方可能正看着它，换掉等于把送到的那条收回）、根本没有链接。
      const relinkPath = pathname.match(DELIVERY_RELINK)
      if (relinkPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '换一条链接只能用 POST：它要换掉档案里的那一枚 token' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到工作台再点一次' })
          return true
        }
        const current = await deliveryReceiptLink(relinkPath[1], relinkPath[2], user)
        if (!current) {
          sendJson(res, 404, { error: '这一条交付没有封存包，没有可换的回执链接' })
          return true
        }
        if (current.receipt) {
          sendJson(res, 409, { error: '这一份已经贴过回执了，不用再换链接', code: 'RECEIPT_ALREADY' })
          return true
        }
        if (!current.token) {
          sendJson(res, 409, {
            error: '这一版还没有回执链接：到作品页那一版点「生成回执链接」，再来换',
            code: 'NO_RECEIPT_LINK',
          })
          return true
        }
        // 换掉一条已经送到的地址，比不发更糟：对方点开的是旧的那条，而它刚失效
        const opened = await getReceiptVisits(current.token)
        if (opened && opened.opens > 0) {
          sendJson(res, 409, {
            error: '这条链接已经被打开过 ' + opened.opens + ' 次：他可能正看着它，别换地址——再发一次这条，或者换个方式发',
            code: 'LINK_OPENED',
          })
          return true
        }
        const saved = await saveDeliveryRelink(relinkPath[1], relinkPath[2], user)
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付记录不在了，刷新一下再试' })
          return true
        }
        if (saved.already) {
          sendJson(res, 409, { error: '这一份已经贴过回执了，不用再换链接', code: 'RECEIPT_ALREADY' })
          return true
        }
        if (saved.missingLink) {
          sendJson(res, 409, {
            error: '这一版还没有回执链接：到作品页那一版点「生成回执链接」，再来换',
            code: 'NO_RECEIPT_LINK',
          })
          return true
        }
        // 换到头了（v0.9.150）：换地址换的是地址，不是渠道。两条路都在这里拦住，
        // 免得换个入口还能把第三条地址发进同一个收不到的地方。
        if (saved.capped) {
          sendJson(res, 409, {
            error:
              '这一条已经换过 ' +
              saved.count +
              ' 次地址都没被打开：再换一条也一样，先问他一句，或者换个收件人',
            code: 'LINK_ROTATE_LIMIT',
          })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          token: saved.token,
          at: saved.at,
          count: saved.count,
          resendsBefore: saved.resendsBefore,
        })
        return true
      }

      // 这一条是给谁的（v0.9.152）：写一个称呼，或者清掉。
      // 只认发件人这一侧；不进包、不进回执页——它不是这份作品的一部分，是发件人自己记的一行字。
      const recipientPath = pathname.match(DELIVERY_RECIPIENT)
      if (recipientPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '收件人只能用 POST 写：它要记进交付档案' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到作品页再写收件人' })
          return true
        }
        const body = await readBody(req)
        const raw = body?.recipient
        if (raw !== undefined && typeof raw !== 'string') {
          sendJson(res, 400, { error: '收件人写成一个称呼就行：{"recipient": "王老师"}', code: 'RECIPIENT_INVALID' })
          return true
        }
        const text = String(raw ?? '')
        // 上限按字算（不是按字节、也不是按 UTF-16 长度）：一个称呼够写「王老师 · 内容组」，超了就明说写不下
        if (Array.from(text.replace(/\s+/g, ' ').trim()).length > RECIPIENT_LIMIT) {
          sendJson(res, 400, {
            error: '收件人最多写 ' + RECIPIENT_LIMIT + ' 个字：一个称呼就够，备注写在作品里',
            code: 'RECIPIENT_TOO_LONG',
          })
          return true
        }
        const saved = await saveDeliveryRecipient(recipientPath[1], recipientPath[2], text, user)
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付没有封存包，谈不上发给谁' })
          return true
        }
        sendJson(res, 200, { ok: true, changed: saved.changed, recipient: saved.recipient })
        return true
      }

      // 他回了什么（v0.9.153）：收包人回的那段话，发件人记在这一条交付上。
      // 和收件人称呼一样只在发件人这一侧：不进包、不进回执页——
      // 拿到链接的人不需要知道发件人这边记了什么，也不需要看见自己的话被存了一份。
      const replyPath = pathname.match(DELIVERY_REPLY)
      if (replyPath) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '回复只能用 POST 记：它要记进交付档案' })
          return true
        }
        if (!user && config.auth.requireAuth) {
          sendJson(res, 401, { error: '登录已过期：回到作品页再记' })
          return true
        }
        const body = await readBody(req)
        const raw = body?.reply
        if (raw !== undefined && typeof raw !== 'string') {
          sendJson(res, 400, { error: '回复写一段字就行：{"reply": "第 3 张背景色偏了"}', code: 'REPLY_INVALID' })
          return true
        }
        const text = String(raw ?? '')
        // 上限按字算：先把形状整理好，再数有多少个字——先截断就永远比不出「写多了」
        if (deliveryReplyLength(text) > REPLY_LIMIT) {
          sendJson(res, 400, {
            error: '回复最多记 ' + REPLY_LIMIT + ' 个字、6 行：一句能直接拿去改的话就够',
            code: 'REPLY_TOO_LONG',
          })
          return true
        }
        const saved = await saveDeliveryReply(replyPath[1], replyPath[2], text, user)
        if (!saved) {
          sendJson(res, 404, { error: '这一条交付没有封存包，谈不上他回了什么' })
          return true
        }
        sendJson(res, 200, { ok: true, changed: saved.changed, reply: saved.reply })
        return true
      }

      // 收包人那一侧（v0.9.137）：链接里的 token 就是凭证，不登录也能打开、也能贴。
      // GET 只说「这是哪一份、之前贴过没有」，不给哈希也不给档案——有包的人在自己那张校验页上看得到；
      // POST 收下收据、比对完写进那一条交付记录，回给收包人的只有哪几项对上，不回「这一条是多少」。
      // 收包人那一侧的第一句话（v0.9.151）：他点「收到了」。
      // 与贴收据同一枚 token、同一套「旧地址 / 不在了」的说法，但写的是另一件事：
      // 收据说的是「验完了，对不对得上」，这一下只说「东西到我手上了，还没验」。
      const publicAck = pathname.match(PUBLIC_RECEIPT_ACK)
      if (publicAck) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '「收到了」只能用 POST 点' })
          return true
        }
        const foundAck = await findReceiptLink(publicAck[1])
        if (!foundAck) {
          const retiredAck = await findRetiredReceiptLink(publicAck[1])
          if (retiredAck) {
            // 换掉的旧地址一样要记这一次点击：他手上还是旧的那条（v0.9.149），
            // 而这一次尤其说明新的一条确实没送到他那儿。
            await noteRetiredReceiptLinkHit(publicAck[1])
            sendJson(res, 410, {
              error: '这条地址已经被换成了新的一条：旧地址从那会儿起就打不开了，用我最后发给你的那条就行。',
              code: 'LINK_RETIRED',
              retiredAt: retiredAck.at,
            })
            return true
          }
          sendJson(res, 404, { error: '这条回执链接不在了：找发件人要一条新的' })
          return true
        }
        const saved = await saveDeliveryAck(publicAck[1])
        if (!saved) {
          sendJson(res, 404, { error: '这条回执链接刚刚失效了：找发件人要一条新的' })
          return true
        }
        if (saved.already) {
          // 验都验完了：再说一句「收到了」不会多出任何信息，也不该把结论改回没验
          sendJson(res, 409, {
            error: '这一份已经贴过收据了，不用再说收到了',
            code: 'RECEIPT_ALREADY',
          })
          return true
        }
        // 重复点不算错：页面刷新、手滑点两次都正常，回同一个时刻，不写第二遍
        sendJson(res, 200, { ok: true, at: saved.at, repeated: saved.repeated === true })
        return true
      }

      const publicReceipt = pathname.match(PUBLIC_RECEIPT)
      if (publicReceipt) {
        const found = await findReceiptLink(publicReceipt[1])
        if (!found) {
          // 换掉的旧地址（v0.9.148）：收包人还会从聊天记录点回旧的，那时候「不在了」是句错话——
          // 它听起来像发件人收回了一份交出去的包。这里只说「已经换成新的」，不给新地址、不给包，
          // 也不记一次打开（打开的是一句说明，不是那一份包）。用 410：它确实曾经在，现在永久不在了。
          const retired = await findRetiredReceiptLink(publicReceipt[1])
          if (retired) {
            // 有人点回旧地址这件事本身是个信号（v0.9.149）：他手上还是旧的那条，新的一条没到他那儿。
            // 只记次数与时间；这一屏照旧只说「换成了新的」，不把次数写给他看——
            // 他知道自己被数着点了几次没有任何好处，要这个数的是发件人。
            await noteRetiredReceiptLinkHit(publicReceipt[1])
            // 这里只写「换过了」，不写日期：收包人那一侧没有账号、拿不到时区，
            // 一句按 UTC 算的日期在他那儿可能是另一天。要日期的是页面，它自己按浏览器时区写。
            sendJson(res, 410, {
              error: '这条地址已经被换成了新的一条：旧地址从那会儿起就打不开了，用我最后发给你的那条就行。',
              code: 'LINK_RETIRED',
              retiredAt: retired.at,
            })
            return true
          }
          sendJson(res, 404, { error: '这条回执链接不在了：找发件人要一条新的' })
          return true
        }
        const receipt = found.delivery.receipt || null
        if (req.method === 'GET') {
          // 打开页面的那一次就记一次（v0.9.145）：发件人据此分得清「他没点开」和「他看了还没贴」。
          // 只记这条地址被打开过，不记是谁；同一分钟内刷新算一次（页面一刷新就会再取一次数据）。
          await recordReceiptOpen(publicReceipt[1], req.headers?.['user-agent'])
          sendJson(res, 200, {
            ok: true,
            project: { title: found.project.title },
            delivery: {
              version: found.delivery.version,
              fileName: found.delivery.package?.fileName || '',
              bytes: found.delivery.package?.bytes || 0,
              at: found.delivery.at,
            },
            // 他点过「收到了」没有（v0.9.151）：刷新页面还看得见，不用记得自己点过
            ackAt: found.delivery.ack?.at || '',
            receipt: receipt
              ? { state: receipt.state, at: receipt.at, summary: receipt.summary || '' }
              : null,
          })
          return true
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '收据只能用 POST 贴上来' })
          return true
        }
        const body = await readBody(req)
        const text = String(body?.text ?? '')
        if (!text.trim()) {
          sendJson(res, 400, { error: '先把收据整段贴进来', code: 'RECEIPT_REQUIRED' })
          return true
        }
        if (text.length > RECEIPT_MAX_CHARS) {
          sendJson(res, 413, {
            error: '这段太长了（超过 ' + RECEIPT_MAX_CHARS + ' 字）：只贴收据那几行',
            code: 'RECEIPT_TOO_LONG',
          })
          return true
        }
        const check = checkReceipt({ text, delivery: found.delivery })
        if (!check.parsed) {
          sendJson(res, 422, { error: check.error, code: 'RECEIPT_UNREADABLE' })
          return true
        }
        const saved = await saveReceiptByToken(publicReceipt[1], {
          at: new Date().toISOString(),
          state: check.state,
          summary: check.summary,
          problems: check.problems,
          checks: check.checks,
          claimed: check.claimed,
          via: 'link',
        })
        if (!saved) {
          sendJson(res, 404, { error: '这条回执链接刚刚失效了：找发件人要一条新的' })
          return true
        }
        sendJson(res, 200, {
          ok: check.state === 'match',
          state: check.state,
          summary: check.summary,
          problems: check.problems,
          // 只回哪几项对上：期望值不给，免得不拿包也能照抄出一段「对得上」
          checks: check.checks.map((entry) => ({ k: entry.k, ok: entry.ok === true })),
          at: saved.delivery.receipt?.at || '',
        })
        return true
      }

      // 整包体检（v0.9.130）：把包里每一条都解开、重算 CRC32，跟目录里记的比。
      // 只读：按偏移从盘上读，内存里最多一条；不缓存结果、不改文件、不写档案。
      const packageVerify = pathname.match(DELIVERY_PACKAGE_VERIFY)
      if (packageVerify) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '封存包只能体检，不能修改' })
          return true
        }
        const project = await getProject(packageVerify[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const delivery = (project.deliveries || []).find((entry) => entry.id === packageVerify[2] && entry.package)
        if (!delivery) {
          sendJson(res, 404, { error: '这一条交付没有封存包，或者包已经不在了' })
          return true
        }
        const handle = await openDeliveryPackage(project.id, delivery.id)
        if (!handle) {
          sendJson(res, 404, { error: '盘上那份封存包不在了；下载回来的拷贝还能自己核对 SHA-256' })
          return true
        }
        try {
          if (handle.size > MAX_PACKAGE_BYTES) {
            sendJson(res, 413, {
              error: '这个包超过 ' + Math.round(MAX_PACKAGE_BYTES / (1024 * 1024)) + ' MB，太大了不能在这里体检；下载下来自己核对',
            })
            return true
          }
          const directory = readZipDirectoryAt(handle.fd, handle.size)
          if (!directory) {
            sendJson(res, 200, {
              ok: false,
              state: 'unreadable',
              error: '包里的目录读不出来：可能被截断，或者尾部被改过',
            })
            return true
          }
          const started = Date.now()
          const audit = verifyZipAt(handle.fd, handle.size, directory.entries)
          sendJson(res, 200, {
            ok: audit.failed.length === 0 && audit.skipped === 0,
            state: 'ok',
            verifiedAt: new Date().toISOString(),
            total: audit.total,
            passed: audit.passed,
            skipped: audit.skipped,
            budgetBytes: MAX_VERIFY_BYTES,
            failed: audit.failed,
            bytes: handle.size,
            readBytes: audit.readBytes,
            ms: Date.now() - started,
            manifest: delivery.package.files?.length ? compareManifest(directory.entries, delivery.package.files) : null,
          })
        } finally {
          await handle.close()
        }
        return true
      }

      // 包里的一条内容（v0.9.129）：按条目名取，只认目录里真有的那一条。
      // 解开之后先验 CRC32 再发：包里这一块坏了就回 409，不把坏字节当内容展示。
      const packageEntry = pathname.match(DELIVERY_PACKAGE_ENTRY)
      if (packageEntry) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '封存包的内容只能读，不能修改' })
          return true
        }
        const project = await getProject(packageEntry[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        const delivery = (project.deliveries || []).find((entry) => entry.id === packageEntry[2] && entry.package)
        if (!delivery) {
          sendJson(res, 404, { error: '这一条交付没有封存包，或者包已经不在了' })
          return true
        }
        let entryName = ''
        try {
          entryName = decodeURIComponent(packageEntry[3])
        } catch {
          sendJson(res, 400, { error: '条目名的编码不对' })
          return true
        }
        const handle = await openDeliveryPackage(project.id, delivery.id)
        if (!handle) {
          sendJson(res, 404, { error: '盘上那份封存包不在了；包内清单还能看档案里记的那一份' })
          return true
        }
        // 按偏移读：目录只读尾部那一小段，内容只读这一条（v0.9.131），不再把整包摊进内存
        let directory
        let entry
        let read
        try {
          if (handle.size > MAX_PACKAGE_BYTES) {
            sendJson(res, 413, {
              error: '这个包超过 ' + Math.round(MAX_PACKAGE_BYTES / (1024 * 1024)) + ' MB，不能在这里读单条内容；下载下来再看',
            })
            return true
          }
          directory = readZipDirectoryAt(handle.fd, handle.size)
          if (!directory) {
            sendJson(res, 409, { error: '包里的目录读不出来：可能被截断，先下载包来看' })
            return true
          }
          entry = findZipEntry(directory.entries, entryName)
          if (!entry) {
            sendJson(res, 404, { error: '包里没有这个文件' })
            return true
          }
          if (entry.bytes > MAX_ENTRY_BYTES) {
            sendJson(res, 413, {
              error: '这一条超过 ' + Math.round(MAX_ENTRY_BYTES / (1024 * 1024)) + ' MB，不能在这里预览；下载包来解压',
            })
            return true
          }
          read = readZipEntryAt(handle.fd, handle.size, entry)
        } finally {
          await handle.close()
        }
        if (!read) {
          sendJson(res, 409, { error: '这一条读不出来：包在这一块可能坏了' })
          return true
        }
        if (!read.crcOk) {
          sendJson(res, 409, { error: '这一条的内容跟包里的 CRC32 对不上：包在这一块坏了，别拿它当内容' })
          return true
        }
        const mime = entryMime(entry.name)
        const headers = {
          'Content-Type': mime,
          'Content-Length': String(read.bytes),
          'Content-Disposition': 'inline',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex',
          'X-VQ-Entry-Crc32': String(entry.crc),
          // 这一回真从盘上读了多少字节（目录 + 这一条），跟包大小对照着看就知道没翻整包
          'X-VQ-Read-Bytes': String((directory?.readBytes || 0) + (read.readBytes || 0)),
          'X-VQ-Package-Bytes': String(handle.size),
        }
        // 页面进沙箱 iframe（前端 sandbox 属性）之外再加一道：即使哪天漏了 sandbox，也不许取外部资源
        if (mime.startsWith('text/html')) {
          headers['Content-Security-Policy'] =
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"
        }
        res.writeHead(200, headers)
        res.end(read.data)
        return true
      }

      // 花费明细：一条作品花了哪些笔、按版本各多少；?month=YYYY-MM 只看那个月
      const spendPath = pathname.match(SPEND)
      if (spendPath && req.method === 'GET') {
        const project = await getProject(spendPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, await projectSpendDetail(project, user, { month: String(url.searchParams.get('month') || '') }))
        return true
      }

      // 一次运行按分镜画出来的图，一次贴回分镜（r278）。
      // 三道核对：作品是我的、这次运行是我的并且确实是这条作品的工作流跑出来的、镜头号在分镜范围内。
      // 图先存进分镜画面库（r279，shotframes/<账号>/<作品>/）再记到作品上：运行目录是将来的清理对象，
      // 分镜上的画面不能跟着消失；而且它不再占用「上传素材」那 20 个位置——那 20 个是用户自己传的图。
      // 只认开工作流时按分镜建的 n_shot_NN 节点，用户自己拉的出图节点没有镜号，不往分镜上硬塞。
      const shotFromRunPath = pathname.match(SHOT_FROM_RUN)
      if (shotFromRunPath && req.method === 'POST') {
        if (!user?.id) {
          sendJson(res, 401, { error: '请先登录', code: 'LOGIN_REQUIRED' })
          return true
        }
        const project = await getProject(shotFromRunPath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除', code: 'PROJECT_NOT_FOUND' })
          return true
        }
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        const shotCount = Array.isArray(template?.storyboard) ? template.storyboard.length : 0
        if (!shotCount) {
          sendJson(res, 409, { error: '这条作品还没有分镜：画面要挂在某一镜上，先在模板里拆出分镜', code: 'NO_STORYBOARD' })
          return true
        }
        const body = await readBody(req)
        const runId = String(body.runId || '')
        const run = runId ? await getRun(runId, user) : null
        if (!run) {
          sendJson(res, 404, { error: '没有这次运行：编号不对，或者它不在你的账号下', code: 'RUN_NOT_FOUND' })
          return true
        }
        if (!projectFlowIds(project).includes(String(run.flowId || ''))) {
          sendJson(res, 409, { error: '这次运行不是这条作品的：只贴这条作品自己的工作流画出来的图', code: 'RUN_NOT_THIS_PROJECT' })
          return true
        }
        const images = runShotImages(run, shotCount)
        if (!images.length) {
          sendJson(res, 409, {
            error: '这次运行没有按分镜出图：先用「开工作流」给每一镜建出图节点，跑完再回来贴',
            code: 'RUN_NO_SHOT_IMAGES',
          })
          return true
        }
        // 已经贴过这次运行的镜不再复制一份：先分堆，只复制这次新画的那几张
        const plan = planRunAttach(images, project.shots, run.id)
        const entries = []
        const failed = []
        for (const image of plan.toCopy) {
          let buffer = null
          try {
            const file = runAssetPath(run.id, image.file)
            buffer = file ? await fsp.readFile(file) : null
          } catch {
            buffer = null
          }
          if (!buffer) {
            failed.push({ shotNo: image.shotNo, reason: '这次运行的这张图已经不在了' })
            continue
          }
          try {
            const stored = await saveShotFrame({ userId: user.id, projectId: project.id, buffer })
            entries.push({ shotNo: image.shotNo, media: stored.media, from: run.id })
          } catch (error) {
            failed.push({ shotNo: image.shotNo, reason: publicError(error, '这张图没贴上') })
          }
        }
        if (!entries.length && !plan.kept.length) {
          sendJson(res, 409, { error: '这次运行的图都读不回来：可能运行目录已经被清掉了', code: 'RUN_ASSETS_MISSING', failed })
          return true
        }
        const saved = await setProjectShotFrames(project.id, entries, user)
        if (saved.status !== 200) {
          sendJson(res, saved.status, { error: saved.error, code: saved.code })
          return true
        }
        // 换掉的那几镜原来的图不再被引用：清掉，免得一条作品反复贴几轮攒出一堆死图。
        // 清理失败不影响这次贴图的结果（画面上已经有图了），下一轮贴图会再扫一遍。
        await sweepProjectShotFrames({
          userId: user.id,
          projectId: project.id,
          keep: Object.values(saved.shots || {}).map((row) => row?.media || ''),
        }).catch(() => {})
        sendJson(res, 200, {
          ok: true,
          runId: run.id,
          applied: saved.applied,
          kept: [...plan.kept, ...saved.kept],
          overwritten: saved.overwritten,
          refused: saved.refused,
          failed,
          shots: saved.shots,
          templateShots: shotCount,
        })
        return true
      }

      // 某一镜的画面（v0.9.161）：先核作品与镜头号，再核这张图是不是自己的
      const shotFramePath = pathname.match(SHOT_FRAME)
      if (shotFramePath && req.method === 'POST') {
        const project = await getProject(shotFramePath[1], user)
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除', code: 'PROJECT_NOT_FOUND' })
          return true
        }
        const template = project.templateId ? await getTemplate(project.templateId, user) : null
        const shotCount = Array.isArray(template?.storyboard) ? template.storyboard.length : 0
        const body = await readBody(req)
        const shotNo = normalizeShotNo(shotFramePath[2])
        const media = String(body.media || '')
        const blocked = shotFrameBlock({ media, user, shotNo, shotCount, admin: isAdmin(user), projectId: project.id })
        if (blocked) {
          sendJson(res, blocked.status, { error: blocked.error, code: blocked.code })
          return true
        }
        const saved = await setProjectShotFrame(project.id, shotNo, media, user)
        if (saved.status !== 200) {
          sendJson(res, saved.status, { error: saved.error, code: saved.code })
          return true
        }
        // 换图 / 撤销之后，这一镜原来那张分镜画面没人用了：清掉（上传素材不碰，那是用户自己的东西）
        await sweepProjectShotFrames({
          userId: user.id,
          projectId: project.id,
          keep: Object.values(saved.shots || {}).map((row) => row?.media || ''),
        }).catch(() => {})
        sendJson(res, 200, { ok: true, changed: saved.changed, shots: saved.shots, templateShots: shotCount })
        return true
      }

      // 回收站（v0.9.253）：删掉的作品 30 天内能原样放回去，所以这三个入口都在这里，
      // 且都排在 ITEM 前面 —— 'trash' 本身会被 ITEM 的正则当成一个作品号。
      if (pathname === '/api/projects/trash' && req.method === 'GET') {
        const items = await listProjectTrash(user)
        sendJson(res, 200, { items, days: PROJECT_TRASH_DAYS })
        return true
      }

      const restoreMatch = pathname.match(/^\/api\/projects\/([\w-]+)\/restore$/)
      if (restoreMatch && req.method === 'POST') {
        const result = await restoreProject(restoreMatch[1], user)
        if (result.status === 404) {
          sendJson(res, 404, { error: '回收站里没有这条作品：可能已经恢复过，或者超过 30 天被清掉了', code: 'TRASH_NOT_FOUND' })
          return true
        }
        if (result.status === 403) {
          sendJson(res, 403, { error: '这条作品属于另一个账号，不能恢复', code: 'NOT_OWNER' })
          return true
        }
        if (result.status === 409) {
          const message = result.code === 'PROJECT_LIMIT'
            ? '作品数量已经到上限，先删掉一些再恢复这一条'
            : '这条作品已经在库里了，不用恢复'
          sendJson(res, 409, { error: message, code: result.code || 'RESTORE_CONFLICT' })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          project: workflowHidden(user) ? briefWithoutWorkflow(result.project) : result.project,
          restored: result.restored,
        })
        return true
      }

      const purgeMatch = pathname.match(/^\/api\/projects\/trash\/([\w-]+)$/)
      if (purgeMatch && req.method === 'DELETE') {
        const result = await purgeProject(purgeMatch[1], user)
        if (result.status === 404) {
          sendJson(res, 404, { error: '回收站里没有这条作品', code: 'TRASH_NOT_FOUND' })
          return true
        }
        if (result.status === 403) {
          sendJson(res, 403, { error: '这条作品属于另一个账号，不能删除', code: 'NOT_OWNER' })
          return true
        }
        sendJson(res, 200, { ok: true })
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
        // 工作流 beta（r313）：绑定 project.flowId 等于把作品挂到一块工作流上，普通账号一律拒；
        // 标题 / 状态 / 参考资产这些日常字段照旧，不误伤作品的常规操作。
        if ('flowId' in body && workflowHidden(user)) return denyWorkflowBeta(res)
        if ('flowId' in body && body.flowId) {
          const flow = await getFlow(String(body.flowId), user)
          if (!flow) {
            sendJson(res, 404, { error: '要绑定的工作流不存在', code: 'FLOW_NOT_FOUND' })
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
        // 出图参考资产：传引用就写，传空串就清掉；非法值由存储层归一成空串（等于没选）
        if ('assetRef' in body) patch.assetRef = normalizeAssetRef(body.assetRef)
        // 标记交付 = 同时封存这一版的整套交付包（v0.9.125）：以后改模板、清帧图、开新版，
        // 「当初交出去的是什么」都还能原样取回。封存失败不挡交付，记录照落。
        let deliveryId = ''
        let deliveryPackage = null
        // 回执链接（v0.9.137）：新封存的包一出生就带一枚 token，档案里直接能复制链接发出去
        let receiptToken = ''
        if (patch.status === 'done') {
          const current = await getProject(item[1], user)
          if (current) {
            const rawTz = Number(body.tz)
            const tz = Number.isFinite(rawTz) ? Math.max(-720, Math.min(840, Math.round(rawTz))) : 480
            try {
              const { archive, zipName, files } = await buildProjectDeliveryArchive(current, user, tz)
              deliveryId = newDeliveryPackageId()
              receiptToken = newReceiptToken()
              deliveryPackage = await saveDeliveryPackage(current.id, deliveryId, archive, { fileName: zipName, files })
            } catch (caught) {
              console.warn('[projects] 交付包封存失败：' + (caught instanceof Error ? caught.message : String(caught)))
            }
          }
        }
        const project = await updateProject(item[1], patch, user, { deliveryId, deliveryPackage, receiptToken })
        if (!project) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, { ok: true, project: workflowHidden(user) ? briefWithoutWorkflow(project) : project })
        return true
      }

      if (item && req.method === 'DELETE') {
        // 删掉的作品进回收站：作品记录、评审、已看过、拍板一起暂存，恢复时原样放回
        const removed = await deleteProject(item[1], user)
        if (!removed) {
          sendJson(res, 404, { error: '作品不存在或已被删除' })
          return true
        }
        sendJson(res, 200, { ok: true, removed: removed.project, trash: removed.trash })
        return true
      }

      sendJson(res, 404, { error: '未知的作品接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}