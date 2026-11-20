// 分镜 → 出图提示词（v0.9.164）
//
// 出画面这一步不在我们这边：出图要平台 Key、要花额度，也发生在无限画布（外部应用）里。
// 但「这一镜该让人看见什么」一直在这边——分镜有画面与机位，脚本有这一段要念的话，
// 模板知道它来自竖屏还是横屏。把它们拼成一条能直接贴进生图框的提示词，
// 不调用任何模型、不改任何数据：拼错了改一句文案就能修，不会白花一次额度。
//
// 刻意不做的事：
//   - 不改写内容：拼进去的就是脚本与分镜里的原话，不替用户编主体、不替品牌起名；
//   - 不猜比例：只有认得出是竖屏平台才写「竖屏 9:16」，直链/认不出就整段不写；
//   - 不把镜头号、时长写进提示词本身（那是给人看的编号，模型读了只会画出一排字）。

export type ShotLike = {
  shotNo?: number
  startSec?: number
  endSec?: number
  visual?: string
  camera?: string
  caption?: string
  purpose?: string
}

export type BeatLike = {
  beat?: string
  startSec?: number
  endSec?: number
  voiceover?: string
  onScreen?: string
}

export type ShotPromptOptions = {
  /** 模板来源平台：douyin / xiaohongshu 认作竖屏；direct 或空不写比例 */
  platform?: string
  /** 这条作品自己的标题，只用在「复制全部」的抬头 */
  title?: string
  /** 脚本从哪来（v0.9.164）：作品自己改成口播句，模板那份写成原片口播，别把两者说成一件事 */
  scriptSource?: 'own' | 'template'
}

const STYLE_TAIL = '实拍质感，自然光，色彩克制；不要出现文字、Logo、水印、界面截图。'

function clean(text?: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function sentence(text: string): string {
  const value = clean(text)
  if (!value) return ''
  return /[。！？.!?]$/.test(value) ? value : value + '。'
}

/** 平台 → 画幅。认不出就不写，不替用户决定画面是竖的还是横的。 */
export function shotAspect(platform?: string): string {
  const key = clean(platform).toLowerCase()
  if (!key) return ''
  if (key === 'douyin' || key === 'xiaohongshu' || key === 'xhs') return '竖屏 9:16'
  if (key === 'bilibili' || key === 'youtube') return '横屏 16:9'
  return ''
}

/** 这一镜落在哪一段脚本里：按开始时间找，落在缝里的取前面最近的段，找不到返回 null。 */
export function beatForShot(shot: ShotLike, beats: BeatLike[] | null | undefined): BeatLike | null {
  const at = Number(shot?.startSec) || 0
  let fallback: BeatLike | null = null
  for (const beat of Array.isArray(beats) ? beats : []) {
    const start = Number(beat?.startSec) || 0
    const end = Number(beat?.endSec) || 0
    if (at >= start && (end === 0 || at < end)) return beat
    if (start <= at) fallback = beat
  }
  return fallback
}

/**
 * 一镜一条提示词。
 * beat 是这条作品自己的脚本段落（改过脚本的用改过的那份），没有就只按分镜的画面与机位拼。
 */
export function shotPrompt(shot: ShotLike, beat?: BeatLike | null, options: ShotPromptOptions = {}): string {
  const parts: string[] = []
  const aspect = shotAspect(options.platform)
  const shooting = [clean(shot?.camera), clean(shot?.visual)].filter(Boolean).join('，')
  const target = clean(beat?.voiceover)
  // 「空」要看画面与脚本有没有内容，不能拿比例顶上：只写一句「竖屏 9:16」等于让模型自己编。
  const scriptLead = options.scriptSource === 'own' ? '画面按这条作品自己的脚本：' : options.scriptSource === 'template' ? '画面按原片这一段口播：' : '画面按这段口播：'
  if (shooting) {
    parts.push(sentence([aspect, shooting].filter(Boolean).join('，')))
    if (target) parts.push(sentence(scriptLead + target))
  } else if (target) {
    parts.push(sentence([aspect, scriptLead + target].filter(Boolean).join('，')))
  } else {
    const no = Math.max(1, Math.round(Number(shot?.shotNo) || 1))
    parts.push(sentence([aspect, '按第 ' + no + ' 镜的位置补一个能接上前后镜头的画面'].filter(Boolean).join('，')))
  }
  parts.push(STYLE_TAIL)
  return parts.join('')
}

function timeLabel(shot: ShotLike): string {
  const start = Number(shot?.startSec)
  const end = Number(shot?.endSec)
  if (!Number.isFinite(start) && !Number.isFinite(end)) return '时间待定'
  return (Number.isFinite(start) ? start : 0) + '–' + (Number.isFinite(end) ? end : 0) + ' 秒'
}

/**
 * 整条作品的全部提示词：抬头一行说清是什么，下面按镜头号一段一段排。
 * 镜头号与时长只出现在这里（给人看的编号），不出现在提示词正文里。
 */
export function allShotPrompts(shots: ShotLike[] | null | undefined, beats: BeatLike[] | null | undefined, options: ShotPromptOptions = {}): string {
  const list = Array.isArray(shots) ? shots : []
  if (!list.length) return ''
  const title = clean(options.title)
  const head = '分镜提示词 · ' + (title || '这条作品') + '（' + list.length + ' 镜）'
  // r277：出图这件事已经收进作品页（点「出这一镜」就画），复制走只是另一个出口
  const note = '每镜可以点「出这一镜」就地画一张（花你自己的积分），也可以复制走去别处出图。'
  const rows = list.map((shot, index) => {
    const no = Math.max(1, Math.round(Number(shot?.shotNo) || index + 1))
    const name = '第 ' + String(no).padStart(2, '0') + ' 镜 · ' + timeLabel(shot)
    return name + '\n' + shotPrompt(shot, beatForShot(shot, beats), options)
  })
  return [head, note].join('\n') + '\n\n' + rows.join('\n\n')
}

/** 脚本从哪来：作品自己改过的那份 / 还在跟模板 / 模板也没脚本。拼进提示词的句子要跟着这三种说法。 */
export type ShotPromptScriptSource = 'own' | 'template' | 'none'

/** 提示词面板顶上那句说明：拼的是哪几样东西、有没有动过原话、会不会花钱。 */
export function shotPromptHint(source: ShotPromptScriptSource): string {
  const from = source === 'own' ? '与这条作品自己的脚本' : source === 'template' ? '与模板那一段脚本' : ''
  return '由这一镜的画面、机位' + from + '拼成，没有经过模型改写；点「出这一镜」就用这一条画一张（花你自己的积分），也可以复制走去别处出图。'
}
