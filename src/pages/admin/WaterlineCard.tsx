import { useCallback, useEffect, useState } from 'react'
import { getWaterline, type WaterlineLevel, type WaterlineReport } from '../../api/waterline'
import { formatDateTime } from './data'
import { Badge, ErrorBanner, LoadingLine, RefreshButton, SourceTag } from './ui'

// 运行水位（v0.9.69）：一张只读卡。
// 三个刻意的决定：
//   1) 只量不猜：可用内存取 /proc/meminfo 的 MemAvailable，堆取 V8 的真实上限，不拿 RSS 倒推；
//   2) 数字全部由服务端算：前端不做第二次判断，也不在页面上现调阈值；
//   3) 阈值只读：红线是部署时定的，后台不放「偷偷调高红线」的按钮——想改就走环境变量。

const LEVEL: Record<WaterlineLevel, { label: string; tone: 'ok' | 'warn' | 'fail' }> = {
  ok: { label: '水位正常', tone: 'ok' },
  tight: { label: '偏紧 · 重活降到 1 并发', tone: 'warn' },
  critical: { label: '到红线 · 重活已暂停', tone: 'fail' },
}

const HEAVY_LABEL: Record<string, string> = {
  replicate: '一键复刻',
  review: '视觉评审',
  flow_run: '画布运行',
  canvas_gen: '画布出图',
}

// 没有账号可挂的那一类（v0.9.79）：它的上限是整机口径，不是「每账号」
const NO_USER_KINDS = new Set(['canvas_gen'])

