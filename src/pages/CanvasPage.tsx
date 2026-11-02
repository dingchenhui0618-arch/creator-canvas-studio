import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Check, ChevronDown, Clock3, Copy, FileImage, Film, Grid2X2, Layers3, Link2, Move, Play, Plus, RotateCcw, RotateCw, Search, Sparkles, Trash2, X, Zap } from 'lucide-react'
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, addEdge, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node } from '@xyflow/react'
import type { Artifact, CanvasNodeData, NodeStatus, RunEvent } from '../domain/types'
import { dshAdapter } from '../runtime/mockAdapter'
import { assets, initialEdges, initialNodes } from '../data/mock'
import { nodeTypes } from '../components/nodeTypes'
import { StatusDot } from '../components/ui'

const accentByTone: Record<string, string> = {
  terracotta: '#c77d5a',
  indigo: '#7b88b8',
  sage: '#7d9b7b',
  gold: '#d9a952',
  blue: '#5f6b92',
  rose: '#c98b8b',
}

type CanvasPageProps = { onToast: (message: string) => void }

export default function CanvasPage({ onToast }: CanvasPageProps) {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace onToast={onToast} />
    </ReactFlowProvider>
  )
}

function CanvasWorkspace({ onToast }: CanvasPageProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CanvasNodeData>>(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [selectedId, setSelectedId] = useState('agent-layout')
  const [tab, setTab] = useState<'props' | 'refs'>('props')
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'success'>('idle')
  const [events, setEvents] = useState<RunEvent[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [references, setReferences] = useState<Record<string, string[]>>({
    'agent-layout': ['asset-1', 'asset-2'],
    'output-board': ['asset-3'],
  })
  const [history, setHistory] = useState<{ nodes: Node<CanvasNodeData>[]; edges: Edge[] }[]>([])
  const [future, setFuture] = useState<{ nodes: Node<CanvasNodeData>[]; edges: Edge[] }[]>([])
  const rf = useReactFlow()
  const counter = useRef(0)
  const version = 'v3'

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1440px)')
    const sync = () => { if (query.matches) setRailOpen(false) }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId), [nodes, selectedId])
  const selectedRefs = selectedId ? references[selectedId] ?? [] : []
  const activeEvents = events.slice(-4)

  const pushHistory = useCallback(() => {
    setHistory((current) => [...current.slice(-9), { nodes, edges }])
    setFuture([])
  }, [nodes, edges])

  const onConnect = useCallback((connection: Connection) => {
    pushHistory()
    setEdges((current) => addEdge({ ...connection, animated: true }, current))
    onToast('已连接两个节点')
  }, [pushHistory, setEdges, onToast])

  const applyStatus = (nodeId: string, status: NodeStatus) => {
    setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, status } } : node)))
  }

  const runCanvas = async () => {
    if (runStatus === 'running') return
    setRunStatus('running')
    setEvents([])
    setArtifacts([])
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: node.data.kind === 'output' ? 'ready' : 'running' } })))
    try {
      const result = await dshAdapter.runCanvas(
        {
          versionId: `canvas-${version}`,
          nodes: nodes.map((node) => ({ id: node.id, kind: node.data.kind, title: node.data.title, data: node.data })),
          edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
        },
        (event) => {
          setEvents((current) => [...current, event])
          if (event.nodeId && event.type === 'node-started') applyStatus(event.nodeId, 'running')
          if (event.nodeId && event.type === 'node-completed') applyStatus(event.nodeId, 'success')
        },
      )
      setArtifacts(result.artifacts)
      setRunStatus('success')
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: 'success' } })))
      if (result.artifacts.length) {
        setReferences((current) => {
          const outputNode = nodes.find((node) => node.data.kind === 'output')
          if (!outputNode) return current
          return { ...current, [outputNode.id]: Array.from(new Set([...(current[outputNode.id] ?? []), 'asset-1'])) }
        })
      }
      onToast(`运行完成，生成 ${result.artifacts.length} 个可引用资产`)
    } catch {
      setRunStatus('idle')
      onToast('运行已取消')
    }
  }

  const addNode = (kind: CanvasNodeData['kind']) => {
    pushHistory()
    counter.current += 1
    const id = `node-${Date.now()}-${counter.current}`
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const preset: Record<string, CanvasNodeData> = {
      asset: { kind: 'asset', label: '参考资产', title: '新的参考资产', description: '等待选择文件或从资产库拖入', status: 'ready', meta: '未关联文件', icon: 'image', accent: '#c77d5a' },
      agent: { kind: 'agent', label: '创作智能体', title: '商品视觉编辑', description: '整理输入资产，输出详情页视觉方向', status: 'ready', meta: 'DSH Adapter · Mock', icon: 'bot', accent: '#6b62d9' },
      output: { kind: 'output', label: '生成资产', title: '新的生成资产', description: '运行后生成可视化结果', status: 'ready', meta: 'PNG · 1:1', icon: 'image', accent: '#d9a952' },
    }
    setNodes((current) => [...current, { id, type: kind, position: { x: center.x - 110, y: center.y - 60 }, data: preset[kind] }])
    setSelectedId(id)
    setAddMenuOpen(false)
    onToast(`已添加${preset[kind].label}节点`)
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const assetId = event.dataTransfer.getData('application/x-asset')
    const asset = assets.find((item) => item.id === assetId)
    if (!asset) return
    pushHistory()
    counter.current += 1
    const point = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    const id = `asset-${Date.now()}-${counter.current}`
    setNodes((current) => [...current, {
      id,
      type: 'asset',
      position: { x: point.x - 110, y: point.y - 40 },
      data: { kind: 'asset', label: asset.tag, title: asset.name, description: asset.detail, status: 'ready', meta: `来自资产库 · ${asset.type}`, icon: asset.type === '文本' ? 'text' : 'image', accent: accentByTone[asset.tone] ?? '#c77d5a' },
    }])
    setSelectedId(id)
    onToast(`已把「${asset.name}」拖入画布`)
  }

  const deleteSelected = () => {
    if (!selectedNode) return
    pushHistory()
    setNodes((current) => current.filter((node) => node.id !== selectedId))
    setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId))
    setSelectedId('')
    onToast('已删除节点及其连接')
  }

  const duplicateSelected = () => {
    if (!selectedNode) return
    pushHistory()
    counter.current += 1
    const id = `copy-${Date.now()}-${counter.current}`
    setNodes((current) => [...current, { ...selectedNode, id, selected: false, position: { x: selectedNode.position.x + 36, y: selectedNode.position.y + 36 }, data: { ...selectedNode.data, title: `${selectedNode.data.title} 副本` } }])
    setSelectedId(id)
    onToast('已复制节点')
  }

  const undo = () => {
    const previous = history[history.length - 1]
    if (!previous) return onToast('没有可撤销的操作')
    setFuture((current) => [...current, { nodes, edges }])
    setNodes(previous.nodes)
    setEdges(previous.edges)
    setHistory((current) => current.slice(0, -1))
  }

  const redo = () => {
    const next = future[future.length - 1]
    if (!next) return onToast('没有可重做的操作')
    setHistory((current) => [...current, { nodes, edges }])
    setNodes(next.nodes)
    setEdges(next.edges)
    setFuture((current) => current.slice(0, -1))
  }

  const addReference = () => {
    if (!selectedId) return onToast('先选择一个节点')
    const pool = assets.filter((asset) => !selectedRefs.includes(asset.id))
    if (!pool.length) return onToast('所有资产都已引用')
    const next = pool[0]
    setReferences((current) => ({ ...current, [selectedId]: [...(current[selectedId] ?? []), next.id] }))
    onToast(`已引用「${next.name}」`)
  }

  const removeReference = (assetId: string) => {
    setReferences((current) => ({ ...current, [selectedId]: (current[selectedId] ?? []).filter((id) => id !== assetId) }))
  }

  return (
    <div className="page page--canvas">
      <div className="page-heading page-heading--canvas">
        <div>
          <div className="eyebrow"><span className="eyebrow-dot" />项目 / 内容创作</div>
          <h1>春日上新 · 视觉资产画布</h1>
          <p>把参考素材整理成可以继续创作、复用和引用的视觉资产。</p>
        </div>
        <div className="heading-actions">
          <span className="save-state"><span className="save-dot" />{version} · 已保存</span>
          <button className="button button--ghost"><ArrowDownToLine size={16} />导出</button>
          <button className="button button--primary" onClick={runCanvas} disabled={runStatus === 'running'}>
            <Play size={15} fill="currentColor" />{runStatus === 'running' ? '运行中…' : '运行画布'}
          </button>
        </div>
      </div>

      <div className={`canvas-workspace ${railOpen ? '' : 'no-rail'}`}>
        <aside className="asset-rail" aria-label="资产库">
          <div className="asset-rail-head">
            <div>
              <span className="panel-kicker">可引用资产</span>
              <strong>{assets.length} 个</strong>
            </div>
            <button className="tool-icon" onClick={() => setRailOpen(false)} aria-label="收起资产栏"><X size={14} /></button>
          </div>
          <label className="rail-search"><Search size={13} /><input placeholder="筛选资产" /></label>
          <div className="asset-rail-list">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className={`rail-item ${selectedRefs.includes(asset.id) ? 'is-referenced' : ''}`}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('application/x-asset', asset.id)}
                onDoubleClick={() => setSelectedId(selectedNode?.id ?? '')}
              >
                <div className={`rail-thumb rail-thumb--${asset.tone}`}>{asset.type === '文本' ? 'Aa' : <FileImage size={14} />}</div>
                <div className="rail-copy">
                  <strong>{asset.name}</strong>
                  <span>{asset.type} · {asset.detail.split(' · ')[0]}</span>
                </div>
                {selectedRefs.includes(asset.id) ? <Check size={13} className="rail-check" /> : <button className="rail-add" onClick={addReference} aria-label={`引用 ${asset.name}`}><Plus size={13} /></button>}
              </div>
            ))}
          </div>
          <div className="asset-rail-foot"><Move size={12} />拖到画布即可引用</div>
        </aside>

        <section className="canvas-stage" aria-label="资产画布编辑器">
          <div className="canvas-toolbar">
            <div className="tool-group">
              <button className="tool-button is-active"><Move size={15} />选择</button>
              <button className="tool-button" onClick={() => onToast('拖动节点右侧圆点到另一个节点即可连接')}><Link2 size={15} />连接</button>
              <button className="tool-button" onClick={() => setRailOpen((value) => !value)}><Layers3 size={15} />资产库</button>
              <div className="add-node">
                <button className="tool-button" onClick={() => setAddMenuOpen((value) => !value)}><Plus size={15} />添加节点</button>
                {addMenuOpen && (
                  <div className="add-node-menu">
                    <button onClick={() => addNode('asset')}><FileImage size={14} />参考资产</button>
                    <button onClick={() => addNode('agent')}><Sparkles size={14} />智能体</button>
                    <button onClick={() => addNode('output')}><Film size={14} />生成资产</button>
                  </div>
                )}
              </div>
            </div>
            <div className="tool-group">
              <button className="tool-icon" onClick={undo} aria-label="撤销"><RotateCcw size={15} /></button>
              <button className="tool-icon" onClick={redo} aria-label="重做"><RotateCw size={15} /></button>
              <span className="tool-divider" />
              <button className="zoom-label" onClick={() => rf.fitView({ padding: 0.2 })}>{Math.round(zoom * 100)}%</button>
              <button className="tool-icon" onClick={() => rf.fitView({ padding: 0.2 })} aria-label="适应画布"><Grid2X2 size={15} /></button>
            </div>
          </div>
          <div className="canvas-viewport" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => { setSelectedId(node.id); setTab('props') }}
              onPaneClick={() => setSelectedId('')}
              onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { stroke: '#7c70d8', strokeWidth: 1.8 }, animated: true }}
            >
              <Background color="#ddd9d0" gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(node) => (node.id === selectedId ? '#7c70d8' : '#d6d1c7')} />
            </ReactFlow>
            <div className="canvas-note"><span className="live-pulse" />从左侧拖入资产，或点击节点查看引用</div>
          </div>
          {runStatus !== 'idle' && (
            <div className="run-dock">
              <div className="run-dock-head">
                <div>
                  <span className="run-kicker">最近一次运行 · 绑定 {version}</span>
                  <strong>{runStatus === 'running' ? '正在整理输入资产…' : `运行完成 · ${artifacts.length} 个 Artifact`}</strong>
                </div>
                <span className={`run-status run-status--${runStatus}`}>{runStatus === 'running' ? 'RUNNING' : 'SUCCEEDED'}</span>
              </div>
              <div className="run-progress"><span style={{ width: `${events[events.length - 1]?.progress ?? 0}%` }} /></div>
              <div className="run-events">
                {activeEvents.map((event) => (
                  <div className={`run-event run-event--${event.type}`} key={event.id}>
                    <span className="run-event-icon"><StatusDot status={event.type === 'completed' ? 'success' : event.type === 'node-completed' ? 'success' : 'running'} /></span>
                    <div><strong>{event.label}</strong>{event.detail && <span>{event.detail}</span>}</div>
                  </div>
                ))}
              </div>
              <div className="run-dock-foot">
                <span><Clock3 size={13} />{runStatus === 'running' ? '进行中' : '00:00:03'}</span>
                <span><Zap size={13} />DSH Adapter · Mock</span>
                <button>查看运行详情 <span aria-hidden>→</span></button>
              </div>
            </div>
          )}
        </section>

        <aside className="inspector-panel">
          <div className="inspector-head">
            <div>
              <span className="panel-kicker">节点检查器</span>
              <h2>{selectedNode?.data?.title ?? '选择一个节点'}</h2>
            </div>
            <button className="icon-button" aria-label="更多"><ChevronDown size={17} /></button>
          </div>
          <div className="inspector-tabs">
            <button className={tab === 'props' ? 'is-active' : ''} onClick={() => setTab('props')}>属性</button>
            <button className={tab === 'refs' ? 'is-active' : ''} onClick={() => setTab('refs')}>引用资产 <span>{selectedRefs.length}</span></button>
          </div>
          <div className="inspector-body">
          {!selectedNode ? (
            <div className="inspector-empty"><FileImage size={24} /><p>点击画布节点查看资产、参数和引用关系。</p></div>
          ) : tab === 'props' ? (
            <>
              <div className="inspector-section">
                <div className="field-label">节点类型</div>
                <div className="type-pill">
                  <span className="type-pill-icon">{selectedNode.data.icon === 'bot' ? <Sparkles size={13} /> : <FileImage size={13} />}</span>
                  <div><strong>{selectedNode.data.label}</strong><span>{selectedNode.data.kind === 'agent' ? '负责整理输入并生成下一步建议' : '可被智能体引用的项目资产'}</span></div>
                  <StatusDot status={selectedNode.data.status} />
                </div>
              </div>
              <div className="inspector-section">
                <div className="field-label">节点参数</div>
                <div className="param-row"><span>描述</span><strong>{selectedNode.data.description}</strong></div>
                <div className="param-row"><span>来源</span><strong>{selectedNode.data.meta ?? '—'}</strong></div>
                <div className="param-row"><span>状态</span><strong>{selectedNode.data.status === 'running' ? '执行中' : selectedNode.data.status === 'success' ? '已完成' : '待运行'}</strong></div>
              </div>
              <div className="inspector-section">
                <div className="field-label">执行设置</div>
                <div className="setting-row"><span>保存生成结果</span><button className="switch is-on"><span /></button></div>
                <div className="setting-row"><span>需要人工确认</span><button className="switch"><span /></button></div>
              </div>
              <div className="inspector-section inspector-section--quiet">
                <div className="field-label">适配器</div>
                <div className="adapter-row"><span className="adapter-mark">D</span><div><strong>DSH Adapter</strong><span>当前为演示连接</span></div><span className="connection-state">已连接</span></div>
              </div>
            </>
          ) : (
            <div className="inspector-section inspector-section--grow">
              <div className="field-label">该节点引用的资产</div>
              <div className="reference-list">
                {selectedRefs.length === 0 && <p className="empty-hint">还没有引用资产。从左侧拖入，或点击下方按钮添加。</p>}
                {selectedRefs.map((assetId) => {
                  const asset = assets.find((item) => item.id === assetId)
                  if (!asset) return null
                  return (
                    <div className="reference-row" key={assetId}>
                      <div className={`mini-thumb mini-thumb--${asset.tone}`}>{asset.type === '文本' ? 'Aa' : <FileImage size={12} />}</div>
                      <div><strong>{asset.name}</strong><span>{asset.type} · 当前版本</span></div>
                      <button className="reference-remove" onClick={() => removeReference(assetId)} aria-label={`移除 ${asset.name}`}><X size={13} /></button>
                    </div>
                  )
                })}
              </div>
              <button className="reference-button" onClick={addReference}><Plus size={15} />添加资产引用</button>
            </div>
          )}
          </div>
          <div className="inspector-footer">
            <button className="button button--ghost" onClick={duplicateSelected}><Copy size={14} />复制节点</button>
            <button className="button button--danger" onClick={deleteSelected}><Trash2 size={14} />删除</button>
          </div>
        </aside>
      </div>
    </div>
  )
}
