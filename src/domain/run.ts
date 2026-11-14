import type { RunProjectRef, RunRecord, RunResumePlan } from '../api/flows'

/** 一条运行在页面上怎么称呼：颜色档与文案全站一处，别一处写「排队中」一处写「PENDING」。 */
export type RunStatusTone = 'pass' | 'fail' | 'warn' | 'live' | 'queued'
export type RunStatusMeta = { label: string; tone: RunStatusTone; note: string }

/**
 * 运行记录的四种落库终态之外，还有两种「此刻的样子」：
 *   queued（v0.9.98）＝ 还在整机队里等名额，没开始跑、没扣积分；
 *   running = 正在跑，节点会一个个补上。
 * 以前页面把所有非成功都写成「失败」——排队中和在跑都顶着红点，读起来像已经失败并退了钱。
 */
export function runStatusMeta(status: unknown, canceled = false): RunStatusMeta {
  const key = String(status || '')
  if (key === 'success') return { label: '成功', tone: 'pass', note: '' }
  if (key === 'interrupted') {
    return canceled
      ? { label: '已停止', tone: 'warn', note: '你停止了这次运行：跑完的节点按比例计费，没跑完的部分已退回；可以接着跑没跑完的节点。' }
      : { label: '已中断', tone: 'warn', note: '这次运行被中断，积分按账本退回；有已跑完的节点时可以接着跑。' }
  }
  if (key === 'running') return { label: '运行中', tone: 'live', note: '这次运行还在跑：节点会一个个补上，跑完自动结算。' }
  if (key === 'queued') return { label: '排队中', tone: 'queued', note: '正在排队：还没轮到这个名额，排到才开始跑、才扣积分。' }
  if (key === 'error' || key === 'failed' || !key) return { label: '失败', tone: 'fail', note: '这次运行失败了，积分原路退回；有已跑完的节点时可以接着跑。' }
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
 * 一条跑完的运行该写多久：只写节点耗时会把排队那段时间藏掉——用户等了一分钟，
 * 记录上写 7.0s，看起来像产品在撒谎。排队过就写「排队 52.0s · 运行 7.0s」（v0.9.100）。
 */
export function runSpentText(run: {
  status: string
  durationMs?: number
  queuedMs?: number
  queuedAt?: string | null
  startedAt?: string | null
}): string {
  if (run.status === 'running' || run.status === 'queued') return runLiveText(run)
  const runMs = Math.max(0, Number(run.durationMs) || 0)
  const waited = Math.max(0, Number(run.queuedMs) || 0)
  const runText = (runMs / 1000).toFixed(1) + 's'
  // 几十毫秒的「排队」只是占位记录到扣费之间的时间，不是用户在门口等：
  // 写「排队 0.0s」既难看又像在表功，1 秒以内就不提（原始数仍在记录里）。
  if (waited < 1000) return runText
  const waitText = waited < 10000 ? (waited / 1000).toFixed(1) + 's' : Math.round(waited / 1000) + 's'
  return '排队 ' + waitText + ' · 运行 ' + runText
}

/** 续跑入口要用到的三个数：还差几个节点、这次还要补多少积分、上次复用了几个。 */
export type RunResumeInfo = { left: number; cost: number; reused: number; resumable: boolean }

export function runResumeInfo(run: RunRecord | null): RunResumeInfo {
  if (!run) return { left: 0, cost: 0, reused: 0, resumable: false }
  const nodes = Array.isArray(run.nodes) ? run.nodes : []
  const done = nodes.filter((node) => node.status === 'success' || node.status === 'unsupported').length
  const total = Math.max(0, Number(run.total) || 0)
  const left = Math.max(0, total - done)
  const cost = Math.max(0, Number(run.credits?.cost) || 0)
  // 主动停止已经按跑完节点结过账：补账本里还没付的那部分。
  // 失败 / 重启是全额退：按剩下节点占全图的比例收，不按整张画布再收一遍。
  const kept = run.credits?.settled ? Math.max(0, Number(run.credits.kept) || 0) : 0
  const nextCost = run.credits?.settled
    ? Math.max(0, cost - kept)
    : (total > 0 ? Math.min(cost, Math.ceil((cost * left) / total)) : 0)
  return {
    left,
    cost: nextCost,
    reused: done,
    resumable: Boolean(run.resumable ?? (run.status !== 'success' && done > 0 && left > 0)),
  }
}

/**
 * 运行记录页的续跑预检文案（v0.9.105）：点「继续运行」之前先把当前画布算清楚。
 * 运行记录里存的是上次收尾时的 resumable / 节点数；画布改过之后它就会过期。
 * 这里只负责把服务端刚算出的 plan 翻成人话，不替服务端判断能不能续。
 */
export type RunResumePlanView = { resumable: boolean; summary: string; note: string; button: string }

export function runResumePlanView(plan: RunResumePlan | null): RunResumePlanView {
  if (!plan) return { resumable: false, summary: '', note: '', button: '' }
  const reused = Math.max(0, Number(plan.reused) || 0)
  const rerun = Math.max(0, Number(plan.rerun) || 0)
  const stale = Math.max(0, Number(plan.stale) || 0)
  if (!plan.resumable) {
    return {
      resumable: false,
      summary: String(plan.reason || '当前画布没有能原样复用的已跑节点'),
      note: '不会复用旧结果：从头运行会按最新画布跑全图。',
      button: '',
    }
  }
  const cost = Math.max(0, Number(plan.cost) || 0)
  const costText = cost > 0 ? '补 ' + cost + ' 积分' : '不再扣费'
  const staleText = stale > 0 ? '（其中 ' + stale + ' 个改过）' : ''
  return {
    resumable: true,
    summary: '复用 ' + reused + ' 个 · 还差 ' + rerun + ' 个' + staleText + ' · ' + costText,
    note: stale > 0
      ? '上次跑过、但改过或已不在画布上的 ' + stale + ' 个节点会重跑；其余没跑完的节点这次补上。'
      : '上次跑完且内容没变的节点直接复用，不重复调上游。',
    button: '继续运行 · ' + costText,
  }
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
