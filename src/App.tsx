import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  Loader2,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { pageLabels, type Page } from './domain/types'
import './App.css'
import './styles/shell.css'
import './styles/overview.css'
import { NavItem } from './components/ui'
import { CommandPalette } from './components/CommandPalette'
import type { PaletteCommand } from './domain/commands'
import { DESKTOP_NAV, PRIMARY_NAV, SETTINGS_NAV, TOOL_NAV, isNavActive, isToolPage, type NavEntry } from './nav'
import { getDesktop } from './desktop/bridge'
import { WelcomeGuide } from './components/WelcomeGuide'
import { ModelSwitch } from './components/ModelSwitch'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PageSkeleton } from './components/PageSkeleton'
import ReviewPage from './pages/ReviewPage'
import { OverviewPage } from './pages/OverviewPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectPage from './pages/ProjectPage'
import { RunsPage } from './pages/RunsPage'
import { SettingsPage } from './pages/SettingsPage'
import { RadarPage } from './pages/RadarPage'
import LocalWorkspacePage from './pages/LocalWorkspacePage'
import { RequireSession } from './auth/RequireSession'
import { useSession } from './auth/useSession'
import { useUiMode } from './api/app'
import { initialsFor, sessionKindLabel, type RegisterInput, type Session, type SignInInput } from './auth/session'
import { listAgents, setPendingAgentProject } from './api/agents'
import { createBdcCanvas } from './api/bdc'
import { listReviewQueue } from './api/review'
import { listFeedback } from './api/feedback'
import { navigate, pageToRoute, routeKey, routeToPage, useRoute, type Route } from './router'
import { planScroll } from './domain/scroll'
import { welcomeSeenKey } from './onboarding'
import packageJsonRaw from '../package.json?raw'
import { EDITION_BY_ID, EDITION_STORAGE_KEY, type AdminSection } from './editions'

const APP_VERSION = (JSON.parse(packageJsonRaw) as { version?: string }).version ?? '0.0.0'

// 快速跳转的快捷键提示按平台显示；功能本身两个修饰键都收。
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

// 重页面按路由拆包：画布带 @xyflow、智能体与模板库带各自的样式表，首屏不必等它们。
const CanvasPage = lazy(() => import('./pages/CanvasPage'))
const AgentsPage = lazy(() => import('./pages/AgentsPage').then((module) => ({ default: module.AgentsPage })))
const TemplateLibraryPage = lazy(() =>
  import('./pages/TemplateLibraryPage').then((module) => ({ default: module.TemplateLibraryPage })),
)
const AdminConsolePage = lazy(() => import('./pages/admin/AdminConsolePage'))
const LegalPage = lazy(() => import('./pages/LegalPage').then((module) => ({ default: module.LegalPage })))
// 找回密码页也是「不登录就能打开」的一屏：邮件链接直接落到这里
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then((module) => ({ default: module.ResetPasswordPage })))
// 只读分享页单独拆包：外部访客只下载这一屏，不需要工作台那一整套
const SharePage = lazy(() => import('./pages/SharePage'))
// 作品分享页也单独拆包：它读的是脚本与分镜，不依赖工作台组件
const ProjectSharePage = lazy(() => import('./pages/ProjectSharePage'))
// 帮助中心也是公开可读的一屏：不登录的人先来这里找答案，而不是卡在登录页
const HelpPage = lazy(() => import('./pages/HelpPage').then((module) => ({ default: module.HelpPage })))
// 素材来源与下架通道（v0.9.82）：公开可读的一屏，和帮助中心一样不进工作台外壳
const SourcesPage = lazy(() => import('./pages/SourcesPage').then((module) => ({ default: module.SourcesPage })))
const AgentEditorPage = lazy(() => import('./pages/AgentEditorPage'))

function sectionLabel(section: string): string {
  const found = EDITION_BY_ID.admin.nav.find((item) => item.section === section)
  return found?.label ?? EDITION_BY_ID.admin.nav[0]?.label ?? ''
}

type AgentSeed = { name: string; description: string }

/**
 * 智能体编辑器路由：地址里可能给的是 id（外链）或名称（列表入口只回传名称）。
 * 先把引用解析成 AgentEditorPage 需要的 { name, description }，再交给编辑器。
 */
