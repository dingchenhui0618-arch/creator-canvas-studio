import type { RunProjectRef } from '../api/flows'

/** 一条运行在页面上怎么称呼：颜色档与文案全站一处，别一处写「排队中」一处写「PENDING」。 */
export type RunStatusTone = 'pass' | 'fail' | 'warn' | 'live' | 'queued'
export type RunStatusMeta = { label: string; tone: RunStatusTone; note: string }

/**
 * 运行记录的四种落库终态之外，还有两种「此刻的样子」：
 *   queued（v0.9.98）＝ 还在整机队里等名额，没开始跑、没扣积分；
 *   running = 正在跑，节点会一个个补上。
 * 以前页面把所有非成功都写成「失败」——排队中和在跑都顶着红点，读起来像已经失败并退了钱。
 */
export function runStatusMeta(status: unknown): RunStatusMeta {
  const key = String(status || '')
  if (key === 'success') return { label: '成功', tone: 'pass', note: '' }
  if (key === 'interrupted') return { label: '已中断', tone: 'warn', note: '这次运行被中断，积分按账本退回。' }
  if (key === 'running') return { label: '运行中', tone: 'live', note: '这次运行还在跑：节点会一个个补上，跑完自动结算。' }
  if (key === 'queued') return { label: '排队中', tone: 'queued', note: '正在排队：还没轮到这个名额，排到才开始跑、才扣积分。' }
  if (key === 'error' || key === 'failed' || !key) return { label: '失败', tone: 'fail', note: '这次运行失败了，积分原路退回。' }
  return { label: key, tone: 'warn', note: '' }
}

/** 排队 / 在跑的记录没有「耗时」可言：按开始时刻算个活的秒数，别拿 0.0s 冒充跑完了。 */
export function runLiveText(run: { status: string; queuedAt?: string | null; startedAt?: string | null }): string {
  const from = Date.parse(String((run.status === 'queued' ? run.queuedAt : run.startedAt) || run.startedAt || ''))
  if (!Number.isFinite(from)) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000))
  return (run.status === 'queued' ? '排队 ' : '已跑 ') + seconds + 's'
}

/**
 * 运行记录里「这条运行属于哪条作品的哪一版」的写法，全站一处。
 * 运行记录页的第二行、详情页头、工作台的最近运行都读它——分开写迟早一处写「v2」、
 * 一处写「第2版」，归档版还会有一处忘了标「已归档」。
 */
export function runVersionLabel(project: RunProjectRef): string {
  if (!project.version) return '还没分版'
  return '第 ' + project.version + ' 版' + (project.archived ? '（归档）' : '')
}

/**
 * 列表里的那一行：画布通常按作品名自动命名（「毛衣折叠收纳法」、新版画布是「… v2」），
 * 再抄一遍标题就是同一行重复两遍，所以画布名里已经带着标题时只写版次；
 * 画布被改过名才补上作品名。空白画布直接跑的运行如实写「没挂在作品上」。
 */
export function runWorkLine(run: { flowName: string; project?: RunProjectRef | null }): string {
  const project = run.project
  if (!project) return '没挂在作品上'
  const title = project.title && !String(run.flowName || '').includes(project.title) ? project.title + ' · ' : ''
  return '作品 · ' + title + runVersionLabel(project)
}
