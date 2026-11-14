import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, CircleAlert, Copy, Expand, GitCompareArrows, History, Hourglass, LayoutGrid, Maximize2, Minimize2, Play, Plus, RotateCcw, RotateCw, Save, Square, Trash } from 'lucide-react'
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
  getRun,
  getRunQueue,
  getRunResumePlan,
  listFlows,
  runFlowStream,
  saveFlowAsTemplate,
  stopRun as stopRunRequest,
  updateFlow,
  type ApiFlow,
  type RunGraphSnapshot,
  type RunNodeResult,
  type RunProjectRef,
  type RunRecord,
  type RunResumePlan,
} from '../api/flows'
import { getCredits } from '../api/credits'
import { runResumeInfo, runSpentText, runStatusMeta } from '../domain/run'
import { diffRunGraph, type RunGraphDiff } from '../domain/run-diff'
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
import { RunCompareModal } from '../components/RunCompareModal'
import { RunDrawer } from '../canvas/RunDrawer'
import { autoLayout } from '../canvas/layout'
import { fromFlowEdges, fromFlowNodes, toFlowEdges, toFlowNodes, validateConnection } from '../canvas/serialize'
import type { FlowNodeData, FlowNodeKind, RunNodeStatus } from '../canvas/types'
import PageHead from '../components/PageHead'
import { Pill } from '../components/ui'
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

// 画布页有四个入口，都来自地址栏：
//   flowId       #/canvas/<flowId>                    内置编排的流程（模板库、运行记录跳转）
//   viewRunId    #/canvas/<flowId>/run/<runId>        只读查看一次运行：回放节点结果，不许改画布（v0.9.106）
//   resumeRunId  #/canvas/<flowId>/resume/<runId>     特定一次运行：打开时把记录放回抽屉（v0.9.104）
//   canvasId     #/canvas/project/<画布ID>            画布服务里的画布项目（工作台「继续上次的画布」）
type CanvasPageProps = {
  onToast?: (message: string) => void
  flowId?: string
  resumeRunId?: string
  viewRunId?: string
  canvasId?: string
  // 专注模式：进画布收起侧栏与顶栏，只留画布自己的工具条；再点一次退出
  focus?: boolean
  onToggleFocus?: () => void
}

type Snapshot = { nodes: Node<FlowNodeData>[]; edges: Edge[] }

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

function formatRunTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// 回看的是运行开始时的快照，不是现在这张画布。把「这之后改了什么」摊开：
// 参数 / 位置 / 标题分开数，避免把「挪了一下」说成「改了提示词」。
function RunGraphDiffBlock({ diff }: { diff: RunGraphDiff }) {
  const names = (items: RunGraphDiff['changed']) => {
    const shown = items.slice(0, 6).map((item) => item.title).join(' · ')
    return items.length > 6 ? shown + ' 等 ' + items.length + ' 个' : shown
  }
  const groups = [
    ['参数', diff.changed],
    ['位置', diff.moved],
    ['标题', diff.retitled],
    ['新增', diff.added],
    ['删除', diff.removed],
  ] as const
  const edges = [
    diff.edgesAdded ? '多 ' + diff.edgesAdded + ' 条' : '',
    diff.edgesRemoved ? '少 ' + diff.edgesRemoved + ' 条' : '',
  ].filter(Boolean).join(' · ')
  return (
    <details className={'cv-runview-diff' + (diff.same ? ' is-same' : '')}>
      <summary>
        <span className="cv-runview-diff-label">与当前画布比</span>
        <span className={'cv-runview-diff-summary' + (diff.same ? ' is-same' : '')}>
          {diff.same ? '一致' : diff.summary}
        </span>
        <span className="cv-runview-diff-counts vq-mono">快照 {diff.snapshotNodes} · 当前 {diff.currentNodes} 个节点</span>
        <ChevronDown size={13} className="cv-runview-diff-chev" aria-hidden="true" />
      </summary>
      {diff.same ? (
        <p className="cv-runview-diff-note">位置、标题、参数与连线都没有变。</p>
      ) : (
        <div className="cv-runview-diff-body">
          {groups.filter(([, items]) => items.length > 0).map(([label, items]) => (
            <div className="cv-runview-diff-row" key={label}>
              <span className="cv-runview-diff-kind">{label}</span>
              <span className="cv-runview-diff-names">{names(items)}</span>
            </div>
          ))}
          {edges ? (
            <div className="cv-runview-diff-row">
              <span className="cv-runview-diff-kind">连线</span>
              <span className="cv-runview-diff-names">{edges}</span>
            </div>
          ) : null}
        </div>
      )}
    </details>
  )
}

