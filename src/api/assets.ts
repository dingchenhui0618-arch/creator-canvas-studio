// 自有资产与注册后身份引导：与 server/routes/assets.mjs 一一对应（r311 契约见
// docs/r311-asset-onboarding-contract.md）。生成是后台任务：POST /generate 立刻回
// generating，之后由 watchAsset 每 2.5 秒拿一次 GET /api/assets/:id，直到 ready/partial/failed。
import { request } from './client'
import { uploadMediaAsset } from './media-gen'

export type AssetKind = 'product' | 'avatar'

export type AssetStatus = 'draft' | 'generating' | 'ready' | 'partial' | 'failed'

export type AssetRef = {
  slot: string
  label: string
  /** /api/assets/<id>/files/<slot>：要登录，别人的一律 404 */
  url: string
  width: number | null
  height: number | null
  bytes: number
  createdAt: string
}

export type AssetSource = {
  /** 上传素材 id（ast_ 开头），生成时拿它当参考 */
  id: string
  name: string
  width: number | null
  height: number | null
  previewUrl: string
}

export type Asset = {
  id: string
  kind: AssetKind
  name: string
  category: string
  status: AssetStatus
  progress: { done: number; total: number }
  sources: AssetSource[]
  refs: AssetRef[]
  error: string
  /** 这一套走的是新手免费额度（0 积分） */
  free: boolean
  createdAt: string
  updatedAt: string
}

export type AssetLimits = {
  product: number
  avatar: number
  sourcesProduct: number
  sourcesAvatar: number
  freeSlots: number
  paidCreditsPerImage: number
}

export type AssetListResponse = { ok: boolean; items: Asset[]; limits: AssetLimits }

export type AssetResponse = { ok: boolean; asset: Asset }

export type OnboardingIdentityId = 'creator' | 'commerce' | 'agency'

export type OnboardingIdentity = { id: OnboardingIdentityId; label: string; hint: string }

export type OnboardingState = {
  ok: boolean
  identity: OnboardingIdentityId | ''
  category: string
  direction: string
  identityAt: string | null
  doneAt: string | null
  done: boolean
  skippedAt: string | null
  counts: { product: number; avatar: number }
  needs: { identity: boolean; asset: boolean }
  /** 后端把可选身份与类目一起下发；缺省时用下面的同一份常量兜底 */
  identities?: OnboardingIdentity[]
  categories?: string[]
}

/** 一次生成的张数与轮询间隔：服务端固定 4 张、每张 20–90 秒。 */
export const ASSET_POLL_MS = 2500
export const ASSET_NAME_MAX = 40
export const ASSET_CATEGORY_MAX = 20
export const ONBOARDING_DIRECTION_MAX = 20

/** 槽位定义与 server/asset-prompts.mjs 同源；顺序就是生成顺序与界面顺序。 */
export const ASSET_SLOTS: Record<AssetKind, ReadonlyArray<{ slot: string; label: string; hint: string }>> = {
  product: [
    { slot: 'hero', label: '白底主图', hint: '纯白背景、商品居中' },
    { slot: 'scene', label: '场景图', hint: '生活场景、背景虚化' },
    { slot: 'detail', label: '细节特写', hint: '材质与缝线的微距' },
    { slot: 'pack', label: '成套平铺', hint: '商品与配件俯拍平铺' },
  ],
  avatar: [
    { slot: 'front', label: '正面定妆', hint: '肩部以上、看镜头' },
    { slot: 'half', label: '半身景别', hint: '微微侧身、自然微笑' },
    { slot: 'side', label: '侧脸角度', hint: '三分之四侧脸' },
    { slot: 'action', label: '场景中使用', hint: '室内环境、生活抓拍' },
  ],
}

export const ASSET_KIND_META: Record<
  AssetKind,
  { label: string; short: string; hint: string; sourceHint: string; sourceMax: number }
> = {
  product: {
    label: '产品资产',
    short: '产品',
    hint: '同一件商品的白底主图、场景图、细节与平铺',
    sourceHint: '上传 1–3 张商品图：正面、细节或包装都行，图片要清楚',
    sourceMax: 3,
  },
  avatar: {
    label: '数字人资产',
    short: '数字人',
    hint: '同一张脸的正面、半身、侧脸与场景定妆照（只做参考图，不做唇形驱动）',
    sourceHint: '上传 1 张清楚的正脸照：光线均匀、不戴墨镜、不用滤镜',
    sourceMax: 1,
  },
}

export const ASSET_STATUS_META: Record<AssetStatus, { label: string; tone: 'idle' | 'live' | 'pass' | 'warn' | 'fail' }> = {
  draft: { label: '待生成', tone: 'idle' },
  generating: { label: '生成中', tone: 'live' },
  ready: { label: '已生成', tone: 'pass' },
  partial: { label: '部分完成', tone: 'warn' },
  failed: { label: '生成失败', tone: 'fail' },
}

