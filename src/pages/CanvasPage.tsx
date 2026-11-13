import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Copy, Expand, Hourglass, LayoutGrid, Maximize2, Minimize2, Play, Plus, RotateCcw, RotateCw, Save, Trash } from 'lucide-react'
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
  getFlow,
  listFlows,
  runFlowStream,
  saveFlowAsTemplate,
  updateFlow,
  type ApiFlow,
  type RunNodeResult,
  type RunProjectRef,
  type RunRecord,
} from '../api/flows'
import { getCredits } from '../api/credits'
import { getCanvasSessionTicket } from '../api/canvasSession'
import { getCanvasQueue, type CanvasQueueView } from '../api/canvasQueue'
import { useUiMode } from '../api/app'
import { navigate, replaceRoute } from '../router'
import {
  createBdcCanvas,
  getBdcStatus,
  listBdcCanvases,
  writeBdcNote,
  type BdcCanvas,
  type BdcStatus,
} from '../api/bdc'
import { NODE_META } from '../canvas/catalog'
import { FlowNodeCard } from '../canvas/FlowNode'
import { Inspector } from '../canvas/Inspector'
import { Palette } from '../canvas/Palette'
import { RunDrawer } from '../canvas/RunDrawer'
import { autoLayout } from '../canvas/layout'
import { fromFlowEdges, fromFlowNodes, toFlowEdges, toFlowNodes, validateConnection } from '../canvas/serialize'
import type { FlowNodeData, FlowNodeKind, RunNodeStatus } from '../canvas/types'
import PageHead from '../components/PageHead'
import { Select } from '../components/Select'
import '../styles/canvas.css'

const nodeTypes = {
  input: FlowNodeCard,
  llm: FlowNodeCard,
  kb: FlowNodeCard,
  tool: FlowNodeCard,
  condition: FlowNodeCard,
  output: FlowNodeCard,
}

// 画布页有两个入口，都来自地址栏：
//   flowId   #/canvas/<flowId>          内置编排的流程（模板库、运行记录跳转）
//   canvasId #/canvas/project/<画布ID>  画布服务里的画布项目（工作台「继续上次的画布」）
type CanvasPageProps = {
  onToast?: (message: string) => void
  flowId?: string
  canvasId?: string
  // 专注模式：进画布收起侧栏与顶栏，只留画布自己的工具条；再点一次退出
  focus?: boolean
  onToggleFocus?: () => void
}

type Snapshot = { nodes: Node<FlowNodeData>[]; edges: Edge[] }

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

export default function CanvasPage({ onToast, flowId, canvasId, focus, onToggleFocus }: CanvasPageProps) {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace onToast={onToast} flowId={flowId} canvasId={canvasId} focus={focus} onToggleFocus={onToggleFocus} />
    </ReactFlowProvider>
  )
}

