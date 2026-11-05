import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleAlert, Copy, LayoutGrid, Maximize2, Play, Plus, RotateCcw, RotateCw, Save, Trash } from 'lucide-react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import {
  createFlow,
  deleteFlow,
  listFlows,
  runFlowStream,
  updateFlow,
  type ApiFlow,
  type RunNodeResult,
  type RunRecord,
} from '../api/flows'
import { getBdcStatus, type BdcStatus } from '../api/bdc'
import { NODE_META } from '../canvas/catalog'
import { FlowNodeCard } from '../canvas/FlowNode'
import { Inspector } from '../canvas/Inspector'
import { Palette } from '../canvas/Palette'
import { RunDrawer } from '../canvas/RunDrawer'
import { autoLayout } from '../canvas/layout'
import { fromFlowEdges, fromFlowNodes, toFlowEdges, toFlowNodes, validateConnection } from '../canvas/serialize'
import type { FlowNodeData, FlowNodeKind, RunNodeStatus } from '../canvas/types'
import '../styles/canvas.css'

const nodeTypes = {
  input: FlowNodeCard,
  llm: FlowNodeCard,
  kb: FlowNodeCard,
  tool: FlowNodeCard,
  condition: FlowNodeCard,
  output: FlowNodeCard,
}

type CanvasPageProps = { onToast?: (message: string) => void }

type Snapshot = { nodes: Node<FlowNodeData>[]; edges: Edge[] }

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

export default function CanvasPage({ onToast }: CanvasPageProps) {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace onToast={onToast} />
    </ReactFlowProvider>
  )
}

