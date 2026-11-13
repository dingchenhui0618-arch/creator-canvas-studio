import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Check, ExternalLink, Film, Loader2, Sparkles, X } from 'lucide-react'
import { getJob, getTemplate, formatDuration, startReplicate } from '../api/radar'
import { getCredits, type CreditsResponse } from '../api/credits'
import { useUiMode } from '../api/app'
import type { MediaItem, ReplicaTemplate, ReplicateJob } from '../domain/radar'

const STEPS = [
  { key: 'resolve', label: '获取视频与抽帧', hint: '远端算力服务，或本地 FFmpeg' },
  { key: 'probe', label: '读取视频信息', hint: '时长 / 分辨率 / 切镜点' },
  { key: 'frames', label: '抽帧', hint: '按时间轴均匀 + 切镜补帧' },
  { key: 'vision', label: '逐帧分析脚本与分镜', hint: '视觉模型输出结构化 JSON' },
  { key: 'save', label: '写入模板库', hint: '脚本结构 + 分镜 + 原链接' },
]

// 远端算力一次覆盖了「解析 / 探测 / 抽帧」三步，落到第一条；done 视为全部完成
const stepIndex = (step: string) => {
  if (step === 'remote') return 0
  if (step === 'scene') return 1
  if (step === 'done') return 5
  return STEPS.findIndex((item) => item.key === step)
}