export default function CanvasPage({ onToast, flowId, resumeRunId, viewRunId, canvasId, focus, onToggleFocus }: CanvasPageProps) {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace onToast={onToast} flowId={flowId} resumeRunId={resumeRunId} viewRunId={viewRunId} canvasId={canvasId} focus={focus} onToggleFocus={onToggleFocus} />
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

function CanvasWorkspace({ onToast, flowId: initialFlowId, resumeRunId: initialResumeId, viewRunId: initialViewId, canvasId: initialCanvasId, focus, onToggleFocus }: CanvasPageProps) {
  const { internal } = useUiMode()
  // 只读查看（v0.9.106）：地址里带的是 run 时，画布回放这次运行的结果，但不写回、不扣费、不提供运行入口。
  const readOnly = Boolean(initialViewId)
  const openRunId = initialViewId || initialResumeId || ''
  const rf = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FlowNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [flows, setFlows] = useState<ApiFlow[]>([])
  const [flowId, setFlowId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // 这块画布挂在哪条作品的第几版：服务端按画布指针现算，空白画布为 null
  const [flowProject, setFlowProject] = useState<RunProjectRef | null>(null)
  // 只读回看的画布已经被删除（v0.9.109）：快照还在时按当时那张图回放，退出不能再回到一张不存在的画布。
  const [flowDeleted, setFlowDeleted] = useState(false)
  // 画布删了、这次运行也没有快照：没有可回放的画布，只能把话说清并送回运行记录。
  const [missingSnapshot, setMissingSnapshot] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState('')
  const [running, setRunning] = useState(false)
  const [runNodes, setRunNodes] = useState<RunNodeResult[]>([])
  const [runRecord, setRunRecord] = useState<RunRecord | null>(null)
  // 这次运行开始时的画布快照（v0.9.107）：有它，回看的是当时的位置与参数；没有才退回当前画布。
  const [runGraph, setRunGraph] = useState<RunGraphSnapshot | null>(null)
  // 进只读回看时服务端给的当前画布（v0.9.108）：用来和快照对照，回答「这之后改了什么」。
  // 快照会替换 nodes / edges，所以必须在替换前把它留在这一份里。
  const [previewBase, setPreviewBase] = useState<ApiFlow | null>(null)
  // 停止 / 失败后还能接着跑的那条运行：抽屉里的「继续」按它发起，复用它已跑完的节点
  const [resumeSource, setResumeSource] = useState<RunRecord | null>(null)
  // 续跑预检（v0.9.103）：画布改过之后，旧记录里的「跑完 3 个」不等于「还能复用 3 个」。
  // 由服务端按节点内容指纹现算，页面只负责把「复用几个 / 重跑几个 / 补多少」说清楚。
  const [resumePlan, setResumePlan] = useState<RunResumePlan | null>(null)
  const [runMeta, setRunMeta] = useState<{ id: string; total: number }>({ id: '', total: 0 })
  const [runError, setRunError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 运行对照（v0.9.110）：只读弹窗，打开时才去读对照对象；不在画布页加载时预取
  const [compareOpen, setCompareOpen] = useState(false)
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
  // 运行的排队位（v0.9.96）：名额满时这一单先进整机的队，等的时候顶栏显示「第几位 · 已等几秒」。
  // 票号是这次运行的凭据：页面自己生成，服务端按它查名次；排到之后 waitedMs 记下来给运行结论用。
  const [runQueue, setRunQueue] = useState<{ position: number; waitedMs: number; waiting: number; waitMs: number } | null>(null)
  const [runQueuedMs, setRunQueuedMs] = useState(0)
  const runQueueTicketRef = useRef('')
  const [runElapsed, setRunElapsed] = useState(0)
  // 取消排队（v0.9.97）：点「取消」把这条连接 abort 掉。服务端认的是响应被关掉，
  // 于是退出排队（票退掉、不占名额、不扣积分），页面立刻回到空闲。
  const runAbortRef = useRef<AbortController | null>(null)
  // 这一次运行的 id：排队阶段还没有，run-start 之后才有；「停止运行」按它找服务端那一条
  const runIdRef = useRef('')
  const [stopping, setStopping] = useState(false)
  // 上一次问名次时还排着队：取消之后靠它分清「退出排队」与「中断一条已经开跑的运行」
  const runQueuedRef = useRef(false)
  const [runCancelled, setRunCancelled] = useState(false)
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

  // 退出只读查看：地址回到普通画布，App 按模式重挂一次画布，原来的运行态不会挂到编辑态上。
  // 画布已经删除时不能回到一张不存在的画布：优先回作品页，没有作品就回运行记录。
  const exitRunView = useCallback(() => {
    if (flowDeleted || missingSnapshot) {
      const projectId = runRecord?.project?.id
      if (projectId) {
        navigate({ kind: 'page', page: 'projects', projectId })
        return
      }
      navigate({ kind: 'page', page: 'runs' })
      return
    }
    const id = flowIdRef.current
    if (!id) {
      navigate({ kind: 'page', page: 'runs' })
      return
    }
    navigate({ kind: 'page', page: 'canvas', flowId: id })
  }, [flowDeleted, missingSnapshot, runRecord])

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
  // 地址里点名的那条运行已经放回抽屉没有：路由重渲染、保存后重跑 effect 都不该再拉一次
  const appliedRunRef = useRef('')
  // 只读回看只加载一次：画布删了 / 没有快照时没有 applyFlow 可以把 loadedFlowRef 填上，
  // 少了这道闸，渲染一次就再拉一次 flows + run，会变成一串 404。
  const viewLoadRef = useRef('')

  const applyFlow = useCallback((flow: ApiFlow, resumeRunId?: string, viewRunId?: string) => {
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
    setRunGraph(null)
    setPreviewBase(viewRunId ? flow : null)
    setResumeSource(null)
    setResumePlan(null)
    setRunNodes([])
    setRunMeta({ id: '', total: 0 })
    setRunError('')
    setSaveState('saved')
    setSaveError('')
    // 地址栏跟着当前流程走：刷新、复制链接、从其它页面跳回来都能落到同一张画布。
    // 从运行记录点进来时保留 runId，并且查看 / 续跑两种入口不能互相覆盖：
    // 查看是只读回放（v0.9.106），续跑才会重新执行没跑完的节点（v0.9.104）。
    if (flow.id) {
      replaceRoute({
        kind: 'page',
        page: 'canvas',
        flowId: flow.id,
        ...(viewRunId ? { viewRunId } : resumeRunId ? { resumeRunId } : {}),
      })
    }
  }, [setNodes, setEdges])

  const saveNow = useCallback(async (): Promise<boolean> => {
    const id = flowIdRef.current
    // 只读查看不是编辑会话：任何保存入口（按钮、Ctrl+S、切流程）都不能落盘。
    if (!id || readOnly) return false
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
      // 保存失败时 handleRun 会在发请求前停住；这里保留上一次成功保存的预检，
      // 至少不会拿一份没落盘的画布去报价，也不把抽屉整块清空。
      return false
    }
  }, [readOnly])

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
      // 同一条只读回看已经失败过：保持失败页，不再反复请求。成功那条由 applyFlow 接管。
      if (initialViewId && viewLoadRef.current === initialViewId) return
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
        // 画布被删除后，运行记录与快照还在：地址带 runId 时用快照重建一块只读画布。
        // 这时绝不创建「未命名流程」——用户要看的是历史，不是一张新画布。
        let deletedFlow = false
        if (!target && initialFlowId && initialViewId) {
          try {
            const run = await getRun(initialViewId)
            const graph = run.graph && run.graph.nodes.length ? run.graph : null
            if (run.flowId !== initialFlowId) {
              viewLoadRef.current = initialViewId
              setLoadError('这次运行不属于地址里的画布。')
              setLoadState('error')
              return
            }
            if (!graph) {
              viewLoadRef.current = initialViewId
              setFlowDeleted(true)
              setMissingSnapshot(true)
              setName(run.flowName || '已删除的画布')
              setLoadError('这块画布已经被删除，这次运行也没有留下画布快照。')
              setLoadState('error')
              return
            }
            target = {
              id: run.flowId,
              name: run.flowName || '已删除的画布',
              description: '',
              nodes: graph.nodes,
              edges: graph.edges,
              runCount: 0,
              lastRunId: run.id,
              lastRunAt: run.finishedAt || run.startedAt,
              createdAt: graph.capturedAt,
              updatedAt: graph.capturedAt,
              project: run.project ?? null,
            }
            deletedFlow = true
          } catch (error) {
            viewLoadRef.current = initialViewId
            const status = (error as { status?: number }).status
            setMissingSnapshot(status === 404)
            setLoadError(
              status === 404
                ? '这次运行不存在或已被清理。'
                : '这次运行打不开：' + (error instanceof Error ? error.message : String(error)),
            )
            setLoadState('error')
            return
          }
        }
        if (!alive) return
        if (!list.length && !target) {
          const created = await createFlow({ name: '未命名流程', description: '', nodes: [], edges: [] })
          list = [created]
        }
        if (target) {
          const current = target
          list = [current, ...list.filter((flow) => flow.id !== current.id)]
        }
        const chosen = target || list[0]
        if (!chosen) throw new Error('没有可打开的画布')
        if (deletedFlow) setFlowDeleted(true)
        setFlows(list)
        applyFlow(chosen, initialResumeId, initialViewId)
        // 画布已经删除：没有「当前画布」可对照，不显示差异行，也不写「一致」。
        if (deletedFlow) setPreviewBase(null)
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
  }, [applyFlow, initialFlowId, initialResumeId, initialViewId, rf, bdcTarget])

  // 从运行记录点「查看」或「继续运行」进来（v0.9.104 / v0.9.106）：地址里带着 runId，
  // 画布就绪后把那条记录放回抽屉——关过页面、换过设备、隔天再回来，都不必先记得上次停在哪一屏。
  // 查看模式只回放节点结果，不写画布、不扣费；能不能续仍由 resume-plan 在记录页现算，这里不替服务端下结论。
  useEffect(() => {
    const id = flowIdRef.current
    const runId = openRunId
    if (!runId || !id || loadState !== 'ready') return undefined
    const mode = readOnly ? 'view' : 'resume'
    const key = mode + ':' + id + ':' + runId
    if (appliedRunRef.current === key) return undefined
    appliedRunRef.current = key
    let alive = true
    const timer = window.setTimeout(() => {
      getRun(runId)
        .then((run) => {
          if (!alive) return
          if (run.flowId !== flowIdRef.current) {
            toast('这条运行不属于当前画布')
            navigate({ kind: 'page', page: 'canvas', flowId: flowIdRef.current }, { replace: true })
            return
          }
          const byId = new Map(run.nodes.map((node) => [node.id, node]))
          const withResult = (node: Node<FlowNodeData>): Node<FlowNodeData> => {
            const result = byId.get(node.id)
            if (!result) {
              return { ...node, data: { ...node.data, status: undefined, ms: undefined, output: undefined, error: undefined } }
            }
            return {
              ...node,
              data: {
                ...node.data,
                status: (result.status === 'success' ? 'done' : result.status) as RunNodeStatus,
                ms: result.ms,
                output: typeof result.output?.text === 'string' ? result.output.text : '',
                error: result.error ?? undefined,
              },
            }
          }
          // 有快照就以快照为准：即使画布后来挪过、删过节点，回看的还是当时那张图。
          // 旧运行没有快照，仍按原来的方式把结果贴到当前画布上，并在页面上写明这一点。
          const graph = readOnly && run.graph && run.graph.nodes.length ? run.graph : null
          if (graph) {
            const pinned = fromFlowNodes(graph.nodes).map(withResult)
            const keepIds = new Set(pinned.map((node) => node.id))
            setNodes(pinned)
            setEdges(fromFlowEdges(graph.edges, keepIds))
            setSelectedId(pinned[0]?.id ?? '')
            setRunGraph(graph)
            window.setTimeout(() => rf.fitView({ padding: 0.12, duration: 200 }), 80)
          } else {
            setRunGraph(null)
            setNodes((current) => current.map(withResult))
          }
          setRunRecord(run)
          setRunNodes(run.nodes)
          setRunMeta({ id: run.id, total: run.total })
          setRunError('')
          setRunCancelled(Boolean(run.canceled))
          // 查看模式不提供续跑入口；续跑入口只在 resume 地址里出现，避免只读页偷偷变成执行页。
          setResumeSource(!readOnly && runResumeInfo(run).resumable ? run : null)
          setResumePlan(null)
          setDrawerOpen(true)
        })
        .catch((error) => {
          if (!alive) return
          toast('这条运行打不开：' + (error instanceof Error ? error.message : String(error)))
          navigate({ kind: 'page', page: 'canvas', flowId: flowIdRef.current }, { replace: true })
        })
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [openRunId, readOnly, flowId, loadState, rf, setEdges, setNodes, toast])

  // 自动保存：只比较节点/连线/流程名的投影，选中态变化不会触发保存
  useEffect(() => {
    // 只读查看不回写任何内容：即使 React Flow 只改了选中态，也不让保存链路有机会落盘。
    if (loadState !== 'ready' || readOnly) return
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
  }, [graphSignature, loadState, readOnly, saveNow])

  // 续跑预检：等画布存完再问，免得服务端拿旧内容算出一份会过期的复用数。
  // 只读请求，不扣费、不写记录；失败就退回旧记录的估算，不让抽屉整块消失。
  useEffect(() => {
    let alive = true
    if (!resumeSource) return
    if (running || loadState !== 'ready') return
    if (saveState !== 'saved') return
    const id = flowIdRef.current
    if (!id) return
    const timer = window.setTimeout(() => {
      getRunResumePlan(id, resumeSource.id)
        .then((plan) => { if (alive) setResumePlan(plan) })
        .catch(() => { if (alive) setResumePlan(null) })
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [resumeSource, graphSignature, saveState, running, loadState])

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId])
  // 这次运行里有、当前画布上已经没有的节点：查看页只能说清「回放缺了几块」，不能假装画布还是当时的版本。
  const runViewMissing = readOnly && runRecord
    ? runRecord.nodes.filter((result) => !nodes.some((node) => node.id === result.id)).length
    : 0
  const hasRunSnapshot = Boolean(readOnly && runGraph)
  // 只读页上的快照与「进页面时的当前画布」对照：没有快照就没有这份差异，不编。
  const runGraphDiff = useMemo(
    () => (readOnly ? diffRunGraph(runGraph, previewBase) : null),
    [readOnly, runGraph, previewBase],
  )
  const runViewStatus = runRecord ? runStatusMeta(runRecord.status, Boolean(runRecord.canceled)) : null
  const runViewSpent = runRecord ? runSpentText(runRecord) : '读取中'

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
    if (readOnly) return
    const kind = event.dataTransfer.getData('application/x-flow-node') as FlowNodeKind
    if (!kind || !NODE_META[kind]) return
    const point = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY })
    addNodeAt(kind, { x: Math.round(point.x - 116), y: Math.round(point.y - 52) })
  }, [addNodeAt, readOnly, rf])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    if (readOnly) return
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
  }, [pushHistory, readOnly, setEdges, toast])

  const deleteSelected = useCallback(() => {
    if (readOnly) return
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
  }, [pushHistory, readOnly, selectNode, setNodes, setEdges, toast])

  const duplicateSelected = useCallback(() => {
    if (readOnly) return
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
  }, [pushHistory, readOnly, selectNode, setNodes, toast])

  const patchSelected = useCallback((patch: Partial<FlowNodeData>, key: string) => {
    if (readOnly) return
    const id = selectedIdRef.current
    if (!id) return
    pushHistory('node:' + id + ':' + key)
    setNodes((current) => current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)))
  }, [pushHistory, readOnly, setNodes])

  const patchConfig = useCallback((patch: FlowNodeData['config'], key: string) => {
    if (readOnly) return
    const id = selectedIdRef.current
    if (!id) return
    pushHistory('cfg:' + id + ':' + key)
    setNodes((current) => current.map((node) => (
      node.id === id ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node
    )))
  }, [pushHistory, readOnly, setNodes])

  const relayout = useCallback(() => {
    if (readOnly) return
    pushHistory()
    setNodes((current) => autoLayout(current, edgesRef.current))
    window.setTimeout(() => rf.fitView({ padding: 0.12, duration: 200 }), 60)
    toast('已按依赖层级重新布局')
  }, [pushHistory, readOnly, setNodes, rf, toast])

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

  // 运行排队这段时间的秒表与名次（v0.9.96）：只在「点了运行、还没回来」时跑。
  // 第一次立刻问，别等一个轮询周期；排到了（position 变 null）就把条子收起来——
  // 后面是节点在跑，按钮改成「运行中 Ns」，和评审页同一套说法。
  useEffect(() => {
    if (!running) return
    let alive = true
    const startedAt = Date.now()
    const tick = () => {
      if (alive) setRunElapsed(Math.round((Date.now() - startedAt) / 1000))
      const ticket = runQueueTicketRef.current
      if (!ticket) return
      getRunQueue(ticket)
        .then((next) => {
          if (!alive) return
          if (!next.position) {
            runQueuedRef.current = false
            setRunQueue(null)
            return
          }
          runQueuedRef.current = true
          setRunQueue({ position: next.position, waitedMs: next.waitedMs, waiting: next.waiting, waitMs: next.waitMs })
        })
        .catch(() => undefined)
    }
    tick()
    const poll = window.setInterval(tick, 1200)
    return () => {
      alive = false
      window.clearInterval(poll)
    }
  }, [running])

  const handleRun = useCallback(async (resumeFrom: RunRecord | null = null) => {
    if (readOnly) {
      toast('只读查看中，不能运行；退出查看后再运行')
      return
    }
    if (running) return
    if (!nodesRef.current.length) {
      toast('画布还没有节点，先从左侧拖入一个')
      return
    }
    const resume = runResumeInfo(resumeFrom)
    if (resumeFrom && (!resume.resumable || resume.left <= 0)) {
      toast('这条运行没有可复用的已跑节点，直接重新运行即可')
      return
    }
    const saved = await saveNow()
    if (!saved) {
      toast('保存失败，未发起运行：' + saveError)
      return
    }
    // 续跑失败在 run-start 之前时，把上一次的结论原样放回抽屉，别让页面空掉
    let started = false
    const previous = resumeFrom
    setRunning(true)
    setDrawerOpen(true)
    setRunNodes([])
    setRunRecord(null)
    setResumeSource(null)
    setResumePlan(null)
    setRunMeta({ id: '', total: 0 })
    setRunError('')
    // 票号是这次运行的凭据：排队期间页面按它问名次，服务端按它认出「是同一条」而不是新来一条
    runQueueTicketRef.current =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'vq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    setRunQueue(null)
    setRunQueuedMs(0)
    setRunElapsed(0)
    setRunCancelled(false)
    setStopping(false)
    runIdRef.current = ''
    runQueuedRef.current = false
    setNodes((current) => current.map((node) => ({
      ...node,
      data: { ...node.data, status: 'pending', ms: undefined, output: undefined, error: undefined },
    })))

    const controller = new AbortController()
    runAbortRef.current = controller
    try {
      const record = await runFlowStream(flowIdRef.current, (event) => {
        if (event.type === 'run-start') started = true
        if (event.type === 'run-queue') {
          // 排到了：名次收起，把「等了多久」留给运行结论（排队 N 秒后开始）
          runQueuedRef.current = false
          setRunQueue(null)
          setRunQueuedMs(event.waitedMs)
          return
        }
        if (event.type === 'run-start') {
          runIdRef.current = event.run.id
          setRunMeta({ id: event.run.id, total: event.run.total })
          // 这次运行已经真的开始了：地址里那条「旧运行」不再是用户正在看的对象；
          // 再刷新时别把旧记录放回抽屉，最新那条在运行记录页。
          replaceRoute({ kind: 'page', page: 'canvas', flowId: flowIdRef.current })
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
      }, runQueueTicketRef.current, controller.signal, resumeFrom?.id || '')
      setRunRecord(record)
      setResumeSource(runResumeInfo(record).resumable ? record : null)
      // 停止/中断时正在跑的那个节点不会再有 node-end：不能让它一直挂着「运行中」
      if (record.status === 'interrupted') {
        setNodes((current) => current.map((node) => (
          node.data.status === 'running' || node.data.status === 'pending'
            ? { ...node, data: { ...node.data, status: undefined, ms: undefined } }
            : node
        )))
      }
      if (record.status === 'success') {
        toast('运行完成 · ' + (record.durationMs / 1000).toFixed(1) + 's')
      } else if (record.status === 'interrupted') {
        const back = Number(record.credits?.refundedAmount ?? 0) || 0
        toast(record.canceled
          ? '已停止' + (back > 0 ? ' · 退回 ' + back + ' 积分' : ' · 已跑部分不退')
          : '运行被中断 · 已退回积分')
      } else {
        toast('运行结束，有节点失败 · ' + (record.durationMs / 1000).toFixed(1) + 's')
      }
    } catch (error) {
      // 自己点的「取消」：abort 不是失败。节点退回「还没跑」，不当成一条错误留在画布上。
      if ((error as { name?: string })?.name === 'AbortError') {
        const stillQueued = runQueuedRef.current
        setRunQueue(null)
        setRunError('')
        setNodes((current) => current.map((node) => (
          node.data.status === 'running' || node.data.status === 'pending'
            ? { ...node, data: { ...node.data, status: undefined, ms: undefined, output: undefined, error: undefined } }
            : node
        )))
        if (stillQueued) {
          // 名次条还在 = 这一单还没排到：钱一分没动，流程也没跑
          setRunCancelled(true)
          toast('已退出排队 · 没有扣积分')
        } else {
          setRunCancelled(false)
          toast('已停止等待这次运行 · 已开跑的按运行记录结算')
        }
        if (previous && !started) {
          setRunRecord(previous)
          setResumeSource(previous)
        }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      // 续跑被服务端拒绝（画布改过、没有可复用节点）：上一次的结论还在，放回抽屉并保留续跑入口
      if (previous && !started) {
        setRunRecord(previous)
        setResumeSource(previous)
      }
      setRunError(message)
      setNodes((current) => current.map((node) => (
        node.data.status === 'running' || node.data.status === 'pending'
          ? { ...node, data: { ...node.data, status: 'error', error: message } }
          : node
      )))
      toast('运行失败：' + message)
    } finally {
      setRunning(false)
      setStopping(false)
      setRunQueue(null)
      runQueuedRef.current = false
      runAbortRef.current = null
      runQueueTicketRef.current = ''
      runIdRef.current = ''
      // 运行结束（含失败退款）后余额会变，重新读一次，别让按钮旁的余额停在旧值
      refreshRunCredit()
    }
  }, [readOnly, refreshRunCredit, running, saveError, saveNow, setNodes, toast])

  // 只退排队：入口只在有名次条时出现（已经开跑就没有这个按钮），所以不会把一条在跑的运行当成「退队」。
  const cancelRunQueue = useCallback(() => {
    const controller = runAbortRef.current
    if (!controller) return
    controller.abort()
  }, [])

  // 停止已经开跑的运行（v0.9.101）：不再直接 abort 连接——那样服务端只能猜「人走了」。
  // 走一条明确的接口，服务端中止当前上游、按跑完的节点结算；页面继续读流，直到 run-end。
  const stopRunning = useCallback(async () => {
    const id = runIdRef.current
    if (!id || stopping) return
    setStopping(true)
    try {
      await stopRunRequest(id)
      toast('正在停止 · 跑完的节点按比例计费')
    } catch (error) {
      toast('停止失败：' + (error instanceof Error ? error.message : String(error)))
      setStopping(false)
    }
  }, [stopping, toast])

  // 接着上次停下的地方跑（v0.9.102）：服务端复用已跑完的节点，只补没跑完的，只收没付过的部分。
  const resumeRunning = useCallback(() => {
    if (!resumeSource || running) return
    void handleRun(resumeSource)
  }, [handleRun, resumeSource, running])

  // 画布改到没有可复用节点时，抽屉里给的出口不是「继续」而是「从头运行」。
  const restartRunning = useCallback(() => {
    if (running) return
    void handleRun(null)
  }, [handleRun, running])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable))
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && key === 'z' && !typing) {
        event.preventDefault()
        if (readOnly) return
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (modifier && key === 'y' && !typing) {
        event.preventDefault()
        if (readOnly) return
        redo()
        return
      }
      if (modifier && key === 's') {
        event.preventDefault()
        if (readOnly) {
          toast('只读查看中，画布没有改动')
          return
        }
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
        if (!readOnly) deleteSelected()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteSelected, readOnly, redo, saveError, saveNow, toast, undo])

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
        kicker={readOnly ? '画布 / 历史运行' : '画布 / 流程编排'}
        title={
          <span className="cv-title-row">
            <input
              className="cv-flow-name"
              value={readOnly ? (runRecord?.flowName || name) : name}
              onChange={(event) => setName(event.target.value)}
              aria-label="流程名称"
              spellCheck={false}
              disabled={loadState !== 'ready' || readOnly}
            />
            <span className={`cv-save is-${readOnly ? 'saved' : saveState}`} title={readOnly ? '只读查看：不改动当前画布' : saveError || saveLabel}>
              <span className="cv-save-dot" />{readOnly ? '只读查看' : saveLabel}
            </span>
            {flowDeleted ? <Pill tone="warn">画布已删除</Pill> : null}
          </span>
        }
        desc={readOnly
          ? missingSnapshot
            ? '这块画布已经被删除，这次运行也没有留下可回放的画布快照；逐节点结果与扣费仍留在运行记录里。'
            : flowDeleted
              ? '这块画布已经被删除；下面回放的是这次运行开始时留下的画布快照。只读查看不会写回，也不会扣积分。'
              : '回放一次运行：有画布快照时，位置与参数也是当时那一版；状态、耗时、输出都来自这条记录。只读查看不会写回，也不会扣积分。'
          : '按依赖顺序逐个节点执行 · 每次运行记录耗时、输出与失败原因，失败自动退回积分'}
        actions={
          <div className="cv-head-actions">
          {readOnly ? (
            <>
              <button
                className="vq-button vq-button--ghost"
                type="button"
                onClick={() => setDrawerOpen(true)}
                disabled={!runRecord}
                title="重新打开这次运行的逐节点结果"
              >
                <History size={14} />运行结果
              </button>
              <button
                className="vq-button vq-button--ghost"
                type="button"
                onClick={() => setCompareOpen(true)}
                disabled={!runRecord}
                title="和同一条画布上的另一条运行逐节点对照：哪里变了、慢在哪、多花多少"
              >
                <GitCompareArrows size={14} />对照上次
              </button>
              <button className="vq-button vq-button--primary" type="button" onClick={exitRunView} title="回到可编辑画布；这次查看没有改动任何内容">
                <ArrowLeft size={14} />退出查看
              </button>
            </>
          ) : (
          <>
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
          {runQueue ? (
            <span
              className="cv-run-queue"
              role="status"
              title={
                '整机此刻 ' + runQueue.waiting + ' 条在等，每条最多等 ' + Math.round(runQueue.waitMs / 1000) +
                ' 秒；排到才扣积分、才跑流程，现在关掉页面不会扣费'
              }
            >
              <Hourglass size={12} strokeWidth={1.75} />
              <span className="cv-run-queue-text">排队中 · 第 {runQueue.position} 位 · 已等 {runElapsed}s</span>
              <button type="button" className="cv-run-queue-cancel" onClick={cancelRunQueue} title="退出排队：这条流程不跑、也不扣积分">
                取消
              </button>
            </span>
          ) : null}
          {/* 关掉抽屉去改画布之后，还能从这里回到上次那条运行；否则「改完再续跑」没有入口 */}
          {resumeSource && !running ? (
            <button
              className="vq-button vq-button--ghost"
              type="button"
              onClick={() => setDrawerOpen(true)}
              title="查看上次停止 / 失败的运行；内容没改的节点可以继续复用"
            >
              <History size={14} />上次运行
            </button>
          ) : null}
          {running && !runQueue && runMeta.id ? (
            <button
              className="vq-button vq-button--danger"
              type="button"
              onClick={() => { void stopRunning() }}
              disabled={stopping}
              title="停止这次运行：当前上游会立刻中止；跑完的节点按比例计费，没跑完的部分退回"
            >
              <Square size={12} fill="currentColor" />{stopping ? '停止中…' : '停止运行 ' + runElapsed + 's'}
            </button>
          ) : (
            <button
              className="vq-button vq-button--primary"
              type="button"
              onClick={() => { void handleRun() }}
              disabled={running || loadState !== 'ready' || (runCredit != null && runCredit.balance != null && runCredit.balance < runCredit.price)}
              title={runCredit && runCredit.balance != null && runCredit.balance < runCredit.price ? '积分不足，先让管理员发放' : '按拓扑序执行整张画布'}
            >
              <Play size={14} fill="currentColor" />{running ? '排队中' : '运行流程'}
            </button>
          )}
          <button className="vq-button vq-button--icon" type="button" onClick={() => { void removeFlow() }} disabled={running || loadState !== 'ready'} aria-label="删除流程" title="删除流程">
            <Trash size={14} />
          </button>
          </>
          )}
          </div>
        }
      />
      )}

      {readOnly && loadState === 'ready' ? (
        <div className="cv-runview" role="status" aria-live="polite">
          <div className="cv-runview-line">
            <span className="cv-runview-kicker"><History size={13} strokeWidth={1.75} />历史运行 · {hasRunSnapshot ? '画布快照' : '只读'}</span>
            <Pill tone={runViewStatus?.tone || 'idle'} dot>{runViewStatus?.label || '正在读取'}</Pill>
            <span className="vq-mono">{openRunId}</span>
            <span className="vq-mono">{runRecord ? formatRunTime(runRecord.startedAt) : '—'}</span>
            <span className="vq-mono">{runViewSpent}</span>
            <span className="vq-mono">{runNodes.length} / {runRecord?.total || '—'} 节点</span>
            {runRecord?.credits && runRecord.credits.cost > 0 ? (
              <span className="vq-mono">
                {runRecord.credits.refunded
                  ? runRecord.credits.kept != null
                    ? '已退 ' + (runRecord.credits.refundedAmount ?? 0) + ' · 已跑部分 ' + runRecord.credits.kept + ' 积分'
                    : '已退回 ' + runRecord.credits.cost + ' 积分'
                  : '消耗 ' + runRecord.credits.cost + ' 积分'}
              </span>
            ) : null}
          </div>
          <p className="cv-runview-copy">
            {flowDeleted
              ? '这块画布已经被删除：位置、标题与参数取这次运行开始时的快照，画布上就是当时的版本。查看不会写回，也不扣积分。'
              : hasRunSnapshot
                ? '节点位置、标题与参数取这次运行开始时的画布快照；状态、耗时、输出取这条运行。查看不会写回画布，也不扣积分。'
                : '这条运行没有留下画布快照：位置与参数只能取当前画布；状态、耗时、输出来自这条运行。查看不会写回画布，也不扣积分。'}
          </p>
          {runGraphDiff ? <RunGraphDiffBlock diff={runGraphDiff} /> : null}
          {runViewMissing > 0 ? (
            <p className="cv-runview-warn">
              {hasRunSnapshot
                ? '这次运行的画布快照里缺少 ' + runViewMissing + ' 个节点：它们的结果仍可在右侧运行结果里查看，但不会画在画布上。'
                : '这次运行里有 ' + runViewMissing + ' 个节点不在当前画布上：它们的结果仍可在右侧运行结果里查看，但不会画在画布上。'}
            </p>
          ) : null}
        </div>
      ) : null}

      {bdc?.deployed && !bdcView && !readOnly ? (
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
            <strong>{missingSnapshot ? '这次运行没有画布可回看' : '画布加载失败'}</strong>
            <p>{loadError}</p>
            <p className="cv-muted">
              {missingSnapshot
                ? '运行记录本身还在：逐节点结果、耗时与扣费都能在运行记录里看。'
                : internal
                  ? '确认 API 服务（127.0.0.1:8787）已启动，然后重新加载页面。'
                  : '稍后重新加载页面；如果仍未恢复，请联系平台维护人员。'}
            </p>
          </div>
          <button
            className="vq-button vq-button--ghost"
            type="button"
            onClick={() => (missingSnapshot ? navigate({ kind: 'page', page: 'runs' }) : window.location.reload())}
          >
            {missingSnapshot ? '去运行记录' : '重新加载'}
          </button>
        </div>
      ) : (
        <div className="cv-workspace">
          {!readOnly && paletteOpen ? (
            <Palette onAdd={addFromPalette} onClose={() => setPaletteOpen(false)} disabled={loadState !== 'ready'} />
          ) : null}

          <section className="cv-stage" aria-label="流程画布">
            {/* 画布是从作品某一步被带进来的能力：先写清在帮哪条作品、哪一版，再给两个出口。
                空白画布不写——没有作品就别编一条出来。 */}
            {flowProject && !readOnly ? (
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
                {readOnly ? (
                  <span className="cv-toolbar-count cv-toolbar-count--readonly" title="历史运行只读查看：不提供布局、撤销与节点编辑">
                    <History size={13} strokeWidth={1.75} />历史运行 · 只读
                  </span>
                ) : (
                  <>
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
                  </>
                )}
                <span className="cv-toolbar-count" title={historyCount ? '已记录 ' + historyCount + ' 步可撤销操作' : ''}>
                  {nodes.length} 节点 · {edges.length} 连线
                </span>
              </div>
              <div className="cv-toolbar-group">
                {readOnly ? null : (
                  <>
                    <button
                      className={`cv-tool ${paletteOpen ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => setPaletteOpen((value) => !value)}
                      title="双击画布也可唤出节点面板"
                    >
                      <Plus size={14} />节点
                    </button>
                    <span className="cv-divider" />
                  </>
                )}
                <button className="cv-tool" type="button" onClick={() => rf.fitView({ padding: 0.12, duration: 200 })}>
                  <Maximize2 size={14} />适应画布
                </button>
                <span className="cv-zoom">{Math.round(zoom * 100)}%</span>
              </div>
            </div>

            <div
              className={'cv-canvas' + (readOnly ? ' is-readonly' : '')}
              ref={stageRef}
              onDrop={readOnly ? undefined : onDrop}
              onDragOver={readOnly ? undefined : onDragOver}
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={(changes) => {
                  if (!readOnly) {
                    onNodesChange(changes)
                    return
                  }
                  // 只读只接受选中态与尺寸测量；拖动、删除、新增等变更一律丢掉。
                  // dimensions 必须放行：React Flow 靠它算连线的起点 / 终点，
                  // 连尺寸一起丢掉的话，快照里的线会从画布左上角乱飞（2026-11-14 截图发现）。
                  const safe = changes.filter((change) => change.type === 'select' || change.type === 'dimensions')
                  if (safe.length) onNodesChange(safe)
                }}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                nodesDraggable={!readOnly}
                nodesConnectable={!readOnly}
                edgesFocusable={!readOnly}
                onNodeClick={(_, node) => selectNode(node.id)}
                onNodeDragStart={() => { if (!readOnly) pushHistory() }}
                onPaneClick={() => selectNode('')}
                onMoveEnd={(_, viewport) => setZoom(viewport.zoom)}
                deleteKeyCode={null}
                fitView
                fitViewOptions={{ padding: 0.12 }}
                zoomOnDoubleClick={false}
                onDoubleClick={(event) => {
                  if (readOnly) return
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
                <span className="cv-hint-dot" data-running={running} data-readonly={readOnly} />
                {readOnly
                  ? hasRunSnapshot
                    ? '只读查看：画布是这次运行开始时的快照，不会被改动'
                    : '只读查看：节点状态来自这次运行，画布不会被改动'
                  : running ? '运行中：节点会按拓扑序逐个点亮' : '拖动节点右侧圆点连线；每个输入端口只接一根线'}
              </div>
            </div>
          </section>

          <Inspector
            node={selectedNode}
            onPatch={patchSelected}
            onConfig={patchConfig}
            onDuplicate={duplicateSelected}
            onDelete={deleteSelected}
            readOnly={readOnly}
            runSnapshot={hasRunSnapshot}
          />
        </div>
      )}

      <RunDrawer
        open={drawerOpen}
        running={running}
        flowName={readOnly ? (runRecord?.flowName || name) : name}
        runId={runMeta.id}
        total={runMeta.total}
        nodes={runNodes}
        record={runRecord}
        resume={readOnly ? null : resumeSource}
        resumePlan={readOnly ? null : resumePlan}
        onResume={readOnly ? undefined : resumeRunning}
        onRestart={readOnly ? undefined : restartRunning}
        queuedMs={runQueuedMs}
        queue={runQueue}
        queueElapsed={runElapsed}
        cancelled={runCancelled}
        onCancelQueue={readOnly ? undefined : cancelRunQueue}
        error={runError}
        onClose={() => setDrawerOpen(false)}
        onSelectNode={focusNode}
      />

      {readOnly && compareOpen ? (
        <RunCompareModal runId={runRecord?.id || openRunId} onClose={() => setCompareOpen(false)} />
      ) : null}
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

