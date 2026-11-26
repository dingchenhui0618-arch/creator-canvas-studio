import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  BookOpen,
  Check,
  ChevronRight,
  Compass,
  Gauge,
  Info,
  Loader2,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Wallet,
  X,
} from 'lucide-react'
import { pageLabels, type Page } from './domain/types'
import './App.css'
import './styles/shell.css'
import './styles/overview.css'
import { NavItem } from './components/ui'
import { CommandPalette } from './components/CommandPalette'
import { useModalFocus } from './components/useModalFocus'
import type { PaletteCommand } from './domain/commands'
import { ASSET_NAV, DESKTOP_NAV, PRIMARY_NAV, SETTINGS_NAV, TOOL_NAV, WORKFLOW_NAV, isNavActive, isToolPage, type NavEntry } from './nav'
import { getDesktop } from './desktop/bridge'
import { WelcomeGuide } from './components/WelcomeGuide'
import { OnboardingGate } from './components/OnboardingGate'
import { ModelSwitch } from './components/ModelSwitch'
import { AccountMenu } from './components/AccountMenu'
import { UserAvatar } from './components/UserAvatar'
import { setWorkflowEnabled } from './domain/features'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PageSkeleton } from './components/PageSkeleton'
import ReviewPage from './pages/ReviewPage'
import { OverviewPage } from './pages/OverviewPage'
import ProjectsPage from './pages/ProjectsPage'
import ProjectPage from './pages/ProjectPage'
import { RunsPage } from './pages/RunsPage'
import RoomsPage from './pages/RoomsPage'
import { SettingsPage } from './pages/SettingsPage'
import RechargePage from './pages/RechargePage'
import { RadarPage } from './pages/RadarPage'
import LocalWorkspacePage from './pages/LocalWorkspacePage'
import { RequireSession } from './auth/RequireSession'
import { useSession } from './auth/useSession'
import { useUiMode } from './api/app'
import { request } from './api/client'
import { sessionKindLabel, type RegisterInput, type Session, type SessionUser, type SignInInput } from './auth/session'
import { accountIdentifier } from './domain/account-label'
import { listAgents, setPendingAgentProject } from './api/agents'
import { createBdcCanvas } from './api/bdc'
import { listReviewQueue } from './api/review'
import { listFeedback } from './api/feedback'
import {
  cancelLeave,
  confirmLeave,
  isInitialBareEntry,
  navigate,
  pageToRoute,
  resetLeaveRequest,
  routeKey,
  routeToPage,
  useLeaveRequest,
  useRoute,
  type Route,
} from './router'
import { setUnsaved, unsavedNote } from './domain/unsaved-guard'
import { normalizeToastTone, toastDuration, toastExitDelay, toastRole, type ToastFn, type ToastTone } from './domain/toast'
import { planScroll } from './domain/scroll'
import { welcomeSeenKey } from './onboarding'
import { browserFlagStore, dismissMobileNote, mobileNoteVisible } from './domain/mobile-note'
import packageJsonRaw from '../package.json?raw'
import { readPackageVersion } from './lib/package-version'
import {
  DEFAULT_ADMIN_SECTION,
  EDITION_BY_ID,
  EDITION_STORAGE_KEY,
  canAccessAdminRoute,
  readStoredEdition,
  rememberEdition,
  resolveEdition,
  stripAdminEditionQuery,
  type AdminSection,
} from './editions'

const APP_VERSION = readPackageVersion(packageJsonRaw) || '0.0.0'

// 快速跳转的快捷键提示按平台显示；功能本身两个修饰键都收。
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)

