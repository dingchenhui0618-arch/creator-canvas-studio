// 地址栏路由：页面的唯一真源是 location.hash。
// 约定：#/overview #/projects #/radar #/templates #/rooms #/agents #/runs #/review #/canvas #/board #/settings #/recharge
//      两张画布是两条地址（v0.9.163）：#/canvas 是 VisionQA 自己的工作流，#/board 是外部的无限画布
//      作品：#/projects/<作品 id>；评审带作品：#/review/project/<作品 id>
//      某一条交付：#/projects/<作品 id>/delivery/<交付记录 id>（工作台点一行直接落在那一版的档案上，v0.9.140）
//      单条历史评审：#/review/<评审 id>（作品页点一条评审就走到这里，刷新与后退都能回到那条）
//      单条模板：#/templates/<模板 id>（作品页「来源」里点模板名走进来，刷新与后退都还在这条模板上）
//      对话预设编辑：#/agents/new 与 #/agents/<id 或唯一名称>
//      帮助中心：#/help 是目录，#/help/<slug> 是单篇（公开可读，不登录也能看）
//      后台管理：#/admin/<section>，section 取自 editions.ts 的后台导航。
//
// 说明：本文件不碰登录态。RequireSession 仍然决定有没有工作台；
// 只有工作台内部的页面切换走 hash，刷新与前进/后退都由浏览器负责。
import { useSyncExternalStore } from 'react'
import type { Page } from './domain/types'
import { DEFAULT_ADMIN_SECTION, EDITION_BY_ID, type AdminSection, type EditionId } from './editions'
import { isHelpSlug, type HelpSlug } from './domain/help'
import { canvasRunLinkFromSegments, canvasRunLinkHash, canvasRunViewLinkHash } from './domain/canvas-run-link'
import { deliveryLinkFromSegments, deliveryLinkHash } from './domain/delivery-link'
import { clearUnsaved, shouldAskBeforeLeave, unsavedNote } from './domain/unsaved-guard'

/** 外壳里真正占一屏的用户页面；登录与编辑器各自有独立入口。 */
export type ShellPage = Exclude<Page, 'login' | 'agent-editor'>

export type Route =
  // 工作流有三个可寻址对象（#/canvas，VisionQA 自己的节点编排）：
  //   #/canvas/<flowId>                     一条流程（模板库、运行记录跳转都走它）
  //   #/canvas/<flowId>/run/<runId>         只读查看一次运行：把记录放回抽屉，工作流不许改（v0.9.106）
  //   #/canvas/<flowId>/resume/<runId>      特定一次运行：打开工作流时把那条记录放回抽屉（v0.9.104）
  // 无限画布是另一条地址（v0.9.163）：
  //   #/board                               打开上次那块无限画布
  //   #/board/<画布ID>                      无限画布服务里的某一块画布（工作台「继续上次的无限画布」走它）
  // 旧的 #/canvas/project/<id> 仍认：解析时直接改写成 #/board/<id>，老链接不掉进空白页。
  | {
      kind: 'page'
      page: ShellPage
      flowId?: string
      /** 无限画布服务里的某一块画布：#/board/<画布ID> */
      boardId?: string
      projectId?: string
      reviewId?: string
      /** 画布地址里点名的那条运行：刷新、前进后退后仍能回到「继续运行」 */
      resumeRunId?: string
      /** 画布地址里点名的那条运行：只读查看，不提供保存与编辑（v0.9.106） */
      viewRunId?: string
      /** 模板库里的单条模板：#/templates/<模板 id>（v0.9.35 起作品页的「模板 · X」点得开） */
      templateId?: string
      /** 作品页要点开的那一条交付（v0.9.140）：工作台「交出去的」点一行就带着它过来 */
      deliveryId?: string
    }
  | { kind: 'agent-editor'; agentRef: string | null }
  | { kind: 'legal'; doc: 'terms' | 'privacy' }
  // 帮助中心：slug 认不出就落回目录页，坏链接不挡人
  | { kind: 'help'; slug: HelpSlug | null }
  // 素材来源与下架通道（v0.9.82）：公开可读，被收录的人不用先注册就能提交下架
  | { kind: 'sources' }
  // 只读分享：链接里带随机 token，不登录也能打开（App 根部整屏渲染，不进工作台外壳）
  | { kind: 'share'; token: string }
  // 作品级分享：#/share/project/<token>，读的是脚本 + 分镜的公开视图
  | { kind: 'shared-project'; token: string }
  // 收包人的回执：#/receipt/<token>，不登录也能贴一段收据回来（v0.9.137）
  | { kind: 'receipt'; token: string }
  | { kind: 'admin'; section: AdminSection }
  // 找回密码：从邮件里点进来的 #/reset?token=…，不登录也要能打开
  | { kind: 'reset'; token: string }