export function ReplicateModal({ item, hasKey, visionReady, onClose, onDone, onOpenTemplates, mode = 'replicate' }: {
  item: MediaItem
  hasKey: boolean
  visionReady: boolean
  onClose: () => void
  // templateId：解析完成时这条模板可能已经在原地换了 id（saved → replica），
  // 调用方要能直接打开它，而不是猜一条新的
  onDone: (title: string, templateId?: string) => void
  onOpenTemplates: () => void
  // 同一套流程两个入口名（v0.9.40）：从只存了链接的模板进来叫「解析」，从检索卡片叫「一键复刻」。
  // 已经点开「去解析这条」的人，弹窗标题不该再叫「一键复刻」。
  mode?: 'replicate' | 'parse'
}) {
  const parseMode = mode === 'parse'
  const { internal } = useUiMode()
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [job, setJob] = useState<ReplicateJob | null>(null)
  const [template, setTemplate] = useState<ReplicaTemplate | null>(null)
  const [error, setError] = useState('')
  const [credits, setCredits] = useState<CreditsResponse | null>(null)
  const [spent, setSpent] = useState<{ cost: number; balance: number | null } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  // 复刻按次扣积分：开始前把单价和余额说清楚，而不是等 402 才报错
  useEffect(() => {
    getCredits(1).then(setCredits).catch(() => setCredits(null))
    return () => { window.clearInterval(timer.current) }
  }, [])

  const price = credits?.prices.replicate ?? null
  const balance = credits?.balance ?? null
  const insufficient = balance !== null && price !== null && balance < price

  const poll = (jobId: string) => {
    window.clearInterval(timer.current)
    timer.current = window.setInterval(async () => {
      try {
        const next = await getJob(jobId)
        setJob(next)
        if (next.status === 'done') {
          window.clearInterval(timer.current)
          setPhase('done')
          if (next.templateId) {
            const detail = await getTemplate(next.templateId).catch(() => null)
            if (detail) setTemplate(detail)
          }
        }
        if (next.status === 'error') {
          window.clearInterval(timer.current)
          setPhase('error')
          setError(next.error || '复刻失败')
        }
      } catch (caught) {
        window.clearInterval(timer.current)
        setPhase('error')
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }, 900)
  }

  const begin = async () => {
    setPhase('running')
    setError('')
    setJob(null)
    setTemplate(null)
    try {
      const result = await startReplicate(item, url.trim())
      setSpent(result.credits ?? null)
      getCredits(1).then(setCredits).catch(() => undefined)
      poll(result.jobId)
    } catch (caught) {
      setPhase('error')
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const canRun = Boolean(url.trim() || item.url)
  const currentIndex = job ? stepIndex(job.step) : -1

  return (
    <div className="modal-backdrop" onMouseDown={phase === 'running' ? undefined : onClose}>
      <div className="replicate-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="replicate-head">
          <div>
            <span className="section-kicker">{parseMode ? '解析这条原片' : '一键复刻'}</span>
            <strong>{item.title || '（无标题）'}</strong>
            <span className="replicate-sub">{item.platformLabel}{item.author ? ' · ' + item.author : ''}</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        {phase === 'idle' && (
          <div className="replicate-body">
            <div className="replicate-field">
              <label>视频来源</label>
              <div className="replicate-source">
                <span className={`source-chip ${item.url ? 'is-ready' : 'is-off'}`}><Film size={13} />{item.url ? item.platformLabel + ' 原链接' : '示例数据无真实链接'}</span>
                <span className="replicate-hint">优先用原链接解析；解析失败时用下面的直链</span>
              </div>
            </div>
            <div className="replicate-field">
              <label htmlFor="direct-url">视频直链（可选，mp4 地址可直接跑通全流程）</label>
              <input
                id="direct-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://... .mp4"
              />
            </div>
            <div className="replicate-checks">
              <span className={hasKey ? 'is-ok' : 'is-warn'}>{hasKey ? '解析服务已配置；解析失败时用直链兜底' : '解析服务未接入：只能用直链视频'}</span>
              <span className={visionReady ? 'is-ok' : 'is-warn'}>{visionReady ? '视觉模型就绪，逐帧分析可运行' : internal ? '视觉模型未就绪，需要在服务端配置凭证' : '视觉能力暂未就绪，请联系管理员'}</span>
              {price !== null ? (
                <span className={insufficient ? 'is-warn' : 'is-ok'}>
                  本次消耗 {price} 积分 · 当前余额 {balance ?? '—'}
                  {insufficient ? '（还差 ' + (price - (balance ?? 0)) + '，先让管理员发放）' : ''}
                </span>
              ) : null}
            </div>
            <div className="replicate-foot">
              <button className="button button--ghost" onClick={onClose}>取消</button>
              <button className="button button--primary" disabled={!canRun || insufficient} onClick={() => void begin()}>
                <Sparkles size={15} />{parseMode ? '开始解析' : '开始复刻'}
              </button>
            </div>
          </div>
        )}

        {phase === 'running' && (
          <div className="replicate-body">
            <div className="replicate-progress">
              <div className="replicate-progress-bar"><span style={{ width: (job?.progress ?? 4) + '%' }} /></div>
              <span>{job?.progress ?? 4}%</span>
            </div>
            <ol className="replicate-steps">
              {STEPS.map((step, index) => {
                const state = currentIndex > index ? 'done' : currentIndex === index ? 'active' : 'pending'
                return (
                  <li key={step.key} className={'replicate-step is-' + state}>
                    <span className="replicate-step-icon">
                      {state === 'done' ? <Check size={12} /> : state === 'active' ? <Loader2 size={12} className="spin" /> : null}
                    </span>
                    <div><strong>{step.label}</strong><span>{step.hint}</span></div>
                  </li>
                )
              })}
            </ol>
            <div className="replicate-logs">
              {(job?.logs ?? []).slice(-6).map((log, index) => (
                <div className="replicate-log" key={log.at + index}><span>{log.at.slice(11, 19)}</span>{log.text}</div>
              ))}
            </div>
            <p className="replicate-note">抽帧与逐帧分析需要 30–120 秒，关闭弹窗会中止等待（后台任务仍会继续）。</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="replicate-body">
            <div className="replicate-done">
              <span className="replicate-done-icon"><Check size={16} /></span>
              <div>
                <strong>{template?.title || (parseMode ? '解析完成' : '已存入模板库')}</strong>
                <span>{template ? template.contentType + ' · ' + template.structure.length + ' 个段落 · ' + template.storyboard.length + ' 个分镜 · ' + formatDuration(template.durationSec) : '正在刷新模板库'}</span>
                {spent ? <span className="replicate-credit">本次消耗 {spent.cost} 积分 · 余额 {spent.balance ?? '—'}</span> : null}
              </div>
            </div>
            {template && (
              <div className="replicate-preview">
                {template.frames.slice(0, 5).map((frame) => <img key={frame.index} src={frame.url} alt="" />)}
              </div>
            )}
            {template && (
              <div className="replicate-hook">
                <span className="section-kicker">开头钩子</span>
                <p>{template.hook}</p>
                <div className="replicate-tags">{template.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>
              </div>
            )}
            <div className="replicate-foot">
              <button className="button button--ghost" onClick={() => { onDone(template?.title || (parseMode ? '解析完成' : '复刻完成'), template?.id || job?.templateId || '') }}>完成</button>
              <button className="button button--primary" onClick={onOpenTemplates}>查看模板库<ArrowRight size={15} /></button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="replicate-body">
            <div className="replicate-error"><AlertCircle size={15} /><span>{error}</span></div>
            {/积分不足/.test(error) ? (
              <p className="replicate-note">积分可以在「设置 → 积分」查看；充值通道还没开通，需要管理员在后台发放。</p>
            ) : null}
            {!hasKey && (
              <p className="replicate-note">解析服务还没接入：平台链接无法解析。可以先粘贴一条 mp4 直链验证拆帧与模板流程，或先让管理员接入解析服务。</p>
            )}
            <div className="replicate-foot">
              <button className="button button--ghost" onClick={onClose}>关闭</button>
              <button className="button button--primary" onClick={() => setPhase('idle')}>重试</button>
            </div>
          </div>
        )}

        {item.url && (
          <footer className="replicate-foot-note">
            <ExternalLink size={12} />
            <a href={item.url} target="_blank" rel="noreferrer">打开原视频</a>
          </footer>
        )}
      </div>
    </div>
  )
}
