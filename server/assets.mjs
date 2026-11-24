// 自有资产（r311）：产品资产与数字人资产。
//
// 这是复刻链路的地基：没有「属于我自己的商品图 / 我自己的脸」，一键复刻就只能是无源之水。
// 所以注册后的第一件事不是找爆款，而是建资产 —— 建过之后，模板、画布、作品才有东西可引用。
//
// 四条边界（和素材库同一套口径，但这里更严）：
//  1) 目录第一层就是账号 id，读的时候按归属校验；别人的资产一律当不存在（404，不解释）；
//  2) 生成只能拿**自己账号**上传的素材做参考，别人 id 传进来当不存在；
//  3) 积分先扣后画、失败按张退、重复调用不多退（账本净额决定退多少）；
//  4) 新手首套免费：每个账号第一个产品资产与第一个数字人资产的 4 张图不扣积分，
//     失败作废不算用掉 —— 他连第一套都没看全，不该占掉这个名额。
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { writeFileAtomic } from './atomic-write.mjs'
import { refusal } from './public-error.mjs'
import { compressForReview } from './image-scale.mjs'
import { readMediaAsset } from './media-assets.mjs'
import { chainFor, defaultModelFor, findModel } from './media-models.mjs'
import { runImageChain } from './media-route.mjs'
import { downloadAsset, extensionFor } from './media-fetch.mjs'
import { charge, outstandingCharge, refund } from './credits.mjs'
import { ASSET_KINDS, ASSET_SLOTS, assetJobPlan, slotSpec, validAssetKind } from './asset-prompts.mjs'

const ID_PATTERN = /^asst_[a-z0-9]{6,20}_[a-z0-9]{4,12}$/
const OWNER_PATTERN = /^[A-Za-z0-9_-]{3,64}$/
const SLOT_PATTERN = /^[a-z]{3,10}$/
const NAME_CHARS = 40
const CATEGORY_CHARS = 20

export const ASSET_LIMITS = {
  // 一个账号能存几套：产品 6 套（够一个店主把主推款建完）、数字人 3 套（够做几个人设）
  product: 6,
  avatar: 3,
  sourcesProduct: 3,
  sourcesAvatar: 1,
  nameChars: NAME_CHARS,
  categoryChars: CATEGORY_CHARS,
  // 一次生成 4 张；接口一次最多回收 24 条（列表上限）
  slots: 4,
}

/** 一张资产图多少积分：和快捷创作、工作流出图同一个价，不另开一套。 */
export function assetImageCredits() {
  const spec = findModel('image', defaultModelFor('image'))
  return spec ? Number(spec.credits()) || 0 : 5
}

function safeOwner(value) {
  const id = String(value ?? '')
  return OWNER_PATTERN.test(id) ? id : ''
}

export function validAssetId(value) {
  return ID_PATTERN.test(String(value ?? '')) ? String(value) : ''
}

export function assetRoot() {
  return path.join(config.dataDir, 'assets')
}

function ownerDir(ownerId) {
  const id = safeOwner(ownerId)
  if (!id) throw refusal(400, 'ASSET_OWNER', '资产的归属账号不对')
  return path.join(assetRoot(), id)
}

function assetDir(ownerId, assetId) {
  const id = validAssetId(assetId)
  if (!id) throw refusal(400, 'ASSET_ID', '资产编号不对')
  return path.join(ownerDir(ownerId), id)
}

function nowIso() {
  return new Date().toISOString()
}