export const DEFAULT_ROUTE: Route = { kind: 'page', page: 'overview' }

const USER_PAGES: readonly ShellPage[] = [
  'overview',
  'projects',
  'radar',
  'templates',
  // r315：房间（聊天室）——一级导航第 5 项
  'rooms',
  'agents',
  'runs',
  'review',
  'canvas',
  'board',
  'assets',
  'settings',
  'recharge',
  'local',
]

// 后台 section 直接取自 editions.ts，避免在路由里再抄一份会漂移的清单。
const ADMIN_SECTIONS: readonly string[] = EDITION_BY_ID.admin.nav.map((item) => item.section ?? item.id)

// 首屏是不是「空 hash + ?edition=admin」这种入口。App 在 /api/auth/me 确认管理员后
// 才知道该不该进后台；只有这种入口才替用户补上后台落点，显式收藏的页面不抢。
let initialBareEntry = false

/** 本次启动是不是从一个没有 hash 的地址进来的（用于后台入口的一次性判定）。 */
export function isInitialBareEntry(): boolean {
  return initialBareEntry
}

/** 把路由转回 domain 里的 Page：后台没有用户 Page 语义，统一落到工作台用于面包屑兜底。 */
export function routeToPage(route: Route): Page {
  if (route.kind === 'page') return route.page
  if (route.kind === 'agent-editor') return 'agent-editor'
  return 'overview'
}

/** 不进工作台外壳的路由：条款页与只读分享页整屏渲染，工作台骨架不参与。 */
export function isBareRoute(route: Route): boolean {
  return (
    route.kind === 'legal' ||
    route.kind === 'help' ||
    route.kind === 'sources' ||
    route.kind === 'share' ||
    route.kind === 'shared-project' ||
    route.kind === 'receipt' ||
    route.kind === 'reset'
  )
}

/** Page 转向量：列表页跳转、事件兼容都走这里，避免各页面自己拼 hash。 */
export function pageToRoute(page: Page, agentRef: string | null = null): Route {
  if (page === 'login') return DEFAULT_ROUTE
  if (page === 'agent-editor') return { kind: 'agent-editor', agentRef }
  return { kind: 'page', page }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // 坏链接不抛错，按原样当引用去查，查不到由页面给「找不到」提示。
    return value
  }
}

function parseAdminSection(value: string | undefined): AdminSection {
  // r258：「模型 Key」并进「模型与上游」之后，旧收藏的 #/admin/keys 直接落到那一页，
  // 不猜成总览、也不给 404——Key 与联网搜索现在只有这一处能改。
  if (value === 'keys') return 'models'
  if (value && ADMIN_SECTIONS.includes(value)) return value as AdminSection
  return DEFAULT_ADMIN_SECTION
}

