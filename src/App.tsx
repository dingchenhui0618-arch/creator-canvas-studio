import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  Grid2X2,
  LayoutTemplate,
  Loader2,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  RefreshCw,
  ScanEye,
  Settings2,
  Workflow,
  X,
} from 'lucide-react'
import { pageLabels, type Page } from './domain/types'
import './App.css'
import './styles/shell.css'
import './styles/overview.css'
import { CreateModal, NavItem } from './components/ui'
import { ModelSwitch } from './components/ModelSwitch'
import CanvasPage from './pages/CanvasPage'
import AgentEditorPage from './pages/AgentEditorPage'
import ReviewPage from './pages/ReviewPage'
import { OverviewPage } from './pages/OverviewPage'
import { AgentsPage } from './pages/AgentsPage'
import { RunsPage } from './pages/RunsPage'
import { SettingsPage } from './pages/SettingsPage'
import { RadarPage } from './pages/RadarPage'
import { TemplateLibraryPage } from './pages/TemplateLibraryPage'
import AdminConsolePage from './pages/admin/AdminConsolePage'
import { RequireSession } from './auth/RequireSession'
import { useSession } from './auth/useSession'
import { initialsFor, sessionKindLabel, type RegisterInput, type Session, type SignInInput } from './auth/session'
import packageJsonRaw from '../package.json?raw'
import { EDITION_BY_ID, readInitialEdition, EDITION_STORAGE_KEY, type AdminSection, type EditionId } from './editions'

const APP_VERSION = (JSON.parse(packageJsonRaw) as { version?: string }).version ?? '0.0.0'

