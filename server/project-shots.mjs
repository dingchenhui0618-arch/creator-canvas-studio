// 作品的「画面」（v0.9.161）：分镜每一镜可以挂一张自己的画面。
//
// 为什么挂在作品上、不写进模板：分镜跟着模板走（模板是原片拆出来的，可能被别人也用着），
// 而「这一镜我打算这么拍」是你自己的东西，只属于这条作品的这一版。模板里一个字不动。
//
// 三条边界：
//   1) 只认自己账号下的图：手贴的走上传素材（uploads/<账号>/<文件名>），
//      工作流回贴的走分镜画面库（shotframes/<账号>/<作品>/<文件名>，r279），两边同一道归属校验；
//   2) 镜头号必须是模板分镜里存在的那几镜——没有分镜就没有「第几镜」，不凭空造一个；
//   3) 传空等于撤销：这一镜回到「还没贴画面」，不删除那张图本身（那张图可能还被别的镜用着）。
//
// r278 补上「运行画完的图怎么回来」：工作流按分镜出图之后，那些图躺在 runs/<runId>/ 里，
// 作品页以前只能一镜一镜手动「贴画面」。现在一并贴回来，并且记下这批图是哪次运行画的（from），
// 同一次运行再贴一次不会重复占位置，也不该把已经换成别人手贴的画面又盖回去。
/** 一条作品最多记几镜的画面：模板分镜上限 24 镜，留一倍余量，防止脏数据把记录撑大。 */
export const MAX_SHOT_FRAMES = 48

/**
 * 手贴的画面：uploads/<账号>/<文件名>——与 /api/review 的 media 是同一套写法，评审那条链路不用改。
 * 这是「用户自己传进来的一张图」，所以贴上去只是记个引用，不复制字节。
 */
export const SHOT_MEDIA_UPLOAD = /^uploads\/([A-Za-z0-9_-]{3,64})\/([A-Za-z0-9._-]{1,80})$/

/**
 * 回贴的画面：shotframes/<账号>/<作品>/<文件名>——工作流跑完画的图，存进分镜画面库（r279）。
 * 文件名按分镜画面库自己的起名规则卡死（时间戳-随机串.扩展名）：这里没有历史数据要兼容，
 * 不许写入一条「存进去却永远读不出来」的路径。
 */
export const SHOT_MEDIA_STORE = /^shotframes\/([A-Za-z0-9_-]{3,64})\/([A-Za-z0-9_-]{3,64})\/(\d{10,16}-[0-9a-f]{8,24}\.(?:jpg|png|webp))$/

/** 老名字（r278 只有一种来源时留下的）：现存的代码都改用 parseShotMedia。 */
export const SHOT_MEDIA = SHOT_MEDIA_UPLOAD

/**
 * 认一条画面路径：返回 { kind: 'upload' | 'store', ownerId, projectId, name } 或 null。
 * kind 决定「这张图从哪读」：upload 走上传素材（要登录、只给本人），store 走分镜画面库（同样只给本人）。
 * projectId 只有 store 才有：分镜画面是某一条作品的产物，不能挂到别的作品上。
 */
export function parseShotMedia(media) {
  const value = String(media ?? '')
  const upload = value.match(SHOT_MEDIA_UPLOAD)
  if (upload) return { kind: 'upload', ownerId: upload[1], projectId: '', name: upload[2] }
  const store = value.match(SHOT_MEDIA_STORE)
  if (store) return { kind: 'store', ownerId: store[1], projectId: store[2], name: store[3] }
  return null
}

/**
 * 开工作流时按分镜建的出图节点 id：n_shot_01、n_shot_12（见 server/script-draft.mjs）。
 * 只认这个形状——用户自己拉出来的出图节点没有镜号，就不该被当成「第几镜」。
 */
export const SHOT_NODE = /^n_shot_(\d{2})$/

/** 这批画面是哪次运行画的：运行号写进记录，再贴一次时据此判断「已经是这次的了」。 */
export const SHOT_RUN = /^run_[A-Za-z0-9_-]{3,60}$/

/** 镜头号只认正整数：'1'、1 都算第 1 镜，'1.5'、'第1镜' 都不算。 */
export function normalizeShotNo(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1 || n > MAX_SHOT_FRAMES) return 0
  return Math.round(n) === n ? n : 0
}

/**
 * 记录形状：{ "1": { media, at, from } }。
 * 读的时候不猜：不是 uploads/ 或 shotframes/ 开头的、镜头号不认识的、时间不是时间的，一律丢掉；
 * from 是可选的一项（这批图是哪次运行画的），不是运行号的就不认，其余照旧。
 */
