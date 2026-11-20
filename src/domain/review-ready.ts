/**
 * 评审页首屏的「读到了没有」（r274 / v0.9.256）
 *
 * 评审页一进来要读两件互不相干的事：
 *   ① /api/review/health —— 评审引擎在不在、模型配没配（决定「开始评审」能不能点）
 *   ② /api/templates     —— 左栏那一列模板首帧（只影响挑原片那一帧）
 * 以前它们挤在一个 Promise.all 里：模板库一失手，评审状态也一起丢掉，
 * 页面接着写「评审模型 未配置」「0 个模板首帧」「模板库还是空的」，还把「开始评审」锁死。
 * 两件事都没读到，却被说成两个「没有」。这里把「读不到」与「没有」分开：
 * 读不到就只说读不到、留一条重试；能不能评以读到的状态为准，没读到的部分不替它下结论。
 */
import type { ReviewStatus } from '../api/review'

/** 一次读取的两种结果：读到了，或者读不到（带一句人话） */
export type ReadTrouble = { state: 'failed'; message: string }
export type ReviewStatusRead = { state: 'ok'; status: ReviewStatus } | ReadTrouble
export type ReviewTemplatesRead = { state: 'ok'; count: number } | ReadTrouble

export const STATUS_FALLBACK = '评审服务状态没读到'
export const TEMPLATES_FALLBACK = '模板库没读到'

/**
 * 从异常里取一句能给人看的话：不把 Error 写成「Error」、不把对象写成 [object Object]。
 * 服务端的中文原话优先，取不到就用调用方给的兜底句。
 */
