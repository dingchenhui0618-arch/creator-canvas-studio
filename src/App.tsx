import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Grid2X2,
  Layers3,
  LayoutTemplate,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  RefreshCw,
  ScanEye,
  Search,
  Settings2,
  Workflow,
} from 'lucide-react'
import type { Page } from './domain/types'
import './App.css'
import './styles/shell.css'
import './styles/overview.css'
import { agents, assets, pageLabels } from './data/mock'
import { CreateModal, NavItem } from './components/ui'
import { VisionQaMark, VisionQaLockup } from './brand/VisionQaMark'
import CanvasPage from './pages/CanvasPage'
import AgentEditorPage from './pages/AgentEditorPage'
import ReviewPage from './pages/ReviewPage'
import { OverviewPage } from './pages/OverviewPage'
import { AgentsPage } from './pages/AgentsPage'
import { AssetsPage } from './pages/AssetsPage'
import { RunsPage } from './pages/RunsPage'
import { SettingsPage } from './pages/SettingsPage'
import { RadarPage } from './pages/RadarPage'
import { TemplateLibraryPage } from './pages/TemplateLibraryPage'
import { RequireSession } from './auth/RequireSession'
import { useSession } from './auth/useSession'
import { initialsFor, sessionKindLabel, type Session, type SignInInput } from './auth/session'

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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [assetFilter, setAssetFilter] = useState('全部')
  const [showCreate, setShowCreate] = useState(false)
  const [toast, setToast] = useState('')
  const [editorAgent, setEditorAgent] = useState<{ name: string; description: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const notify = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
  }, [])

  const go = useCallback((page: Page) => {
    setActivePage(page)
    setMenuOpen(false)
  }, [])

  // 跨页跳转：模板库等页面通过 window 事件请求切页，外壳只负责接收。
  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: Page }>).detail
      if (detail?.page && detail.page !== 'login' && detail.page in pageLabels) {
        setActivePage(detail.page)
        setMenuOpen(false)
      }
    }
    window.addEventListener('vq:navigate', onNavigate)
    return () => window.removeEventListener('vq:navigate', onNavigate)
  }, [])

  // 用户菜单：点外部或 Esc 关闭。
  useEffect(() => {
    if (!menuOpen) return
    const closeOnPointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnPointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnPointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  // ⌘K / Ctrl+K 聚焦搜索框。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filteredAssets = assets.filter((asset) => {
    const matchesFilter = assetFilter === '全部' || asset.type === assetFilter
    const matchesSearch = !search || `${asset.name} ${asset.tag}`.toLowerCase().includes(search.toLowerCase())
    return matchesFilter && matchesSearch
  })

  const openAgent = (name: string) => {
    const found = agents.find((item) => item.name === name)
    setEditorAgent(found ? { name: found.name, description: found.description } : { name, description: '' })
    setActivePage('agent-editor')
  }

  const renderPage = () => {
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
      case 'assets':
        return (
          <AssetsPage
            assets={filteredAssets}
            filter={assetFilter}
            setFilter={setAssetFilter}
            search={search}
            setSearch={setSearch}
            onReference={(name) => notify(`已将「${name}」加入当前节点引用`)}
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
        <div className="vq-brand">
          {sidebarOpen ? <VisionQaLockup /> : <VisionQaMark size={22} />}
        </div>

        {sidebarOpen && (
          <button
            type="button"
            className="vq-workspace"
            onClick={() => notify('工作区切换会在接入真实账号体系后开放')}
          >
            <span className="vq-workspace-avatar">{initials}</span>
            <span className="vq-workspace-meta">
              <strong>{session.user.workspace}</strong>
              <span>Local session</span>
            </span>
            <ChevronDown size={13} />
          </button>
        )}

        <nav className="vq-nav" aria-label="主导航">
          <NavItem icon={Grid2X2} label="工作台" active={activePage === 'overview'} compact={!sidebarOpen} onClick={() => go('overview')} />
          <NavItem icon={Radar} label="爆款雷达" active={activePage === 'radar'} compact={!sidebarOpen} onClick={() => go('radar')} />
          <NavItem icon={LayoutTemplate} label="模板库" active={activePage === 'templates'} compact={!sidebarOpen} onClick={() => go('templates')} />
          <NavItem
            icon={Bot}
            label="智能体"
            active={activePage === 'agents' || activePage === 'agent-editor'}
            compact={!sidebarOpen}
            badge={String(agents.length)}
            onClick={() => go('agents')}
          />
          <NavItem icon={Workflow} label="画布" active={activePage === 'canvas'} compact={!sidebarOpen} onClick={() => go('canvas')} />
          <NavItem icon={ScanEye} label="视觉评审" active={activePage === 'review'} compact={!sidebarOpen} onClick={() => go('review')} />
          <NavItem icon={Layers3} label="资产库" active={activePage === 'assets'} compact={!sidebarOpen} onClick={() => go('assets')} />
          <NavItem icon={Activity} label="运行记录" active={activePage === 'runs'} compact={!sidebarOpen} onClick={() => go('runs')} />
          <NavItem icon={Settings2} label="设置" active={activePage === 'settings'} compact={!sidebarOpen} onClick={() => go('settings')} />
        </nav>

        <div className="vq-sidebar-foot">
          <NavItem
            icon={CircleHelp}
            label="帮助中心"
            compact={!sidebarOpen}
            onClick={() => notify('帮助中心会在接入文档后开放')}
          />
          {sidebarOpen && (
            <span className="vq-sidebar-version">
              <span>Workbench</span>
              <span>v0.1.0</span>
            </span>
          )}
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
              <strong>{pageLabels[activePage]}</strong>
            </div>
          </div>

          <div className="vq-topbar-right">
            <label className="vq-search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索项目、资产或运行记录"
                aria-label="搜索"
              />
              <kbd>⌘ K</kbd>
            </label>
            <button type="button" className="vq-icon-button vq-has-dot" aria-label="通知" onClick={() => notify('没有新的评审提醒')}>
              <Bell size={16} />
            </button>

            <div className="vq-user-menu" ref={menuRef}>
              <button
                type="button"
                className="vq-user-trigger"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <span className="vq-avatar">{initials}</span>
                <span className="vq-user-trigger-text">
                  <strong>{session.user.name}</strong>
                  <small>{session.user.email}</small>
                </span>
                <ChevronDown size={14} />
              </button>

              {menuOpen && (
                <div className="vq-menu" role="menu">
                  <div className="vq-menu-head">
                    <span className="vq-avatar">{initials}</span>
                    <div>
                      <strong>{session.user.name}</strong>
                      <span>{session.user.email}</span>
                      <span className="vq-mono">{sessionKindLabel(session.user.kind)} · 本地会话</span>
                    </div>
                  </div>
                  <button type="button" role="menuitem" onClick={() => go('settings')}>
                    <Settings2 size={15} />
                    账号设置
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
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
                      setMenuOpen(false)
                      onSignOut()
                    }}
                  >
                    <LogOut size={15} />
                    退出登录
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <div className="vq-content">{renderPage()}</div>
      </div>

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
              go('canvas')
              notify('已创建新的资产画布草稿')
            }
          }}
        />
      )}
    </div>
  )
}

function App() {
  const { session, signIn, continueAsGuest, signOut } = useSession()
  const [authNotice, setAuthNotice] = useState('')

  const handleSignIn = useCallback(
    async (input: SignInInput) => {
      const next = await signIn(input)
      setAuthNotice('')
      return next
    },
    [signIn],
  )

  const handleGuest = useCallback(() => {
    setAuthNotice('')
    continueAsGuest()
  }, [continueAsGuest])

  const handleExit = useCallback(
    (mode: 'signout' | 'switch') => {
      setAuthNotice(mode === 'switch' ? '已退出当前会话，请使用另一个账号登录。' : '已退出登录。')
      signOut()
    },
    [signOut],
  )

  return (
    <RequireSession session={session} notice={authNotice} onSignIn={handleSignIn} onGuest={handleGuest}>
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