function AgentEditorRoute({
  agentRef,
  onBack,
  onNavigate,
  onToast,
}: {
  agentRef: string | null
  onBack: () => void
  onNavigate: (page: Page) => void
  onToast: (message: string) => void
}) {
  const [seed, setSeed] = useState<AgentSeed | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>(agentRef ? 'loading' : 'ready')

  useEffect(() => {
    if (!agentRef) return
    let alive = true
    listAgents()
      .then((data) => {
        if (!alive) return
        const record =
          data.items.find((item) => item.id === agentRef) ?? data.items.find((item) => item.name === agentRef)
        if (!record) {
          setStatus('missing')
          return
        }
        setSeed({ name: record.name, description: record.role })
        setStatus('ready')
      })
      .catch(() => {
        if (alive) setStatus('missing')
      })
    return () => {
      alive = false
    }
  }, [agentRef])

  if (status === 'loading') return <PageSkeleton label="正在打开智能体编辑器" />
  if (status === 'missing') {
    return (
      <div className="vq-error-fallback" role="alert">
        <div className="vq-error-card">
          <span className="vq-error-kicker">智能体 / 未找到</span>
          <h1>找不到这个智能体</h1>
          <p>地址里的智能体可能已被删除，或链接中的编号不属于当前工作区。返回列表重新选择，或新建一个。</p>
          <div className="vq-error-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={onBack}>
              返回智能体列表
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('agent-editor')}>
              新建智能体
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <AgentEditorPage
      key={seed?.name ?? 'new'}
      agent={seed ?? undefined}
      onBack={onBack}
      onNavigate={onNavigate}
      onToast={onToast}
    />
  )
}