/** 纯解析：不读写 history，方便在事件回调里复用。 */
export function parseRoute(hash: string): Route {
  const cleaned = hash.replace(/^#/, '').trim()
  if (!cleaned || cleaned === '/') return DEFAULT_ROUTE
  // 找回密码的 token 在查询串里（#/reset?token=...），先摘出来，别让它混进路径分段
  if (/^\/reset(?:[?]|$)/.test(cleaned)) {
    const query = cleaned.includes('?') ? cleaned.slice(cleaned.indexOf('?') + 1) : ''
    return { kind: 'reset', token: new URLSearchParams(query).get('token') || '' }
  }
  const segments = cleaned
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeSegment)
  if (!segments.length) return DEFAULT_ROUTE

  const [head, tail] = segments
  if (head === 'admin') return { kind: 'admin', section: parseAdminSection(tail) }
  if (head === 'legal') return { kind: 'legal', doc: tail === 'privacy' ? 'privacy' : 'terms' }
  // 帮助：一篇一个地址，方便从失败提示直接链到对应那一篇
  if (head === 'help') return { kind: 'help', slug: isHelpSlug(tail) ? tail : null }
  // 素材来源与下架：一个地址，页脚、模板库、举报弹窗都链到这里
  if (head === 'sources') return { kind: 'sources' }
  // 分享链接：token 是整条路径的余下部分，缺了就落回工作台。
  // 作品分享多一段 /project/，必须排在模板分享前面判断。
  if (head === 'share') {
    if (tail === 'project' && segments[2]) return { kind: 'shared-project', token: segments[2] }
    return tail ? { kind: 'share', token: tail } : DEFAULT_ROUTE
  }
  // 回执链接：token 在路径里，缺了就落回工作台（没有 token 的页面没有可看的东西）
  if (head === 'receipt') return tail ? { kind: 'receipt', token: tail } : DEFAULT_ROUTE
  // 旧的 #/welcome 链接不再单独成页：引导已改成工作台内的弹窗，落回工作台即可。
  // 作品有两个地址：#/projects 列表与 #/projects/<作品 id>
  if (head === 'projects') {
    // 某一条交付：#/projects/<作品 id>/delivery/<交付记录 id>。缺任何一段都退回作品页本身，
    // 坏链接照样能打开作品，只是不落在某一版上。
    if (tail) {
      const deliveryLink = deliveryLinkFromSegments(segments)
      if (deliveryLink) {
        return { kind: 'page', page: 'projects', projectId: deliveryLink.projectId, deliveryId: deliveryLink.deliveryId }
      }
      return { kind: 'page', page: 'projects', projectId: tail }
    }
    return { kind: 'page', page: 'projects' }
  }
  // 评审页的「这次记入哪条作品」也写进地址：#/review/project/<作品 id>
  // 打开某一条历史评审：地址里带评审 id，那条记录本身就带着归属，不用再挂作品
  if (head === 'review') {
    if (tail === 'project' && segments[2]) return { kind: 'page', page: 'review', projectId: segments[2] }
    if (tail) return { kind: 'page', page: 'review', reviewId: tail }
    return { kind: 'page', page: 'review' }
  }
  if (head === 'agents') {
    if (!tail) return { kind: 'page', page: 'agents' }
    if (tail === 'new') return { kind: 'agent-editor', agentRef: null }
    return { kind: 'agent-editor', agentRef: tail }
  }
  // 模板也有单条地址：#/templates 是列表，#/templates/<模板 id> 直接开那一条
  if (head === 'templates') {
    return tail ? { kind: 'page', page: 'templates', templateId: tail } : { kind: 'page', page: 'templates' }
  }
  // 无限画布：一块画布一条地址，刷新与收藏都落在同一块上
  if (head === 'board') return { kind: 'page', page: 'board', boardId: tail || undefined }
  if ((USER_PAGES as readonly string[]).includes(head)) {
    if (head === 'canvas') {
      // 旧地址（v0.9.162 及以前）：画布项目曾经挂在工作流页下面，现在归无限画布
      if (tail === 'project' && segments[2]) return { kind: 'page', page: 'board', boardId: segments[2] }
      // #/canvas/<flowId>/run|resume/<runId>：缺 runId 的坏链接退回这块画布，不挡住画布本身
      const runLink = canvasRunLinkFromSegments(segments)
      if (runLink) return { kind: 'page', page: 'canvas', ...runLink }
      return { kind: 'page', page: 'canvas', flowId: tail || undefined }
    }
    return { kind: 'page', page: head as ShellPage }
  }
  return DEFAULT_ROUTE
}

/** 规范化 hash：没有任何查询串，只保留可寻址的路径。 */
export function toHash(route: Route): string {
  if (route.kind === 'page') {
    if (route.page === 'board') return route.boardId ? '#/board/' + encodeURIComponent(route.boardId) : '#/board'
    if (route.page === 'canvas') {
      if (route.flowId && route.viewRunId) return canvasRunViewLinkHash(route.flowId, route.viewRunId)
      if (route.flowId && route.resumeRunId) return canvasRunLinkHash(route.flowId, route.resumeRunId)
      if (route.flowId) return '#/canvas/' + encodeURIComponent(route.flowId)
    }
    if (route.page === 'projects' && route.projectId && route.deliveryId) {
      return deliveryLinkHash(route.projectId, route.deliveryId)
    }
    if (route.page === 'projects' && route.projectId) return '#/projects/' + encodeURIComponent(route.projectId)
    if (route.page === 'review' && route.reviewId) return '#/review/' + encodeURIComponent(route.reviewId)
    if (route.page === 'review' && route.projectId) return '#/review/project/' + encodeURIComponent(route.projectId)
    if (route.page === 'templates' && route.templateId) return '#/templates/' + encodeURIComponent(route.templateId)
    return '#/' + route.page
  }
  if (route.kind === 'admin') return '#/admin/' + route.section
  if (route.kind === 'reset') return '#/reset' + (route.token ? '?token=' + encodeURIComponent(route.token) : '')
  if (route.kind === 'receipt') return '#/receipt/' + encodeURIComponent(route.token)
  if (route.kind === 'legal') return '#/legal/' + route.doc
  if (route.kind === 'help') return route.slug ? '#/help/' + route.slug : '#/help'
  if (route.kind === 'sources') return '#/sources'
  if (route.kind === 'share') return '#/share/' + encodeURIComponent(route.token)
  if (route.kind === 'shared-project') return '#/share/project/' + encodeURIComponent(route.token)
  return '#/agents/' + (route.agentRef ? encodeURIComponent(route.agentRef) : 'new')
}

