// 运营位（用户说的「广告模块」）的真源（r320，2026-11-26）
//
// r319 把内容写在前端文件里，改一句话就要发一版——运营位天生是要随时改的东西
// （新功能说一句、活动推一下、过期就撤），所以这一步把真源搬到服务端：
//   - 后台能读、能写、能恢复默认，改完刷新页面就生效，不用发版；
//   - 内容存在数据目录的 promos.json（0600），没存过就用 DEFAULT_PROMOS；
//   - 校验只认「能渲染出来」的形状：位置在白名单里、跳转页在白名单里、字数有上限；
//   - internal 的运营位不给普通账号看：公开接口按请求者身份过滤，不是把开关交给前端。
//
// 为什么文案上限定得这么死（标题 24 / 一句话 80）：运营位在窄屏只占一列，
// 超过这个长度就会挤成三行、把首屏内容推下去——用户要的是「扫一眼知道有什么新东西」。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { writeFileAtomic } from './atomic-write.mjs'
import { storeUnreadable } from './json-store.mjs'

/** 运营位能挂的位置。加位置要同时在页面里放一个 <PromoSlot placement="…">。 */
export const PROMO_PLACEMENTS = ['overview', 'templates', 'recharge']

/** 位置的中文名，后台下拉用它，不再在界面里另写一份。 */
export const PROMO_PLACEMENT_LABELS = {
  overview: '工作台',
  templates: '模板库',
  recharge: '充值 / 积分',
}

/**
 * 运营位按钮能跳到哪些页面。这份名单必须与 src/domain/types.ts 的 Page 逐个一致，
 * 否则后台能把按钮指到一个前端不认识的地方（点了没反应）——test/promos-admin.test.mjs
 * 直接读 types.ts 比对，加页面时忘了改这里会红。
 */
export const PROMO_PAGES = [
  'login', 'overview', 'projects', 'agents', 'agent-editor', 'canvas', 'board', 'runs',
  'settings', 'radar', 'templates', 'assets', 'review', 'rooms', 'recharge', 'local',
]

export const PROMO_LIMITS = {
  /** 一份配置最多几条：再多首页就变成公告栏了。 */
  total: 12,
  /** 同一个位置最多几条（页面一屏最多显示 2 条，留几条在后面补位）。 */
  perPlacement: 5,
  id: 40,
  kicker: 12,
  title: 24,
  body: 80,
  cta: 8,
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * 首次部署、或后台点「恢复默认」之后显示的内容。
 * 写文案的三条规矩：
 *   1. 只说我们已经真跑通过的能力，不把「计划做」写成「已经能」；
 *   2. 涉及扣费就写明扣多少、失败怎么办（房间那条写的是每轮 1 积分、失败全额退回）；
 *   3. 一句话说清「点进去能拿到什么」，不写「赋能 / 一站式 / 全新升级」这类空话。
 */
export const DEFAULT_PROMOS = [
  {
    id: 'rooms-beta',
    placement: 'overview',
    weight: 20,
    kicker: 'Beta · 聊天室',
    title: '把几个智能体放进同一个房间',
    body: '房间里你说一句，平台智能体接一句：起草、拆结构、找选题。每轮 1 积分，答不上来全额退回。',
    cta: '去聊天室',
    page: 'rooms',
  },
  {
    id: 'radar-to-template',
    placement: 'overview',
    weight: 10,
    kicker: '复刻主线',
    title: '从一条爆款到一份可复用模板',
    body: '爆款雷达搜抖音与小红书，拆出钩子、结构与分镜；落进模板库就能直接拿去改编。',
    cta: '去爆款雷达',
    page: 'radar',
  },
  {
    id: 'review-evidence',
    placement: 'overview',
    weight: 0,
    kicker: '视觉评审',
    title: '按帧给结论，每条带证据',
    body: '抽帧逐条标出问题与像素锚点，评审结论可以回写到作品，作为封版依据。',
    cta: '去视觉评审',
    page: 'review',
  },
  // r322 补上充值页：位置白名单里一直有 recharge，但没有任何页面挂载点，
  // 后台配了也看不见；补挂载点的同时得给一条默认内容，否则生产（后台没存过）那个槽是空的。
  // 数字都按真实单价写（复刻 10 / 出图 5 / 4 秒视频 15），失败全额退回。
  {
    id: 'recharge-what-credits-buy',
    placement: 'recharge',
    weight: 10,
    kicker: '积分能换什么',
    title: '10 积分复刻一条片子',
    body: '复刻扣 10 积分，失败原路退回；出一张图 5 积分，4 秒视频 15 积分。',
    cta: '去复刻',
    page: 'radar',
  },
  {
    id: 'template-source-footprint',
    placement: 'templates',
    weight: 10,
    kicker: '模板库',
    title: '每条模板都记着它从哪来',
    body: '模板会写下解析来源与用了几次；改编出的作品也回指这条模板，方便回头找同款结构。',
    cta: '去爆款雷达',
    page: 'radar',
  },
]

export function promosFile() {
  return path.join(config.dataDir, 'promos.json')
}

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * 单个字段：先折叠空白，再看长度。
 * 超出上限一律报错，不静默截断——少了下半句却不告诉编辑会出现
 * 「后台里是完整的、线上少一句」这种要查半天的怪事。
 */
function checkText(value, max, label) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return { error: label + '不能为空' }
  if (text.length > max) return { error: label + '最多 ' + max + ' 个字（现在 ' + text.length + ' 个）' }
  return { value: text }
}

