// 「作品」→「快捷创作」的一次交接（r229）。
//
// 为什么要中转：作品流里点「用作参考」时，文件已经在服务端了（/api/media/tasks/<id>/file、
// /api/runs/.../assets/...、/api/works/canvas-file?...），上传成素材也在作品页算得出来；
// 但「挂到哪种生成方式上」的规则只在快捷创作里（domain/media-refs）。所以作品页只负责
// 「取回字节 → 传成素材」，把素材号放进 sessionStorage，跳过去由快捷创作挂上。
//
// 只走 sessionStorage 的理由：这是一次性的跳转，不该跨标签页、也不该留到下次打开；
// 读完就删，避免同一个素材被反复挂进另一段对话。
import type { RefKind } from './media-refs'

export const REF_HANDOFF_KEY = 'vq:ref-handoff'

export type RefHandoff = {
  /** 已经落在服务端的素材号 */
  assetId: string
  kind: RefKind
  name: string
  /** 从哪来：作品卡上的来源（快捷创作 / 工作流 / 无限画布），只用于说明 */
  from: string
  /** 作品自己的比例：带过去的图是 9:16，出图就别默认落回 1:1 */
  ratio?: string
}

/** 只认界面上真出现过的这几档比例：其余一律丢掉，当作没带 */
const RATIOS = new Set(['1:1', '9:16', '16:9', '4:3', '3:4'])

function parse(raw: string | null | undefined): RefHandoff | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : ''
  // 素材号只可能是服务端生成的 [A-Za-z0-9_-]：别的值一律不认，免得把任意字符串带进请求
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(assetId)) return null
  const kind = input.kind === 'video' ? 'video' : input.kind === 'image' ? 'image' : ''
  if (!kind) return null
  const ratio = typeof input.ratio === 'string' && RATIOS.has(input.ratio) ? input.ratio : ''
  return {
    assetId,
    kind,
    name: typeof input.name === 'string' ? input.name.slice(0, 120) : '',
    from: typeof input.from === 'string' ? input.from.slice(0, 24) : '',
    ...(ratio ? { ratio } : {}),
  }
}

function storageOf(storage: Storage | null | undefined): Storage | null {
  return storage && typeof storage.getItem === 'function' ? storage : null
}

/** 记下一次交接。存不进去（隐私模式 / 配额满）不算错，只是跳过去以后不会自动挂上。 */
export function writeRefHandoff(storage: Storage | null | undefined, input: RefHandoff): boolean {
  const target = storageOf(storage)
  if (!target) return false
  try {
    target.setItem(REF_HANDOFF_KEY, JSON.stringify(input))
    return true
  } catch {
    return false
  }
}

/** 看一眼，不删：页面挂载时要先知道切到哪个页签，等素材挂上才算用掉。 */
export function peekRefHandoff(storage: Storage | null | undefined): RefHandoff | null {
  const target = storageOf(storage)
  if (!target) return null
  try {
    return parse(target.getItem(REF_HANDOFF_KEY))
  } catch {
    return null
  }
}

/** 用掉了：读出来顺手删掉，同一个素材不会在下次进来时又挂一遍。 */
export function takeRefHandoff(storage: Storage | null | undefined): RefHandoff | null {
  const found = peekRefHandoff(storage)
  const target = storageOf(storage)
  if (target) {
    try {
      target.removeItem(REF_HANDOFF_KEY)
    } catch {
      // 删不掉也不影响这次交接：读的时候已经拿到了
    }
  }
  return found
}
