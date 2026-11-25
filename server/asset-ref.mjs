// 资产引用（r312）：把「我自己的商品图 / 我自己的脸」引用到出图、出视频与工作流节点里。
//
// 为什么要有这一层：r311 只把资产建出来了，但模板出图、工作流出图、出视频都还是纯文生图，
// 画出来的商品跟手里那件没关系 —— 资产建了却用不上，等于白建。
// 这一层只做一件事：把一个**字符串引用**（asst_xxx:hero）换成「这次生成可用的参考图字节」。
//
// 四条边界：
//  1) 引用格式是死的：asst_<32进制时间戳>_<4位以上十六进制>:<槽位名>，解析不出来的当不存在；
//  2) 归属先判：别人的资产 / 已删的资产 / 还没出图的槽位，一律当作「这套资产图不在了」，
//     不解释它存在与否（与资产库同一套口径，见 server/assets.mjs）；
//  3) 发上游前压到长边 1024 的 JPEG：一张手机原图几 MB，四张图都带原图发既慢又没必要；
//  4) 只读不写：这里不改资产状态、不扣积分 —— 花钱的那一下归调用方（出图 / 出视频节点自己记账）。
import fsp from 'node:fs/promises'
import { compressForReview } from './image-scale.mjs'
import { refusal } from './public-error.mjs'
import { getAsset, listAssets, resolveRefFile } from './assets.mjs'
import { slotSpec } from './asset-prompts.mjs'

/** 资产引用的唯一格式：asst_<ts36>_<hex4>:<slot>。与 server/assets.mjs 的 ID_PATTERN 对齐。 */
export const ASSET_REF = /^asst_[a-z0-9]{6,20}_[a-z0-9]{4,12}:[a-z]{3,10}$/

/** 认一条资产引用：不合法回空串（调用方据此当「没选资产」，而不是报错炸掉整次运行）。 */
export function normalizeAssetRef(value) {
  const text = String(value ?? '').trim()
  return ASSET_REF.test(text) ? text : ''
}

/** 拆开引用：返回 { assetId, slot } 或 null。 */
export function splitAssetRef(value) {
  const text = normalizeAssetRef(value)
  if (!text) return null
  const index = text.indexOf(':')
  return { assetId: text.slice(0, index), slot: text.slice(index + 1) }
}

/** 拼一条引用：assetId + 槽位 → asst_xxx:hero；拼不出来回空串。 */
export function assetRefToken(assetId, slot) {
  const id = String(assetId ?? '').trim()
  const key = String(slot ?? '').trim()
  return normalizeAssetRef(id + ':' + key)
}

/** 一句人话：产品「美式咖啡机 · 白底主图」，数字人「小林 · 正面定妆」。 */
export function assetRefLabel(asset, slot) {
  const kindLabel = asset?.kind === 'avatar' ? '数字人' : '产品'
  const slotLabel = slotSpec(asset?.kind, slot)?.label || slot
  const name = String(asset?.name || '').trim() || '未命名资产'
  return kindLabel + '「' + name + '」· ' + slotLabel
}

function missing() {
  return refusal(400, 'ASSET_REF_MISSING', '这套资产图不在了（可能被删了，或这一张还没生成出来）：重新选一张再生成')
}

/**
 * 读出这次生成要用的参考图字节。
 * 返回 { token, assetId, slot, kind, name, label, mime, filename, buffer }；读不到直接抛 ASSET_REF_MISSING。
 * 调用方要在**扣费之前**调它：资产没了就不该先扣钱再报错。
 */
export async function readAssetReference(ownerId, value) {
  const parts = splitAssetRef(value)
  if (!parts) throw missing()
  const asset = await getAsset(ownerId, parts.assetId)
  if (!asset) throw missing()
  const found = await resolveRefFile(ownerId, parts.assetId, parts.slot)
  if (!found) throw missing()
  let raw
  try {
    raw = await fsp.readFile(found.file)
  } catch {
    throw missing()
  }
  if (!raw?.length) throw missing()
  const scaled = await compressForReview(raw, found.mime || 'image/jpeg', { maxEdge: 1024, minBytes: 0 })
  const bytes = scaled?.bytes?.length ? scaled.bytes : raw
  const mime = scaled?.mime || found.mime || 'image/jpeg'
  return {
    token: assetRefToken(parts.assetId, parts.slot),
    assetId: parts.assetId,
    slot: parts.slot,
    kind: asset.kind,
    name: asset.name || '',
    label: assetRefLabel(asset, parts.slot),
    mime,
    filename: 'asset.' + (mime === 'image/png' ? 'png' : 'jpg'),
    buffer: bytes,
  }
}

/**
 * 给选择器用的一张清单：只列「已经有图」的槽位。
 * 没生成的槽位不该出现在下拉里 —— 选了才知道没图，那是让用户白点一次。
 */
export async function listAssetRefOptions(ownerId) {
  const items = await listAssets(ownerId, { kind: 'all' })
  const rows = []
  for (const asset of items) {
    if (!['ready', 'partial'].includes(String(asset.status || ''))) continue
    for (const ref of asset.refs || []) {
      const token = assetRefToken(asset.id, ref.slot)
      if (!token) continue
      rows.push({
        id: token,
        assetId: asset.id,
        kind: asset.kind,
        name: asset.name || '',
        slot: ref.slot,
        label: ref.label || slotSpec(asset.kind, ref.slot)?.label || ref.slot,
        full: assetRefLabel(asset, ref.slot),
        url: '/api/assets/' + asset.id + '/files/' + ref.slot,
        width: ref.width || null,
        height: ref.height || null,
      })
    }
  }
  return rows
}