/** 一条运营位：能读出来就返回 { value }，不能就读出原因。 */
function normalizeItem(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const idChecked = checkText(source.id, PROMO_LIMITS.id, '标识（id）')
  if (idChecked.error) return { error: idChecked.error }
  const id = idChecked.value.toLowerCase()
  if (!ID_PATTERN.test(id)) return { error: '标识只能用英文小写、数字与横杠，例如 rooms-beta' }
  const placement = cleanText(source.placement, 20)
  if (!PROMO_PLACEMENTS.includes(placement)) {
    return { error: '位置只能是 ' + PROMO_PLACEMENTS.join(' / ') }
  }
  const kicker = checkText(source.kicker, PROMO_LIMITS.kicker, '小标签')
  if (kicker.error) return { error: kicker.error }
  const title = checkText(source.title, PROMO_LIMITS.title, '标题')
  if (title.error) return { error: title.error }
  const body = checkText(source.body, PROMO_LIMITS.body, '一句话说明')
  if (body.error) return { error: body.error }
  const cta = checkText(source.cta, PROMO_LIMITS.cta, '按钮文字')
  if (cta.error) return { error: cta.error }
  const page = cleanText(source.page, 20)
  if (!PROMO_PAGES.includes(page)) return { error: '按钮跳转的页面不认识：' + (page || '（空）') }
  const weight = Number.isFinite(Number(source.weight)) ? Math.trunc(Number(source.weight)) : 0
  const from = cleanText(source.from, 10)
  if (from && !DATE_PATTERN.test(from)) return { error: '起始日期要写成 YYYY-MM-DD' }
  const until = cleanText(source.until, 10)
  if (until && !DATE_PATTERN.test(until)) return { error: '截止日期要写成 YYYY-MM-DD' }
  if (from && until && until < from) return { error: '截止日期比起始日期还早' }
  return {
    value: {
      id,
      placement,
      weight: Math.max(-999, Math.min(999, weight)),
      kicker: kicker.value,
      title: title.value,
      body: body.value,
      cta: cta.value,
      page,
      from,
      until,
      internal: source.internal === true,
    },
  }
}

/** 校验一份待保存的运营位。错误带第几条，后台直接显示。 */
export function validatePromos(input) {
  if (!Array.isArray(input)) return { ok: false, error: '运营位要是一组数据（数组）' }
  if (input.length > PROMO_LIMITS.total) {
    return { ok: false, error: '最多 ' + PROMO_LIMITS.total + ' 条，现在有 ' + input.length + ' 条' }
  }
  const items = []
  const seen = new Set()
  for (let index = 0; index < input.length; index += 1) {
    const checked = normalizeItem(input[index])
    if (checked.error) return { ok: false, error: '第 ' + (index + 1) + ' 条：' + checked.error }
    const item = checked.value
    if (seen.has(item.id)) return { ok: false, error: '第 ' + (index + 1) + ' 条：标识 ' + item.id + ' 重复了' }
    seen.add(item.id)
    items.push(item)
  }
  for (const placement of PROMO_PLACEMENTS) {
    const count = items.filter((item) => item.placement === placement).length
    if (count > PROMO_LIMITS.perPlacement) {
      return {
        ok: false,
        error: PROMO_PLACEMENT_LABELS[placement] + '最多 ' + PROMO_LIMITS.perPlacement + ' 条（现在 ' + count + ' 条）',
      }
    }
  }
  return { ok: true, items }
}

