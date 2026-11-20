// 分镜 → 出图提示词（服务端镜像，r277）
//
// 前端 src/domain/shot-prompt.ts 是同一套口径：作品页「出这一镜」用哪条提示词，
// 开工作流时给每一镜建的出图节点就用哪条。服务端跑的是 node，不能 import .ts，
// 所以这里是逐条镜像；两份是否还是同一份由 test/shot-prompt-parity.test.mjs 逐字比对，
// 改一边忘了另一边会直接红——不靠「应该一样」的自觉。
//
// 刻意不做的事（与前端同一条）：不改写内容、不猜比例、不把镜头号与时长写进提示词。
const STYLE_TAIL = '实拍质感，自然光，色彩克制；不要出现文字、Logo、水印、界面截图。'

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function sentence(text) {
  const value = clean(text)
  if (!value) return ''
  return /[。！？.!?]$/.test(value) ? value : value + '。'
}

/** 平台 → 画幅。认不出就不写，不替用户决定画面是竖的还是横的。 */
export function shotAspect(platform) {
  const key = clean(platform).toLowerCase()
  if (!key) return ''
  if (key === 'douyin' || key === 'xiaohongshu' || key === 'xhs') return '竖屏 9:16'
  if (key === 'bilibili' || key === 'youtube') return '横屏 16:9'
  return ''
}

/** 这一镜落在哪一段脚本里：按开始时间找，落在缝里的取前面最近的段，找不到返回 null。 */
export function beatForShot(shot, beats) {
  const at = Number(shot?.startSec) || 0
  let fallback = null
  for (const beat of Array.isArray(beats) ? beats : []) {
    const start = Number(beat?.startSec) || 0
    const end = Number(beat?.endSec) || 0
    if (at >= start && (end === 0 || at < end)) return beat
    if (start <= at) fallback = beat
  }
  return fallback
}

/** 一镜一条提示词。beat 是这条作品自己的脚本段落，没有就只按分镜的画面与机位拼。 */
export function shotPrompt(shot, beat, options = {}) {
  const parts = []
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
