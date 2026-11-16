// 作品的「画面」（v0.9.161）：分镜每一镜可以挂一张自己的画面。
//
// 为什么挂在作品上、不写进模板：分镜跟着模板走（模板是原片拆出来的，可能被别人也用着），
// 而「这一镜我打算这么拍」是你自己的东西，只属于这条作品的这一版。模板里一个字不动。
//
// 三条边界：
//   1) 只认自己账号目录下的上传图（uploads/<账号>/<文件名>），与评审入口同一道归属校验；
//   2) 镜头号必须是模板分镜里存在的那几镜——没有分镜就没有「第几镜」，不凭空造一个；
//   3) 传空等于撤销：这一镜回到「还没贴画面」，不删除那张图本身（那张图可能还被别的镜用着）。
/** 一条作品最多记几镜的画面：模板分镜上限 24 镜，留一倍余量，防止脏数据把记录撑大。 */
export const MAX_SHOT_FRAMES = 48

/** uploads/<账号>/<文件名>：与 /api/review 的 media 是同一套写法，评审那条链路不用改。 */
export const SHOT_MEDIA = /^uploads\/([A-Za-z0-9_-]{3,64})\/([A-Za-z0-9._-]{1,80})$/

/** 镜头号只认正整数：'1'、1 都算第 1 镜，'1.5'、'第1镜' 都不算。 */
export function normalizeShotNo(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1 || n > MAX_SHOT_FRAMES) return 0
  return Math.round(n) === n ? n : 0
}

/**
 * 记录形状：{ "1": { media, at } }。
 * 读的时候不猜：不是 uploads/ 开头的、镜头号不认识的、时间不是时间的，一律丢掉。
 */
export function normalizeShotFrames(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    const shotNo = normalizeShotNo(key)
    if (!shotNo) continue
    const media = String(value?.media || '')
    if (!SHOT_MEDIA.test(media)) continue
    const at = String(value?.at || '')
    if (!at || Number.isNaN(Date.parse(at))) continue
    out[String(shotNo)] = { media, at }
  }
  return out
}

/**
 * 能不能把这把图挂到这一镜：返回 null 表示可以，否则返回要回给页面的状态。
 * 与评审入口同一句话术：不属于你的图说「不在你的账号下」，不说「不存在」（不泄露别人的文件在不在）。
 */
export function shotFrameBlock({ media, user, shotNo, shotCount, admin = false }) {
  if (!shotNo) {
    return { status: 400, code: 'SHOT_NO_INVALID', error: '镜头号不对：只认分镜里第几镜（正整数）' }
  }
  if (!shotCount) {
    return { status: 409, code: 'NO_STORYBOARD', error: '这条作品还没有分镜：画面要挂在某一镜上，先在模板里拆出分镜' }
  }
  if (shotNo > shotCount) {
    return {
      status: 400,
      code: 'SHOT_NO_RANGE',
      error: '这条作品的分镜只有 ' + shotCount + ' 镜，第 ' + shotNo + ' 镜不存在',
    }
  }
  const matched = String(media || '').match(SHOT_MEDIA)
  if (!matched) {
    return { status: 400, code: 'MEDIA_INVALID', error: '画面要用自己上传的图：先在这里传一张 jpg / png / webp' }
  }
  const owner = matched[1]
  if (!admin && String(user?.id || '') !== owner) {
    return { status: 404, code: 'MEDIA_FORBIDDEN', error: '这张图不在你的账号下：画面没有记上，也没有删任何东西' }
  }
  return null
}

/**
 * 页面读的形状：模板那几镜逐镜给一行，说清「这一镜现在挂的是哪张图」。
 * 没贴过的镜也留着（frameUrl 是模板抽出来的原片帧）：让它能显示「原片帧」而不是一片空白。
 */
export function shotFrameRows(storyboard, frames) {
  const shots = Array.isArray(storyboard) ? storyboard : []
  const own = normalizeShotFrames(frames)
  return shots.map((shot, index) => {
    const shotNo = Math.max(1, Math.round(Number(shot?.shotNo) || index + 1))
    const entry = own[String(shotNo)] || null
    return {
      shotNo,
      own: Boolean(entry),
      media: entry?.media || '',
      at: entry?.at || '',
      // 原片帧：模板里记下的那一张，只作对照；贴了自己的画面就不再拿它顶
      frameUrl: String(shot?.frameUrl || ''),
    }
  })
}

/** 贴图 / 撤销之后要回给页面的那份：只回这一条作品自己的画面，不带别人的路径。 */
export function shotFramesView(frames) {
  const own = normalizeShotFrames(frames)
  const out = {}
  for (const [key, value] of Object.entries(own)) out[key] = { media: value.media, frameUrl: '/media/' + value.media, at: value.at }
  return out
}