function sectionLabel(edition: EditionId, section: string): string {
  const found = EDITION_BY_ID[edition].nav.find((item) => item.section === section)
  return found?.label ?? EDITION_BY_ID[edition].nav[0]?.label ?? ''
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
  const [activePage, setActivePage] = useState<Page>('overview')
  const [edition, setEdition] = useState<EditionId>(() => readInitialEdition())
  const [consoleSection, setConsoleSection] = useState<string>(() => {
    const initial = readInitialEdition()
    return EDITION_BY_ID[initial].nav[0]?.section ?? 'overview'
  })
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [toast, setToast] = useState('')
  const [editorAgent, setEditorAgent] = useState<{ name: string; description: string } | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  const accountRef = useRef<HTMLDivElement>(null)

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
        setUpdateMessage('更新通道未接入：/api/version 没有返回版本信息，未执行任何下载。')
      } else if (payload.version === APP_VERSION) {
        setUpdateMessage(`已是最新版本（远端 ${payload.version}）。`)
      } else {
        setUpdateMessage(`远端版本 ${payload.version}，与本地 ${APP_VERSION} 不一致；发布版需重新拉取构建产物。`)
      }
    } catch {
      setUpdateMessage('更新通道未接入：请求 /api/version 失败，未执行任何下载。')
    } finally {
      setUpdateChecking(false)
    }
  }, [])

  const switchEdition = useCallback((next: EditionId) => {
    setEdition(next)
    try {
      window.localStorage.setItem(EDITION_STORAGE_KEY, next)
    } catch {
      // 隐私模式下写不进去，本次会话仍然生效
    }
    setAccountMenuOpen(false)
    const firstSection = EDITION_BY_ID[next].nav[0]?.section
    if (firstSection) setConsoleSection(firstSection)
    if (next === 'user') setActivePage('overview')
  }, [])

  const go = useCallback((page: Page) => {
    setActivePage(page)
    setAccountMenuOpen(false)
  }, [])

  // 跨页跳转：模板库等页面通过 window 事件请求切页，外壳只负责接收。
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: Page }>).detail
      if (detail?.page && detail.page !== 'login' && detail.page in pageLabels) {
        setActivePage(detail.page)
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

  // 智能体编辑器只认服务端返回的条目，前端不再缓存一份假列表。
  const openAgent = (name: string) => {
    setEditorAgent({ name, description: '' })
    setActivePage('agent-editor')
  }

  const renderPage = () => {
    if (edition === 'admin') return <AdminConsolePage section={consoleSection as AdminSection} />
    switch (activePage) {
      case 'canvas':
        return <CanvasPage onToast={notify} />
      case 'radar':
        return <RadarPage onToast={notify} onOpenTemplates={() => go('templates')} />
      case 'templates':
        return <TemplateLibraryPage onToast={notify} onBack={() => go('radar')} />
      case 'overview':
        return <OverviewPage userName={session.user.name} onCreate={() => setShowCreate(true)} onNavigate={go} />
      case 'agents':
        return (
          <AgentsPage
            onCreate={() => {
              setEditorAgent(null)
              go('agent-editor')
            }}
            onOpenAgent={openAgent}
          />
        )
      case 'agent-editor':
        return (
          <AgentEditorPage
            key={editorAgent?.name ?? 'new'}
            agent={editorAgent ?? undefined}
            onBack={() => go('agents')}
            onNavigate={go}
            onToast={notify}
          />
        )
      case 'runs':
        return <RunsPage />
      case 'review':
        return <ReviewPage />
      case 'settings':
        return <SettingsPage session={session} onSignOut={onSignOut} onSwitchAccount={onSwitchAccount} />
      default:
        return null
    }
  }

  const initials = initialsFor(session.user.name)

  return (
    <div className="vq-scope vq-shell">
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
                <span>{session.user.kind === 'guest' ? '访客会话' : '服务端会话'}</span>
              </span>
            </div>
          )}

          {edition === 'admin' && (
            // 后台只从地址栏 ?edition=admin 进来；普通用户侧栏里没有任何形态切换。
            <div className="vq-edition-bar" aria-label="当前形态">
              <span className="vq-edition-kicker" title={EDITION_BY_ID.admin.hint}>
                后台管理版
              </span>
              <button type="button" className="vq-edition-exit" onClick={() => switchEdition('user')}>
                返回生产版
              </button>
            </div>
          )}

          {edition === 'user' ? (
            <nav className="vq-nav" aria-label="主导航">
              <NavItem icon={Grid2X2} label="工作台" active={activePage === 'overview'} compact={!sidebarOpen} onClick={() => go('overview')} />
              <NavItem icon={Radar} label="爆款雷达" active={activePage === 'radar'} compact={!sidebarOpen} onClick={() => go('radar')} />
              <NavItem icon={LayoutTemplate} label="模板库" active={activePage === 'templates'} compact={!sidebarOpen} onClick={() => go('templates')} />
              <NavItem
                icon={Bot}
                label="智能体"
                active={activePage === 'agents' || activePage === 'agent-editor'}
                compact={!sidebarOpen}
                onClick={() => go('agents')}
              />
              <NavItem icon={Workflow} label="画布" active={activePage === 'canvas'} compact={!sidebarOpen} onClick={() => go('canvas')} />
              <NavItem icon={ScanEye} label="视觉评审" active={activePage === 'review'} compact={!sidebarOpen} onClick={() => go('review')} />
            </nav>
          ) : (
            <nav className="vq-nav" aria-label={EDITION_BY_ID[edition].label + '导航'}>
              {EDITION_BY_ID[edition].nav.map((item) => {
                const Icon = item.icon
                return (
                  <NavItem
                    key={item.id}
                    icon={Icon}
                    label={item.label}
                    active={consoleSection === item.section}
                    compact={!sidebarOpen}
                    onClick={() => setConsoleSection(item.section ?? item.id)}
                  />
                )
              })}
            </nav>
          )}
        </div>

        <div className="vq-sidebar-bottom">
                    {edition === 'user' ? (
            <>
  <div className="vq-nav-divider" role="presentation" />
            <nav className="vq-nav vq-nav--utility" aria-label="设置层">
              <NavItem utility icon={Activity} label="运行记录" active={activePage === 'runs'} compact={!sidebarOpen} onClick={() => go('runs')} />
              <NavItem utility icon={Settings2} label="设置" active={activePage === 'settings'} compact={!sidebarOpen} onClick={() => go('settings')} />
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
                      <span className="vq-mono">服务端会话</span>
                    </div>
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
              title="版本与在线更新"
            >
              <span className="vq-version-dot" aria-hidden="true" />
              <span className="vq-version-label">v{APP_VERSION}</span>
              <span className="vq-version-action">在线更新</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="vq-main">
        <header className="vq-topbar">
          <div className="vq-topbar-left">
            <button
              type="button"
              className="vq-icon-button"
              onClick={() => setSidebarOpen((value) => !value)}
              aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            >
              {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </button>
            <div className="vq-breadcrumb">
              <span>{session.user.workspace}</span>
              <ChevronRight size={11} />
              <strong>
                {edition === 'user'
                  ? pageLabels[activePage]
                  : EDITION_BY_ID[edition].label + ' · ' + sectionLabel(edition, consoleSection)}
              </strong>
            </div>
          </div>

          <div className="vq-topbar-right">
            <ModelSwitch />
          </div>
        </header>

        <div className="vq-content">{renderPage()}</div>
      </div>

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
                <span className="vq-mono">Build / Version</span>
                <h2 id="vq-update-title">版本与在线更新</h2>
              </div>
              <button type="button" className="vq-icon-button" aria-label="关闭" onClick={() => setUpdateOpen(false)}>
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
                <span>检查接口</span>
                <strong className="vq-mono">/api/version</strong>
              </div>
            </div>

            <p className="vq-update-note">
              检查更新只读取服务端 <code>/api/version</code> 的版本号；接口未接入时不会伪造下载进度或「已是最新」。发布版更新通过重新拉取构建产物完成。
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

            <p className="vq-update-foot">账号与会话由服务端校验，数据落在服务端数据目录。© 2026 VisionQA</p>
          </div>
        </div>
      )}

      {toast && (
        <div className="vq-toast" role="status">
          <Check size={14} />
          {toast}
        </div>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onCreate={(kind) => {
            setShowCreate(false)
            if (kind === 'agent') {
              setEditorAgent(null)
              go('agent-editor')
            } else {
              // 画布的新建在画布页里做（那里才有画布服务端接口），这里只负责把人送过去。
              go('canvas')
            }
          }}
        />
      )}
    </div>
  )
}

function App() {
  const { session, loading: sessionLoading, signIn, register, signOut } = useSession()
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

  return (
    <RequireSession
      session={session}
      loading={sessionLoading}
      notice={authNotice}
      onSignIn={handleSignIn}
      onRegister={handleRegister}
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
