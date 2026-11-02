import { useCallback, useRef, useState } from 'react'
import { Activity, Bot, Check, ChevronDown, CircleHelp, Cloud, FolderOpen, Grid2X2, Layers3, MessageSquareText, PanelLeftClose, PanelLeftOpen, Search, Settings2, Workflow } from 'lucide-react'
import type { Page } from './domain/types'
import './App.css'
import { agents, assets, pageLabels } from './data/mock'
import { CreateModal, NavItem } from './components/ui'
import CanvasPage from './pages/CanvasPage'
import AgentEditorPage from './pages/AgentEditorPage'
import { OverviewPage } from './pages/OverviewPage'
import { AgentsPage } from './pages/AgentsPage'
import { AssetsPage } from './pages/AssetsPage'
import { RunsPage } from './pages/RunsPage'
import { SettingsPage } from './pages/SettingsPage'

function App() {
  const [activePage, setActivePage] = useState<Page>('canvas')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [assetFilter, setAssetFilter] = useState('全部')
  const [showCreate, setShowCreate] = useState(false)
  const [toast, setToast] = useState('')
  const [editorAgent, setEditorAgent] = useState<{ name: string; description: string } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const notify = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2400)
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

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? '' : 'sidebar--collapsed'}`}>
        <div className="brand-lockup"><div className="brand-mark"><span>✦</span></div>{sidebarOpen && <div><strong>纸飞机</strong><span>Creative Workbench</span></div>}</div>
        {sidebarOpen && <div className="workspace-switcher"><div className="workspace-avatar">A</div><div className="workspace-meta"><strong>Aurora Studio</strong><span>个人工作区</span></div><ChevronDown size={14} /></div>}
        <nav className="primary-nav" aria-label="主导航">
          <NavItem icon={Grid2X2} label="工作台" active={activePage === 'overview'} compact={!sidebarOpen} onClick={() => setActivePage('overview')} />
          <NavItem icon={Bot} label="智能体" active={activePage === 'agents' || activePage === 'agent-editor'} compact={!sidebarOpen} onClick={() => setActivePage('agents')} badge="3" />
          <NavItem icon={Workflow} label="资产画布" active={activePage === 'canvas'} compact={!sidebarOpen} onClick={() => setActivePage('canvas')} />
          <NavItem icon={Layers3} label="资产库" active={activePage === 'assets'} compact={!sidebarOpen} onClick={() => setActivePage('assets')} />
          <NavItem icon={Activity} label="运行记录" active={activePage === 'runs'} compact={!sidebarOpen} onClick={() => setActivePage('runs')} />
        </nav>
        {sidebarOpen && <div className="nav-section-label">项目空间</div>}
        <nav className="secondary-nav" aria-label="项目空间">
          <NavItem icon={FolderOpen} label="品牌资产" compact={!sidebarOpen} onClick={() => setActivePage('assets')} />
          <NavItem icon={MessageSquareText} label="灵感收集" compact={!sidebarOpen} onClick={() => setActivePage('assets')} />
          <NavItem icon={Cloud} label="共享空间" compact={!sidebarOpen} onClick={() => setActivePage('settings')} />
        </nav>
        <div className="sidebar-bottom">
          <NavItem icon={Settings2} label="设置" active={activePage === 'settings'} compact={!sidebarOpen} onClick={() => setActivePage('settings')} />
          <NavItem icon={CircleHelp} label="帮助中心" compact={!sidebarOpen} onClick={() => notify('帮助中心将在接入文档后开放')} />
          <div className="profile-chip"><div className="profile-avatar">陈</div>{sidebarOpen && <div><strong>陈先生</strong><span>免费工作区</span></div>}<ChevronDown size={15} /></div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)} aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}>{sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
            <div className="breadcrumbs"><span>个人工作区</span><span>/</span><strong>{pageLabels[activePage]}</strong></div>
          </div>
          <div className="topbar-actions">
            <label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目、资产或运行记录" /><kbd>⌘ K</kbd></label>
            <button className="icon-button has-dot" aria-label="通知"><Activity size={17} /></button>
            <button className="avatar-button">陈</button>
          </div>
        </header>
        <div className="content-wrap">
          {activePage === 'canvas' && <CanvasPage onToast={notify} />}
          {activePage === 'overview' && <OverviewPage onCreate={() => setShowCreate(true)} onNavigate={setActivePage} />}
          {activePage === 'agents' && <AgentsPage onCreate={() => { setEditorAgent(null); setActivePage('agent-editor') }} onOpenAgent={openAgent} />}
          {activePage === 'agent-editor' && <AgentEditorPage key={editorAgent?.name ?? 'new'} agent={editorAgent ?? undefined} onBack={() => setActivePage('agents')} onNavigate={setActivePage} onToast={notify} />}
          {activePage === 'assets' && <AssetsPage assets={filteredAssets} filter={assetFilter} setFilter={setAssetFilter} search={search} setSearch={setSearch} onReference={(name) => notify(`已将「${name}」加入当前节点引用`)} />}
          {activePage === 'runs' && <RunsPage />}
          {activePage === 'settings' && <SettingsPage />}
        </div>
      </main>

      {toast && <div className="toast"><Check size={15} />{toast}</div>}
      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreate={(kind) => { setShowCreate(false); if (kind === 'agent') { setEditorAgent(null); setActivePage('agent-editor') } else { setActivePage('canvas'); notify('已创建新的资产画布草稿') } }} />}
    </div>
  )
}

export default App