/**
 * 读后台存的那份。
 * - 文件不存在 → null（还没在后台存过，用默认内容）
 * - 读不出来 / 不是合法 JSON → 抛 storeUnreadable：调用方不许当成「空的」往下走，
 *   否则下一次保存会把用户存过的内容整份盖掉还看不出来。
 */
export async function readPromoStore() {
  let text
  try {
    text = await fsp.readFile(promosFile(), 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw storeUnreadable('运营位', error)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw storeUnreadable('运营位', error)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw storeUnreadable('运营位', new Error('形状不对（应该是 { items: [...] }）'))
  }
  // 存进去的时候已经逐条校验过；这里再走一遍同样的校验，只为了让手改过的文件不至于把页面带崩
  const checked = validatePromos(parsed.items)
  if (!checked.ok) throw storeUnreadable('运营位', new Error(checked.error))
  return {
    items: checked.items,
    updatedAt: String(parsed.updatedAt || ''),
    updatedBy: String(parsed.updatedBy || ''),
  }
}

/**
 * 生效中的运营位：后台存过的优先，没存过（或文件坏了）用默认内容。
 * source 告诉界面这些内容从哪来：admin（后台改过）/ default（还在默认值）/ error（文件坏了，用的是默认值）。
 */
export async function resolvePromos() {
  try {
    const stored = await readPromoStore()
    if (!stored) return { items: DEFAULT_PROMOS.map((item) => ({ ...item, internal: item.internal === true })), source: 'default', updatedAt: '', updatedBy: '', error: '' }
    return { items: stored.items, source: 'admin', updatedAt: stored.updatedAt, updatedBy: stored.updatedBy, error: '' }
  } catch (error) {
    // 页面照常显示默认内容（运营位不值得让首屏报错），但把原因带出去给后台看
    return {
      items: DEFAULT_PROMOS.map((item) => ({ ...item, internal: item.internal === true })),
      source: 'error',
      updatedAt: '',
      updatedBy: '',
      error: error instanceof Error ? error.message : '运营位配置读不出来',
    }
  }
}

async function persist(items, { by }) {
  const target = promosFile()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const saved = { items, updatedAt: new Date().toISOString(), updatedBy: String(by || '').slice(0, 120) }
  await writeFileAtomic(target, JSON.stringify(saved, null, 2))
  await fsp.chmod(target, 0o600).catch(() => {})
  return saved
}

/**
 * 保存：整份覆盖（后台一次提交整组运营位，不是逐条合并——避免「改了一条，另一条还是旧的」这种半份状态）。
 * force=false 时，文件读不出来就拒绝保存：让管理员先看见「现在是坏的」，别一保存就把旧内容盖掉。
 */
export async function savePromos(input, { by = '', force = false } = {}) {
  const checked = validatePromos(input)
  if (!checked.ok) return { ok: false, error: checked.error }
  if (!force) {
    try {
      await readPromoStore()
    } catch (error) {
      return {
        ok: false,
        conflict: true,
        error: (error instanceof Error ? error.message : '运营位配置读不出来') + '。确认要覆盖就用「覆盖坏文件」。',
      }
    }
  }
  const saved = await persist(checked.items, { by })
  return { ok: true, items: saved.items, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }
}

/** 恢复默认：删掉后台那份，回到 DEFAULT_PROMOS。 */
export async function clearPromos() {
  await fsp.rm(promosFile(), { force: true })
}

/** 公开视图：普通账号看不到 internal 的运营位（不是把开关交给前端过滤）。 */
export function publicPromos(items, viewerIsAdmin) {
  return items.filter((item) => (item.internal ? viewerIsAdmin : true))
}
