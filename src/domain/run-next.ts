import type { RunNodeResult, RunRecord } from '../api/flows'

/**
 * 跑完之后往哪走（r250 / v0.9.233）。
 *
 * 工作流页此前只在「跑之前」给出口：另存为模板在顶栏、去评审在作品条上。跑完那一刻，
 * 运行结果抽屉里除了逐节点状态什么都没有——用户看着结果，不知道下一步该点哪里，
 * 只能关掉抽屉自己找。这块把「接下来」直接钉在抽屉底栏：结果在哪，下一步就在哪。
 *
 * 挑哪几个出口、写什么字都在这里，组件只负责画，所以改动会被单测抓到。
 */
export type RunNextAction = 'review' | 'saveTemplate' | 'openProject'

export type RunNextPlan = {
  tone: 'done' | 'partial' | 'stopped'
  title: string
  copy: string
  actions: RunNextAction[]
}

export type RunNextInput = {
  record: RunRecord | null | undefined
  nodes: RunNodeResult[]
  /** 还在跑 / 还在排队：这一屏是过程，不是结论 */
  running?: boolean
  /** 抽屉当前这条工作流；和运行记录对不上时不提「存成模板」（存下去会是另一条） */
  flowId?: string
}

/** 底部按钮的字：动作名要能自己说清结果，别写「确定」「继续」这种指向不明的词。 */
export function runNextActionLabel(action: RunNextAction): string {
  if (action === 'review') return '送去评审这一版'
  if (action === 'saveTemplate') return '存成模板'
  return '打开作品'
}

function spendOf(record: RunRecord): number {
  const total = Number(record.spentTotal)
  if (Number.isFinite(total)) return Math.max(0, total)
  const run = Number(record.credits?.cost) || 0
  return Math.max(0, run + (Number(record.imageCredits) || 0) + (Number(record.videoCredits) || 0))
}

/**
 * 这次运行接下来能做什么。返回 null = 不显示这一块（还在跑、还没有结论、或这条记录
 * 根本没跑起来），而不是显示一块占位。
 */
export function runNextPlan(input: RunNextInput): RunNextPlan | null {
  const { record, nodes, running = false, flowId = '' } = input
  if (running || !record) return null
  if (record.status === 'running' || record.status === 'queued') return null

  const total = Math.max(0, Number(record.total) || nodes.length)
  if (!total) return null

  const done = nodes.filter((node) => node.status === 'success').length
  const failed = nodes.filter((node) => node.status === 'error').length
  const left = Math.max(0, total - done - failed)

  const project = record.project || null
  // 归档的旧版工作流已经不在「当前这一版」上了：拉去评审等于给旧版打分，不给这个出口。
  const canReview = Boolean(project) && !project?.archived
  const sameFlow = !record.flowId || !flowId || record.flowId === flowId
  const actions: RunNextAction[] = []
  if (canReview) actions.push('review')
  if (sameFlow) actions.push('saveTemplate')
  if (project) actions.push('openProject')

  if (!actions.length) return null

  const refunded = Boolean(record.credits?.refunded) || record.status === 'interrupted'

  // 主动停止：不是失败，别用「没跑完」那种带责备的说法
  if (record.canceled) {
    const copy = done > 0
      ? done + ' 个节点留下结果，' + left + ' 个没跑' + (refunded ? '；没跑的那部分已退回积分' : '') + '。'
      : '一个节点都没跑完，' + (refunded ? '积分已退回。' : '这次没有留下结果。')
    return { tone: 'stopped', title: '你停下了这次运行', copy, actions }
  }

  if (record.status === 'success' && !failed) {
    const spent = spendOf(record)
    const spentText = spent > 0 ? '，花 ' + spent + ' 积分' : ''
    // 版次可能还是 0（作品后来才绑上这条工作流）：写「第 0 版」既难看也是错的信息
    const version = Number(project?.version) || 0
    const versionText = project
      ? '《' + project.title + '》' + (version > 0 ? '第 ' + version + ' 版下' : '下')
      : ''
    const copy = project
      ? '全部 ' + total + ' 个节点跑完了' + spentText + '；这一版已经记在' + versionText + '。'
      : '全部 ' + total + ' 个节点跑完了' + spentText + '；这次运行还没挂到作品上，存成模板后能在别处套用这段结构。'
    return { tone: 'done', title: '这次跑完了', copy, actions }
  }

  // 失败 / 被进程打断：把「哪个数」说清，再指出去处
  const interrupted = record.status === 'interrupted'
  const title = interrupted ? '这次被中断了' : '这次没跑完'
  const countText = done > 0
    ? done + '/' + total + ' 个节点跑完，' + failed + ' 个失败'
    : '没有节点跑完'
  const extra = record.resumable
    ? '；改完可以接着跑，不用从头'
    : refunded ? '；积分已退回' : ''
  return { tone: 'partial', title, copy: countText + extra + '。', actions }
}