// 重页面按路由拆包：画布带 @xyflow、对话预设与模板库带各自的样式表，首屏不必等它们。
const CanvasPage = lazy(() => import('./pages/CanvasPage'))
// 无限画布（外部那张自由画布）单独一屏：它和工作流是两件东西，代码也分开按需加载
const BoardPage = lazy(() => import('./pages/BoardPage'))
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
const ReceiptPage = lazy(() => import('./pages/ReceiptPage'))
// 帮助中心也是公开可读的一屏：不登录的人先来这里找答案，而不是卡在登录页
const HelpPage = lazy(() => import('./pages/HelpPage').then((module) => ({ default: module.HelpPage })))
// 素材来源与下架通道（v0.9.82）：公开可读的一屏，和帮助中心一样不进工作台外壳
const SourcesPage = lazy(() => import('./pages/SourcesPage').then((module) => ({ default: module.SourcesPage })))
const AgentEditorPage = lazy(() => import('./pages/AgentEditorPage'))
// 自有资产（r311）：注册后的引导与资产库之后，模板、工作流都从这里取参考图
const AssetsPage = lazy(() => import('./pages/AssetsPage'))
// 工作流 Beta 的落地页（r313）：非管理员直连 #/canvas 时落在这里，不进画布
const WorkflowBetaPage = lazy(() => import('./pages/WorkflowBetaPage'))

function sectionLabel(section: string): string {
  const found = EDITION_BY_ID.admin.nav.find((item) => item.section === section)
  return found?.label ?? EDITION_BY_ID.admin.nav[0]?.label ?? ''
}

/**
 * 普通账号直接访问 #/admin/* 时的落地页：不挂后台侧栏、不请求后台接口，
 * 也不把人踢回登录页（他已经登录了，只是没有这个角色）。
 */
// 用户名账号的 email 是内部占位（@login.visionqa.local），界面上优先显示用户名
function loginLabel(account: SessionUser): string {
  return accountIdentifier(account)
}

function AdminAccessDenied({
  session,
  onBack,
  onSwitchAccount,
}: {
  session: Session
  onBack: () => void
  onSwitchAccount: () => void
}) {
  return (
    <div className="vq-scope vq-access-denied">
      <div className="vq-error-card" role="alert">
        <span className="vq-error-kicker">Admin / No access</span>
        <h1>这个账号没有后台权限</h1>
        <p>
          后台管理版只对管理员开放。当前登录的是 {loginLabel(session.user)}（{sessionKindLabel(session.user)}）。
          你可以继续使用用户生产版；如果这是工作账号，请联系平台管理员调整角色后再试。
        </p>
        <div className="vq-access-denied-actions">
          <button type="button" className="vq-button vq-button--primary" onClick={onBack}>
            返回工作台
          </button>
          <button type="button" className="vq-button vq-button--ghost" onClick={onSwitchAccount}>
            切换账号
          </button>
        </div>
      </div>
    </div>
  )
}

type AgentSeed = { name: string; description: string }