function Workbench({
  session,
  onSignOut,
  onSwitchAccount,
}: {
  session: Session
  onSignOut: () => void
  onSwitchAccount: () => void
}) {
  const route = useRoute()
  const { internal } = useUiMode()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  // 快速跳转：导航收敛到 4 项之后，工具与动作靠键盘跳转（Ctrl / ⌘ + K）
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 画布专注模式：收起侧栏与顶栏，把屏幕让给画布本身（状态在壳里，画布页只负责切换）
  const [canvasFocus, setCanvasFocus] = useState(false)
  // 「等你看」的角标：数字来自工作台评审队列的 total，外壳不另算一遍。
  // null 表示这一次没取到——宁可没有角标，也不拿 0 冒充「没有等你改的」。
  const [queuePending, setQueuePending] = useState<number | null>(null)
  // 后台「反馈」的待处理角标：只在管理后台里取，进后台就对一次数
  const [feedbackPending, setFeedbackPending] = useState(0)

  const [toast, setToast] = useState('')
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const accountRef = useRef<HTMLDivElement>(null)
  // 换页的落地位置：真的换了页面就回到页头（v0.9.43）。
  // 该不该回、哪几种不算换页，判断只在 src/domain/scroll.ts 一处；这里只负责把 scrollTop 归零。
  const contentRef = useRef<HTMLDivElement | null>(null)
  const previousRoute = useRef<Route | null>(null)

  // 上手引导：第一次进工作台就弹出来（按账号记一次），关闭即记住；之后从账号菜单还能再看。
  const seenKey = welcomeSeenKey(session.user.id)
  const [guideOpen, setGuideOpen] = useState(() => {
    if (!seenKey) return false
    try {
      return !window.localStorage.getItem(seenKey)
    } catch {
      return false
    }
  })
  const closeGuide = useCallback(() => {
    setGuideOpen(false)
    try {
      if (seenKey) window.localStorage.setItem(seenKey, '1')
    } catch {
      // 隐私模式下写不进去：下次进工作台会再弹一次，可以接受
    }
  }, [seenKey])

  // 侧栏高亮、面包屑和内容页都从 hash 路由推导，页面本身不再保存 activePage。
  const activePage = routeToPage(route)
  // 路由的稳定标识：换页时用它触发角标对一次数，不必把整个 route 对象塞进依赖
  const routeId = routeKey(route)

  // 错误边界按「页」隔离，而不是按整条地址（v0.9.43）：
  // 同一页里发生的地址变化——打开单条模板的抽屉、打开一条历史评审、作品参数变化——
  // 以前会把整页重挂一遍，重挂连列表的搜索词、来源筛选和滚动位置一起清掉。
  // （画布页与作品页各自还留着自己的 key：换画布项目、换作品仍然要从头挂。）
  const pageBoundaryKey =
    route.kind === 'page'
      ? 'page:' + route.page
      : route.kind === 'admin'
        ? 'admin:' + route.section
        : route.kind === 'legal'
          ? 'legal:' + route.doc
          : route.kind

  // 换页后内容区停在哪儿：从页头开始（判断在 src/domain/scroll.ts）。
  // 在浏览器绘制前改 scrollTop（useLayoutEffect），换页不会先闪一下旧位置。
  // 淡入不在这里做：页面根节点挂载时由 tokens.css 的 vq-page-in 负责，换页才重挂，抽屉不会。
  useLayoutEffect(() => {
    const node = contentRef.current
    const previous = previousRoute.current
    previousRoute.current = route
    if (!node || planScroll(previous, route) !== 'top') return
    node.scrollTop = 0
  }, [route])
  // 本地工作区只在桌面外壳里成立：网页版连这一项都不显示
  const desktopBridge = getDesktop()

  // 专注模式只在画布页生效：离开画布时侧栏与顶栏一定回来，不会出现「侧栏不见了」；
  // 回到画布仍保持专注，等于记住用户上次的选择。
  const focusOn = canvasFocus && activePage === 'canvas'
  // 面包屑跟着导航层级走：工具页多一段「工具」，否则用户看不出自己已经离开了主线
  const inTools = isToolPage(activePage) || activePage === 'agent-editor'

  const notify = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
  }, [])

  // 只读取 /api/version 的真实版本号；接口不存在时如实说明，不伪造进度。
  const checkUpdate = useCallback(async () => {
    setUpdateChecking(true)
    setUpdateMessage('')
    try {
      const response = await fetch('/api/version', { headers: { Accept: 'application/json' } })
      const body = await response.text()
      let payload: { version?: string } | null = null
      try {
        payload = JSON.parse(body) as { version?: string }
      } catch {
        payload = null
      }
      if (!response.ok || !payload?.version) {
        setUpdateMessage(internal ? '更新通道未接入：/api/version 没有返回版本信息，未执行任何下载。' : '暂时无法检查更新，未执行任何下载。')
      } else if (payload.version === APP_VERSION) {
        setUpdateMessage(`已是最新版本（${payload.version}）。`)
      } else {
        setUpdateMessage(internal
          ? `远端版本 ${payload.version}，与本地 ${APP_VERSION} 不一致；发布版需重新拉取构建产物。`
          : `有新版本可用（${payload.version}），请联系平台维护人员完成升级。`)
      }
    } catch {
      setUpdateMessage(internal ? '更新通道未接入：请求 /api/version 失败，未执行任何下载。' : '暂时无法检查更新，未执行任何下载。')
    } finally {
      setUpdateChecking(false)
    }
  }, [internal])

  // 角标只读队列的 total：换页时对一次；评出新结论 / 看过 / 撤销 / 拍板后由事件再对一次。
  // 管理后台与取数失败都不显示数字。
  const refreshQueueBadge = useCallback(async () => {
    try {
      const result = await listReviewQueue(1)
      const total = Number(result?.total)
      setQueuePending(Number.isFinite(total) ? Math.max(0, Math.round(total)) : null)
    } catch {
      setQueuePending(null)
    }
  }, [])

  useEffect(() => {
    // 管理后台不渲染主线导航，角标不参与；它那套导航里也不该出现「等你看」
    if (route.kind === 'admin') return
    // 与列表页同一套写法：换页先让首屏渲染，再对一次数，不在 effect 里同步改状态
    const timer = window.setTimeout(() => void refreshQueueBadge(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshQueueBadge, routeId, route.kind, session.user.id])

  const refreshFeedbackBadge = useCallback(async () => {
    try {
      const data = await listFeedback('new')
      setFeedbackPending(Number(data.counts?.new) || 0)
    } catch {
      setFeedbackPending(0)
    }
  }, [])

  useEffect(() => {
    if (route.kind !== 'admin') return
    const timer = window.setTimeout(() => void refreshFeedbackBadge(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshFeedbackBadge, routeId, route.kind])

  useEffect(() => {
    const onFeedbackChanged = () => void refreshFeedbackBadge()
    window.addEventListener('vq:feedback-changed', onFeedbackChanged)
    return () => window.removeEventListener('vq:feedback-changed', onFeedbackChanged)
  }, [refreshFeedbackBadge])

  useEffect(() => {
    const onQueueChanged = () => void refreshQueueBadge()
    window.addEventListener('vq:queue-changed', onQueueChanged)
    return () => window.removeEventListener('vq:queue-changed', onQueueChanged)
  }, [refreshQueueBadge])

  const queueBadge = queuePending && queuePending > 0 ? (queuePending > 99 ? '99+' : String(queuePending)) : undefined

  const go = useCallback((page: Page) => {
    navigate(pageToRoute(page))
    setAccountMenuOpen(false)
  }, [])

  const openNewAgent = useCallback(() => {
    navigate({ kind: 'agent-editor', agentRef: null })
    setAccountMenuOpen(false)
  }, [])

  // 「新建 → 资产画布」直接调画布服务建一块真画布，建完就打开它；
  // 服务不可用时退回画布页并如实提示，不留下一个只在本地存在的新画布。
  const createCanvasProject = useCallback(async () => {
    notify('正在新建画布…')
    const stamp = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date())
    try {
      const result = await createBdcCanvas('新画布 ' + stamp)
      if (result?.canvas?.id) {
        navigate({ kind: 'page', page: 'canvas', canvasId: result.canvas.id })
        notify('已新建画布：' + result.canvas.name)
        return
      }
      go('canvas')
      notify('画布服务没有返回新画布，已打开画布页')
    } catch (error) {
      go('canvas')
      notify('新建画布失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [go, notify])

  // 侧栏与命令面板共用同一个跳转口径：已经在画布上不重载当前流程。
  const navTo = useCallback(
    (entry: NavEntry) => {
      if (entry.id === 'canvas' && route.kind === 'page' && route.page === 'canvas') {
        setAccountMenuOpen(false)
        return
      }
      go(entry.id)
    },
    [go, route],
  )

  // 命令面板的清单直接由导航真源生成，再补三条真实动作；不另抄一份页面清单。
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const navCommand = (entry: NavEntry, group: string): PaletteCommand => ({
      id: 'go-' + entry.id,
      label: entry.label,
      hint: entry.hint,
      group,
      icon: entry.icon,
      keywords: entry.keywords,
      run: () => navTo(entry),
    })
    return [
      ...PRIMARY_NAV.map((entry) => navCommand(entry, '页面')),
      // 本机这一项只在桌面端存在，网页版不列出（列了也点不进真实能力）
      ...(desktopBridge ? [navCommand(DESKTOP_NAV, '本机')] : []),
      ...TOOL_NAV.map((entry) => navCommand(entry, '工具')),
      navCommand(SETTINGS_NAV, '设置'),
      {
        id: 'action-new-canvas',
        label: '新建空白画布',
        hint: '建一块真画布，建完直接打开',
        group: '动作',
        icon: Plus,
        keywords: 'new canvas 新建 空白 画布',
        run: () => void createCanvasProject(),
      },
      {
        id: 'action-guide',
        label: '使用引导',
        hint: '三步：找 → 拆 → 验',
        group: '动作',
        icon: Compass,
        keywords: 'guide help 帮助 引导 教程',
        run: () => setGuideOpen(true),
      },
      {
        id: 'action-help',
        label: '帮助中心',
        hint: '积分、失败排查、素材边界',
        group: '动作',
        icon: BookOpen,
        keywords: 'help 帮助 文档 积分 失败 版权',
        run: () => navigate({ kind: 'help', slug: null }),
      },
      {
        id: 'action-sidebar',
        label: sidebarOpen ? '收起侧栏' : '展开侧栏',
        hint: '把屏幕让给内容',
        group: '动作',
        icon: sidebarOpen ? PanelLeftClose : PanelLeftOpen,
        keywords: 'sidebar 侧栏 折叠 展开',
        run: () => setSidebarOpen((value) => !value),
      },
    ]
  }, [createCanvasProject, desktopBridge, navTo, sidebarOpen])

  // Ctrl / ⌘ + K 打开快速跳转。正在输入的地方不抢键：编辑器里的同名快捷键仍然属于编辑器。
  useEffect(() => {
    if (guideOpen || updateOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      const target = event.target as HTMLElement | null
      const editing =
        target instanceof HTMLElement &&
        (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      if (editing) return
      event.preventDefault()
      setPaletteOpen((value) => !value)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [guideOpen, updateOpen])

  // 列表入口只把名称交给外壳。先换成稳定 id 再写地址，地址栏里始终是 #/agents/<id>；
  // 解析失败时退回名称，编辑器那边仍能按唯一名称找回记录。
  const openAgent = useCallback((name: string) => {
    setAccountMenuOpen(false)
    void listAgents()
      .then((data) => {
        const record = data.items.find((item) => item.name === name)
        navigate({ kind: 'agent-editor', agentRef: record?.id ?? name })
      })
      .catch(() => {
        navigate({ kind: 'agent-editor', agentRef: name })
      })
  }, [])

  const leaveAdmin = useCallback(() => {
    try {
      window.localStorage.setItem(EDITION_STORAGE_KEY, 'user')
    } catch {
      // 隐私模式下写不进去，本次会话仍然生效
    }
    navigate({ kind: 'page', page: 'overview' })
    setAccountMenuOpen(false)
  }, [])

  // 跨页跳转：保留旧的自定义事件（评审页仍用它），统一翻译成 hash 路由。
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: Page }>).detail
      if (detail?.page && detail.page !== 'login' && detail.page in pageLabels) {
        navigate(pageToRoute(detail.page))
        setAccountMenuOpen(false)
      }
    }
    window.addEventListener('vq:navigate', onNavigate)
    return () => window.removeEventListener('vq:navigate', onNavigate)
  }, [])

  // 账号菜单点外部关闭；菜单与更新面板都响应 Esc。
  useEffect(() => {
    if (!accountMenuOpen && !updateOpen) return
    const closeOnPointer = (event: MouseEvent) => {
      if (accountMenuOpen && accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setAccountMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountMenuOpen(false)
        setUpdateOpen(false)
      }
    }
    document.addEventListener('mousedown', closeOnPointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountMenuOpen, updateOpen])

  const renderPage = () => {
    // 合规页与只读分享页在 App 根部整屏渲染，不进侧栏外壳；引导是工作台里的弹窗，不占路由
    if (
      route.kind === 'legal' ||
      route.kind === 'help' ||
      route.kind === 'sources' ||
      route.kind === 'share' ||
      route.kind === 'shared-project' ||
      route.kind === 'reset'
    ) {
      return null
    }
    if (route.kind === 'admin') return <AdminConsolePage section={route.section} />
    if (route.kind === 'agent-editor') {
      return (
        <AgentEditorRoute
          agentRef={route.agentRef}
          onBack={() => go('agents')}
          onNavigate={go}
          onToast={notify}
        />
      )
    }
    switch (route.page) {
      case 'canvas':
        // 只有「换了画布项目」才整页重挂（不带上一块的撤销栈）。
        // flowId 故意不进 key：页面加载完会把它补进地址栏，进 key 就等于自己把自己重挂一次——
        // 表现出来就是进画布闪一下、/api/flows 连打两遍。
        return (
          <CanvasPage
            key={'canvas:' + (route.canvasId || 'flow')}
            flowId={route.flowId}
            resumeRunId={route.resumeRunId}
            canvasId={route.canvasId}
            onToast={notify}
            focus={focusOn}
            onToggleFocus={() => setCanvasFocus((value) => !value)}
          />
        )
      case 'projects':
        // 作品有两个地址：#/projects 列表与 #/projects/<id>；打开某一项不换页面职责，只换参数
        return route.projectId ? (
          <ProjectPage
            key={route.projectId}
            projectId={route.projectId}
            onBack={() => navigate({ kind: 'page', page: 'projects' })}
            onOpenFlow={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onOpenReview={(projectId) => navigate({ kind: 'page', page: 'review', projectId })}
            onOpenReviewRecord={(reviewId) => navigate({ kind: 'page', page: 'review', reviewId })}
            onOpenAgents={(projectId) => {
              // 一次性交接：智能体页读到这条作品就清掉，之后再进不会还挂着上一条
              setPendingAgentProject(projectId)
              go('agents')
            }}
            onBrowseTemplates={() => go('templates')}
            onOpenTemplate={(templateId) => navigate({ kind: 'page', page: 'templates', templateId })}
            onToast={notify}
          />
        ) : (
          <ProjectsPage
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
            onBrowseTemplates={() => go('templates')}
            onDiscover={() => go('radar')}
          />
        )
      case 'radar':
        return (
          <RadarPage
            onToast={notify}
            onOpenTemplates={() => go('templates')}
            onOpenTemplate={(templateId) => navigate({ kind: 'page', page: 'templates', templateId })}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
          />
        )
      case 'templates':
        return (
          <TemplateLibraryPage
            onToast={notify}
            onBack={() => go('radar')}
            onOpenCanvas={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
            // 单条模板有地址：刷新、后退、从作品页的「来源」点进来都落在同一条上。
            // 关抽屉用 replace：后退回到进来之前那一页，而不是重新打开刚关掉的模板。
            templateId={route.templateId}
            onOpenTemplate={(templateId) => navigate({ kind: 'page', page: 'templates', templateId })}
            onCloseTemplate={() => navigate({ kind: 'page', page: 'templates' }, { replace: true })}
          />
        )
      case 'overview':
        return (
          <OverviewPage
            userName={session.user.name}
            onCreateCanvas={() => void createCanvasProject()}
            onNavigate={go}
            onOpenCanvas={(canvasId) => navigate({ kind: 'page', page: 'canvas', canvasId })}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
            onOpenGuide={() => setGuideOpen(true)}
          />
        )
      case 'agents':
        // 结构化草稿的两个出口：存为模板去模板库，送到画布直接带着新流程进画布页
        return (
          <AgentsPage
            onCreate={openNewAgent}
            onOpenAgent={openAgent}
            onOpenTemplates={() => go('templates')}
            onOpenCanvas={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
            onToast={notify}
          />
        )
      case 'runs':
        return (
          <RunsPage
            onOpenFlow={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onResumeRun={(flowId, runId) => navigate({ kind: 'page', page: 'canvas', flowId, resumeRunId: runId })}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
          />
        )
      case 'local':
        return <LocalWorkspacePage />
      case 'review':
        return (
          <ReviewPage
            key={route.projectId || 'review'}
            projectId={route.projectId}
            reviewId={route.reviewId}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
            onOpenReview={(reviewId) => navigate({ kind: 'page', page: 'review', reviewId })}
            onReviewProject={(projectId) => navigate({ kind: 'page', page: 'review', projectId })}
            onClearReview={() => navigate({ kind: 'page', page: 'review' })}
            onOpenProjects={() => navigate({ kind: 'page', page: 'projects' })}
          />
        )
      case 'settings':
        return <SettingsPage session={session} onSignOut={onSignOut} onSwitchAccount={onSwitchAccount} />
      default:
        return null
    }
  }

  const initials = initialsFor(session.user.name)

  return (
    <div className={'vq-scope vq-shell' + (focusOn ? ' is-focus' : '')}>
      <aside className={`vq-sidebar${sidebarOpen ? '' : ' vq-sidebar--collapsed'}`}>
        <div className="vq-sidebar-scroll">
          <div className="vq-brand">
            <span className="vq-brand-dot" aria-hidden="true" />
            <span className="vq-brand-text">VisionQA</span>
          </div>

          {sidebarOpen && (
            <div className="vq-workspace">
              <span className="vq-workspace-avatar">{initials}</span>
              <span className="vq-workspace-meta">
                <strong>{session.user.workspace}</strong>
                <span>{session.user.kind === 'guest' ? '访客会话' : internal ? '服务端会话' : '已登录'}</span>
              </span>
            </div>
          )}

          {route.kind === 'admin' && (
            // 后台只从地址栏 #/admin/<section> 进来；普通用户侧栏里没有任何形态切换。
            <div className="vq-edition-bar" aria-label="当前形态">
              <span className="vq-edition-kicker" title={EDITION_BY_ID.admin.hint}>
                后台管理版
              </span>
              <button type="button" className="vq-button vq-button--quiet vq-button--sm" onClick={leaveAdmin}>
                返回生产版
              </button>
            </div>
          )}

          {route.kind !== 'admin' ? (
            <>
              <nav className="vq-nav" aria-label="主导航">
                {PRIMARY_NAV.map((entry) => (
                  <NavItem
                    key={entry.id}
                    icon={entry.icon}
                    label={entry.label}
                    active={isNavActive(entry, activePage)}
                    compact={!sidebarOpen}
                    badge={entry.id === 'overview' ? queueBadge : undefined}
                    badgeLabel={entry.id === 'overview' && queueBadge ? queueBadge + ' 条评审等你看' : undefined}
                    onClick={() => navTo(entry)}
                  />
                ))}
              </nav>
              {desktopBridge ? (
                <nav className="vq-nav" aria-label="本机">
                  <div className="vq-nav-label" aria-hidden="true">
                    本机
                  </div>
                  <NavItem
                    icon={DESKTOP_NAV.icon}
                    label={DESKTOP_NAV.label}
                    active={activePage === 'local'}
                    compact={!sidebarOpen}
                    onClick={() => navTo(DESKTOP_NAV)}
                  />
                </nav>
              ) : null}
              {/* 工具区：能力不再和「发现 / 模板库」并列成同一类入口；收起侧栏时只留一道分隔线 */}
              <nav className="vq-nav vq-nav--tools" aria-label="工具">
                {/* 展开时是一行分组标签，收起或窄屏时同一元素变成一道分隔线（见 shell.css） */}
                <div className="vq-nav-label" aria-hidden="true">
                  工具
                </div>
                {TOOL_NAV.map((entry) => (
                  <NavItem
                    key={entry.id}
                    icon={entry.icon}
                    label={entry.label}
                    active={isNavActive(entry, activePage)}
                    compact={!sidebarOpen}
                    onClick={() => navTo(entry)}
                  />
                ))}
              </nav>
            </>
          ) : (
            <nav className="vq-nav" aria-label={EDITION_BY_ID.admin.label + '导航'}>
              {EDITION_BY_ID.admin.nav.map((item) => {
                const Icon = item.icon
                return (
                  <NavItem
                    key={item.id}
                    icon={Icon}
                    label={item.label}
                    active={route.kind === 'admin' && route.section === item.section}
                    compact={!sidebarOpen}
                    badge={item.section === 'feedback' && feedbackPending > 0 ? (feedbackPending > 99 ? '99+' : String(feedbackPending)) : undefined}
                    badgeLabel={item.section === 'feedback' && feedbackPending > 0 ? feedbackPending + ' 条反馈待处理' : undefined}
                    onClick={() => {
                      if (item.section) navigate({ kind: 'admin', section: item.section as AdminSection })
                    }}
                  />
                )
              })}
            </nav>
          )}
        </div>

        <div className="vq-sidebar-bottom">
                    {route.kind !== 'admin' ? (
            <>
  <div className="vq-nav-divider" role="presentation" />
            <nav className="vq-nav vq-nav--utility" aria-label="设置层">
              <NavItem
                utility
                icon={SETTINGS_NAV.icon}
                label={SETTINGS_NAV.label}
                active={activePage === 'settings'}
                compact={!sidebarOpen}
                onClick={() => go('settings')}
              />
            </nav>
            </>
          ) : null}

          <div className="vq-sidebar-account" ref={accountRef}>
            <>
                <button
                  type="button"
                  className="vq-sidebar-account-row"
                  aria-haspopup="menu"
                  aria-expanded={accountMenuOpen}
                  onClick={() => setAccountMenuOpen((value) => !value)}
                  title={sidebarOpen ? undefined : `${session.user.name} · ${session.user.email}`}
                >
                  <span className="vq-sidebar-account-avatar">{initials}</span>
                  <span className="vq-sidebar-account-copy">
                    <strong>{session.user.name}</strong>
                    <small title={session.user.email}>{session.user.email}</small>
                  </span>
                  <MoreHorizontal size={15} className="vq-sidebar-account-more" />
                </button>

                {accountMenuOpen && (
                  <div className="vq-menu vq-sidebar-account-menu" role="menu">
                    <div className="vq-sidebar-account-menu-meta">
                      <span className="vq-mono">{sessionKindLabel(session.user.kind)}</span>
                      <span className="vq-mono">{internal ? '服务端会话' : '已登录'}</span>
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenuOpen(false)
                        setGuideOpen(true)
                      }}
                    >
                      <Compass size={15} />
                      使用引导
                    </button>
                    <button type="button" role="menuitem" onClick={() => go('settings')}>
                      <Settings2 size={15} />
                      账号设置
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAccountMenuOpen(false)
                        onSwitchAccount()
                      }}
                    >
                      <RefreshCw size={15} />
                      切换账号
                    </button>
                    <div className="vq-menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        setAccountMenuOpen(false)
                        onSignOut()
                      }}
                    >
                      <LogOut size={15} />
                      退出登录
                    </button>
                  </div>
                )}
              </>
          </div>

          <div className="vq-version">
            <button
              type="button"
              className="vq-version-trigger"
              aria-haspopup="dialog"
              aria-expanded={updateOpen}
              onClick={() => {
                setUpdateOpen(true)
                setUpdateMessage('')
              }}
              title="版本信息"
            >
              <span className="vq-version-dot" aria-hidden="true" />
              <span className="vq-version-label">v{APP_VERSION}</span>
              <span className="vq-version-action">版本</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="vq-main">
        <header className="vq-topbar">
          <div className="vq-topbar-left">
            <button
              type="button"
              className="vq-button vq-button--icon"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            >
              {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </button>
            <div className="vq-breadcrumb">
              <span>{session.user.workspace}</span>
              {inTools ? (
                <>
                  <ChevronRight size={11} />
                  <span>工具</span>
                </>
              ) : activePage === 'local' ? (
                <>
                  <ChevronRight size={11} />
                  <span>本机</span>
                </>
              ) : null}
              <ChevronRight size={11} />
              <strong>
                {route.kind === 'admin'
                  ? EDITION_BY_ID.admin.label + ' · ' + sectionLabel(route.section)
                  : pageLabels[activePage]}
              </strong>
            </div>
          </div>

          <button
            type="button"
            className="vq-search vq-search--trigger"
            onClick={() => setPaletteOpen(true)}
            aria-label="快速跳转（Ctrl 或 Command 加 K）"
            title="快速跳转 · Ctrl / ⌘ + K"
          >
            <Search size={14} aria-hidden="true" />
            <span className="vq-search-label">跳转到…</span>
            <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
          </button>

          <div className="vq-topbar-right">
            {internal ? (
              <span className="vq-env-pill vq-mono" title="内部测试环境：后台会显示模型标识、上游地址与环境变量等排障信息">
                内部测试
              </span>
            ) : null}
            <ModelSwitch />
          </div>
        </header>

        <div className="vq-content" ref={contentRef}>
          <p className="vq-mobile-note" role="note">
            这是一个桌面工作台。手机上能查看，但检索、拆解与评审建议在电脑上做。
          </p>
          <ErrorBoundary key={pageBoundaryKey}>
            <Suspense fallback={<PageSkeleton />}>{renderPage()}</Suspense>
          </ErrorBoundary>
        </div>
      </div>

      {paletteOpen ? <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} /> : null}

      {updateOpen && (
        <div className="vq-modal-backdrop" onMouseDown={() => setUpdateOpen(false)}>
          <div
            className="vq-update-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vq-update-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="vq-update-head">
              <div>
                <span className="vq-mono">{internal ? 'Build / Version' : '发布版本'}</span>
                <h2 id="vq-update-title">版本信息</h2>
              </div>
              <button type="button" className="vq-button vq-button--icon" aria-label="关闭" onClick={() => setUpdateOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="vq-update-rows">
              <div>
                <span>当前版本</span>
                <strong className="vq-mono">v{APP_VERSION}</strong>
              </div>
              <div>
                <span>站点</span>
                <strong className="vq-mono">{window.location.host}</strong>
              </div>
              <div>
                <span>环境</span>
                <strong className="vq-mono">{internal ? '内部测试' : '生产'}</strong>
              </div>
              {internal ? (
                <div>
                  <span>检查接口</span>
                  <strong className="vq-mono">/api/version</strong>
                </div>
              ) : null}
            </div>

            <p className="vq-update-note">
              {internal
                ? '检查更新只读取服务端 /api/version 的版本号；接口未接入时不会伪造下载进度或「已是最新」。发布版更新通过重新拉取构建产物完成。'
                : '检查更新只读取平台的发布版本；没有可用更新时不会伪造进度，也不会假装已是最新。'}
            </p>

            {updateMessage && (
              <p className="vq-update-message" role="status">
                {updateMessage}
              </p>
            )}

            <div className="vq-update-actions">
              <button type="button" className="vq-button vq-button--primary" onClick={checkUpdate} disabled={updateChecking}>
                {updateChecking ? (
                  <>
                    <Loader2 size={14} className="vq-spin" />
                    检查中…
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} />
                    检查更新
                  </>
                )}
              </button>
              <button type="button" className="vq-button vq-button--ghost" onClick={() => setUpdateOpen(false)}>
                关闭
              </button>
            </div>

            <p className="vq-update-foot">{internal ? '账号与会话由服务端校验，数据落在服务端数据目录。' : '登录状态安全保存，数据保存在你的账号下。'} © 2026 VisionQA</p>
          </div>
        </div>
      )}

      {toast && (
        <div className="vq-toast" role="status">
          <Check size={14} />
          {toast}
        </div>
      )}

      {guideOpen && <WelcomeGuide onClose={closeGuide} onGo={go} />}

    </div>
  )
}

function App() {
  const { session, loading: sessionLoading, signIn, verifyTwoFactor, register, signOut } = useSession()
  // 服务条款 / 隐私说明：不登录也要能打开（登录页页脚可点进来）
  const route = useRoute()
  const [authNotice, setAuthNotice] = useState('')

  const handleSignIn = useCallback(
    async (input: SignInInput) => {
      const next = await signIn(input)
      setAuthNotice('')
      return next
    },
    [signIn],
  )

  const handleRegister = useCallback(
    async (input: RegisterInput) => {
      const next = await register(input)
      setAuthNotice('')
      return next
    },
    [register],
  )

  const handleExit = useCallback(
    (mode: 'signout' | 'switch') => {
      setAuthNotice(mode === 'switch' ? '已退出当前会话，请使用另一个账号登录。' : '已退出登录。')
      signOut()
    },
    [signOut],
  )

  // 帮助中心：没有账号也能看。放在 RequireSession 之前，和条款页一样整屏渲染。
  if (route.kind === 'help') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开帮助" />}>
        <HelpPage slug={route.slug} />
      </Suspense>
    )
  }

  if (route.kind === 'sources') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开素材来源" />}>
        <SourcesPage />
      </Suspense>
    )
  }

  if (route.kind === 'legal') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开条款" />}>
        <LegalPage doc={route.doc} />
      </Suspense>
    )
  }

  // 找回密码：邮件链接里带 token，不登录也要能打开（和条款页一样整屏渲染）
  if (route.kind === 'reset') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开重置页" />}>
        <ResetPasswordPage key={route.token} token={route.token} />
      </Suspense>
    )
  }

  // 分享链接是发给没有账号的人的：不经过 RequireSession，否则打开就先去登录页
  if (route.kind === 'share') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开分享内容" />}>
        <SharePage key={route.token} token={route.token} />
      </Suspense>
    )
  }

  if (route.kind === 'shared-project') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开作品分享" />}>
        <ProjectSharePage key={route.token} token={route.token} />
      </Suspense>
    )
  }

  return (
    <RequireSession
      session={session}
      loading={sessionLoading}
      notice={authNotice}
      onSignIn={handleSignIn}
      onRegister={handleRegister}
      onVerifyTwoFactor={verifyTwoFactor}
    >
      {(activeSession) => (
        <Workbench
          session={activeSession}
          onSignOut={() => handleExit('signout')}
          onSwitchAccount={() => handleExit('switch')}
        />
      )}
    </RequireSession>
  )
}

export default App