// BD Canvas 的默认地址是本机回环。访客浏览器里的 127.0.0.1 指的是「他自己那台电脑」，
// 所以这种地址只能在自己机器上内嵌；对外必须换成独立子域，否则只能给提示卡而不是白屏 iframe。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function CanvasWorkspace({ onToast }: CanvasPageProps) {
  const rf = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [flows, setFlows] = useState<ApiFlow[]>([])
  const [flowId, setFlowId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [running, setRunning] = useState(false)
  const [runNodes, setRunNodes] = useState<RunNodeResult[]>([])
  const [runRecord, setRunRecord] = useState<RunRecord | null>(null)
  const [runMeta, setRunMeta] = useState<{ id: string; total: number }>({ id: '', total: 0 })
  const [runError, setRunError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [bdc, setBdc] = useState<BdcStatus | null>(null)
  const [bdcView, setBdcView] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [historyCount, setHistoryCount] = useState(0)
  const [futureCount, setFutureCount] = useState(0)

  const bdcLocalOnly =
    Boolean(bdc?.web.url) &&
    LOOPBACK_HOSTS.has(hostOf(bdc?.web.url || '')) &&
    !LOOPBACK_HOSTS.has(typeof window === 'undefined' ? '' : window.location.hostname.toLowerCase())

  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const flowIdRef = useRef(flowId)
  const nameRef = useRef(name)
  const descriptionRef = useRef(description)
  const selectedIdRef = useRef(selectedId)
  const flowsRef = useRef(flows)

  const history = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const lastEdit = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const counter = useRef(0)
  const skipSave = useRef(true)
  const savedSignature = useRef('')
  const stageRef = useRef<HTMLDivElement>(null)

  const toast = useCallback((message: string) => onToast?.(message), [onToast])

  const graphSignature = useMemo(
    () =>
      JSON.stringify({
        name,
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
          data: {
            kind: node.data.kind,
            title: node.data.title,
            description: node.data.description,
            config: node.data.config,
          },
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
        })),
      }),
    [nodes, edges, name],
  )
  const signatureRef = useRef(graphSignature)

  // 把最新 state 同步到 ref，供事件处理与自动保存读取；放在 effect 里避免渲染期写 ref
  useEffect(() => {
    nodesRef.current = nodes
    edgesRef.current = edges
    flowIdRef.current = flowId
    nameRef.current = name
    descriptionRef.current = description
    selectedIdRef.current = selectedId
    flowsRef.current = flows
    signatureRef.current = graphSignature
  }, [nodes, edges, flowId, name, description, selectedId, flows, graphSignature])

  const snapshot = useCallback((): Snapshot => ({
    nodes: nodesRef.current.map((node) => ({ ...node })),
    edges: edgesRef.current.map((edge) => ({ ...edge })),
  }), [])

  const pushHistory = useCallback((key = '') => {
    const now = Date.now()
    // 连续输入同一个字段时合并成一步，避免每敲一个字都压栈
    if (key && lastEdit.current.key === key && now - lastEdit.current.at < 1200) {
      lastEdit.current.at = now
      return
    }
    lastEdit.current = { key, at: now }
    history.current = [...history.current.slice(-29), snapshot()]
    future.current = []
    setHistoryCount(history.current.length)
    setFutureCount(0)
  }, [snapshot])

  const undo = useCallback(() => {
    const previous = history.current[history.current.length - 1]
    if (!previous) {
      toast('没有可撤销的操作')
      return
    }
    future.current = [...future.current, snapshot()]
    history.current = history.current.slice(0, -1)
    setNodes(previous.nodes.map((node) => ({ ...node, selected: node.id === selectedIdRef.current })))
    setEdges(previous.edges)
    setHistoryCount(history.current.length)
    setFutureCount(future.current.length)
  }, [snapshot, setNodes, setEdges, toast])

  const redo = useCallback(() => {
    const next = future.current[future.current.length - 1]
    if (!next) {
      toast('没有可重做的操作')
      return
    }
    history.current = [...history.current, snapshot()]
    future.current = future.current.slice(0, -1)
    setNodes(next.nodes.map((node) => ({ ...node, selected: node.id === selectedIdRef.current })))
    setEdges(next.edges)
    setHistoryCount(history.current.length)
    setFutureCount(future.current.length)
  }, [snapshot, setNodes, setEdges, toast])

  const applyFlow = useCallback((flow: ApiFlow) => {
    skipSave.current = true
    setFlowId(flow.id)
    setName(flow.name)
    setDescription(flow.description ?? '')
    const nextNodes = fromFlowNodes(flow.nodes)
    const first = nextNodes[0]
    if (first) first.selected = true
    setNodes(nextNodes)
    setEdges(fromFlowEdges(flow.edges, new Set(nextNodes.map((node) => node.id))))
    setSelectedId(first?.id ?? '')
    history.current = []
    future.current = []
    setHistoryCount(0)
    setFutureCount(0)
    setRunRecord(null)
    setRunNodes([])
    setRunMeta({ id: '', total: 0 })
    setRunError('')
    setSaveState('saved')
    setSaveError('')
  }, [setNodes, setEdges])

  const saveNow = useCallback(async (): Promise<boolean> => {
    const id = flowIdRef.current
    if (!id) return false
    const sentSignature = signatureRef.current
    setSaveState('saving')
    try {
      const updated = await updateFlow(id, {
        name: nameRef.current,
        description: descriptionRef.current,
        nodes: toFlowNodes(nodesRef.current),
        edges: toFlowEdges(edgesRef.current),
      })
      setFlows((current) => current.map((flow) => (flow.id === updated.id ? updated : flow)))
      savedSignature.current = sentSignature
      if (signatureRef.current === sentSignature) setSaveState('saved')
      setSaveError('')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSaveState('error')
      setSaveError(message)
      return false
    }
  }, [])

  // 初次加载：列出流程；没有流程时创建一个空流程，保证画布可用
  useEffect(() => {
    let alive = true
    const load = async () => {
      setLoadState('loading')
      try {
        let list = await listFlows()
        if (!alive) return
        if (!list.length) {
          const created = await createFlow({ name: '未命名流程', description: '', nodes: [], edges: [] })
          list = [created]
        }
        setFlows(list)
        applyFlow(list[0])
        setLoadState('ready')
        window.setTimeout(() => rf.fitView({ padding: 0.12 }), 80)
      } catch (error) {
        if (!alive) return
        setLoadError(error instanceof Error ? error.message : String(error))
        setLoadState('error')
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [applyFlow, rf])

  // 自动保存：只比较节点/连线/流程名的投影，选中态变化不会触发保存
  useEffect(() => {
    if (loadState !== 'ready') return
    if (skipSave.current) {
      skipSave.current = false
      savedSignature.current = graphSignature
      setSaveState('saved')
      return
    }
    if (graphSignature === savedSignature.current) return
    setSaveState('dirty')
    const timer = window.setTimeout(() => {
      void saveNow()
    }, 900)
    return () => window.clearTimeout(timer)
  }, [graphSignature, loadState, saveNow])

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId])

  // 选中状态同时写进 node.selected，React Flow 的选中样式才会跟着走
  const selectNode = useCallback((id: string) => {
    setSelectedId(id)
    setNodes((current) => current.map((node) => {
      const next = node.id === id
      return (node.selected ?? false) === next ? node : { ...node, selected: next }
    }))
  }, [setNodes])

  const addNodeAt = useCallback((kind: FlowNodeKind, position: { x: number; y: number }) => {
    const meta = NODE_META[kind]
    pushHistory()
    counter.current += 1
    const id = kind + '-' + Date.now().toString(36) + '-' + counter.current
    const node: Node<FlowNodeData> = {
      id,
      type: kind,
      position,
      selected: true,
      data: {
        kind,
        title: meta.defaultTitle,
        description: meta.defaultDescription,
        config: { ...meta.defaultConfig },
        status: 'idle',
      },
    }
    setNodes((current) => [...current, node])
    selectNode(id)
    toast('已添加' + meta.label + '节点')
  }, [pushHistory, selectNode, setNodes, toast])

  const addFromPalette = useCallback((kind: FlowNodeKind) => {
    const rect = stageRef.current?.getBoundingClientRect()
    const fallback = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const point = rf.screenToFlowPosition({
      x: rect ? rect.left + rect.width / 2 : fallback.x,
      y: rect ? rect.top + rect.height / 2 : fallback.y,
    })
    const jitter = (counter.current % 5) * 24
    const base = { x: Math.round(point.x - 120 + jitter), y: Math.round(point.y - 60 + jitter) }
    const offsets = [[0, 0], [0, 152], [280, 0], [-280, 0], [280, 152], [-280, 152], [0, 304], [0, -152], [280, -152], [-280, -152]]
    // 找一个不和已有节点重叠的落点，避免点一下面板就盖住现有卡片
    const free = offsets
      .map(([dx, dy]) => ({ x: base.x + dx, y: base.y + dy }))
      .find((spot) => !nodesRef.current.some((node) => Math.abs(node.position.x - spot.x) < 264 && Math.abs(node.position.y - spot.y) < 150))
    addNodeAt(kind, free ?? base)
  }, [addNodeAt, rf])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    const kind = event.dataTransfer.getData('application/x-flow-node') as FlowNodeKind
    if (!kind || !NODE_META[kind]) return
    const point = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    addNodeAt(kind, { x: Math.round(point.x - 116), y: Math.round(point.y - 52) })
  }, [addNodeAt, rf])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    const error = validateConnection(edgesRef.current, connection)
    if (error) {
      toast(error)
      return
    }
    const source = nodesRef.current.find((node) => node.id === connection.source)
    const branch = source?.data.kind === 'condition'
      ? connection.sourceHandle === 'false' ? 'false' : 'true'
      : undefined
    pushHistory()
    setEdges((current) => addEdge({
      ...connection,
      id: 'e-' + connection.source + '-' + connection.target + '-' + Date.now().toString(36),
      label: branch,
      className: branch ? 'cv-edge cv-edge--branch' : 'cv-edge',
    }, current))
    toast(branch ? '已连接（' + branch + ' 分支）' : '已连接两个节点')
  }, [pushHistory, setEdges, toast])

  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current
    if (!id) {
      toast('先选中一个节点')
      return
    }
    pushHistory()
    setNodes((current) => current.filter((node) => node.id !== id))
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id))
    selectNode('')
    toast('已删除节点及其连线')
  }, [pushHistory, selectNode, setNodes, setEdges, toast])

  const duplicateSelected = useCallback(() => {
    const node = nodesRef.current.find((item) => item.id === selectedIdRef.current)
    if (!node) return
    pushHistory()
    counter.current += 1
    const id = node.data.kind + '-' + Date.now().toString(36) + '-' + counter.current
    setNodes((current) => [...current, {
      ...node,
      id,
      selected: true,
      position: { x: node.position.x + 32, y: node.position.y + 32 },
      data: { ...node.data, title: node.data.title + ' 副本', status: 'idle', ms: undefined, output: undefined, error: undefined },
    }])
    selectNode(id)
    toast('已复制节点')
  }, [pushHistory, selectNode, setNodes, toast])

  const patchSelected = useCallback((patch: Partial<FlowNodeData>, key: string) => {
    const id = selectedIdRef.current
    if (!id) return
    pushHistory('node:' + id + ':' + key)
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)))
  }, [pushHistory, setNodes])

  const patchConfig = useCallback((patch: FlowNodeData['config'], key: string) => {
    const id = selectedIdRef.current
    if (!id) return
    pushHistory('cfg:' + id + ':' + key)
    setNodes((current) => current.map((node) => (
      node.id === id ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node
    )))
  }, [pushHistory, setNodes])

  const relayout = useCallback(() => {
    pushHistory()
    setNodes((current) => autoLayout(current, edgesRef.current))
    window.setTimeout(() => rf.fitView({ padding: 0.12, duration: 200 }), 60)
    toast('已按依赖层级重新布局')
  }, [pushHistory, setNodes, rf, toast])

  const focusNode = useCallback((id: string) => {
    selectNode(id)
    const node = nodesRef.current.find((item) => item.id === id)
    if (node) rf.setCenter(node.position.x + 116, node.position.y + 70, { zoom: Math.max(zoom, 0.75), duration: 280 })
  }, [rf, selectNode, zoom])

  const switchFlow = useCallback(async (nextId: string) => {
    if (nextId === flowIdRef.current) return
    if (running) {
      toast('运行中不能切换流程')
      return
    }
    await saveNow()
    const target = flowsRef.current.find((flow) => flow.id === nextId)
    if (!target) return
    applyFlow(target)
    window.setTimeout(() => rf.fitView({ padding: 0.12 }), 80)
  }, [applyFlow, running, saveNow, rf, toast])

  const createNewFlow = useCallback(async () => {
    if (running) return
    await saveNow()
    try {
      const created = await createFlow({ name: '未命名流程', description: '', nodes: [], edges: [] })
      setFlows((current) => [created, ...current])
      applyFlow(created)
      toast('已新建流程')
    } catch (error) {
      toast('新建失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [applyFlow, running, saveNow, toast])

  const saveAsTemplate = useCallback(async () => {
    if (running) return
    await saveNow()
    try {
      const copy = await createFlow({
        name: nameRef.current + ' · 模板',
        description: descriptionRef.current,
        nodes: toFlowNodes(nodesRef.current),
        edges: toFlowEdges(edgesRef.current),
      })
      setFlows((current) => [copy, ...current])
      toast('已另存为模板流程：' + copy.name)
    } catch (error) {
      toast('另存失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [running, saveNow, toast])

  const removeFlow = useCallback(async () => {
    const id = flowIdRef.current
    if (!id || running) return
    if (!window.confirm('删除整个流程？节点和连线会一起删除，已产生的运行记录保留。')) return
    try {
      const result = await deleteFlow(id)
      if (!result.ok) {
        toast('删除失败：流程不存在')
        return
      }
      const rest = flowsRef.current.filter((flow) => flow.id !== id)
      if (!rest.length) {
        const created = await createFlow({ name: '未命名流程', description: '', nodes: [], edges: [] })
        setFlows([created])
        applyFlow(created)
      } else {
        setFlows(rest)
        applyFlow(rest[0])
      }
      toast('流程已删除')
    } catch (error) {
      toast('删除失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }, [applyFlow, running, toast])

  const handleRun = useCallback(async () => {
    if (running) return
    if (!nodesRef.current.length) {
      toast('画布还没有节点，先从左侧拖入一个')
      return
    }
    const saved = await saveNow()
    if (!saved) {
      toast('保存失败，未发起运行：' + saveError)
      return
    }
    setRunning(true)
    setDrawerOpen(true)
    setRunNodes([])
    setRunRecord(null)
    setRunMeta({ id: '', total: 0 })
    setRunError('')
    setNodes((current) => current.map((node) => ({
      ...node,
      data: { ...node.data, status: 'pending', ms: undefined, output: undefined, error: undefined },
    })))

    try {
      const record = await runFlowStream(flowIdRef.current, (event) => {
        if (event.type === 'run-start') {
          setRunMeta({ id: event.run.id, total: event.run.total })
          return
        }
        if (event.type === 'node-start') {
          setNodes((current) => current.map((node) => (
            node.id === event.nodeId ? { ...node, data: { ...node.data, status: 'running' } } : node
          )))
          return
        }
        if (event.type === 'node-end') {
          const node = event.node
          const status: RunNodeStatus = node.status === 'success' ? 'done' : node.status
          setRunNodes((current) => [...current, node])
          setNodes((current) => current.map((item) => (
            item.id === node.id
              ? {
                  ...item,
                  data: {
                    ...item.data,
                    status,
                    ms: node.ms,
                    error: node.error ?? undefined,
                    output: typeof node.output?.text === 'string' ? node.output.text : '',
                  },
                }
              : item
          )))
        }
      })
      setRunRecord(record)
      toast(record.status === 'success'
        ? '运行完成 · ' + (record.durationMs / 1000).toFixed(1) + 's'
        : '运行结束，有节点失败 · ' + (record.durationMs / 1000).toFixed(1) + 's')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRunError(message)
      setNodes((current) => current.map((node) => (
        node.data.status === 'running' || node.data.status === 'pending'
          ? { ...node, data: { ...node.data, status: 'error', error: message } }
          : node
      )))
      toast('运行失败：' + message)
    } finally {
      setRunning(false)
    }
  }, [running, saveError, saveNow, setNodes, toast])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable))
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && key === 'z' && !typing) {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (modifier && key === 'y' && !typing) {
        event.preventDefault()
        redo()
        return
      }
      if (modifier && key === 's') {
        event.preventDefault()
        void saveNow().then((ok) => toast(ok ? '已保存' : '保存失败：' + saveError))
        return
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false)
        setDrawerOpen(false)
        return
      }
      if (!typing && selectedIdRef.current && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelected, redo, saveError, saveNow, toast, undo])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void getBdcStatus()
        .then((status) => {
          setBdc(status)
          // BD Canvas 部署后它就是画布本体，默认直接进 BD Canvas；
          // 用户点「回到内置编排」才切回本仓库那套节点编排。
          if (status.deployed) setBdcView(true)
        })
        .catch(() => undefined)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const saveLabel = saveState === 'saving'
    ? '保存中…'
    : saveState === 'dirty'
      ? '有未保存修改'
      : saveState === 'error'
        ? '保存失败'
        : '已保存'

  return (
    <div className={`page cv-page${bdcView && bdc?.deployed ? ' is-bdc' : ''}`}>
      {bdcView && bdc?.deployed ? (
        // 画布页的主角是画布本身：第三方画布自带完整的顶栏与工具条，
        // 我们这层不该再叠一遍标题和说明，只留一条 42px 的状态条（在哪 / 通没通 / 两个出口）。
        <div className="cv-bdc-strip">
          {/* 上一层的面包屑已经说了「画布」，这里只留第三方署名与连接状态，不重复 */}
          <span className="cv-bdc-label">BD CANVAS</span>
          <span className="cv-bdc-state" title={bdc.web.url}>
            <span className="cv-save-dot" />
            本机已连接
          </span>
          <span className="cv-bdc-spacer" />
          <span className="cv-bdc-url">{bdc.web.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
          <a
            className="cv-icon-btn"
            href={bdc.web.url}
            target="_blank"
            rel="noreferrer"
            title="在新窗口打开"
            aria-label="在新窗口打开"
          >
            <Maximize2 size={14} />
          </a>
          <button
            className="cv-icon-btn"
            type="button"
            onClick={() => setBdcView(false)}
            title="回到内置编排"
            aria-label="回到内置编排"
          >
            <LayoutGrid size={14} />
          </button>
        </div>
      ) : (
      <div className="cv-head">
        <div className="cv-head-main">
          <div className="cv-eyebrow">画布 / 流程编排</div>
          <div className="cv-title-row">
            <input
              className="cv-flow-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="流程名称"
              spellCheck={false}
              disabled={loadState !== 'ready'}
            />
            <span className={`cv-save is-${saveState}`} title={saveError || saveLabel}>
              <span className="cv-save-dot" />{saveLabel}
            </span>
          </div>
          <p className="cv-sub">服务端按拓扑序执行 · 模型调用走本地端点 · 运行记录写入 data/runs.json</p>
        </div>
        <div className="cv-head-actions">
          <label className="cv-flow-select">
            <span className="cv-sr-only">切换流程</span>
            <select
              value={flowId}
              onChange={(event) => { void switchFlow(event.target.value) }}
              disabled={running || loadState !== 'ready'}
            >
              {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>
          <button className="cv-btn" type="button" onClick={() => { void createNewFlow() }} disabled={running} title="新建流程">
            <Plus size={14} />新建
          </button>
          <button className="cv-btn" type="button" onClick={() => { void saveAsTemplate() }} disabled={running} title="把当前画布另存为一个新流程">
            <Copy size={14} />另存为模板
          </button>
          <button className="cv-btn" type="button" onClick={() => { void saveNow().then((ok) => toast(ok ? '已保存到 data/flows.json' : '保存失败：' + saveError)) }} disabled={running || saveState === 'saving'} title="Ctrl+S">
            <Save size={14} />保存
          </button>
          <button className="cv-btn cv-btn--primary" type="button" onClick={() => { void handleRun() }} disabled={running || loadState !== 'ready'}>
            <Play size={14} fill="currentColor" />{running ? '运行中…' : '运行流程'}
          </button>
          <button className="cv-icon-btn" type="button" onClick={() => { void removeFlow() }} disabled={running || loadState !== 'ready'} aria-label="删除流程" title="删除流程">
            <Trash size={14} />
          </button>
        </div>
      </div>
      )}

      {bdc?.deployed && !bdcView ? (
        <div className="cv-bdc-bar">
          <span className="vq-mono">BD CANVAS · 本机已部署</span>
          <p>画布由 BD Canvas 接管（{bdc.web.url}）；这里的流程编排保留作备选，数据各存各的。</p>
          <button className="cv-btn" type="button" onClick={() => setBdcView(true)}>在这里打开</button>
          <a className="cv-btn" href={bdc.web.url} target="_blank" rel="noreferrer">新窗口</a>
        </div>
      ) : null}

      {bdcView && bdc?.deployed ? (
        // 本机地址不能嵌给外部访客：客户浏览器会把 127.0.0.1 解析成他自己的电脑，只会看到白屏。
        bdcLocalOnly ? (
          <div className="cv-state">
            <CircleAlert size={18} strokeWidth={1.5} />
            <div>
              <strong>画布还没对外发布</strong>
              <p>BD Canvas 现在只监听本机（{bdc.web.url}），从别的电脑打开会连到访客自己的机器。</p>
              <p className="cv-muted">把它部署到独立子域并把 BDC_WEB_URL 指过去，这里就会直接显示画布。</p>
            </div>
            <button className="cv-btn" type="button" onClick={() => setBdcView(false)}>用内置编排</button>
          </div>
        ) : (
          <iframe className="cv-bdc-frame" src={bdc.web.url} title="BD Canvas" />
        )
      ) : loadState === 'error' ? (
        <div className="cv-state">
          <CircleAlert size={18} strokeWidth={1.5} />
          <div>
            <strong>画布加载失败</strong>
            <p>{loadError}</p>
            <p className="cv-muted">确认 API 服务（127.0.0.1:8787）已启动，然后重新加载页面。</p>
          </div>
          <button className="cv-btn" type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      ) : (
        <div className="cv-workspace">
          {paletteOpen ? (
            <Palette onAdd={addFromPalette} onClose={() => setPaletteOpen(false)} disabled={loadState !== 'ready'} />
          ) : null}

          <section className="cv-stage" aria-label="流程画布">
            <div className="cv-toolbar">
              <div className="cv-toolbar-group">
                <button className="cv-tool" type="button" onClick={relayout} disabled={!nodes.length}>
                  <LayoutGrid size={14} />自动布局
                </button>
                <span className="cv-divider" />
                <button className="cv-tool" type="button" onClick={undo} disabled={!historyCount} title="Ctrl+Z">
                  <RotateCcw size={14} />撤销
                </button>
                <button className="cv-tool" type="button" onClick={redo} disabled={!futureCount} title="Ctrl+Shift+Z / Ctrl+Y">
                  <RotateCw size={14} />重做
                </button>
                <span className="cv-divider" />
                <span className="cv-toolbar-count" title={historyCount ? '已记录 ' + historyCount + ' 步可撤销操作' : ''}>
                  {nodes.length} 节点 · {edges.length} 连线
                </span>
              </div>
              <div className="cv-toolbar-group">
                <button
                  className={`cv-tool ${paletteOpen ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setPaletteOpen((value) => !value)}
                  title="双击画布也可唤出节点面板"
                >
                  <Plus size={14} />节点
                </button>
                <span className="cv-divider" />
                <button className="cv-tool" type="button" onClick={() => rf.fitView({ padding: 0.12, duration: 200 })}>
                  <Maximize2 size={14} />适应画布
                </button>
                <span className="cv-zoom">{Math.round(zoom * 100)}%</span>
              </div>
            </div>

            <div className="cv-canvas" ref={stageRef} onDrop={onDrop} onDragOver={onDragOver}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => selectNode(node.id)}
                onNodeDragStart={() => pushHistory()}
                onPaneClick={() => selectNode('')}
                onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
                deleteKeyCode={null}
                fitView
                fitViewOptions={{ padding: 0.12 }}
                zoomOnDoubleClick={false}
                onDoubleClick={(event) => {
                  if ((event.target as HTMLElement).closest('.react-flow__node')) return
                  setPaletteOpen(true)
                }}
                minZoom={0.25}
                maxZoom={1.8}
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{
                  className: 'cv-edge',
                  style: { stroke: 'rgba(17,17,17,.34)', strokeWidth: 1 },
                  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'rgba(17,17,17,.5)' },
                }}
                connectionLineStyle={{ stroke: 'rgba(17,17,17,.55)', strokeWidth: 1 }}
              >
                <Background color="rgba(17,17,17,.12)" gap={22} size={1} />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable={false}
                  nodeColor={(node) => (node.id === selectedId ? '#111111' : '#d5d5d5')}
                  maskColor="rgba(244,244,244,.78)"
                />
              </ReactFlow>

              {loadState === 'loading' && <div className="cv-overlay">正在读取 data/flows.json…</div>}
              {loadState === 'ready' && !nodes.length && (
                <div className="cv-overlay cv-overlay--empty">
                  <strong>画布还没有节点</strong>
                  <p>从左侧面板拖入输入、大模型或评审节点，再用右侧的圆点连线。</p>
                </div>
              )}
              <div className="cv-hint">
                <span className="cv-hint-dot" data-running={running} />
                {running ? '运行中：节点会按拓扑序逐个点亮' : '拖动节点右侧圆点连线；每个输入端口只接一根线'}
              </div>
            </div>
          </section>

          <Inspector
            node={selectedNode}
            onPatch={patchSelected}
            onConfig={patchConfig}
            onDuplicate={duplicateSelected}
            onDelete={deleteSelected}
          />
        </div>
      )}

      <RunDrawer
        open={drawerOpen}
        running={running}
        flowName={name}
        runId={runMeta.id}
        total={runMeta.total}
        nodes={runNodes}
        record={runRecord}
        error={runError}
        onClose={() => setDrawerOpen(false)}
        onSelectNode={focusNode}
      />
    </div>
  )
}