// VisionQA Canvas 的默认地址是本机回环。访客浏览器里的 127.0.0.1 指的是「他自己那台电脑」，
// 所以这种地址只能在自己机器上内嵌；对外必须换成独立子域，否则只能给提示卡而不是白屏 iframe。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function CanvasWorkspace({ onToast, flowId: initialFlowId, canvasId: initialCanvasId, focus, onToggleFocus }: CanvasPageProps) {
  const { internal } = useUiMode()
  const rf = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [flows, setFlows] = useState<ApiFlow[]>([])
  const [flowId, setFlowId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // 这块画布挂在哪条作品的第几版：服务端按画布指针现算，空白画布为 null
  const [flowProject, setFlowProject] = useState<RunProjectRef | null>(null)
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
  // 从工作台点进来时地址里带的是画布项目 id：等画布服务确认后再挂 iframe
  const bdcTarget = initialCanvasId || ''
  const [bdcChecked, setBdcChecked] = useState(false)
  const [bdcMissing, setBdcMissing] = useState(false)
  // 画布 ↔ 工作台：画布列表、当前画布、把评审笔记写回画布
  const [canvases, setCanvases] = useState<BdcCanvas[]>([])
  const [canvasId, setCanvasId] = useState(() => {
    // 地址里点名了画布项目就以它为准；否则沿用上次打开的
    if (initialCanvasId) return initialCanvasId
    try { return window.localStorage.getItem('vq:bdcCanvas') || '' } catch { return '' }
  })
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  // 写完笔记让 iframe 重新挂载一次，画布直接重载出那条文本节点
  const [frameKey, setFrameKey] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [historyCount, setHistoryCount] = useState(0)
  const [futureCount, setFutureCount] = useState(0)
  // 画布运行按次扣积分：运行前就把单价和余额摆出来，402 时不用去猜
  const [runCredit, setRunCredit] = useState<{ price: number; balance: number | null } | null>(null)
  // 画布出图的排队位（v0.9.83）：出图发生在画布 iframe 里，等的时候这边什么也看不见。
  // 轮询只读接口，把「几张在跑、几张在排队、最久的等了多久」挂到状态条上；空闲时不显示。
  const [queueView, setQueueView] = useState<CanvasQueueView | null>(null)
  const [queueIdleAt, setQueueIdleAt] = useState(0)
  const queueWasBusy = useRef(false)
  const queueIdleTimer = useRef<number | undefined>(undefined)
  // 画布 iframe：画布加载完会要一张信任票据，拿到后它自己换会话，用户不用在画布里再登一次
  const bdcFrameRef = useRef<HTMLIFrameElement | null>(null)
  // 进页面时地址里点名的那块内置流程（只影响「默认进哪个视图」，之后切流程不动它）
  const requestedFlowRef = useRef(initialFlowId)

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

  const refreshRunCredit = useCallback(() => {
    void getCredits(1)
      .then((data) => setRunCredit({ price: Number(data.prices.flow_run) || 0, balance: data.balance }))
      .catch(() => setRunCredit(null))
  }, [])

  useEffect(() => {
    refreshRunCredit()
  }, [refreshRunCredit])

  // 排队位：页面可见时每 3 秒问一次，切到后台就停（别在看不见的标签页里空转）。
  // 刚忙完那一阵要留在屏幕上几秒——「出完了」也是个结论，不该一瞬间消失。
  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const view = await getCanvasQueue()
        if (!alive) return
        setQueueView(view)
        const busy = view.active > 0 || view.waiting > 0
        if (busy) {
          setQueueIdleAt(0)
        } else if (queueWasBusy.current) {
          // 刚忙完：先留一句「刚刚那批出完了」，8 秒后自己收起来（不在渲染里读时钟）
          setQueueIdleAt(1)
          if (queueIdleTimer.current) window.clearTimeout(queueIdleTimer.current)
          queueIdleTimer.current = window.setTimeout(() => setQueueIdleAt(0), 8000)
        }
        queueWasBusy.current = busy
      } catch {
        // 未登录 / 接口暂时不通：状态条就不显示，不在这条路径上报错
        if (alive) setQueueView(null)
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 3000)
    const onVisible = () => { if (!document.hidden) void tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      if (queueIdleTimer.current) window.clearTimeout(queueIdleTimer.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

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

  // 已经装进页面的流程：applyFlow 会把 id 写回地址栏，路由再回灌进来时用它挡住第二次加载
  const loadedFlowRef = useRef('')

  const applyFlow = useCallback((flow: ApiFlow) => {
    skipSave.current = true
    loadedFlowRef.current = flow.id
    setFlowId(flow.id)
    setName(flow.name)
    setDescription(flow.description ?? '')
    setFlowProject(flow.project ?? null)
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
    // 地址栏跟着当前流程走：刷新、复制链接、从其它页面跳回来都能落到同一张画布
    if (flow.id) replaceRoute({ kind: 'page', page: 'canvas', flowId: flow.id })
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
      // 目标是画布项目时不需要流程：不写地址、不创建「未命名流程」，直接留给下面的画布视图
      if (bdcTarget) {
        setLoadState('ready')
        return
      }
      // 地址里这个流程就是刚装好的那一张（applyFlow 自己回写的），不要再拉一次列表
      if (initialFlowId && initialFlowId === loadedFlowRef.current) {
        setLoadState('ready')
        return
      }
      setLoadState('loading')
      try {
        let list = await listFlows()
        if (!alive) return
        // 地址里有 #/canvas/<flowId>：优先打开指定流程；找不到就退回列表第一条
        let target: ApiFlow | null = initialFlowId ? list.find((flow) => flow.id === initialFlowId) || null : null
        if (initialFlowId && !target) {
          try {
            target = await getFlow(initialFlowId)
            if (target) list = [target, ...list]
          } catch {
            target = null
          }
        }
        if (!alive) return
        if (!list.length) {
          const created = await createFlow({ name: '未命名流程', description: '', nodes: [], edges: [] })
          list = [created]
        }
        setFlows(list)
        applyFlow(target || list[0])
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
  }, [applyFlow, initialFlowId, rf, bdcTarget])

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

  // 另存为模板 = 写进模板库的工作流条目（带 blueprint），不是再复制一张流程
  const saveAsTemplate = useCallback(async () => {
    if (running) return
    const id = flowIdRef.current
    if (!id) return
    if (!nodesRef.current.length) {
      toast('画布还是空的，先拖入节点再存为模板')
      return
    }
    await saveNow()
    try {
      const result = await saveFlowAsTemplate(id, nameRef.current)
      toast('已存为模板：' + result.template.title + '（可在模板库套用回画布）')
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
      // 运行结束（含失败退款）后余额会变，重新读一次，别让按钮旁的余额停在旧值
      refreshRunCredit()
    }
  }, [refreshRunCredit, running, saveError, saveNow, setNodes, toast])

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
          // 地址里点名了一块内置流程（#/canvas/<flowId>，例如从作品页「套用模板开画布」进来）时，
          // 默认就进那块流程——刚生成完却先看到画布服务的另一块画布，会以为没生效。
          // 没点名流程（或者点名的是画布服务里的画布）时默认进 VisionQA Canvas。
          if (status.deployed) setBdcView(!requestedFlowRef.current)
        })
        .catch(() => undefined)
        .finally(() => setBdcChecked(true))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const reloadCanvases = useCallback(async () => {
    try {
      const res = await listBdcCanvases()
      setCanvases(res.canvases || [])
      return res
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    if (!bdc?.deployed) return
    let cancelled = false
    void listBdcCanvases()
      .then((res) => {
        if (cancelled) return
        const list = res.canvases || []
        setCanvases(list)
        // 链接里的画布可能已被别人删掉：直说，不悄悄换成列表第一块
        setBdcMissing(Boolean(bdcTarget) && !list.some((item) => item.id === bdcTarget))
        setCanvasId((current) => {
          if (bdcTarget && list.some((item) => item.id === bdcTarget)) return bdcTarget
          return list.some((item) => item.id === current) ? current : list[0]?.id || ''
        })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [bdc?.deployed, bdcTarget])

  useEffect(() => {
    try {
      if (canvasId) window.localStorage.setItem('vq:bdcCanvas', canvasId)
      else window.localStorage.removeItem('vq:bdcCanvas')
    } catch {
      /* 隐私模式忽略 */
    }
  }, [canvasId])

  // iframe 地址：一次性入口（种 cookie）+ 画布 id（画布自己用 ?loadCanvas= 认）
  // 票据只发给画布自己的源：postMessage 的 targetOrigin 用真实 origin，绝不用 '*'
  const bdcOrigin = useMemo(() => {
    try {
      return new URL(bdc?.web.embedUrl || bdc?.web.url || '').origin
    } catch {
      return ''
    }
  }, [bdc?.web.embedUrl, bdc?.web.url])

  useEffect(() => {
    if (!bdcOrigin) return
    let cancelled = false
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== bdcOrigin) return
      const data = event.data as { type?: string } | null
      if (!data || data.type !== 'vq-canvas:ready') return
      getCanvasSessionTicket()
        .then((ticket) => {
          if (cancelled) return
          bdcFrameRef.current?.contentWindow?.postMessage(
            { type: 'vq-canvas:ticket', token: ticket.token, issuer: ticket.issuer, audience: ticket.audience, expiresAt: ticket.expiresAt },
            bdcOrigin,
          )
        })
        .catch(() => {
          // 互通没开或票据接口不可用：画布继续走它自己的登录，不弹错误打断用户
        })
    }
    window.addEventListener('message', onMessage)
    return () => {
      cancelled = true
      window.removeEventListener('message', onMessage)
    }
  }, [bdcOrigin])

  const bdcFrameSrc = useMemo(() => {
    const base = bdc?.web.embedUrl || bdc?.web.url || ''
    if (!base || !canvasId) return base
    return base + (base.includes('?') ? '&' : '?') + 'loadCanvas=' + encodeURIComponent(canvasId)
  }, [bdc?.web.embedUrl, bdc?.web.url, canvasId])

  const handleCreateCanvas = useCallback(async () => {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[^0-9]/g, '').slice(4, 12)
    try {
      const res = await createBdcCanvas(`评审画布-${stamp}`)
      if (res?.canvas) {
        setCanvases((list) => [res.canvas, ...list])
        setCanvasId(res.canvas.id)
        toast?.(`已新建画布：${res.canvas.name}`)
      }
    } catch (error) {
      toast?.(error instanceof Error ? error.message : '新建画布失败')
    }
  }, [toast])

  const handleWriteNote = useCallback(async () => {
    const text = noteText.trim()
    if (!text) return
    if (!canvasId) {
      toast?.('先选一个画布，再写笔记')
      return
    }
    setNoteBusy(true)
    try {
      await writeBdcNote(canvasId, text, 'VisionQA 评审笔记')
      setNoteText('')
      setNoteOpen(false)
      await reloadCanvases()
      setFrameKey((key) => key + 1)
      toast?.('已写进画布，画布正在重载')
    } catch (error) {
      toast?.(error instanceof Error ? error.message : '写入画布失败')
    } finally {
      setNoteBusy(false)
    }
  }, [canvasId, noteText, reloadCanvases, toast])

  const saveLabel = saveState === 'saving'
    ? '保存中…'
    : saveState === 'dirty'
      ? '有未保存修改'
      : saveState === 'error'
        ? '保存失败'
        : '已保存'

  // 画布项目依赖画布服务：确认前只给一条细状态条；连不上就写清楚，不白屏、不假装已打开
  if (bdcTarget && !bdcChecked) {
    return (
      <div className="page cv-page">
        <div className="cv-bdc-strip">
          <span className="cv-bdc-label">VisionQA Canvas</span>
          <span className="cv-bdc-state">正在连接画布…</span>
        </div>
      </div>
    )
  }
  if (bdcTarget && bdcMissing) {
    return (
      <div className="page cv-page">
        <div className="vq-empty">
          <strong>这块画布不在了</strong>
          <span>它可能已被删除，或链接里的编号不属于当前账号。回工作台看现在还有哪些画布。</span>
          <button type="button" className="vq-button vq-button--ghost" onClick={() => navigate({ kind: 'page', page: 'overview' })}>
            返回工作台
          </button>
        </div>
      </div>
    )
  }
  if (bdcTarget && (!bdc || !bdc.deployed)) {
    return (
      <div className="page cv-page">
        <div className="vq-empty">
          <strong>这块画布暂时打不开</strong>
          <span>画布服务没有连接上，工作台里的画布项目需要它才能显示。稍后重试，或回到工作台用内置编排。</span>
          <button type="button" className="vq-button vq-button--ghost" onClick={() => navigate({ kind: 'page', page: 'overview' })}>
            返回工作台
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`page cv-page${bdcView && bdc?.deployed ? ' is-bdc' : ''}`}>
      {bdcView && bdc?.deployed ? (
        // 画布页的主角是画布本身：第三方画布自带完整的顶栏与工具条，
        // 我们这层不该再叠一遍标题和说明，只留一条 42px 的状态条（在哪 / 通没通 / 两个出口）。
        <div className="cv-bdc-strip">
          {/* 上一层的面包屑已经说了「画布」，这里只留第三方署名与连接状态，不重复 */}
          <span className="cv-bdc-label">VisionQA Canvas</span>
          <span className="cv-bdc-state" title={bdc.web.url}>
            <span className="cv-save-dot" />
            {bdcLocalOnly ? '本机已连接' : '已连接'}
          </span>
          <CanvasQueueChip view={queueView} idleAt={queueIdleAt} />
          <span className="cv-bdc-sep" aria-hidden="true" />
          <div className="cv-bdc-picker">
            <span className="cv-bdc-picker-label">画布项目</span>
            <Select
              size="sm"
              label="选择画布项目"
              value={canvasId}
              options={[
                { value: '', label: canvases.length ? '未指定（默认画布）' : '暂无已保存的画布' },
                ...canvases.map((item) => ({ value: item.id, label: item.name + ' · ' + item.nodeCount + ' 节点' })),
              ]}
              onChange={(value) => setCanvasId(value)}
            />
          </div>
          <button className="cv-bdc-action" type="button" onClick={handleCreateCanvas} title="新建一块画布并绑定到工作台">
            <Plus size={12} />新建
          </button>
          <button
            className="cv-bdc-action"
            type="button"
            onClick={() => setNoteOpen((open) => !open)}
            aria-expanded={noteOpen}
            title="把评审结论作为文本节点写进画布"
          >
            <Save size={12} />写笔记
          </button>
          {noteOpen ? (
            <div className="cv-bdc-note" role="dialog" aria-label="写进画布">
              <div className="cv-bdc-note-title">写进画布 · {canvases.find((item) => item.id === canvasId)?.name || '未指定画布'}</div>
              <textarea
                className="cv-bdc-note-input"
                value={noteText}
                onChange={(event) => setNoteText(event.target.value)}
                placeholder="评审结论、待确认项、返工点…"
                rows={4}
                spellCheck={false}
              />
              <div className="cv-bdc-note-foot">
                <span className="cv-bdc-note-hint">会以文本节点落在画布左上角</span>
                <button className="cv-bdc-action" type="button" onClick={() => setNoteOpen(false)}>取消</button>
                <button
                  className="cv-bdc-action is-primary"
                  type="button"
                  onClick={handleWriteNote}
                  disabled={noteBusy || !noteText.trim() || !canvasId}
                >
                  {noteBusy ? '写入中…' : '写入画布'}
                </button>
              </div>
            </div>
          ) : null}
          <span className="cv-bdc-spacer" />
          <span className="cv-bdc-url">{bdc.web.url.replace(/^https?:\/\//, '').split('/')[0]}</span>
          {onToggleFocus ? (
            <button
              className={'cv-bdc-action' + (focus ? ' is-primary' : '')}
              type="button"
              onClick={onToggleFocus}
              title={focus ? '退出专注模式，回到自己的工作台' : '专注模式：收起左侧栏与顶栏，只留画布'}
              aria-pressed={Boolean(focus)}
            >
              {focus ? <Minimize2 size={12} /> : <Expand size={12} />}
              {focus ? '退出专注' : '专注'}
            </button>
          ) : null}
          <a
            className="vq-button vq-button--icon"
            href={bdc.web.embedUrl || bdc.web.url}
            target="_blank"
            rel="noreferrer"
            title="在新窗口打开"
            aria-label="在新窗口打开"
          >
            <Maximize2 size={14} />
          </a>
          <button
            className="vq-button vq-button--icon"
            type="button"
            onClick={() => {
              // 从画布项目链接进来的页面没有加载内置流程：回内置编排要走一次路由，让它正常拉流程
              if (bdcTarget) navigate({ kind: 'page', page: 'canvas' })
              else setBdcView(false)
            }}
            title="回到内置编排"
            aria-label="回到内置编排"
          >
            <LayoutGrid size={14} />
          </button>
        </div>
      ) : (
      <PageHead
        kicker="画布 / 流程编排"
        title={
          <span className="cv-title-row">
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
          </span>
        }
        desc="按依赖顺序逐个节点执行 · 每次运行记录耗时、输出与失败原因，失败自动退回积分"
        actions={
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
          <button className="vq-button vq-button--ghost" type="button" onClick={() => { void createNewFlow() }} disabled={running} title="新建流程">
            <Plus size={14} />新建
          </button>
          <button className="vq-button vq-button--ghost" type="button" onClick={() => { void saveAsTemplate() }} disabled={running} title="把当前画布另存为一个新流程">
            <Copy size={14} />另存为模板
          </button>
          <button className="vq-button vq-button--ghost" type="button" onClick={() => { void saveNow().then((ok) => toast(ok ? (internal ? '已保存到 data/flows.json' : '已保存') : '保存失败：' + saveError)) }} disabled={running || saveState === 'saving'} title="Ctrl+S">
            <Save size={14} />保存
          </button>
          {runCredit && runCredit.price > 0 ? (
            <span className="cv-run-credit" title="画布按次扣积分；有节点失败会全额退回">
              运行 {runCredit.price} 积分 · 余额 {runCredit.balance ?? '—'}
            </span>
          ) : null}
          <button
            className="vq-button vq-button--primary"
            type="button"
            onClick={() => { void handleRun() }}
            disabled={running || loadState !== 'ready' || (runCredit != null && runCredit.balance != null && runCredit.balance < runCredit.price)}
            title={runCredit && runCredit.balance != null && runCredit.balance < runCredit.price ? '积分不足，先让管理员发放' : '按拓扑序执行整张画布'}
          >
            <Play size={14} fill="currentColor" />{running ? '运行中…' : '运行流程'}
          </button>
          <button className="vq-button vq-button--icon" type="button" onClick={() => { void removeFlow() }} disabled={running || loadState !== 'ready'} aria-label="删除流程" title="删除流程">
            <Trash size={14} />
          </button>
          </div>
        }
      />
      )}

      {bdc?.deployed && !bdcView ? (
        <div className="cv-bdc-bar">
          <span className="vq-mono">BD CANVAS · {bdcLocalOnly ? '本机已部署' : '已部署'}</span>
          <p>画布由 VisionQA Canvas 接管（{bdc.web.url}）；这里的流程编排保留作备选，数据各存各的。</p>
          <CanvasQueueChip view={queueView} idleAt={queueIdleAt} />
          <button className="vq-button vq-button--ghost" type="button" onClick={() => setBdcView(true)}>在这里打开</button>
          <a className="vq-button vq-button--ghost" href={bdc.web.url} target="_blank" rel="noreferrer">新窗口</a>
        </div>
      ) : null}

      {bdcView && bdc?.deployed ? (
        // 本机地址不能嵌给外部访客：客户浏览器会把 127.0.0.1 解析成他自己的电脑，只会看到白屏。
        bdcLocalOnly ? (
          <div className="cv-state">
            <CircleAlert size={18} strokeWidth={1.5} />
            <div>
              <strong>画布还没对外发布</strong>
              <p>VisionQA Canvas 现在只监听本机（{bdc.web.url}），从别的电脑打开会连到访客自己的机器。</p>
              <p className="cv-muted">{internal ? '把它部署到独立子域并把 BDC_WEB_URL 指过去，这里就会直接显示画布。' : '发布到独立域名后，这里就会直接显示画布。'}</p>
            </div>
            <button className="vq-button vq-button--ghost" type="button" onClick={() => setBdcView(false)}>用内置编排</button>
          </div>
        ) : (
          <iframe key={frameKey} ref={bdcFrameRef} className="cv-bdc-frame" src={bdcFrameSrc} title="VisionQA Canvas" />
        )
      ) : loadState === 'error' ? (
        <div className="cv-state">
          <CircleAlert size={18} strokeWidth={1.5} />
          <div>
            <strong>画布加载失败</strong>
            <p>{loadError}</p>
            <p className="cv-muted">{internal ? '确认 API 服务（127.0.0.1:8787）已启动，然后重新加载页面。' : '稍后重新加载页面；如果仍未恢复，请联系平台维护人员。'}</p>
          </div>
          <button className="vq-button vq-button--ghost" type="button" onClick={() => window.location.reload()}>重新加载</button>
        </div>
      ) : (
        <div className="cv-workspace">
          {paletteOpen ? (
            <Palette onAdd={addFromPalette} onClose={() => setPaletteOpen(false)} disabled={loadState !== 'ready'} />
          ) : null}

          <section className="cv-stage" aria-label="流程画布">
            {/* 画布是从作品某一步被带进来的能力：先写清在帮哪条作品、哪一版，再给两个出口。
                空白画布不写——没有作品就别编一条出来。 */}
            {flowProject ? (
              <div className="cv-project">
                <span className="cv-project-kicker">{flowProject.archived ? '归档画布' : '在帮'}</span>
                <strong className="cv-project-title">
                  《{flowProject.title}》· 第 {flowProject.version} 版{flowProject.archived ? '（已归档）' : ''}
                </strong>
                <span className="cv-project-meta">
                  {flowProject.archived
                    ? '这条作品现在用的是新的一版；这一版留着查看，跑出来的运行仍记在第 ' + flowProject.version + ' 版上'
                    : '这块画布就是这条作品当前这一版，跑出来的运行与评审都记在它下面'}
                </span>
                <div className="cv-project-actions">
                  <button
                    className="vq-button vq-button--ghost"
                    type="button"
                    onClick={() => navigate({ kind: 'page', page: 'projects', projectId: flowProject.id })}
                  >
                    打开作品
                  </button>
                  {flowProject.archived ? null : (
                    <button
                      className="vq-button vq-button--ghost"
                      type="button"
                      onClick={() => navigate({ kind: 'page', page: 'review', projectId: flowProject.id })}
                    >
                      去评审这一版
                    </button>
                  )}
                </div>
              </div>
            ) : null}
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
                {/* 空画布不挂小地图：以前是一块空白白框浮在右下角，看着像没加载完 */}
                {nodes.length ? (
                  <MiniMap
                    pannable
                    zoomable={false}
                    nodeColor={(node) => (node.id === selectedId ? '#111111' : '#d5d5d5')}
                    maskColor="rgba(244,244,244,.78)"
                  />
                ) : null}
              </ReactFlow>

              {loadState === 'loading' && <div className="cv-overlay">{internal ? '正在读取 data/flows.json…' : '正在读取画布…'}</div>}
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


// 排队位小胶囊（v0.9.83）：画布出图发生在 iframe 里，等的时候这边只有一片安静——
// 它回答「几张在跑 / 几张在排队 / 最久的等了多久」，忙完 8 秒后显示一次「刚刚那批出完了」再消失。
// 数字全由服务端现算；空闲时整个不渲染，不在顶栏上挂一个常驻的 0。
function CanvasQueueChip({ view, idleAt }: { view: CanvasQueueView | null; idleAt: number }) {
  if (!view) return null
  const busy = view.active > 0 || view.waiting > 0
  // idleAt 是「刚刚忙完」的标记，8 秒后由轮询那边清掉——这里不读时钟，渲染才是纯的
  const justDone = !busy && idleAt > 0
  if (!busy && !justDone) return null
  if (!busy) {
    return (
      <span className="cv-bdc-queue is-done" title="这一批画布出图都已经结束：名额都还回去了">
        <Check size={12} strokeWidth={2} />刚刚那批出完了
      </span>
    )
  }
  // 小于 10 秒保留一位小数（0.4 秒不该写成「0 秒」），再长就取整
  const seconds = (ms: number) => (ms >= 10000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10))
  const hint = view.waitMs > 0
    ? '每条最多等 ' + seconds(view.waitMs) + ' 秒、最多 ' + view.maxWaiting + ' 条同时排（' + (view.queueScope === 'process' ? '按进程算' : '整机') + '）'
    : '名额满时直接拒，这类没有排队'
  return (
    <span
      className={'cv-bdc-queue' + (view.waiting > 0 ? ' is-waiting' : '') + (view.full ? ' is-full' : '')}
      title={'画布出图的排队位：' + hint + '。在跑 ' + view.active + ' / 上限 ' + (view.limit || '不限') + '，排队 ' + view.waiting + '。'}
    >
      {view.waiting > 0 ? <Hourglass size={12} strokeWidth={2} /> : <span className="cv-bdc-queue-dot" />}
      在跑 {view.active}
      {view.waiting > 0 ? ' · 排队 ' + view.waiting + '（最久 ' + seconds(view.oldestWaitMs) + 's）' : ''}
      {view.full ? ' · 排队位已满' : ''}
    </span>
  )
}

