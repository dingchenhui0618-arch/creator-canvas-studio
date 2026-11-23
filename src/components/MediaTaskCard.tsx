// r288：对话框里直接生成出来的那条任务（图片 / 视频）。
//
// 会话里只存任务号与规格：进度与结果按任务号轮询 /api/media/tasks/:id（只读元数据、不打上游、
// 不扣积分），所以关掉页面回来、换设备打开，这张卡片照样能接着看到结果，而不是一直写着「生成中」。
import { useEffect, useState } from 'react'
import { AlertCircle, Download, Loader2 } from 'lucide-react'
import { getMediaTask } from '../api/media-gen'
import type { MediaTask } from '../api/media-gen'
import type { ChatMediaInfo } from '../api/chat'

const POLL_MS = 2500

function bytesLabel(bytes: number) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function clockOf(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

export default function MediaTaskCard({ media }: { media: ChatMediaInfo }) {
  const [task, setTask] = useState<MediaTask | null>(null)
  const [gone, setGone] = useState('')
  const [waited, setWaited] = useState(0)
  const status = task?.status ?? media.status

  // 还在跑才轮询：成功 / 失败之后一次都不再打服务端
  useEffect(() => {
    if (status !== 'processing') return
    // 「已等多久」从这一次打开卡片算起：不在渲染里读时钟（那样每次重渲染的数字都不稳）
    const base = Date.now()
    let cancelled = false
    let timer = 0
    const tick = async () => {
      try {
        const result = await getMediaTask(media.id)
        if (cancelled) return
        setTask(result.task)
        setWaited(Date.now() - base)
        if (result.task.status === 'processing') timer = window.setTimeout(() => void tick(), POLL_MS)
      } catch (caught) {
        if (cancelled) return
        const code = (caught as { status?: number }).status
        // 记录被删了 / 不是这个账号的：停在这里，别一直打服务端
        if (code === 404 || code === 403) {
          setGone(code === 404 ? '这条生成记录已经不在了（可能被删掉了）' : '这条生成记录不属于当前账号')
          return
        }
        timer = window.setTimeout(() => void tick(), POLL_MS * 2)
      }
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [media.id, status])

  const current = task
  const state = current?.status ?? media.status
  const download = current?.downloadUrl || media.downloadUrl
  const size = current?.file?.bytes ?? 0
  // 退款状态以「刚查到的任务」为准：会话里存的是建任务那一刻的值，
  // 后面的失败退款只在任务元数据上，不跟着改聊天记录（不跟着查就会自相矛盾：
  // 上面写着「积分已全额退回」，下面还在叫人带着任务号去找管理员）。
  const refunded = current ? current.credits.refunded : media.credits.refunded
  // 带图生成要写在规格里：不然用户看不出「这张是照我传的图画的」，还会以为是纯文字那条路
  const refs = media.assets?.length ?? 0
  const spec = (
    media.kind === 'image'
      ? [media.modelLabel || media.model, media.ratio, media.size]
      : [media.modelLabel || media.model, media.ratio, media.duration ? media.duration + ' 秒' : '', media.resolution]
  )
    .concat(refs ? ['参考 ' + refs + ' 张'] : [])
    .filter(Boolean)
    .join(' · ')

  return (
    <div className={'qc-media' + (state === 'failed' ? ' is-failed' : '') + (state === 'succeeded' ? ' is-done' : '')}>
      <div className="qc-media-head">
        <span className="qc-media-kind">{media.kind === 'image' ? '图片' : '视频'}</span>
        {/* 积分跟规格写在同一行：分成两个 flex 项时，窄屏会被自动外边距挤到第三行 */}
        <span className="qc-media-spec">{spec} · {media.credits.cost} 积分</span>
      </div>

      {gone ? <p className="qc-media-note">{gone}</p> : null}

      {!gone && state === 'processing' ? (
        <div className="qc-media-run" role="status">
          <Loader2 size={14} className="qc-spin" />
          <span>
            {media.kind === 'image' ? '出图生成中' : '视频生成中'}
            {waited > 0 ? ' · 已等 ' + clockOf(waited) : ''}
          </span>
          <span className="qc-media-run-note">关掉这一页也会跑完</span>
        </div>
      ) : null}

      {!gone && state === 'succeeded' ? (
        <>
          {media.kind === 'image' ? (
            <a className="qc-media-thumb" href={download} target="_blank" rel="noreferrer" title="点开看原图">
              <img src={download} alt={media.prompt} loading="lazy" />
            </a>
          ) : (
            <video className="qc-media-video" src={download} controls playsInline preload="metadata" />
          )}
          <div className="qc-media-foot">
            <span className="qc-media-note">{size ? bytesLabel(size) : ''}</span>
            <a className="qc-media-dl" href={download} download>
              <Download size={12} />
              下载{media.kind === 'image' ? '图片' : '视频'}
            </a>
          </div>
        </>
      ) : null}

      {!gone && state === 'failed' ? (
        <div className="qc-media-error">
          <AlertCircle size={14} />
          <div>
            <p>{current?.error || media.error || '上游没有返回结果'}</p>
            <span className="qc-media-note">
              {refunded ? '这 ' + media.credits.cost + ' 积分已全额退回' : '积分退款还没确认，带着任务号 ' + media.id + ' 找管理员'}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