/** 用字符串比较路由是否相同，供 key、订阅去重和「无变化不写历史」共用。 */
export function routeKey(route: Route): string {
  if (route.kind === 'page') {
    if (route.page === 'board') return 'page:board:' + (route.boardId ?? '')
    if (route.page === 'canvas') {
      if (route.flowId && route.viewRunId) return 'page:canvas:flow:' + route.flowId + ':view:' + route.viewRunId
      if (route.flowId && route.resumeRunId) return 'page:canvas:flow:' + route.flowId + ':resume:' + route.resumeRunId
      if (route.flowId) return 'page:canvas:flow:' + route.flowId
    }
    if (route.page === 'projects' && route.projectId && route.deliveryId) {
      return 'page:projects:' + route.projectId + ':delivery:' + route.deliveryId
    }
    if (route.page === 'projects' && route.projectId) return 'page:projects:' + route.projectId
    if (route.page === 'review' && route.reviewId) return 'page:review:record:' + route.reviewId
    if (route.page === 'review' && route.projectId) return 'page:review:project:' + route.projectId
    if (route.page === 'templates' && route.templateId) return 'page:templates:' + route.templateId
    return 'page:' + route.page
  }
  if (route.kind === 'admin') return 'admin:' + route.section
  if (route.kind === 'reset') return 'reset:' + route.token
  if (route.kind === 'legal') return 'legal:' + route.doc
  if (route.kind === 'help') return 'help:' + (route.slug ?? '')
  if (route.kind === 'sources') return 'sources'
  if (route.kind === 'share') return 'share:' + route.token
  if (route.kind === 'shared-project') return 'shared-project:' + route.token
  if (route.kind === 'receipt') return 'receipt:' + route.token
  return 'agent-editor:' + (route.agentRef ?? 'new')
}

let snapshot: Route | null = null
let listening = false
const listeners = new Set<() => void>()

function publish(route: Route) {
  const previous = snapshot
  if (previous && routeKey(previous) === routeKey(route)) return
  snapshot = route
  for (const listener of listeners) listener()
}

// 邀请链接 #/register?code=... 是登录页的入口，不是工作台路由：
// 地址要原样留给登录页读邀请码，规范化成 #/overview 之后码就丢了。
function isAuthEntryLink(hash: string): boolean {
  return /^#\/(?:register|login)(?:[?]|$)/.test(hash)
}

function handleHashChange() {
  const route = parseRoute(window.location.hash)
  // 浏览器的后退 / 前进也是「离开这一页」（r270）：先把地址改回去，再问同一句话。
  // 不这么做的话，只有侧栏和链接被拦住，按一下后退照样悄悄丢。
  const note = unsavedNote()
  if (note && snapshot && routeKey(route) !== routeKey(snapshot)) {
    window.history.pushState(null, '', toHash(snapshot))
    leaveRequest = { route, replace: true, message: note.message, owner: note.owner }
    publishLeave()
    return
  }
  const canonical = toHash(route)
  // 非法或旧格式的 hash 用 replaceState 修正，不额外压一条历史。
  if (window.location.hash !== canonical && !isAuthEntryLink(window.location.hash)) {
    window.history.replaceState(null, '', canonical)
  }
  publish(route)
}

function ensureListening() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('hashchange', handleHashChange)
}

/**
 * 首次进入：把空 hash / 非规范 hash 修正成规范地址，使用 replaceState，
 * 保证启动本身不产生多余的历史记录。preferredEdition 只用于「没有 hash」时的落点。
 */
