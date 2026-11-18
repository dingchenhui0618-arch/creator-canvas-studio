import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleAlert, Expand, Hourglass, Maximize2, Minimize2, Plus, Save } from 'lucide-react'
import {
  createBdcCanvas,
  getBdcStatus,
  listBdcCanvases,
  claimBdcCanvas,
  writeBdcNote,
  type BdcCanvas,
  type BdcStatus,
} from '../api/bdc'
import { getCanvasSessionTicket } from '../api/canvasSession'
import { getCanvasQueue, type CanvasQueueView } from '../api/canvasQueue'
import { useUiMode } from '../api/app'
import { navigate, replaceRoute } from '../router'
import { Select } from '../components/Select'
import '../styles/board.css'

// 无限画布（v0.9.163，用户 2026-11-16 明确要求）：
//
// 这一页只放外部那张自由画布（canvas.wavisionai.cn）。它和工作流是两件东西：
//   · 工作流 #/canvas   前后有依赖的节点排成一条线，跑一次是一条运行记录；
//   · 无限画布 #/board  素材随便摆，出图出视频在画布上就地发生，没有「跑一次」这个动作。
// 以前两者共用「画布」一个入口、靠一个「回到内置编排」按钮互切，谁是什么说不清；
// 现在名字、地址、页面三样都分开，这里不再提「内置编排」。
//
// 画布本体是第三方应用（自带顶栏与工具条），我们这层只保留一条 42px 的状态条：
// 在哪块画布 / 通没通 / 排队位 / 换画布 / 新建 / 写笔记 / 专注 / 新窗口。
// 嵌入靠一次性信任票据换会话，用户不用在画布里再登一次。

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return ''
  }
}

type BoardPageProps = {
  onToast?: (message: string) => void
  /** 地址里点名的画布：#/board/<画布ID>；不填就沿用上次打开的那块 */
  boardId?: string
  /** 专注模式：收起侧栏与顶栏，只留画布自己的工具条 */
  focus?: boolean
  onToggleFocus?: () => void
}

