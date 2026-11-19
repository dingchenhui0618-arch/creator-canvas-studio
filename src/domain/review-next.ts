/**
 * 评完之后往哪走（r251 / v0.9.234）
 * 评审结果到「说明」那一行就结束了：结论有了，但这条结论记在哪一版、能不能往下交付、
 * 该回作品还是回工作流改，全靠自己去别的页面找一遍。这里按结论一次性说清楚。
 * 与工作流那边的 run-next.ts 同一套写法：挑出口与写文案都在这里，组件只管画。
 */
import type { ReviewIssues } from '../api/review'
import { issueCount, issueLine } from './review.ts'

export type ReviewNextAction = 'openProject' | 'openFlow' | 'openProjects'

/** pass 往交付走；fix 要先改；loose 没挂作品 / 只看历史，所以不给动手的出口 */
export type ReviewNextTone = 'pass' | 'fix' | 'loose'

export type ReviewNextPlan = {
  tone: ReviewNextTone
  title: string
  copy: string
  /** 按推荐顺序排：第一个是主按钮 */
  actions: ReviewNextAction[]
}

/** 这次评审记在哪条作品下：服务端现算（project + 那一版 + 有没有工作流），前端不猜 */
export type ReviewNextScope = { id: string; title: string; version: number; flowId?: string }

export type ReviewNextInput = {
  verdict: 'pass' | 'needs_review' | 'fail'
  issues?: ReviewIssues | null
  /** 有界修正建议的条数 */
  fixes?: number
  /** 没挂在作品上（单独评一张画面）为 null */
  project?: ReviewNextScope | null
  /** 打开的是已经落库的旧记录：只读，只给「回去看这一版」 */
  history?: boolean
}

// 按钮上放不下一整条标题：按字数截断，具体是哪条作品正文里写着
const MAX_NAME = 12

function clip(name: string): string {
  const text = String(name || '').trim()
  if (!text) return '这条作品'
  return text.length > MAX_NAME ? text.slice(0, MAX_NAME) + '…' : text
}

/** 第 N 版；还没开工作流的不写「第 0 版」（与 reviewVersionLabel 同一条规矩） */
function versionText(version?: number): string {
  const n = Math.round(Number(version) || 0)
  return n > 0 ? '第 ' + n + ' 版' : ''
}

function whereText(project: ReviewNextScope): string {
  return '《' + String(project.title || '').trim().replace(/^《|》$/g, '') + '》' + versionText(project.version)
}

export function reviewNextActionLabel(action: ReviewNextAction, project?: ReviewNextScope | null): string {
  if (action === 'openProject') return project ? '回《' + clip(project.title) + '》这一版' : '去作品页'
  if (action === 'openFlow') return '打开工作流'
  return '去作品流'
}

export function reviewNextPlan(input: ReviewNextInput): ReviewNextPlan {
  const project = input.project || null
  const issues = input.issues || null
  const counted = issueCount(issues)
  const line = issueLine(issues)
  const fixes = Math.max(0, Math.round(Number(input.fixes) || 0))
  const flow = Boolean(project && project.flowId)

  // 回头看的旧记录：只读，不能再评一次，只把「记在哪」和「去哪看现在的状态」说清
  if (input.history) {
    return project
      ? {
          tone: 'loose',
          title: '这条结论记在' + whereText(project),
          copy: '历史记录只能看，不能在这里再评一次。这一版现在能不能交付、要不要确认，回作品页看。',
          actions: ['openProject'],
        }
      : {
          tone: 'loose',
          title: '这条结论没挂在作品上',
          copy: '单独评的画面不记版次，作品页看不到它。要留档就从作品页送评审。',
          actions: ['openProjects'],
        }
  }

  // 单独评一张画面：结论不留档，先把这件事说清，别让人以为作品页能看到
  if (!project) {
    return {
      tone: 'loose',
      title: '这次评的是一张单独的图',
      copy: '它没挂在任何作品下，所以作品页看不到这份结论；下一版想留档，就从作品页送评审。',
      actions: ['openProjects'],
    }
  }

  const where = whereText(project)
  const actions: ReviewNextAction[] = flow ? ['openProject', 'openFlow'] : ['openProject']

  if (input.verdict === 'pass') {
    const more = fixes > 0 ? '另有 ' + fixes + ' 条建议，想再打磨也可以改完再评一次。' : ''
    return {
      tone: 'pass',
      title: '这一版可以往交付走',
      copy: where + '这次没查出必须先解决的问题。确认这一版、封成交付包都在作品页。' + more,
      actions,
    }
  }

  if (input.verdict === 'fail') {
    const what = counted > 0
      ? '有 ' + counted + ' 处必须先解决' + (line ? '（' + line + '）' : '')
      : '这次判了不通过'
    return {
      tone: 'fix',
      title: '先别发布这一版',
      copy: where + what + '。结构要改就打开工作流重跑，只是画面问题就换一张新画面再评。',
      actions,
    }
  }

  const shape = counted > 0 ? '：' + (line || counted + ' 处待看') : ''
  return {
    tone: 'fix',
    title: '这一版要你拍板',
    copy: where + '这次结论是「需人工确认」' + shape + '。看完回作品页确认这一版，或者改完再评一次。',
    actions,
  }
}