export function initializeRoute(preferredEdition?: EditionId): Route {
  const raw = window.location.hash
  const bare = raw === '' || raw === '#' || raw === '#/'
  initialBareEntry = bare
  let route = parseRoute(raw)
  if (bare && preferredEdition === 'admin') {
    route = { kind: 'admin', section: DEFAULT_ADMIN_SECTION }
  }
  snapshot = route
  const canonical = toHash(route)
  if (raw !== canonical && !isAuthEntryLink(raw)) window.history.replaceState(null, '', canonical)
  ensureListening()
  return route
}

/** 真正落地址；拦不拦由 navigate 决定，这里不做判断。 */
function writeRoute(route: Route, options: { replace?: boolean } = {}) {
  ensureListening()
  const hash = toHash(route)
  if (window.location.hash !== hash) {
    if (options.replace) window.history.replaceState(null, '', hash)
    else window.location.hash = hash
  }
  publish(route)
}

/**
 * 还没保存就跳走时挂在这里的那一次跳转（r270）。
 *
 * 为什么放在路由层：侧栏、命令面板、页里的链接、页头返回都走 navigate，
 * 挨个页面自己拦一定会漏；这里拦一次，所有入口都算数。
 * 不直接 window.confirm：那是浏览器的原生框，和这套界面不是一个东西，
 * 也挡不住「到底丢了哪一句」——所以挂起这次跳转，由 App 用弹窗问。
 */
export type LeaveRequest = {
  route: Route
  replace: boolean
  /** 问用户的那句话：哪个页面、丢了什么 */
  message: string
  /** 谁的登记。用户选了「丢下改动」就把它撤掉，免得下一次跳转又被它拦住 */
  owner: string
}

let leaveRequest: LeaveRequest | null = null
const leaveListeners = new Set<() => void>()

function publishLeave() {
  for (const listener of leaveListeners) listener()
}

export function subscribeLeave(listener: () => void): () => void {
  leaveListeners.add(listener)
  return () => {
    leaveListeners.delete(listener)
  }
}

export function getLeaveRequest(): LeaveRequest | null {
  return leaveRequest
}

/** 挂着的「还没保存就走了」这件事，给 App 画弹窗用。 */
export function useLeaveRequest(): LeaveRequest | null {
  return useSyncExternalStore(subscribeLeave, getLeaveRequest, getLeaveRequest)
}

/** 写路由：默认压一条历史（浏览器后退可用），replace 只改当前条目。 */
export function navigate(route: Route, options: { replace?: boolean } = {}) {
  ensureListening()
  const note = unsavedNote()
  if (note && shouldAskBeforeLeave(true, routeKey(getRouteSnapshot()), routeKey(route))) {
    leaveRequest = { route, replace: Boolean(options.replace), message: note.message, owner: note.owner }
    publishLeave()
    return
  }
  writeRoute(route, options)
}

/** 用户选了「丢下改动，走」：把刚才拦下的那次跳转执行掉。 */
export function confirmLeave(): void {
  const request = leaveRequest
  leaveRequest = null
  publishLeave()
  if (!request) return
  // 用户已经选了「丢下」：先撤登记再落地址。
  // 不撤的话，紧接着的 hashchange 会被当成又一次「没保存就想走」，弹窗自己弹回来。
  clearUnsaved(request.owner)
  writeRoute(request.route, { replace: request.replace })
}

/** 用户选了「留在这页」：这次跳转忘掉，什么都不写。 */
export function cancelLeave(): void {
  if (!leaveRequest) return
  leaveRequest = null
  publishLeave()
}

/**
 * 换人（退出登录 / 切换账号）时清掉挂着的拦截：
 * 上一位用户的编辑已经随会话消失，不能拿它拦住下一位用户的第一次点击。
 */
export function resetLeaveRequest(): void {
  if (!leaveRequest) return
  leaveRequest = null
  publishLeave()
}

/** 只改地址栏、不触发重渲染：画布页内切流程时同步 flowId，避免整页重挂载。 */
export function replaceRoute(route: Route) {
  ensureListening()
  const hash = toHash(route)
  if (window.location.hash === hash) return
  window.history.replaceState(null, '', hash)
}

export function subscribeRoute(listener: () => void): () => void {
  ensureListening()
  if (!snapshot) snapshot = parseRoute(window.location.hash)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getRouteSnapshot(): Route {
  if (!snapshot) snapshot = parseRoute(window.location.hash)
  return snapshot
}

/** 组件里读当前路由：写入 navigate 或浏览器前进/后退都会触发重渲染。 */
export function useRoute(): Route {
  return useSyncExternalStore(subscribeRoute, getRouteSnapshot, getRouteSnapshot)
}