export function failureText(reason: unknown, fallback: string): string {
  if (typeof reason === 'string') {
    const text = reason.trim()
    return text || fallback
  }
  if (reason && typeof reason === 'object') {
    const message = (reason as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallback
}

/** 评审状态：给了 reason 就是读失败；值是空/不是对象也算读失败，绝不当成「模型没配」 */
export function statusReadOf(value: ReviewStatus | null | undefined, reason?: unknown): ReviewStatusRead {
  if (reason !== undefined) return { state: 'failed', message: failureText(reason, STATUS_FALLBACK) }
  if (!value || typeof value !== 'object') return { state: 'failed', message: STATUS_FALLBACK }
  return { state: 'ok', status: value }
}

/** 模板库：没有 items 数组就是读失败，不把「没读到」数成 0 条 */
export function templatesReadOf(
  value: { items?: unknown[] } | null | undefined,
  reason?: unknown,
): ReviewTemplatesRead {
  if (reason !== undefined) return { state: 'failed', message: failureText(reason, TEMPLATES_FALLBACK) }
  const items = value && Array.isArray(value.items) ? value.items : null
  if (!items) return { state: 'failed', message: TEMPLATES_FALLBACK }
  return { state: 'ok', count: items.length }
}

export type ReviewReadiness = {
  /** 「开始评审」能不能点：没读到状态时放行，由服务端再判一次（失败会原路退回） */
  canRun: boolean
  engineLabel: string
  engineTone: 'pass' | 'warn'
  modelLabel: string
  modelTone: 'pass' | 'warn' | 'fail'
  /** 按钮点不了时写在 title 上的原因；能点时是空串 */
  holdReason: string
  /** 页尾那句「这次是谁出的结论」：读不到时不猜「平台模型」 */
  engineNote: string
}

const ENGINE_NOTE = {
  serviceInternal: '当前由 VisionQA 插件服务出结论；fixture provider 只证明链路可用，不代表模型准确率。',
  serviceLocal: '当前由本地评审服务出结论，结果里会标明来源。',
  unpluggedInternal: 'VisionQA 插件服务未启动（127.0.0.1:6300），当前由本地视觉模型按同一套 visual-baseline 规则评审，provider 会写进结果。',
  unpluggedPlatform: '本次由平台视觉模型按同一套评审规则出结论，结果里会标明来源。',
} as const

/**
 * 页面顶上那两只胶囊 + 按钮能不能点。
 * 三种输入分开处理：还没读到 / 读到了 / 读不到。没读到不猜「未配置」。
 */
export function reviewReadiness(input: {
  read: ReviewStatusRead | null
  /** 另一个探针（/api/credits 的模型服务状态）说模型此刻不可用 */
  modelBlocked?: boolean
  internal?: boolean
}): ReviewReadiness {
  const blocked = input.modelBlocked === true
  const read = input.read

  if (!read) {
    return {
      canRun: !blocked,
      engineLabel: '读取中',
      engineTone: 'warn',
      modelLabel: blocked ? '暂时不可用' : '读取中',
      modelTone: blocked ? 'fail' : 'warn',
      holdReason: blocked ? '评审模型暂时不可用，先看页头那条说明' : '',
      engineNote: ENGINE_NOTE.unpluggedPlatform,
    }
  }

  if (read.state === 'failed') {
    return {
      canRun: !blocked,
      engineLabel: '状态没读到',
      engineTone: 'warn',
      modelLabel: blocked ? '暂时不可用' : '状态没读到',
      modelTone: blocked ? 'fail' : 'warn',
      holdReason: blocked ? '评审模型暂时不可用，先看页头那条说明' : '',
      // 读不到服务状态就不知道这次是谁出结论：不写「平台视觉模型」，说清以结果为准
      engineNote: '评审服务状态这次没读到，这次结论的来源以结果里标的那一行为准。',
    }
  }

  const status = read.status
  const engineLabel = status.service ? '本地服务' : '平台模型'
  const engineNote = status.service
    ? input.internal ? ENGINE_NOTE.serviceInternal : ENGINE_NOTE.serviceLocal
    : input.internal ? ENGINE_NOTE.unpluggedInternal : ENGINE_NOTE.unpluggedPlatform

  if (blocked) {
    return {
      canRun: false,
      engineLabel,
      engineTone: 'pass',
      modelLabel: '暂时不可用',
      modelTone: 'fail',
      holdReason: '评审模型暂时不可用，先看页头那条说明',
      engineNote,
    }
  }
  if (!status.model) {
    return {
      canRun: false,
      engineLabel,
      engineTone: 'pass',
      modelLabel: '未配置',
      modelTone: 'fail',
      holdReason: '评审模型还没配置，所以这个按钮点不了：配好模型 Key 之后再评',
      engineNote,
    }
  }
  return {
    canRun: true,
    engineLabel,
    engineTone: 'pass',
    modelLabel: '可用',
    modelTone: 'pass',
    holdReason: '',
    engineNote,
  }
}

export type TemplateShelf = {
  /** 折叠开关上那句（也进 title）：读不到就不说「0 个」 */
  toggle: string
  /** 列表下方的空状态：只有真读到空库才说「还是空的」 */
  emptyNote: string
}

export function templateShelf(read: ReviewTemplatesRead | null): TemplateShelf {
  if (!read) return { toggle: '模板首帧', emptyNote: '' }
  if (read.state === 'failed') {
    return {
      toggle: '模板首帧没读到',
      emptyNote: '模板库这次没读到，所以这里一帧也没列——不是库空了。这只影响挑原片那一帧，不影响评审。',
    }
  }
  if (read.count > 0) return { toggle: read.count + ' 个模板首帧', emptyNote: '' }
  return {
    toggle: '模板首帧',
    emptyNote: '模板库还是空的，先去「爆款雷达」复刻一条。',
  }
}

/**
 * 页头那条提醒：只在真读不到时出现，配一条「重新读取」。
 * 两件都失手就一句话说完，不刷两条一模一样的红条。
 */
export function readNotice(input: {
  status: ReviewStatusRead | null
  templates: ReviewTemplatesRead | null
}): { text: string; detail: string } {
  const trouble: string[] = []
  if (input.status?.state === 'failed') trouble.push(input.status.message)
  if (input.templates?.state === 'failed') trouble.push(input.templates.message)
  if (!trouble.length) return { text: '', detail: '' }

  const parts: string[] = []
  if (input.status?.state === 'failed') {
    parts.push('评审服务状态这次没读到——不是没配置：可以直接点「开始评审」试一次，服务端会再判一遍，不成功会说明原因、原路退回。')
  }
  if (input.templates?.state === 'failed') {
    parts.push('模板库这次也没读到，左栏一帧也没列；这只影响挑原片那一帧，不影响评审。')
  }
  return { text: parts.join(' '), detail: trouble.join(' · ') }
}


/**
 * 「这次挑的画面能不能评」（r274）
 * 以前页面只有两种状态：有预览图，或者「评审时的画面已经不在了」。
 * 于是一个没抽到首帧的模板（本来就没有画面）也被说成「画面已经不在了」，
 * 「开始评审」还照样能点——点下去只是发出一条没有画面的请求。
 * 现在分三种：没有画面 / 打不开 / 可以评，按钮跟说明都按这三种走。
 */
export type PickedReadiness = {
  canRun: boolean
  /** 按钮点不了时写在 title 上的原因 */
  holdReason: string
  tone: 'ready' | 'none' | 'broken'
  /** 画面区那两行字（tone=ready 时不用） */
  title: string
  copy: string
}

export function pickedReadiness(input: {
  media?: string
  imageUrl?: string
  preview?: string
  /** 预览图在浏览器里加载失败 */
  broken?: boolean
  /** 已经有结论（结论与锚点仍然有效，只是原图没了） */
  hasResult?: boolean
}): PickedReadiness {
  const hasSource = Boolean(String(input.media || '').trim() || String(input.imageUrl || '').trim())
  const hasPreview = Boolean(String(input.preview || '').trim())
  if (!hasSource) {
    return {
      canRun: false,
      holdReason: '这次挑的画面是空的：换一个有首帧的模板，或自己传一张图',
      tone: 'none',
      title: '这一条没有可评的画面',
      copy: '模板没抽到首帧、或图片地址是空的。换成有首帧的模板，或自己传一张图再评——现在点「开始评审」也发不出画面。',
    }
  }
  if (hasPreview && input.broken !== true) {
    return { canRun: true, holdReason: '', tone: 'ready', title: '', copy: '' }
  }
  if (input.hasResult) {
    return {
      canRun: true,
      holdReason: '',
      tone: 'broken',
      title: '评审时的画面已经不在了',
      copy: '模板帧被清理、或远程图片失效；这条结论与下面每条问题的锚点仍然有效。',
    }
  }
  return {
    canRun: true,
    holdReason: '',
    tone: 'broken',
    title: '这张图打不开',
    copy: '地址失效或被挡住了。换一张图再评；直接点「开始评审」的话，模型多半也看不到画面。',
  }
}
