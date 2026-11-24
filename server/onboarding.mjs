// 注册后的身份引导（r311）。
//
// 为什么单独存一份，不进 users 表：这三项是「引导过程的状态」，不是登录身份。
// 放 SQLite 里要 ALTER TABLE、要跟着 findUserById 的 SELECT 改、导账号时还要筛，
// 而它读多写少、只有一个使用者（引导弹窗 + 资产默认类目）。一个 JSON 就够，且坏了不影响登录。
//
// 口径：
//  - identity 只认三个枚举值，别的一律拒（前端下拉也来自同一份常量）；
//  - done 一旦为真就不再弹窗；skippedAt 只说明「他这次没建资产」，不等于引导没做完；
//  - 删账号时一起删，不留没有主人的引导记录。
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.mjs'
import { writeFileAtomicSync } from './atomic-write.mjs'

export const ONBOARDING_IDENTITIES = [
  { id: 'creator', label: '自媒体创作者', hint: '做账号、要内容方向与选题' },
  { id: 'commerce', label: '电商产品生产', hint: '有商品要卖，要能反复用的商品图' },
  { id: 'agency', label: '品牌代运营', hint: '同时管几个客户，按客户建资产' },
]

export const ONBOARDING_CATEGORIES = [
  '服装',
  '美妆个护',
  '食品饮料',
  '家居日用',
  '数码 3C',
  '母婴宠物',
  '本地生活',
  '其他',
]

const IDENTITY_IDS = ONBOARDING_IDENTITIES.map((item) => item.id)

function file() {
  return path.join(config.dataDir, 'onboarding.json')
}

let cache = null

function emptyStore() {
  return { users: {} }
}

function load() {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'))
    cache = parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object' ? parsed : emptyStore()
  } catch {
    // 文件不存在或内容坏了：按空表处理。引导状态丢了最坏只是再弹一次，不该挡住整个界面。
    cache = emptyStore()
  }
  return cache
}

function persist(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  writeFileAtomicSync(file(), JSON.stringify(data, null, 2))
}

function recordOf(entry) {
  return {
    identity: entry?.identity || '',
    category: entry?.category || '',
    direction: entry?.direction || '',
    identityAt: entry?.identityAt || null,
    doneAt: entry?.doneAt || null,
    skippedAt: entry?.skippedAt || null,
    updatedAt: entry?.updatedAt || null,
  }
}

export function validIdentity(value) {
  return IDENTITY_IDS.includes(String(value || '')) ? String(value) : ''
}

export function validCategory(value) {
  const text = String(value || '').trim()
  return ONBOARDING_CATEGORIES.includes(text) ? text : ''
}

/** 账号的引导状态；没记录过就是「什么都没选、也没做完」。 */
export function onboardingOf(userId) {
  const id = String(userId || '')
  const entry = id ? load().users[id] : null
  return recordOf(entry)
}

/**
 * 保存身份三件事。identity 必填且必须是枚举值；category / direction 是补充信息，
 * 传空表示清掉（用户可能想改回未选）。
 */
export function saveIdentity(userId, patch = {}) {
  const id = String(userId || '').trim()
  if (!id) return recordOf(null)
  const data = load()
  const current = data.users[id] || {}
  const next = { ...current, updatedAt: new Date().toISOString() }
  const identity = validIdentity(patch.identity)
  if (identity) {
    next.identity = identity
    if (!next.identityAt) next.identityAt = next.updatedAt
  }
  if (patch.category !== undefined) next.category = validCategory(patch.category)
  if (patch.direction !== undefined) {
    next.direction = String(patch.direction || '').replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20)
  }
  data.users[id] = next
  persist(data)
  return recordOf(next)
}

/** 引导收尾。skipAssets 只记一笔「这次没建资产」，不改 done —— 弹窗关了就不该再弹。 */
export function markComplete(userId, { skipAssets = false } = {}) {
  const id = String(userId || '').trim()
  if (!id) return recordOf(null)
  const data = load()
  const current = data.users[id] || {}
  const now = new Date().toISOString()
  const next = { ...current, updatedAt: now }
  if (!next.doneAt) next.doneAt = now
  if (skipAssets) next.skippedAt = now
  data.users[id] = next
  persist(data)
  return recordOf(next)
}

export function removeOnboarding(userId) {
  const id = String(userId || '').trim()
  if (!id) return false
  const data = load()
  if (!data.users[id]) return false
  delete data.users[id]
  persist(data)
  return true
}

/** 引导状态 + 「还缺什么」：前端据此决定弹窗停在哪一步、工作台要不要提示。 */
export function onboardingView(userId, counts = { product: 0, avatar: 0 }) {
  const record = onboardingOf(userId)
  const product = Math.max(0, Number(counts.product) || 0)
  const avatar = Math.max(0, Number(counts.avatar) || 0)
  return {
    ...record,
    done: Boolean(record.doneAt),
    counts: { product, avatar },
    needs: {
      identity: !record.identity,
      // 建过任何一件资产就算过；一件都没有才算还缺
      asset: product + avatar === 0,
    },
    identities: ONBOARDING_IDENTITIES,
    categories: ONBOARDING_CATEGORIES,
  }
}
