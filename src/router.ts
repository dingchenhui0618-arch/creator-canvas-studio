// 地址栏路由：页面的唯一真源是 location.hash。
// 约定：#/overview #/projects #/radar #/templates #/agents #/runs #/review #/canvas #/settings
//      作品：#/projects/<作品 id>；评审带作品：#/review/project/<作品 id>
//      智能体编辑：#/agents/new 与 #/agents/<id 或唯一名称>
//      后台管理：#/admin/<section>，section 取自 editions.ts 的后台导航。
//
// 说明：本文件不碰登录态。RequireSession 仍然决定有没有工作台；
// 只有工作台内部的页面切换走 hash，刷新与前进/后退都由浏览器负责。
import { useSyncExternalStore } from 'react'
import type { Page } from './domain/types'
import { EDITION_BY_ID, type AdminSection, type EditionId } from './editions'

/** 外壳里真正占一屏的用户页面；登录与编辑器各自有独立入口。 */
export type ShellPage = Exclude<Page, 'login' | 'agent-editor'>

export type Route =
  // 画布有两个可寻址对象：
  //   #/canvas/<flowId>            内置编排的流程（模板库、运行记录跳转都走它）
  //   #/canvas/project/<画布ID>    画布服务里的画布项目（工作台「继续上次的画布」走它）
  | { kind: 'page'; page: ShellPage; flowId?: string; canvasId?: string; projectId?: string }
  | { kind: 'agent-editor'; agentRef: string | null }
  | { kind: 'legal'; doc: 'terms' | 'privacy' }
  // 只读分享：链接里带随机 token，不登录也能打开（App 根部整屏渲染，不进工作台外壳）
  | { kind: 'share'; token: string }
  | { kind: 'admin'; section: AdminSection }

export const DEFAULT_ROUTE: Route = { kind: 'page', page: 'overview' }

const USER_PAGES: readonly ShellPage[] = [
  'overview',
  'projects',
  'radar',
  'templates',
  'agents',
  'runs',
  'review',
  'canvas',
  'settings',
]

// 后台 section 直接取自 editions.ts，避免在路由里再抄一份会漂移的清单。
const ADMIN_SECTIONS: readonly string[] = EDITION_BY_ID.admin.nav.map((item) => item.section ?? item.id)
const DEFAULT_ADMIN_SECTION: AdminSection = (ADMIN_SECTIONS[0] as AdminSection | undefined) ?? 'overview'

/** 把路由转回 domain 里的 Page：后台没有用户 Page 语义，统一落到工作台用于面包屑兜底。 */
export function routeToPage(route: Route): Page {
  if (route.kind === 'page') return route.page
  if (route.kind === 'agent-editor') return 'agent-editor'
  return 'overview'
}

/** 不进工作台外壳的路由：条款页与只读分享页整屏渲染，工作台骨架不参与。 */
export function isBareRoute(route: Route): boolean {
  return route.kind === 'legal' || route.kind === 'share'
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
  if (value && ADMIN_SECTIONS.includes(value)) return value as AdminSection
  return DEFAULT_ADMIN_SECTION
}

/** 纯解析：不读写 history，方便在事件回调里复用。 */
export function parseRoute(hash: string): Route {
  const cleaned = hash.replace(/^#/, '').trim()
  if (!cleaned || cleaned === '/') return DEFAULT_ROUTE
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
  // 分享链接：token 是整条路径的余下部分，缺了就落回工作台
  if (head === 'share') return tail ? { kind: 'share', token: tail } : DEFAULT_ROUTE
  // 旧的 #/welcome 链接不再单独成页：引导已改成工作台内的弹窗，落回工作台即可。
  // 作品有两个地址：#/projects 列表与 #/projects/<作品 id>
  if (head === 'projects') {
    if (tail) return { kind: 'page', page: 'projects', projectId: tail }
    return { kind: 'page', page: 'projects' }
  }
  // 评审页的「这次记入哪条作品」也写进地址：#/review/project/<作品 id>
  if (head === 'review') {
    if (tail === 'project' && segments[2]) return { kind: 'page', page: 'review', projectId: segments[2] }
    return { kind: 'page', page: 'review' }
  }
  if (head === 'agents') {
    if (!tail) return { kind: 'page', page: 'agents' }
    if (tail === 'new') return { kind: 'agent-editor', agentRef: null }
    return { kind: 'agent-editor', agentRef: tail }
  }
  if ((USER_PAGES as readonly string[]).includes(head)) {
    if (head === 'canvas') {
      if (tail === 'project' && segments[2]) return { kind: 'page', page: 'canvas', canvasId: segments[2] }
      return { kind: 'page', page: 'canvas', flowId: tail || undefined }
    }
    return { kind: 'page', page: head as ShellPage }
  }
  return DEFAULT_ROUTE
}

/** 规范化 hash：没有任何查询串，只保留可寻址的路径。 */
export function toHash(route: Route): string {
  if (route.kind === 'page') {
    if (route.page === 'canvas') {
      if (route.canvasId) return '#/canvas/project/' + encodeURIComponent(route.canvasId)
      if (route.flowId) return '#/canvas/' + encodeURIComponent(route.flowId)
    }
    if (route.page === 'projects' && route.projectId) return '#/projects/' + encodeURIComponent(route.projectId)
    if (route.page === 'review' && route.projectId) return '#/review/project/' + encodeURIComponent(route.projectId)
    return '#/' + route.page
  }
  if (route.kind === 'admin') return '#/admin/' + route.section
  if (route.kind === 'legal') return '#/legal/' + route.doc
  if (route.kind === 'share') return '#/share/' + encodeURIComponent(route.token)
  return '#/agents/' + (route.agentRef ? encodeURIComponent(route.agentRef) : 'new')
}

/** 用字符串比较路由是否相同，供 key、订阅去重和「无变化不写历史」共用。 */
export function routeKey(route: Route): string {
  if (route.kind === 'page') {
    if (route.page === 'canvas') {
      if (route.canvasId) return 'page:canvas:project:' + route.canvasId
      if (route.flowId) return 'page:canvas:flow:' + route.flowId
    }
    if (route.page === 'projects' && route.projectId) return 'page:projects:' + route.projectId
    if (route.page === 'review' && route.projectId) return 'page:review:project:' + route.projectId
    return 'page:' + route.page
  }
  if (route.kind === 'admin') return 'admin:' + route.section
  if (route.kind === 'legal') return 'legal:' + route.doc
  if (route.kind === 'share') return 'share:' + route.token
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

function handleHashChange() {
  const route = parseRoute(window.location.hash)
  const canonical = toHash(route)
  // 非法或旧格式的 hash 用 replaceState 修正，不额外压一条历史。
  if (window.location.hash !== canonical) window.history.replaceState(null, '', canonical)
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
  let route = parseRoute(raw)
  if (bare && preferredEdition === 'admin') {
    route = { kind: 'admin', section: DEFAULT_ADMIN_SECTION }
  }
  snapshot = route
  const canonical = toHash(route)
  if (raw !== canonical) window.history.replaceState(null, '', canonical)
  ensureListening()
  return route
}

/** 写路由：默认压一条历史（浏览器后退可用），replace 只改当前条目。 */
export function navigate(route: Route, options: { replace?: boolean } = {}) {
  ensureListening()
  const hash = toHash(route)
  if (window.location.hash !== hash) {
    if (options.replace) window.history.replaceState(null, '', hash)
    else window.location.hash = hash
  }
  publish(route)
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