export function normalizeShotFrames(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    const shotNo = normalizeShotNo(key)
    if (!shotNo) continue
    const media = String(value?.media || '')
    if (!parseShotMedia(media)) continue
    const at = String(value?.at || '')
    if (!at || Number.isNaN(Date.parse(at))) continue
    const from = String(value?.from || '')
    out[String(shotNo)] = SHOT_RUN.test(from) ? { media, at, from } : { media, at }
  }
  return out
}

/**
 * 能不能把这把图挂到这一镜：返回 null 表示可以，否则返回要回给页面的状态。
 * 与评审入口同一句话术：不属于你的图说「不在你的账号下」，不说「不存在」（不泄露别人的文件在不在）。
 * projectId（r279）：分镜画面库里的一条画面只属于画它的那条作品，挂到别的作品上不算。
 */
export function shotFrameBlock({ media, user, shotNo, shotCount, admin = false, projectId = '' }) {
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
  const parsed = parseShotMedia(media)
  if (!parsed) {
    // 传空 = 撤销这一镜（页面上的「用回原片」）。镜头号与分镜范围上面已经核过了，
    // 空不空都只改这一条作品的这一镜，不碰任何文件，所以这里放行。
    // （r278 实测发现：以前这行把空值也当「不是自己的图」挡成 400，撤销按钮点了只会弹一句报错。）
    if (!String(media || '')) return null
    return { status: 400, code: 'MEDIA_INVALID', error: '画面要用自己账号下的图：在这里传一张 jpg / png / webp，或者跑完工作流点「贴回分镜」' }
  }
  if (!admin && String(user?.id || '') !== parsed.ownerId) {
    return { status: 404, code: 'MEDIA_FORBIDDEN', error: '这张图不在你的账号下：画面没有记上，也没有删任何东西' }
  }
  const scope = String(projectId || '')
  if (parsed.kind === 'store' && scope && parsed.projectId !== scope) {
    return { status: 400, code: 'MEDIA_INVALID', error: '这张画面是另一条作品的：工作流画面只能贴回画它的那条作品' }
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
  for (const [key, value] of Object.entries(own)) {
    out[key] = { media: value.media, frameUrl: '/media/' + value.media, at: value.at }
    if (value.from) out[key].from = value.from
  }
  return out
}

/**
 * 这次运行里「按分镜画出来的」那几张图（r278）：节点 id → 第几镜，镜头号必须在这条作品的分镜里。
 *
 * 只认真正画成的（status === 'success'）：跳过、失败、还没跑的节点都不算，
 * 失败的那几张在运行记录里已经写明原因，这里不拿一张不存在的图去占镜头。
 * 同一个镜头号出现两次（用户复制了节点）只算第一次，后一张不悄悄顶掉前一张。
 */
export function runShotImages(run, shotCount) {
  const cap = Math.max(0, Math.min(MAX_SHOT_FRAMES, Math.floor(Number(shotCount) || 0)))
  const out = []
  if (!cap) return out
  const seen = new Set()
  for (const node of Array.isArray(run?.nodes) ? run.nodes : []) {
    if (!node || node.kind !== 'image' || node.status !== 'success') continue
    const matched = String(node.id || '').match(SHOT_NODE)
    if (!matched) continue
    const shotNo = Number(matched[1])
    if (!(shotNo >= 1) || shotNo > cap || seen.has(shotNo)) continue
    const path = String(node.output?.imagePath || '')
    const file = path.startsWith('runs/') ? path.split('/').pop() || '' : ''
    if (!/^[A-Za-z0-9_-]{1,80}\.(png|jpg|jpeg|webp|gif)$/i.test(file)) continue
    seen.add(shotNo)
    out.push({ shotNo, file })
  }
  out.sort((a, b) => a.shotNo - b.shotNo)
  return out
}

/**
 * 回贴之前先分两堆（r278）：这一镜已经记着这次运行的图 → kept，不必再复制一份；
 * 其余的才要复制成上传素材再写记录。不先分的话，重贴一次会白复制 8 张图再全丢掉。
 */
export function planRunAttach(images, frames, runId) {
  const own = normalizeShotFrames(frames)
  const toCopy = []
  const kept = []
  const id = String(runId || '')
  for (const image of Array.isArray(images) ? images : []) {
    const before = own[String(image.shotNo)]
    if (before && id && before.from === id) kept.push(image.shotNo)
    else toCopy.push(image)
  }
  return { toCopy, kept }
}