function clip(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

async function writeMeta(ownerId, meta) {
  const dir = assetDir(ownerId, meta.id)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
}

async function readMeta(ownerId, assetId) {
  const id = validAssetId(assetId)
  if (!id) return null
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(assetDir(ownerId, id), 'meta.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

/** 给前端的形状：不暴露磁盘路径，图只给一个要登录的地址。 */
export function publicAsset(meta) {
  if (!meta) return null
  const slots = ASSET_SLOTS[meta.kind] || []
  const refs = (Array.isArray(meta.refs) ? meta.refs : []).map((ref) => ({
    slot: ref.slot,
    label: ref.label || slotSpec(meta.kind, ref.slot)?.label || ref.slot,
    url: '/api/assets/' + meta.id + '/files/' + ref.slot,
    width: ref.width || null,
    height: ref.height || null,
    bytes: Number(ref.bytes) || 0,
    createdAt: ref.createdAt || '',
  }))
  return {
    id: meta.id,
    kind: meta.kind,
    name: meta.name || '',
    category: meta.category || '',
    status: meta.status || 'draft',
    progress: {
      done: Math.max(0, Number(meta.progress?.done) || 0),
      total: Math.max(1, Number(meta.progress?.total) || slots.length || 1),
    },
    sources: (Array.isArray(meta.sources) ? meta.sources : []).map((item) => ({
      id: item.id,
      name: item.name || '',
      width: item.width || null,
      height: item.height || null,
      previewUrl: '/api/media/assets/' + item.id + '/file',
    })),
    refs,
    error: meta.error || '',
    free: Boolean(meta.free),
    createdAt: meta.createdAt || '',
    updatedAt: meta.updatedAt || '',
  }
}

/** 我自己的资产列表：新的在前。读不到目录就是空，不编数字。 */
export async function listAssets(ownerId, { kind = 'all' } = {}) {
  const wanted = kind === 'all' ? '' : validAssetKind(kind)
  let entries = []
  try {
    entries = await fsp.readdir(ownerDir(ownerId), { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !validAssetId(entry.name)) continue
    const meta = await readMeta(ownerId, entry.name)
    if (!meta) continue
    if (wanted && meta.kind !== wanted) continue
    items.push(meta)
  }
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return items.map(publicAsset)
}

export async function countAssets(ownerId) {
  const items = await listAssets(ownerId)
  return {
    product: items.filter((item) => item.kind === 'product').length,
    avatar: items.filter((item) => item.kind === 'avatar').length,
  }
}

export async function getAsset(ownerId, assetId) {
  const meta = await readMeta(ownerId, assetId)
  return meta ? publicAsset(meta) : null
}

/**
 * 新建一套资产：只记名字、类目与来源图，**不扣积分、不调上游**。
 * 生成要用户再点一次 —— 建资产本身是免费的，花钱的那一下必须由他决定。
 */
export async function createAsset({ ownerId, kind, name, category = '', sourceAssetIds = [] } = {}) {
  const type = validAssetKind(kind)
  if (!type) throw refusal(400, 'ASSET_KIND', '资产类型只支持产品资产或数字人资产')
  const title = clip(name, NAME_CHARS)
  if (!title) throw refusal(400, 'ASSET_NAME', '先给它起个名字（比如商品名或人设名）')
  const maxSources = type === 'product' ? ASSET_LIMITS.sourcesProduct : ASSET_LIMITS.sourcesAvatar
  const ids = Array.isArray(sourceAssetIds) ? [...new Set(sourceAssetIds.map((item) => String(item || '')))] : []
  if (!ids.length) throw refusal(400, 'ASSET_SOURCES', '先上传素材图，生成时要拿它当参考')
  if (ids.length > maxSources) {
    throw refusal(400, 'ASSET_SOURCES', type === 'product' ? '产品资产最多 3 张素材图' : '数字人资产先用 1 张正脸照')
  }
  const counts = await countAssets(ownerId)
  if (counts[type] >= ASSET_LIMITS[type]) {
    throw refusal(400, 'ASSET_LIMIT', '这一类的资产已经到上限了（' + ASSET_LIMITS[type] + ' 套），先删掉一套再建')
  }
  const sources = []
  for (const id of ids) {
    const found = await readMediaAsset(ownerId, id)
    // 别的账号的素材当不存在：既不说「无权限」，也不透露这个 id 存不存在
    if (!found) throw refusal(400, 'ASSET_SOURCES', '有一张素材图找不到，重新上传后再建')
    sources.push({
      id: found.meta.id,
      name: found.meta.name || '',
      width: found.meta.width || null,
      height: found.meta.height || null,
    })
  }
  const now = nowIso()
  const meta = {
    version: 1,
    id: 'asst_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
    ownerId: safeOwner(ownerId),
    kind: type,
    name: title,
    category: clip(category, CATEGORY_CHARS),
    status: 'draft',
    progress: { done: 0, total: (ASSET_SLOTS[type] || []).length },
    sources,
    refs: [],
    error: '',
    free: false,
    createdAt: now,
    updatedAt: now,
  }
  await writeMeta(ownerId, meta)
  return publicAsset(meta)
}

export async function updateAsset(ownerId, assetId, patch = {}) {
  const meta = await readMeta(ownerId, assetId)
  if (!meta) throw refusal(404, 'ASSET_NOT_FOUND', '这个资产不存在')
  if (patch.name !== undefined) {
    const title = clip(patch.name, NAME_CHARS)
    if (!title) throw refusal(400, 'ASSET_NAME', '名字不能为空')
    meta.name = title
  }
  if (patch.category !== undefined) meta.category = clip(patch.category, CATEGORY_CHARS)
  meta.updatedAt = nowIso()
  await writeMeta(ownerId, meta)
  return publicAsset(meta)
}

export async function deleteAsset(ownerId, assetId) {
  const meta = await readMeta(ownerId, assetId)
  if (!meta) throw refusal(404, 'ASSET_NOT_FOUND', '这个资产不存在')
  if (inflight.has(meta.id)) {
    throw refusal(409, 'ASSET_STATUS', '这一套正在生成，等它跑完再删')
  }
  await fsp.rm(assetDir(ownerId, meta.id), { recursive: true, force: true })
  return true
}

/** 预览一张资产图：返回文件路径与 mime，不读进内存。 */
export async function resolveRefFile(ownerId, assetId, slot) {
  const key = String(slot || '')
  if (!SLOT_PATTERN.test(key)) return null
  const meta = await readMeta(ownerId, assetId)
  if (!meta) return null
  const ref = (meta.refs || []).find((item) => item.slot === key)
  if (!ref || !ref.file) return null
  const file = path.join(assetDir(ownerId, meta.id), path.basename(ref.file))
  try {
    const stat = await fsp.stat(file)
    if (!stat.size) return null
    return { file, mime: ref.mime || 'image/jpeg', size: stat.size }
  } catch {
    return null
  }
}

// ── 生成 ──────────────────────────────────────────────────────────────────
// 一次生成 4 张、每张 20~90 秒，不可能挂在 HTTP 请求上：先扣费、落 generating、立刻回，
// 后台逐张画，界面每 2.5 秒轮询一次。关掉页面任务照样跑完，结果留在资产库里。
const inflight = new Map()

export function assetGenerating(assetId) {
  return inflight.has(String(assetId || ''))
}

/** 新手首套免费用掉没有：同一类里已经有「正在生成 / 已出片」的免费套，就算用掉了。 */
async function freeSeatUsed(ownerId, kind) {
  const items = await listAssets(ownerId, { kind })
  return items.some((item) => item.free && ['generating', 'ready', 'partial'].includes(item.status))
}

/** 参考图先压到长边 1024 的 JPEG：一张手机原图几 MB，四张图都带原图发上游既慢又没必要。 */
async function prepareReference(ownerId, meta) {
  const first = (meta.sources || [])[0]
  if (!first) return null
  const found = await readMediaAsset(ownerId, first.id)
  if (!found) return null
  const scaled = await compressForReview(found.buffer, found.meta.mime || 'image/png', { maxEdge: 1024, minBytes: 0 })
  return { bytes: scaled.bytes, mime: scaled.mime || 'image/jpeg' }
}

/**
 * 开一次生成。
 * - 只有 draft / partial / failed 能开；generating 拒绝（防止连点扣两份钱）；
 * - 只补还没出的那几张（partial 之后重试不会重画已成功的）；
 * - 免费名额按「同类第一套」算，失败作废不算用掉。
 */
export async function startAssetGeneration({ ownerId, assetId } = {}) {
  const meta = await readMeta(ownerId, assetId)
  if (!meta) throw refusal(404, 'ASSET_NOT_FOUND', '这个资产不存在')
  if (meta.status === 'generating' || inflight.has(meta.id)) {
    throw refusal(409, 'ASSET_STATUS', '这一套正在生成，等它跑完再点')
  }
  if (!(meta.sources || []).length) {
    throw refusal(400, 'ASSET_SOURCES', '还没有素材图：先上传商品图 / 正脸照，生成时要拿它当参考')
  }
  const plan = assetJobPlan({ kind: meta.kind, name: meta.name, category: meta.category })
  const doneSlots = new Set((meta.refs || []).map((item) => item.slot))
  const pending = plan.filter((item) => !doneSlots.has(item.slot))
  if (!pending.length) throw refusal(400, 'ASSET_STATUS', '这一套已经全部生成好了')

  const free = !(await freeSeatUsed(ownerId, meta.kind))
  const per = free ? 0 : assetImageCredits()
  const total = per * pending.length
  const ref = 'asset:' + meta.id
  if (total > 0) {
    const paid = charge(ownerId, 'image_gen', {
      ref,
      amount: total,
      meta: { label: '资产图 · ' + String(meta.name || '').slice(0, 24) + ' · ' + pending.length + ' 张' },
    })
    if (!paid.ok) {
      throw refusal(402, 'ASSET_CREDITS', '积分不足：这 ' + pending.length + ' 张需要 ' + total + ' 积分，当前余额 ' + (paid.balance ?? 0) + ' 积分')
    }
  }

  const next = {
    ...meta,
    status: 'generating',
    free,
    progress: { done: doneSlots.size, total: plan.length },
    error: '',
    pendingSlots: pending.map((item) => item.slot),
    updatedAt: nowIso(),
  }
  await writeMeta(ownerId, next)

  // 后台跑：这里**不能** await，接口要立刻回任务状态
  inflight.set(next.id, true)
  void runGeneration({ ownerId: next.ownerId, assetId: next.id, pending, per, ref })
    .catch(() => {})
    .finally(() => inflight.delete(next.id))

  return publicAsset(next)
}

async function runGeneration({ ownerId, assetId, pending, per, ref }) {
  const meta = await readMeta(ownerId, assetId)
  if (!meta) return
  const reference = await prepareReference(ownerId, meta).catch(() => null)
  const chain = chainFor('image').map((item) => item.id)
  const failures = []

  for (const job of pending) {
    try {
      if (!job.prompt) throw new Error('这一张没有对应的提示词')
      const { result, model } = await runImageChain({
        chain,
        payload: { prompt: job.prompt, size: job.size, n: 1 },
        edit: reference ? { image: reference.bytes, mime: reference.mime, filename: 'source.' + (reference.mime === 'image/png' ? 'png' : 'jpg') } : null,
      })
      const url = Array.isArray(result?.urls) ? result.urls[0] : ''
      if (!url) throw new Error('上游没有返回图片')
      const asset = await downloadAsset(url, 'image')
      if (!asset?.buffer?.length) throw new Error('图片下载回来是空的')
      const ext = extensionFor(asset.mime, 'image', url)
      const file = job.slot + '.' + ext
      const dir = assetDir(ownerId, assetId)
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
      await fsp.writeFile(path.join(dir, file), asset.buffer, { mode: 0o600 })
      meta.refs = [...(meta.refs || []).filter((item) => item.slot !== job.slot), {
        slot: job.slot,
        label: job.label,
        file,
        mime: asset.mime,
        bytes: asset.buffer.length,
        model,
        createdAt: nowIso(),
      }]
    } catch (error) {
      failures.push({ slot: job.slot, label: job.label, error: String(error?.message || error).slice(0, 160) })
      // 按张退：这一张没出成，就不该收这张的钱
      if (per > 0) {
        try {
          const owed = outstandingCharge(ownerId, 'image_gen', ref)
          if (owed > 0) refund(ownerId, 'image_gen', { ref, amount: Math.min(per, owed), meta: { label: '资产图失败退款 · ' + job.label } })
        } catch {
          // 退款失败不掩盖真正的失败原因；账本里还留着待退
        }
      }
    }
    meta.progress = { done: (meta.refs || []).length, total: (ASSET_SLOTS[meta.kind] || []).length }
    meta.updatedAt = nowIso()
    await writeMeta(ownerId, meta).catch(() => {})
  }

  const total = (ASSET_SLOTS[meta.kind] || []).length
  const ok = (meta.refs || []).length
  meta.status = failures.length === 0 && ok >= total ? 'ready' : ok > 0 ? 'partial' : 'failed'
  meta.error = failures.length
    ? failures.map((item) => item.label + '：' + item.error).join('\n').slice(0, 600)
    : ''
  delete meta.pendingSlots
  meta.updatedAt = nowIso()
  await writeMeta(ownerId, meta).catch(() => {})
}

/**
 * 进程重启后把「卡在 generating」的资产改成失败并把钱退回去。
 *
 * 后台任务活在内存里，进程一重启就没了；不收拾的话界面会永远显示「生成中」，
 * 而扣掉的积分留在账上 —— 这正是 r209 出图失败那次的同类问题，这次一开始就兜住。
 */
export async function recoverInterruptedAssets({ olderThanMs = 15 * 60 * 1000 } = {}) {
  let owners = []
  try {
    owners = await fsp.readdir(assetRoot(), { withFileTypes: true })
  } catch {
    return 0
  }
  let recovered = 0
  const now = Date.now()
  for (const owner of owners) {
    if (!owner.isDirectory() || !OWNER_PATTERN.test(owner.name)) continue
    let dirs = []
    try {
      dirs = await fsp.readdir(path.join(assetRoot(), owner.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !validAssetId(dir.name)) continue
      const meta = await readMeta(owner.name, dir.name)
      if (!meta || meta.status !== 'generating') continue
      if (inflight.has(meta.id)) continue
      const touched = Date.parse(meta.updatedAt || '') || 0
      if (touched && now - touched < olderThanMs) continue
      meta.status = (meta.refs || []).length ? 'partial' : 'failed'
      meta.error = '服务重启，这次生成中断了；已经出的图还在，点「继续生成」补剩下的'
      meta.updatedAt = nowIso()
      delete meta.pendingSlots
      await writeMeta(owner.name, meta).catch(() => {})
      try {
        const owed = outstandingCharge(owner.name, 'image_gen', 'asset:' + meta.id)
        if (owed > 0) refund(owner.name, 'image_gen', { ref: 'asset:' + meta.id, amount: owed, meta: { label: '资产图中断退款' } })
      } catch {
        // 退不了就留在账上，后台看得见
      }
      recovered += 1
    }
  }
  return recovered
}

/** 删账号时清掉他的全部资产（图与元数据都删）。 */
export async function deleteAssetsByOwner(ownerId) {
  const id = safeOwner(ownerId)
  if (!id) return 0
  const dir = path.join(assetRoot(), id)
  let count = 0
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    count = entries.filter((entry) => entry.isDirectory() && validAssetId(entry.name)).length
  } catch {
    return 0
  }
  await fsp.rm(dir, { recursive: true, force: true })
  return count
}

export { ASSET_KINDS }