export default function BoardPage({ onToast, boardId, focus, onToggleFocus }: BoardPageProps) {
  const { internal } = useUiMode()
  const toast = useCallback((message: string) => onToast?.(message), [onToast])

  const [bdc, setBdc] = useState<BdcStatus | null>(null)
  const [checked, setChecked] = useState(false)
  const [canvases, setCanvases] = useState<BdcCanvas[]>([])
  const [missing, setMissing] = useState(false)
  const [canvasId, setCanvasId] = useState(() => {
    if (boardId) return boardId
    try { return window.localStorage.getItem('vq:bdcCanvas') || '' } catch { return '' }
  })
  const [frameKey, setFrameKey] = useState(0)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  // 排队位（v0.9.83）：出图发生在画布里，等的时候这边只有一片安静——
  // 轮询只读接口，把「几张在跑、几张排队、最久等了多久」挂到状态条上；空闲时不显示。
  const [queueView, setQueueView] = useState<CanvasQueueView | null>(null)
  const [queueIdleAt, setQueueIdleAt] = useState(0)
  const queueWasBusy = useRef(false)
  const queueIdleTimer = useRef<number | undefined>(undefined)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const localOnly =
    Boolean(bdc?.web.url) &&
    LOOPBACK_HOSTS.has(hostOf(bdc?.web.url || '')) &&
    !LOOPBACK_HOSTS.has(typeof window === 'undefined' ? '' : window.location.hostname.toLowerCase())

  const loadStatus = useCallback(() => {
    setChecked(false)
    void getBdcStatus()
      .then((status) => setBdc(status))
      .catch(() => setBdc(null))
      .finally(() => setChecked(true))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(loadStatus, 0)
    return () => window.clearTimeout(timer)
  }, [loadStatus])

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
        // 链接里的画布可能已被删掉：直说，不悄悄换成列表第一块
        setMissing(Boolean(boardId) && !list.some((item) => item.id === boardId))
        setCanvasId((current) => {
          const wanted = boardId || current
          if (wanted && list.some((item) => item.id === wanted)) return wanted
          return list[0]?.id || ''
        })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [bdc?.deployed, boardId])

  // 选中的画布同时记住三处：本地、地址栏、iframe
  useEffect(() => {
    try {
      if (canvasId) window.localStorage.setItem('vq:bdcCanvas', canvasId)
      else window.localStorage.removeItem('vq:bdcCanvas')
    } catch {
      /* 隐私模式忽略 */
    }
  }, [canvasId])

  useEffect(() => {
    if (!canvasId || canvasId === boardId) return
    // 换了一块画布：地址栏跟着走，刷新与收藏都落在同一块上
    replaceRoute({ kind: 'page', page: 'board', boardId: canvasId })
  }, [boardId, canvasId])

  // 第一次打开一块画布就认领它（r214）：作品流按这个归属决定「画布里的图能不能给你看」。
  // 认领失败不打扰用户：画布照旧能打开，只是这条不会出现在自己的作品流里。
  useEffect(() => {
    if (!canvasId) return
    void claimBdcCanvas(canvasId).catch(() => undefined)
  }, [canvasId])

  // iframe 地址：一次性入口（种 cookie）+ 画布 id（画布自己用 ?loadCanvas= 认）
  // 票据只发给画布自己的源：postMessage 的 targetOrigin 用真实 origin，绝不用 '*'
  const origin = useMemo(() => {
    try {
      return new URL(bdc?.web.embedUrl || bdc?.web.url || '').origin
    } catch {
      return ''
    }
  }, [bdc?.web.embedUrl, bdc?.web.url])

  useEffect(() => {
    if (!origin) return
    let cancelled = false
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return
      const data = event.data as { type?: string } | null
      if (!data || data.type !== 'vq-canvas:ready') return
      getCanvasSessionTicket()
        .then((ticket) => {
          if (cancelled) return
          frameRef.current?.contentWindow?.postMessage(
            { type: 'vq-canvas:ticket', token: ticket.token, issuer: ticket.issuer, audience: ticket.audience, expiresAt: ticket.expiresAt },
            origin,
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
  }, [origin])

  const frameSrc = useMemo(() => {
    const base = bdc?.web.embedUrl || bdc?.web.url || ''
    if (!base) return base
    const params = new URLSearchParams()
    if (canvasId) params.set('loadCanvas', canvasId)
    // 积分口径由服务端配置下发（v0.9.162）：画布按它把报价换算成积分，不再自己写死倍数。
    // 只改 VQ_POINTS_PER_CNY，这一条跟着变，画布与充值页一起对齐。
    const rate = bdc?.credit?.pointsPerCny
    if (rate && rate > 0) params.set('vqCredit', String(rate))
    const query = params.toString()
    return query ? base + (base.includes('?') ? '&' : '?') + query : base
  }, [bdc?.web.embedUrl, bdc?.web.url, canvasId, bdc?.credit?.pointsPerCny])

  // 排队位：页面可见时每 3 秒问一次，切到后台就停。刚忙完那一阵留在屏幕上几秒——
  // 「出完了」也是个结论，不该一瞬间消失。
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
          setQueueIdleAt(1)
          if (queueIdleTimer.current) window.clearTimeout(queueIdleTimer.current)
          queueIdleTimer.current = window.setTimeout(() => setQueueIdleAt(0), 8000)
        }
        queueWasBusy.current = busy
      } catch {
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

  const createCanvas = useCallback(async () => {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[^0-9]/g, '').slice(4, 12)
    try {
      const res = await createBdcCanvas(`新画布-${stamp}`)
      if (res?.canvas) {
        setCanvases((list) => [res.canvas, ...list])
        setCanvasId(res.canvas.id)
        toast('已新建画布：' + res.canvas.name)
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '新建画布失败')
    }
  }, [toast])

  const writeNote = useCallback(async () => {
    const text = noteText.trim()
    if (!text) return
    if (!canvasId) {
      toast('先选一块画布，再写笔记')
      return
    }
    setNoteBusy(true)
    try {
      await writeBdcNote(canvasId, text, 'VisionQA 评审笔记')
      setNoteText('')
      setNoteOpen(false)
      await reloadCanvases()
      setFrameKey((key) => key + 1)
      toast('已写进画布，画布正在重载')
    } catch (error) {
      toast(error instanceof Error ? error.message : '写入画布失败')
    } finally {
      setNoteBusy(false)
    }
  }, [canvasId, noteText, reloadCanvases, toast])

  const current = canvases.find((item) => item.id === canvasId)

  // 连接中：先给一条细状态条，不白屏、不假装已打开
  if (!checked) {
    return (
      <div className="page bd-page">
        <div className="bd-strip">
          <span className="bd-label">无限画布</span>
          <span className="bd-state">正在连接…</span>
        </div>
      </div>
    )
  }

  if (missing) {
    return (
      <div className="page bd-page">
        <div className="bd-centre">
          <strong>这块无限画布不在了</strong>
          <p>它可能已被删除，或链接里的编号不属于当前账号。回工作台看看现在还有哪些画布。</p>
          <div className="bd-centre-actions">
            <button type="button" className="vq-button vq-button--ghost" onClick={() => navigate({ kind: 'page', page: 'overview' })}>
              返回工作台
            </button>
            <button type="button" className="vq-button vq-button--primary" onClick={() => navigate({ kind: 'page', page: 'board' })}>
              打开无限画布
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!bdc || !bdc.deployed) {
    return (
      <div className="page bd-page">
        <div className="bd-centre">
          <CircleAlert size={18} strokeWidth={1.5} />
          <strong>无限画布还没连上</strong>
          <p>无限画布是独立的一张自由画布：素材随便摆，出图出视频都在画布上发生。它跑在自己的服务里，连不上时工作流与作品不受影响。</p>
          <div className="bd-centre-actions">
            <button type="button" className="vq-button vq-button--ghost" onClick={() => navigate({ kind: 'page', page: 'overview' })}>
              返回工作台
            </button>
            <button type="button" className="vq-button vq-button--primary" onClick={loadStatus}>
              重新连接
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 本机地址不能嵌给外部访客：访客浏览器会把 127.0.0.1 解析成他自己的电脑，只会看到白屏
  if (localOnly) {
    return (
      <div className="page bd-page">
        <div className="bd-centre">
          <CircleAlert size={18} strokeWidth={1.5} />
          <strong>无限画布还没对外发布</strong>
          <p>它现在只监听本机（{bdc.web.url}），从别的电脑打开会连到访客自己的机器。</p>
          <p className="bd-muted">{internal ? '把它部署到独立子域，这里就会直接显示画布。' : '发布到独立域名后，这里就会直接显示画布。'}</p>
          <div className="bd-centre-actions">
            <a className="vq-button vq-button--ghost" href={bdc.web.url} target="_blank" rel="noreferrer">新窗口打开</a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page bd-page">
      {/* 窄屏（≤1080）会把「无限画布」字样让给面包屑，所以状态条自带一个无障碍名 */}
      <div className="bd-strip" role="group" aria-label="无限画布状态条">
        <span className="bd-label">无限画布</span>
        <span className="bd-state" title={bdc.web.url}>
          <span className="bd-dot" />
          {localOnly ? '本机已连接' : '已连接'}
        </span>
        <CanvasQueueChip view={queueView} idleAt={queueIdleAt} />
        <span className="bd-sep" aria-hidden="true" />
        <div className="bd-picker">
          <span className="bd-picker-label">画布</span>
          <Select
            size="sm"
            className="bd-select"
            label="选择画布"
            value={canvasId}
            options={[
              { value: '', label: canvases.length ? '未指定（默认画布）' : '暂无已保存的画布' },
              ...canvases.map((item) => ({ value: item.id, label: item.name + ' · ' + item.nodeCount + ' 节点' })),
            ]}
            onChange={(value) => setCanvasId(value)}
          />
        </div>
        <button className="bd-action" type="button" onClick={() => { void createCanvas() }} title="新建一块画布并绑定到工作台">
          <Plus size={12} /><span className="bd-action-text">新建</span>
        </button>
        <button
          className="bd-action"
          type="button"
          onClick={() => setNoteOpen((open) => !open)}
          aria-expanded={noteOpen}
          title="把评审结论作为文本节点写进画布"
        >
          <Save size={12} /><span className="bd-action-text">写笔记</span>
        </button>
        {noteOpen ? (
          <div className="bd-note" role="dialog" aria-label="写进画布">
            <div className="bd-note-title">写进画布 · {current?.name || '未指定画布'}</div>
            <textarea
              className="bd-note-input"
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              placeholder="评审结论、待确认项、返工点…"
              rows={4}
              spellCheck={false}
            />
            <div className="bd-note-foot">
              <span className="bd-note-hint">会以文本节点落在画布左上角</span>
              <button className="bd-action" type="button" onClick={() => setNoteOpen(false)}>取消</button>
              <button
                className="bd-action is-primary"
                type="button"
                onClick={() => { void writeNote() }}
                disabled={noteBusy || !noteText.trim() || !canvasId}
              >
                {noteBusy ? '写入中…' : '写入画布'}
              </button>
            </div>
          </div>
        ) : null}
        <span className="bd-spacer" />
        <span className="bd-url">{bdc.web.url.replace(/^https?:\/\//, '').split('/')[0]}</span>
        {onToggleFocus ? (
          <button
            className={'bd-action' + (focus ? ' is-primary' : '')}
            type="button"
            onClick={onToggleFocus}
            title={focus ? '退出专注模式，回到自己的工作台' : '专注模式：收起左侧栏与顶栏，只留画布'}
            aria-pressed={Boolean(focus)}
          >
            {focus ? <Minimize2 size={12} /> : <Expand size={12} />}
            <span className="bd-action-text">{focus ? '退出专注' : '专注'}</span>
          </button>
        ) : null}
        <a
          className="vq-button vq-button--icon"
          href={frameSrc}
          target="_blank"
          rel="noreferrer"
          title="在新窗口打开这块无限画布"
          aria-label="在新窗口打开"
        >
          <Maximize2 size={14} />
        </a>
      </div>

      <iframe key={frameKey} ref={frameRef} className="bd-frame" src={frameSrc} title="无限画布" />
    </div>
  )
}

// 排队位小胶囊（v0.9.83）：出图发生在 iframe 里，等的时候这边只有一片安静——
// 它回答「几张在跑 / 几张在排队 / 最久的等了多久」，忙完 8 秒后显示一次「刚刚那批出完了」再消失。
// 数字全由服务端现算；空闲时整个不渲染，不在顶栏上挂一个常驻的 0。
function CanvasQueueChip({ view, idleAt }: { view: CanvasQueueView | null; idleAt: number }) {
  if (!view) return null
  const busy = view.active > 0 || view.waiting > 0
  const justDone = !busy && idleAt > 0
  if (!busy && !justDone) return null
  if (!busy) {
    return (
      <span className="bd-queue is-done" title="这一批出图都已经结束：名额都还回去了">
        <Check size={12} strokeWidth={2} />刚刚那批出完了
      </span>
    )
  }
  const seconds = (ms: number) => (ms >= 10000 ? String(Math.round(ms / 1000)) : String(Math.round(ms / 100) / 10))
  const hint = view.waitMs > 0
    ? '每条最多等 ' + seconds(view.waitMs) + ' 秒、最多 ' + view.maxWaiting + ' 条同时排（' + (view.queueScope === 'process' ? '按进程算' : '整机') + '）'
    : '名额满时直接拒，这类没有排队'
  return (
    <span
      className={'bd-queue' + (view.waiting > 0 ? ' is-waiting' : '') + (view.full ? ' is-full' : '')}
      title={'出图的排队位：' + hint + '。在跑 ' + view.active + ' / 上限 ' + (view.limit || '不限') + '，排队 ' + view.waiting + '。'}
    >
      {view.waiting > 0 ? <Hourglass size={12} strokeWidth={2} /> : <span className="bd-queue-dot" />}
      在跑 {view.active}
      {view.waiting > 0 ? ' · 排队 ' + view.waiting : ''}
      {/* 手机上先只留人数：括号里那句换成 title，压住状态条会把这行字截断（r243） */}
      {view.waiting > 0 ? <span className="bd-queue-oldest">（最久 {seconds(view.oldestWaitMs)}s）</span> : null}
      {view.full ? ' · 排队位已满' : ''}
    </span>
  )
}
