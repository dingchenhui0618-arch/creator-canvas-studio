// 运营位的取数层（r320）：一个模块级的小仓库，页面上所有 <PromoSlot> 共用一份。
//
// 为什么不是每个槽各自 fetch：工作台和模板库都挂运营位，同一屏还可能有多个位置；
// 各自请求会重复打 /api/promos，而且「关掉一条」只在自己那个槽里生效——
// 同一屏另一个位置上的同一条不会跟着消失，看起来像没关掉。
//
// 顺序：先用本地缓存立刻上屏，再去服务端要一次。拉不到就保持缓存内容（或什么都不显示），
// 不弹错：运营位是装饰，不值得为它把首屏弄红；下一次打开还会再试。
import { useEffect, useSyncExternalStore } from 'react'
import { request } from './client'
import { PROMO_CACHE_KEY, PROMO_DISMISS_KEY, parsePromoCache, readDismissedPromos, type Promo } from '../domain/promos'

type PromoState = {
  items: Promo[]
  dismissed: string[]
  /** 服务端这一次有没有回过话（回过就说明缓存与线上对过账了）。 */
  fetched: boolean
}

let state: PromoState = { items: [], dismissed: [], fetched: false }
const listeners = new Set<() => void>()
let booted = false

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 隐私模式写不进去：这一次仍然生效，刷新后会回来，不打扰用户
  }
}

function setState(next: Partial<PromoState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function subscribePromos(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function promoState(): PromoState {
  return state
}

/** 关掉一条：所有挂着运营位的位置一起消失，不用各自再去读一次本地存储。 */
export function dismissPromo(id: string) {
  if (!id || state.dismissed.includes(id)) return
  const dismissed = [...state.dismissed, id]
  setState({ dismissed })
  writeLocal(PROMO_DISMISS_KEY, JSON.stringify(dismissed))
}

async function refreshPromos() {
  try {
    const result = await request<{ ok: boolean; promos: Promo[] }>('/api/promos')
    const items = Array.isArray(result?.promos) ? result.promos : []
    setState({ items, fetched: true })
    writeLocal(PROMO_CACHE_KEY, JSON.stringify(items))
  } catch {
    setState({ fetched: true })
  }
}

/** 第一次挂载时调一次：缓存先上屏，再去服务端要一次；同一次会话里不重复请求。 */
export function loadPromos(force = false) {
  if (booted && !force) return
  booted = true
  if (!state.fetched) {
    setState({
      items: parsePromoCache(readLocal(PROMO_CACHE_KEY)),
      dismissed: readDismissedPromos(readLocal(PROMO_DISMISS_KEY)),
    })
  }
  void refreshPromos()
}

/** 组件用这个：拿到当前快照，并在第一次渲染后触发一次取数。 */
export function usePromoStore(): PromoState {
  const snapshot = useSyncExternalStore(subscribePromos, promoState, promoState)
  useEffect(() => {
    loadPromos()
  }, [])
  return snapshot
}