export default function WaterlineCard() {
  const [view, setView] = useState<WaterlineReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    getWaterline()
      .then(setView)
      .catch((caught) => setError(caught instanceof Error ? caught.message : '运行水位读取失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const level = view ? LEVEL[view.level] || LEVEL.ok : { label: '读取中', tone: 'neutral' as const }
  const heap = view?.heap
  const barTone = !heap
    ? ''
    : view.thresholds.criticalHeapPercent > 0 && heap.heapPercent >= view.thresholds.criticalHeapPercent
      ? ' is-full'
      : view.thresholds.tightHeapPercent > 0 && heap.heapPercent >= view.thresholds.tightHeapPercent
        ? ' is-warn'
        : ''

  return (
    <section className="admin-card admin-block admin-block--waterline">
      <div className="admin-block-head">
        <div>
          <p className="admin-label">运行水位</p>
          <p className="admin-sub">
            这台机器还能接多少活。内存到红线时，复刻、评审、画布运行与画布出图会在扣费前被拒绝（不扣积分），其余请求照常；
            水位偏紧时重活并发降到 1——宁可慢一点，也不要两条一起把进程顶穿。
          </p>
        </div>
        <div className="admin-row-actions">
          <Badge tone={level.tone}>{level.label}</Badge>
          <SourceTag kind="api" source="GET /api/admin/waterline" />
          <RefreshButton onClick={load} busy={loading} />
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}
      {loading && !view ? <LoadingLine label="运行水位" /> : null}

      {view && heap ? (
        <>
          <dl className="admin-kv">
            <div>
              <dt>系统可用内存</dt>
              <dd>
                <span className="admin-value admin-value--inline">{view.memory.availableMb} MB</span>
                <span className="admin-cell-sub">
                  共 {view.memory.totalMb} MB · 交换已用 {view.memory.swapUsedMb} / {view.memory.swapTotalMb} MB
                  {view.memory.source === 'proc' ? '' : ' · 本机读数'}
                </span>
              </dd>
            </div>
            <div>
              <dt>进程内存</dt>
              <dd>
                <span className="admin-mono">RSS {heap.rssMb} MB</span>
                <span className="admin-cell-sub">
                  Node 堆 {heap.heapUsedMb} / {heap.heapLimitMb} MB（{heap.heapPercent}%）
                </span>
              </dd>
            </div>
            <div>
              <dt>全站重活</dt>
              <dd>
                <span className="admin-mono">
                  {view.heavy.active} 条在跑
                  {view.heavy.unlimited ? ' · 不限' : ' / 上限 ' + view.heavy.limit + ' 条'}
                </span>
                <span className="admin-cell-sub">
                  {view.heavy.unlimited
                    ? '这一层没开（VQ_GLOBAL_HEAVY=' + view.heavy.configLimit + '），只按账号限'
                    : '跨账号合计；排满后新的重活在扣费前被拒（不扣积分）'}
                </span>
              </dd>
            </div>
            <div>
              <dt>CPU 负载</dt>
              <dd>
                <span className="admin-mono">{view.cpu.load1.toFixed(2)}</span>
                <span className="admin-cell-sub">
                  {view.cpu.cores} 核 · 5 分钟 {view.cpu.load5.toFixed(2)} · 15 分钟 {view.cpu.load15.toFixed(2)}
                </span>
              </dd>
            </div>
          </dl>

          <div className="admin-waterline-bar-row">
            <span className="admin-cell-note">Node 堆</span>
            <div className={'admin-waterline-bar' + barTone} aria-hidden="true">
              <span style={{ width: Math.min(100, Math.max(0, heap.heapPercent)) + '%' }} />
            </div>
            <span className="admin-mono">{heap.heapPercent}%</span>
          </div>

          <div className="admin-waterline-capacity">
            {view.heavyKinds.map((kind) => (
              <div key={kind}>
                <span>{HEAVY_LABEL[kind] || kind}</span>
                <b>{view.capacity[kind] || 0} 条</b>
                <span className="admin-cell-note">
                  {NO_USER_KINDS.has(kind)
                    ? (view.baseCapacity[kind] || 0) === 0
                      ? '不单独限（仍占整机名额）'
                      : '整机同时最多（没有账号可限）'
                    : view.baseCapacity[kind] && view.capacity[kind] !== view.baseCapacity[kind]
                      ? '按水位从 ' + view.baseCapacity[kind] + ' 条收紧'
                      : '同时最多 ' + (view.baseCapacity[kind] || 0) + ' 条'}
                </span>
                {NO_USER_KINDS.has(kind) && view.heavy.queue ? (
                  view.heavy.queue.waitMs > 0 ? (
                    <span className="admin-cell-note">
                      排队 {view.heavy.queue.waiting} / {view.heavy.queue.maxWaiting} 条 · 满了先等 {Math.round(view.heavy.queue.waitMs / 1000)} 秒
                    </span>
                  ) : (
                    <span className="admin-cell-note">没开排队 · 名额满时立刻拒</span>
                  )
                ) : null}
              </div>
            ))}
          </div>

          {view.heavy.queue ? (
            view.heavy.queue.waitMs > 0 ? (
              <p className="admin-hint">
                画布出图排队位：这条通道没有账号可挂，一次批量出图会连发好几张。名额满时先排着——
                每条最多等 {Math.round(view.heavy.queue.waitMs / 1000)} 秒，最多 {view.heavy.queue.maxWaiting} 条同时排；
                排到了照常出图（响应头 X-VQ-Queue-Ms 带回等了多久），排不到才拒，拒绝发生在调上游之前，不花钱。
                本次启动以来：排到 {view.heavy.queue.served} 条 · 等超时 {view.heavy.queue.timedOut} 条 · 排满拒 {view.heavy.queue.full} 条 ·
                客户端提前断开 {view.heavy.queue.abandoned} 条 · 最长等了 {Math.round(view.heavy.queue.maxWaitMs / 1000)} 秒。
              </p>
            ) : (
              <p className="admin-hint">
                画布出图没开排队（VQ_CANVAS_QUEUE_MS=0）：名额满时后面的几张立刻被拒，一次批量出图会「先到的 2 张成功、其余失败」。
              </p>
            )
          ) : null}

          {view.reasons.length ? <p className="admin-hint admin-hint--fail">{view.reasons.join('；')}</p> : null}
          {view.heavy.full ? (
            <p className="admin-hint admin-hint--fail">
              全站重活已经排满（{view.heavy.active} / {view.heavy.limit} 条）：现在的新重活会在扣费前被拒，这一单不扣积分。
            </p>
          ) : null}

          <p className="admin-hint">
            {view.guard
              ? '判定口径：系统可用内存低于 ' +
                view.thresholds.criticalAvailableMb +
                ' MB 或进程堆到 ' +
                view.thresholds.criticalHeapPercent +
                '% 时，重活在扣费前返回 503，' +
                view.retryAfterSec +
                ' 秒后再试；低于 ' +
                view.thresholds.tightAvailableMb +
                ' MB 或 ' +
                view.thresholds.tightHeapPercent +
                '% 时并发降到 1。' +
                (view.heavy.unlimited ? '' : '全站重活上限 ' + view.heavy.limit + ' 条，排满时同样在扣费前拒。') +
                '阈值与上限都由部署时的环境变量决定，这里只读。'
              : '当前部署关掉了守卫（VQ_WATER_GUARD=0）：这里只量、不拦，重活按配置的并发原样放行。'}
            {' 检查时间 '}
            {formatDateTime(view.checkedAt)}。
          </p>
        </>
      ) : null}
    </section>
  )
}