/**
 * 对话预设编辑器路由：地址里可能给的是 id（外链）或名称（列表入口只回传名称）。
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
  onToast: ToastFn
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

  if (status === 'loading') return <PageSkeleton label="正在打开对话预设编辑器" />
  if (status === 'missing') {
    return (
      <div className="vq-error-fallback" role="alert">
        <div className="vq-error-card">
          <span className="vq-error-kicker">对话预设 / 未找到</span>
          <h1>找不到这个对话预设</h1>
          <p>地址里的对话预设可能已被删除，或链接中的编号不属于当前工作区。返回列表重新选择，或新建一个。</p>
          <div className="vq-error-actions">
            <button type="button" className="vq-button vq-button--primary" onClick={onBack}>
              返回对话预设列表
            </button>
            <button type="button" className="vq-button vq-button--ghost" onClick={() => onNavigate('agent-editor')}>
              新建对话预设
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

  // 全局提示条（r324）：带序号——连按同一个动作时动画要重放一次，否则第二次什么都没发生
  // （r325）：带语气——「没做成」不该挂着对勾，图标与播报方式都跟着 tone 走
  const [toast, setToast] = useState<{ seq: number; message: string; tone: ToastTone } | null>(null)
  const [toastLeaving, setToastLeaving] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const toastExitTimer = useRef<number | undefined>(undefined)
  const toastSeq = useRef(0)
  const accountRef = useRef<HTMLDivElement>(null)
  // 换页的落地位置：真的换了页面就回到页头（v0.9.43）。
  // 该不该回、哪几种不算换页，判断只在 src/domain/scroll.ts 一处；这里只负责把 scrollTop 归零。
  const contentRef = useRef<HTMLDivElement | null>(null)
  const previousRoute = useRef<Route | null>(null)

  // 注册后的身份引导（r311）会不会出现：只有普通账号且还没做完引导才有。
  // 这一段是给「上手引导」让路用的——两个弹窗叠在一起，新人第一眼看到的是两层遮罩。
  const [onboardingOpen, setOnboardingOpen] = useState<boolean | null>(null)
  useEffect(() => {
    if (session.user.kind !== 'account') {
      setOnboardingOpen(false)
      return
    }
    let alive = true
    request<{ done?: boolean }>('/api/onboarding')
      .then((data) => {
        if (alive) setOnboardingOpen(data.done !== true)
      })
      .catch(() => {
        // 读不到就当引导不出现：宁可少弹一层，也不要挡住工作台
        if (alive) setOnboardingOpen(false)
      })
    return () => {
      alive = false
    }
  }, [session.user.id, session.user.kind])

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

  // 手机端那条「桌面工作台」提示（r224）：第一次看得见，点 × 之后这台浏览器不再出现。
  // 记不住（隐私模式）时下次照常显示，比「关了却记不住」诚实。
  const [mobileNoteOpen, setMobileNoteOpen] = useState(() => mobileNoteVisible(browserFlagStore()))
  const closeMobileNote = useCallback(() => {
    dismissMobileNote(browserFlagStore())
    setMobileNoteOpen(false)
  }, [])

  // 侧栏高亮、面包屑和内容页都从 hash 路由推导，页面本身不再保存 activePage。
  const activePage = routeToPage(route)
  // 路由的稳定标识：换页时用它触发角标对一次数，不必把整个 route 对象塞进依赖
  const routeId = routeKey(route)

  // 还没保存就走（r270）：页面登记、路由挂起、这里出弹窗——三处共用同一个真源
  const leaveRequest = useLeaveRequest()
  // r328：两个整屏浮层的键盘边界。离开拦截是 alertdialog，autoFocus 已经指定了两颗按钮里安全的那颗
  // （「留在这页」），所以这一层的初始焦点不抢；版本信息是普通 dialog，焦点落在右上角关闭。
  const leaveRef = useRef<HTMLDivElement | null>(null)
  const updateRef = useRef<HTMLDivElement | null>(null)
  useModalFocus(leaveRef, Boolean(leaveRequest), { initial: 'none', lockScroll: true })
  useModalFocus(updateRef, updateOpen, { initial: 'first', lockScroll: true })

  // 工作流是 beta，只对管理员开放（r313）：判定只活在 domain/features 一处，
  // 侧栏、命令面板、各页面、#/canvas 落地页都读它，免得这里放行了、那里还藏着入口。
  // 服务端 /api/auth/me 的 features.workflow 是权威判定（VQ_WORKFLOW_BETA=all 时普通账号也放行）；
  // 读不到 features 的旧缓存就退回身份判定，不至于把管理员的入口也藏了。
  const workflowEnabled = session.features?.workflow === true || session.user.kind === 'admin'
  useEffect(() => {
    setWorkflowEnabled(workflowEnabled)
  }, [workflowEnabled])

  // 右上角的余额（r313）：外壳自己读一次，页面里花了钱就派发 vq:credits 让这里重读。
  // 读不到就显示「—」，不用 0 冒充「已用完」。
  const [topCredits, setTopCredits] = useState<{ balance: number | null; unit: string; loading: boolean }>({
    balance: null,
    unit: '积分',
    loading: true,
  })
  const refreshCredits = useCallback(() => {
    let alive = true
    request<{ balance: number | null; unit: string }>('/api/credits?limit=1')
      .then((data) => {
        if (alive) setTopCredits({ balance: data.balance, unit: data.unit || '积分', loading: false })
      })
      .catch(() => {
        if (alive) setTopCredits((prev) => ({ ...prev, loading: false }))
      })
    return () => {
      alive = false
    }
  }, [])

  // 换页时顺手对一次余额（便宜的一次读，不扣积分）；页面里生成完会派发 vq:credits。
  useEffect(() => {
    if (route.kind === 'admin') return
    return refreshCredits()
  }, [refreshCredits, routeId, route.kind])

  useEffect(() => {
    const onCredits = () => {
      refreshCredits()
    }
    window.addEventListener('vq:credits', onCredits)
    return () => window.removeEventListener('vq:credits', onCredits)
  }, [refreshCredits])

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

  // 专注模式只在无限画布生效：离开时侧栏与顶栏一定回来，不会出现「侧栏不见了」；
  // 回到无限画布仍保持专注，等于记住用户上次的选择。
  const focusOn = canvasFocus && activePage === 'board'
  // 面包屑跟着导航层级走：工具页多一段「工具」，否则用户看不出自己已经离开了主线
  const inTools = isToolPage(activePage) || activePage === 'agent-editor'

  const notify = useCallback((message: string, tone?: ToastTone) => {
    // 语气必须在进状态之前归一：页面传了没见过的值，也只当成功，不会画出第三种图标
    const safeTone = normalizeToastTone(tone)
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, message, tone: safeTone })
    setToastLeaving(false)
    window.clearTimeout(toastTimer.current)
    window.clearTimeout(toastExitTimer.current)
    // 停留时间跟着字数走（r324）：报错往往比「已保存」长得多，固定 2.4 秒读不完
    toastTimer.current = window.setTimeout(() => {
      // 收尾：先淡出下沉，走完再卸载。直接摘掉是硬切，一条长句最明显
      setToastLeaving(true)
      const exitMs = toastExitDelay(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      if (exitMs <= 0) {
        setToast(null)
        return
      }
      toastExitTimer.current = window.setTimeout(() => setToast(null), exitMs)
    }, toastDuration(message))
  }, [])

  // 卸载时把两个计时器都收掉：登录页/后台切换时外壳会重挂，别让旧计时器去写已经卸掉的状态
  useEffect(
    () => () => {
      window.clearTimeout(toastTimer.current)
      window.clearTimeout(toastExitTimer.current)
    },
    [],
  )

  // 关标签页 / 刷新时浏览器只让我们拦一下，不让写自己的话（r270）。
  // 应用内的跳转由路由出弹窗（说清丢了什么），这一层只兜住「页面正在被关掉」。
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!unsavedNote()) return
      event.preventDefault()
      // 现代浏览器只看有没有返回值；老浏览器还会把这句话显示出来
      event.returnValue = '这一页还有没保存的改动'
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
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

  // 「新建 → 无限画布」直接调无限画布服务建一块真画布，建完就打开它；
  // 服务不可用时退回无限画布页并如实提示，不留下一个只在本地存在的新画布。
  const createCanvasProject = useCallback(async () => {
    notify('正在新建无限画布…')
    const stamp = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date())
    try {
      const result = await createBdcCanvas('新画布 ' + stamp)
      if (result?.canvas?.id) {
        navigate({ kind: 'page', page: 'board', boardId: result.canvas.id })
        notify('已新建无限画布：' + result.canvas.name)
        return
      }
      go('board')
      notify('无限画布服务没有返回新画布，已打开无限画布')
    } catch (error) {
      go('board')
      notify('新建无限画布失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [go, notify])

  // 侧栏与命令面板共用同一个跳转口径：已经在工作流上不重载当前流程。
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
      // 工作流是管理员 beta：普通账号的命令面板里不出现，免得搜得到、点进去是 403
      ...(workflowEnabled ? [navCommand(WORKFLOW_NAV, '工具')] : []),
      navCommand(SETTINGS_NAV, '设置'),
      {
        id: 'action-new-canvas',
        label: '新建无限画布',
        hint: '在无限画布服务里建一块真画布，建完直接打开',
        group: '动作',
        icon: Plus,
        keywords: 'new canvas 新建 空白 无限画布',
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
        id: 'action-recharge',
        label: '充值',
        hint: '积分不够时在这里充',
        group: '动作',
        icon: Wallet,
        keywords: 'recharge 充值 积分 余额 付款',
        run: () => go('recharge'),
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
  }, [createCanvasProject, desktopBridge, go, navTo, sidebarOpen, workflowEnabled])

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

  // 帮助与协议是公开页（#/help），从侧栏底部与右上角菜单都能到；它不进工作台外壳。
  const openHelp = useCallback(() => {
    setAccountMenuOpen(false)
    navigate({ kind: 'help', slug: null })
  }, [])

  const openRecharge = useCallback(() => {
    setAccountMenuOpen(false)
    go('recharge')
  }, [go])

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
      route.kind === 'receipt' ||
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
        // 工作流是 beta，只对管理员开放（r313）：收藏、旧链接、命令面板进来都落在 Beta 页，
        // 不挂画布组件、也不发 /api/flows 请求（那只会拿到 403 再显示一个错误弹层）。
        if (!workflowEnabled) {
          return <WorkflowBetaPage onGo={go} />
        }
        // flowId 故意不进 key：页面加载完会把它补进地址栏，进 key 就等于自己把自己重挂一次——
        // 表现出来就是进工作流闪一下、/api/flows 连打两遍。
        return (
          <CanvasPage
            // 运行地址和编辑地址是两种模式：进出只读查看时重挂一次，避免旧运行状态挂在新模式上。
            key={'canvas:' + (route.viewRunId ? 'view' : route.resumeRunId ? 'resume' : 'edit')}
            flowId={route.flowId}
            resumeRunId={route.resumeRunId}
            viewRunId={route.viewRunId}
            onToast={notify}
          />
        )
      case 'board':
        // 无限画布：外部那张自由画布整屏铺满；地址里点名哪一块就打开哪一块（#/board/<画布ID>）
        return (
          <BoardPage
            key={'board:' + (route.boardId || 'last')}
            boardId={route.boardId}
            onToast={notify}
            focus={focusOn}
            onToggleFocus={() => setCanvasFocus((value) => !value)}
          />
        )
      case 'recharge':
        // 充值单独一屏：从设置页的积分卡进来，也能直接收藏 #/recharge
        return <RechargePage onToast={notify} />
      case 'projects':
        // 作品有两个地址：#/projects 列表与 #/projects/<id>；打开某一项不换页面职责，只换参数
        return route.projectId ? (
          <ProjectPage
            key={route.projectId + ':' + (route.deliveryId || '')}
            projectId={route.projectId}
            focusDeliveryId={route.deliveryId}
            onBack={() => navigate({ kind: 'page', page: 'projects' })}
            onOpenFlow={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onViewRun={(flowId, runId) => navigate({ kind: 'page', page: 'canvas', flowId, viewRunId: runId })}
            onOpenReview={(projectId) => navigate({ kind: 'page', page: 'review', projectId })}
            onOpenReviewRecord={(reviewId) => navigate({ kind: 'page', page: 'review', reviewId })}
            onOpenAgents={(projectId) => {
              // 一次性交接：对话预设页读到这条作品就清掉，之后再进不会还挂着上一条
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
            onToast={notify}
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
            // 运营位的按钮要能跳到任意页面（后台可以把按钮指向雷达、评审、聊天室）
            onNavigate={go}
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
            onOpenCanvas={(canvasId) => navigate({ kind: 'page', page: 'board', boardId: canvasId })}
            // 交出去的清单点一行（v0.9.140）：带着那条交付记录过去，作品页的档案直接落在那一版上
            onOpenProject={(projectId, deliveryId) =>
              navigate({ kind: 'page', page: 'projects', projectId, ...(deliveryId ? { deliveryId } : {}) })
            }
            onOpenGuide={() => setGuideOpen(true)}
            onToast={notify}
          />
        )
      case 'agents':
        // 结构化草稿的两个出口：存为模板去模板库，送到工作流直接带着新流程进工作流页
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
      case 'assets':
        // 自己的商品图与数字人：生成 / 补生成都在这一页，关页不丢任务
        return <AssetsPage onToast={notify} />
      case 'runs':
        return (
          <RunsPage
            onOpenFlow={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onResumeRun={(flowId, runId) => navigate({ kind: 'page', page: 'canvas', flowId, resumeRunId: runId })}
            onViewRun={(flowId, runId) => navigate({ kind: 'page', page: 'canvas', flowId, viewRunId: runId })}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
          />
        )
      case 'rooms':
        // 房间（r315）：一期只有人的消息；智能体接入在 1b，页面里不假装它们会回话
        return <RoomsPage onToast={notify} />
      case 'local':
        return <LocalWorkspacePage />
      case 'review':
        return (
          <ReviewPage
            key={route.projectId || 'review'}
            projectId={route.projectId}
            reviewId={route.reviewId}
            onOpenProject={(projectId) => navigate({ kind: 'page', page: 'projects', projectId })}
            // 评完能直接回工作流改这段结构（r251）：只有这条作品接了工作流时结果页才给这个出口
            onOpenFlow={(flowId) => navigate({ kind: 'page', page: 'canvas', flowId })}
            onOpenReview={(reviewId) => navigate({ kind: 'page', page: 'review', reviewId })}
            onReviewProject={(projectId) => navigate({ kind: 'page', page: 'review', projectId })}
            onClearReview={() => navigate({ kind: 'page', page: 'review' })}
            onOpenProjects={() => navigate({ kind: 'page', page: 'projects' })}
            // 存成模板之后直接落到那一条上（r253）：新模板在库里哪一页都不用自己找
            onOpenTemplate={(templateId) => navigate({ kind: 'page', page: 'templates', templateId })}
          />
        )
      case 'settings':
        return <SettingsPage session={session} onSignOut={onSignOut} onSwitchAccount={onSwitchAccount} />
      default:
        return null
    }
  }

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
              <UserAvatar user={session.user} size={28} className="vq-workspace-avatar" />
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
              <button
                type="button"
                className="vq-button vq-button--quiet vq-button--sm vq-edition-leave"
                aria-label="返回生产版"
                title="返回生产版"
                onClick={leaveAdmin}
              >
                <ArrowLeftRight size={15} aria-hidden="true" className="vq-edition-leave-icon" />
                <span className="vq-edition-leave-text">返回生产版</span>
              </button>
            </div>
          )}

          {route.kind !== 'admin' ? (
            <>
              <nav className="vq-nav" aria-label="主导航">
                {PRIMARY_NAV.map((entry) => (
                  <Fragment key={entry.id}>
                    <NavItem
                      icon={entry.icon}
                      label={entry.label}
                      // r315：一级导航也能带 Beta 标（聊天室），不再只有工作流那一处硬编码
                      chip={entry.chip}
                      active={isNavActive(entry, activePage)}
                      compact={!sidebarOpen}
                      badge={entry.id === 'overview' ? queueBadge : undefined}
                      badgeLabel={entry.id === 'overview' && queueBadge ? queueBadge + ' 条评审等你看' : undefined}
                      onClick={() => navTo(entry)}
                    />
                    {/* 我的资产挂在工作台之下（r313）：它是「我的东西」，不是一项工具能力 */}
                    {entry.id === 'overview' ? (
                      <NavItem
                        icon={ASSET_NAV.icon}
                        label={ASSET_NAV.label}
                        nested
                        active={activePage === 'assets'}
                        compact={!sidebarOpen}
                        onClick={() => navTo(ASSET_NAV)}
                      />
                    ) : null}
                  </Fragment>
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
                {TOOL_NAV.slice(0, 2).map((entry) => (
                  <NavItem
                    key={entry.id}
                    icon={entry.icon}
                    label={entry.label}
                    active={isNavActive(entry, activePage)}
                    compact={!sidebarOpen}
                    onClick={() => navTo(entry)}
                  />
                ))}
                {/* 工作流：仅管理员（Beta）。普通账号这一行不渲染，直连 #/canvas 落 Beta 页 */}
                {workflowEnabled ? (
                  <NavItem
                    icon={WORKFLOW_NAV.icon}
                    label={WORKFLOW_NAV.label}
                    chip={WORKFLOW_NAV.chip}
                    active={isNavActive(WORKFLOW_NAV, activePage)}
                    compact={!sidebarOpen}
                    onClick={() => navTo(WORKFLOW_NAV)}
                  />
                ) : null}
                {TOOL_NAV.slice(2).map((entry) => (
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
              {session.user.kind === 'admin' && (
                // 后台只对管理员账号露出来：普通账号既没有这一条，也进不去 #/admin。
                <NavItem
                  utility
                  icon={Gauge}
                  label="后台管理"
                  active={false}
                  compact={!sidebarOpen}
                  onClick={() => navigate({ kind: 'admin', section: DEFAULT_ADMIN_SECTION })}
                />
              )}
              <NavItem
                utility
                icon={BookOpen}
                label="帮助与协议"
                active={false}
                compact={!sidebarOpen}
                onClick={openHelp}
              />
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
                  title={sidebarOpen ? undefined : `${session.user.name} · ${accountIdentifier(session.user)}`}
                >
                  <UserAvatar user={session.user} size={28} className="vq-sidebar-account-avatar" />
                  <span className="vq-sidebar-account-copy">
                    <strong>{session.user.name}</strong>
                    <small title={accountIdentifier(session.user)}>{accountIdentifier(session.user)}</small>
                  </span>
                  <MoreHorizontal size={15} className="vq-sidebar-account-more" />
                </button>

                {accountMenuOpen && (
                  <div className="vq-menu vq-sidebar-account-menu" role="menu">
                    <div className="vq-sidebar-account-menu-meta">
                      <span className="vq-mono">{sessionKindLabel(session.user)}</span>
                      <span className="vq-mono">{internal ? '服务端会话' : '已登录'}</span>
                    </div>
                    {/* 余额也从这里能点开（r313）：右上角是第一入口，左下角这一处不藏起来 */}
                    <div className="vq-sidebar-account-credits">
                      <span>剩余积分</span>
                      <strong>{topCredits.balance === null ? '—' : topCredits.balance}</strong>
                      <button
                        type="button"
                        className="vq-button vq-button--sm"
                        onClick={() => {
                          setAccountMenuOpen(false)
                          go('recharge')
                        }}
                      >
                        充值
                      </button>
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
                    <button type="button" role="menuitem" onClick={openHelp}>
                      <BookOpen size={15} />
                      帮助与协议
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
            {route.kind !== 'admin' ? (
              <AccountMenu
                session={session}
                credits={topCredits}
                onOpenRecharge={openRecharge}
                onOpenSettings={() => go('settings')}
                onOpenHelp={openHelp}
                onOpenGuide={() => setGuideOpen(true)}
                onSwitchAccount={onSwitchAccount}
                onSignOut={onSignOut}
              />
            ) : null}
          </div>
        </header>

        <div className="vq-content" ref={contentRef}>
          {mobileNoteOpen ? (
            <div className="vq-mobile-note" role="note">
              <span className="vq-mobile-note-text">
                手机也能检索、挑素材、送评审；画布连线与逐帧评审建议在电脑上做。
              </span>
              <button
                type="button"
                className="vq-mobile-note-close"
                aria-label="不再显示这条提示"
                title="不再显示"
                onClick={closeMobileNote}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <ErrorBoundary key={pageBoundaryKey}>
            <Suspense fallback={<PageSkeleton />}>{renderPage()}</Suspense>
          </ErrorBoundary>
        </div>
      </div>

      {paletteOpen ? <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} /> : null}

      {leaveRequest && (
        <div className="vq-modal-backdrop" onMouseDown={cancelLeave}>
          <div
            ref={leaveRef}
            className="vq-leave-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="vq-leave-title"
            aria-describedby="vq-leave-body"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="vq-leave-head">
              <span className="vq-mono">还没保存 / UNSAVED</span>
              <h2 id="vq-leave-title">这一段还没存下来</h2>
            </div>
            <p id="vq-leave-body" className="vq-leave-body">{leaveRequest.message}</p>
            <div className="vq-leave-actions">
              <button type="button" className="vq-button vq-button--danger" onClick={confirmLeave}>
                丢下改动，离开
              </button>
              <button type="button" className="vq-button vq-button--primary" onClick={cancelLeave} autoFocus>
                留在这页
              </button>
            </div>
          </div>
        </div>
      )}

      {updateOpen && (
        <div className="vq-modal-backdrop" onMouseDown={() => setUpdateOpen(false)}>
          <div
            ref={updateRef}
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
        <div
          className={'vq-toast' + (toastLeaving ? ' is-leaving' : '')}
          role={toastRole(toast.tone)}
          data-tone={toast.tone}
          key={toast.seq}
        >
          {/* 图标只给看得见的人：读屏听到的是文案本身（「复制失败：…」），不用再念一遍符号 */}
          <span className="vq-toast-mark" aria-hidden="true">
            {toast.tone === 'fail' ? <X size={14} /> : toast.tone === 'info' ? <Info size={14} /> : <Check size={14} />}
          </span>
          {toast.message}
        </div>
      )}

      {/* 身份引导没做完时先不叠「上手引导」：两个弹窗同时出现，第一屏就废了 */}
      {guideOpen && onboardingOpen === false && <WelcomeGuide onClose={closeGuide} onGo={go} />}

      {/* 注册后的身份引导：组件自己判断「账号 + done === false」才出现，管理员/演示/访客都不弹 */}
      {session.user.kind === 'account' && (
        <OnboardingGate session={session} onToast={notify} onOpenAssets={() => go('assets')} />
      )}
    </div>
  )
}

function App() {
  const { session, loading: sessionLoading, signIn, signInSms, verifyTwoFactor, register, signOut } = useSession()
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
      // 换人之后上一页的编辑已经随会话消失：别让那一段拦住下一位用户的第一次点击。
      setUnsaved(null)
      resetLeaveRequest()
      setAuthNotice(mode === 'switch' ? '已退出当前会话，请使用另一个账号登录。' : '已退出登录。')
      signOut()
    },
    [signOut],
  )

  // 首屏的形态落点：本地缓存只够避免管理员刷新时闪一下用户版；会话确认后按真实 kind 再判一次。
  // 只在「进入时没有 hash」的地址上补后台落点，显式收藏的 #/projects 之类不抢。
  const editionApplied = useRef(false)
  useLayoutEffect(() => {
    if (editionApplied.current || sessionLoading) return
    editionApplied.current = true
    if (!session) return
    if (session.user.kind !== 'admin') {
      // 普通账号带 ?edition=admin 进来：把地址栏那一项拿掉，人继续留在用户版。
      stripAdminEditionQuery()
      return
    }
    const edition = resolveEdition({
      search: window.location.search,
      stored: readStoredEdition(),
      isAdmin: true,
    })
    // 首次用 cookie 登录、本地还没有缓存时，main 拿不到角色；确认是管理员后补记形态。
    rememberEdition(edition)
    if (edition === 'admin' && isInitialBareEntry() && route.kind !== 'admin') {
      navigate({ kind: 'admin', section: DEFAULT_ADMIN_SECTION })
    }
  }, [session, sessionLoading, route.kind])

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

  // 回执链接是发给收包人的：他不一定有账号，打开就直接是「贴收据」这一件事
  if (route.kind === 'receipt') {
    return (
      <Suspense fallback={<PageSkeleton label="正在打开回执" />}>
        <ReceiptPage key={route.token} token={route.token} />
      </Suspense>
    )
  }

  return (
    <RequireSession
      session={session}
      loading={sessionLoading}
      notice={authNotice}
      onSignIn={handleSignIn}
      onSignInSms={signInSms}
      onRegister={handleRegister}
      onVerifyTwoFactor={verifyTwoFactor}
    >
      {(activeSession) => {
        if (!canAccessAdminRoute(route, activeSession.user.kind === 'admin')) {
          return (
            <AdminAccessDenied
              session={activeSession}
              onBack={() => navigate({ kind: 'page', page: 'overview' }, { replace: true })}
              onSwitchAccount={() => handleExit('switch')}
            />
          )
        }
        return (
          <Workbench
            session={activeSession}
            onSignOut={() => handleExit('signout')}
            onSwitchAccount={() => handleExit('switch')}
          />
        )
      }}
    </RequireSession>
  )
}

export default App