/** 后端 /api/onboarding 会下发这两份；接口还没接上时用同一份常量兜底。 */
export const ONBOARDING_IDENTITIES: readonly OnboardingIdentity[] = [
  { id: 'creator', label: '自媒体创作者', hint: '做账号、要内容方向与选题' },
  { id: 'commerce', label: '电商产品生产', hint: '有商品要卖，要能反复用的商品图' },
  { id: 'agency', label: '品牌代运营', hint: '同时管几个客户，按客户建资产' },
]

export const ONBOARDING_CATEGORIES: readonly string[] = [
  '服装',
  '美妆个护',
  '食品饮料',
  '家居日用',
  '数码 3C',
  '母婴宠物',
  '本地生活',
  '其他',
]

export function slotsFor(kind: AssetKind) {
  return ASSET_SLOTS[kind] ?? []
}

export function slotLabel(kind: AssetKind, slot: string): string {
  return slotsFor(kind).find((item) => item.slot === slot)?.label ?? slot
}

export function assetKindLabel(kind: AssetKind): string {
  return ASSET_KIND_META[kind]?.label ?? kind
}

/**
 * 资产张数上限：接口没回来时按后端口径兜底，界面不会因为少一个字段就画不出上限。
 * 单价不兜底（0 表示未知）：价格由服务端 limits.paidCreditsPerImage 决定，
 * 前端写死一个数迟早会和实际扣费对不上。
 */
export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  product: 6,
  avatar: 3,
  sourcesProduct: 3,
  sourcesAvatar: 1,
  freeSlots: 4,
  paidCreditsPerImage: 0,
}

/** 后端错误形状 { error, code }；code 用来区分「积分不足 / 上限 / 正在生成」这类可行动的分支。 */
export type AssetErrorInfo = { message: string; code: string; status: number }

export function assetErrorInfo(caught: unknown): AssetErrorInfo {
  if (caught && typeof caught === 'object') {
    const error = caught as { message?: string; status?: number; body?: { code?: string } }
    return {
      message: String(error.message || '请求没有完成'),
      code: String(error.body?.code || ''),
      status: Number(error.status) || 0,
    }
  }
  return { message: String(caught || '请求没有完成'), code: '', status: 0 }
}

export const listAssets = (kind: AssetKind | 'all' = 'all') =>
  request<AssetListResponse>('/api/assets?kind=' + encodeURIComponent(kind))

export const getAsset = (id: string) => request<AssetResponse>('/api/assets/' + encodeURIComponent(id))

export const createAsset = (input: { kind: AssetKind; name: string; category?: string; sourceAssetIds: string[] }) =>
  request<AssetResponse>('/api/assets', { method: 'POST', body: JSON.stringify(input) })

/** 立刻返回 generating；之后用 watchAsset 轮询，关掉页面任务也会在服务端跑完。 */
export const generateAsset = (id: string) =>
  request<AssetResponse>('/api/assets/' + encodeURIComponent(id) + '/generate', { method: 'POST' })

export const updateAsset = (id: string, patch: { name?: string; category?: string }) =>
  request<AssetResponse>('/api/assets/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(patch) })

export const deleteAsset = (id: string) =>
  request<{ ok: boolean }>('/api/assets/' + encodeURIComponent(id), { method: 'DELETE' })

export const getOnboarding = (signal?: AbortSignal) => request<OnboardingState>('/api/onboarding', { signal })

export const saveOnboarding = (input: { identity: OnboardingIdentityId; category?: string; direction?: string }) =>
  request<OnboardingState>('/api/onboarding', { method: 'PUT', body: JSON.stringify(input) })

export const completeOnboarding = (skipAssets: boolean) =>
  request<OnboardingState>('/api/onboarding/complete', {
    method: 'POST',
    body: JSON.stringify({ skipAssets }),
  })

/** 来源图复用媒体库的上传通道（原始字节，不是 multipart）。 */
export function uploadSourceImage(file: File) {
  return uploadMediaAsset({ file })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 盯着一条资产直到它不再是 generating。
 * 取消（切页 / 关弹窗）只停止轮询，服务端任务照常跑完；下次读列表还能看到进度。
 */
export async function watchAsset(
  id: string,
  onUpdate: (asset: Asset) => void,
  signal?: AbortSignal,
): Promise<Asset> {
  let asset = (await getAsset(id)).asset
  onUpdate(asset)
  while (asset.status === 'generating') {
    await sleep(ASSET_POLL_MS, signal)
    if (signal?.aborted) return asset
    asset = (await getAsset(id)).asset
    onUpdate(asset)
  }
  return asset
}
