// 分镜逐镜出图（r276 / v0.9.258）
//
// 为什么要把这一步收进作品页：分镜提示词本来就在这一页现拼（v0.9.164），
// 当时的注释写着「出画面不在我们这边，在无限画布」——那是 v0.9.164 的实情。
// 到 v0.9.210 平台自己有了出图通道（快捷创作 → 图片，走的是我们自己的网关与积分），
// 那句话就不再成立了：复制 → 换应用 → 出图 → 下载 → 回来贴，中间三步都是产品自己的活。
//
// 这条链路的四条边界（都写进单测，改文案时别把这些话说没了）：
//   1) 只有点一下才花钱：进页面、展开提示词、切页签都不出图；
//   2) 价格与余额写在按钮上，余额不够时按钮写「还差 N 积分」，而不是点下去才 402；
//   3) 失败必须分清三件事：钱退没退、是不是余额不足、要不要换个时间再来——
//      不把「上游抖动」「余额不足」「图没取回来」糊成一句「失败了」；
//   4) 画完但没贴上的时候说清那张图在哪（最近生成），别让人以为白花了一次。
//
// 不做的事：不批量、不自动重试（重试就是再扣一次积分）、不改提示词里的字。

export type ShotGenCredits = {
  cost: number
  balance: number | null
  refunded: boolean
  refundedAt: string | null
}

/** 服务端 /api/media/tasks/:id 回的形状里，这一页真正用到的那几项。 */
export type ShotGenTask = {
  id: string
  status: string
  progress?: number | null
  error?: string
  file?: { mime: string; bytes: number } | null
  downloadUrl?: string
  credits?: ShotGenCredits | null
}

export type ShotGenView =
  | { state: 'running'; progress: number; label: string }
  | { state: 'ready'; taskId: string; downloadUrl: string; mime: string }
  | {
      state: 'failed'
      message: string
      /** 这笔积分退回来了没有：只有服务端明确说退了才算退了 */
      refunded: boolean
      /** 这次标价多少（服务端记的，不是界面上猜的） */
      cost: number
      /** 余额不够：要去充值，不是「再试一次」 */
      topUp: boolean
    }

/** 一张图最长等多久：服务端出图超时是 240 秒，这里留 4 分钟整。 */
export const SHOT_GEN_WAIT_MS = 4 * 60 * 1000

const costOf = (credits: ShotGenCredits | null | undefined): number => {
  const value = Math.round(Number(credits?.cost))
  return Number.isFinite(value) && value > 0 ? value : 0
}

const clipProgress = (value: unknown): number => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(99, n)
}

/**
 * 一次任务现在的样子。null 也要有话说：任务号都没回来说明请求半路断了，
 * 这时候不能写「失败，可以重试」——那张图可能已经在画了，重试就是再花一次。
 */
export function shotGenView(task: ShotGenTask | null | undefined): ShotGenView {
  if (!task || !task.id) {
    return {
      state: 'failed',
      message: '出图任务没有回来：先去「快捷创作 → 图片 → 最近生成」看一眼，别在这里直接再点一次（可能已经扣过一次积分）。',
      refunded: false,
      cost: 0,
      topUp: false,
    }
  }
  if (task.status === 'processing') {
    const progress = clipProgress(task.progress)
    return { state: 'running', progress, label: progress > 0 ? '出图中 ' + progress + '%' : '正在提交…' }
  }
  if (task.status === 'succeeded') {
    const url = String(task.downloadUrl || '')
    if (url) {
      return {
        state: 'ready',
        taskId: task.id,
        downloadUrl: url,
        mime: String(task.file?.mime || 'image/png'),
      }
    }
    return {
      state: 'failed',
      message: '这一张画完了，但服务端没给出可下载的地址：去「最近生成」里下载它，别重复花一次积分。',
      refunded: false,
      cost: costOf(task.credits),
      topUp: false,
    }
  }
  const message = String(task.error || '').trim() || '出图没有成功，也说不上是哪一步没成（任务 ' + task.id + '）'
  return {
    state: 'failed',
    message,
    refunded: Boolean(task.credits?.refunded),
    cost: costOf(task.credits),
    topUp: /积分不足|余额不足/.test(message),
  }
}

/** 失败那行下面再补一句：钱退没退、要不要充值——这两件事用户最关心。 */
export function shotGenFailNote(view: Extract<ShotGenView, { state: 'failed' }>): string {
  if (view.topUp) return '余额不够：去「充值」页选一档就能到账，不用重试等它自己好。'
  if (view.refunded && view.cost > 0) return '本次 ' + view.cost + ' 积分已原样退回，没有产生消耗。'
  if (view.cost > 0) return '这 ' + view.cost + ' 积分还没退：稍后到「设置 → 积分」看账本，没退就找管理员。'
  return ''
}

/** 按钮上写这一下花多少；余额不够时直接写还差多少，别让人点下去才被拦。 */
export function shotGenPriceLabel(price: number | null | undefined, balance?: number | null): string {
  const value = Math.round(Number(price))
  if (!Number.isFinite(value) || value <= 0) return '价格读取中'
  // 余额未知（null / undefined）不许当成 0：那会写成「还差 5 积分」，把人挡在一次本来能成的出图外面
  if (balance === null || balance === undefined) return value + ' 积分'
  const left = Number(balance)
  if (Number.isFinite(left) && left >= 0 && left < value) return '还差 ' + (value - left) + ' 积分'
  return value + ' 积分'
}

/** 出图比例：优先竖屏（这一套流程拆的都是抖音/小红书）；模型不支持就退到第一个它认的，绝不传一个上游不认的值。 */
export function shotGenRatio(ratios: string[] | null | undefined): string {
  const list = (Array.isArray(ratios) ? ratios : []).map((item) => String(item || '').trim()).filter(Boolean)
  if (!list.length) return '9:16'
  if (list.includes('9:16')) return '9:16'
  if (list.includes('1:1')) return '1:1'
  return list[0]
}

/** 存上去的那张图叫什么：只给人看，服务端会按文件头重命名成自己的名字。 */
export function shotGenFileName(shotNo: number, mime?: string): string {
  const no = Math.max(1, Math.round(Number(shotNo) || 1))
  const ext = String(mime || '').includes('webp') ? 'webp' : String(mime || '').includes('jpeg') || String(mime || '').includes('jpg') ? 'jpg' : 'png'
  return '第' + String(no).padStart(2, '0') + '镜.' + ext
}

/** 贴不上去时（图在、但没记到这一镜）说出来它还在哪：不让人以为图没了、钱白花了。 */
export const SHOT_GEN_ATTACH_FAILED = '图画好了，但没记到这一镜：去「最近生成」下载它，再用「贴画面」贴进来；模板那几镜一个字没动。'
