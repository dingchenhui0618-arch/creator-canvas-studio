import {
  Activity,
  Boxes,
  Coins,
  Flag,
  Frame,
  Gauge,
  LayoutTemplate,
  MessageSquare,
  Receipt,
  ScrollText,
  Settings2,
  Users,
  type LucideIcon,
} from 'lucide-react'

// 两个形态：用户生产版是唯一对外形态；后台管理版只给运维用，从 URL 进入，不在用户导航里露出。
// 之前的「内测测试版」（接口体检 / 样例对照 / 功能开关 / 诊断导出）整块删除：
// 那一整个人面全是未接线的开关和示例数据，对外发布时属于演示残留。
export type EditionId = 'user' | 'admin'

export type AdminSection =
  | 'overview'
  | 'users'
  | 'canvas'
  | 'keys'
  | 'models'
  | 'templates'
  | 'usage'
  | 'billing'
  | 'reports'
  | 'feedback'
  | 'audit'
  | 'system'

export type EditionNavItem = {
  id: string
  label: string
  icon: LucideIcon
  section?: string
}

export type EditionMeta = {
  id: EditionId
  label: string
  mono: string
  hint: string
  nav: EditionNavItem[]
}

export const EDITIONS: EditionMeta[] = [
  {
    id: 'user',
    label: '用户生产版',
    mono: 'PRODUCTION',
    hint: '检索、复刻、模板、快捷创作、工作流、无限画布',
    nav: [],
  },
  {
    id: 'admin',
    label: '后台管理版',
    mono: 'ADMIN',
    hint: '模板治理、运行审计、系统状态',
    nav: [
      { id: 'overview', label: '总览', icon: Gauge, section: 'overview' },
      { id: 'users', label: '账号', icon: Users, section: 'users' },
      { id: 'canvas', label: '无限画布', icon: Frame, section: 'canvas' },
      { id: 'models', label: '模型与上游', icon: Boxes, section: 'models' },
      { id: 'templates', label: '模板治理', icon: LayoutTemplate, section: 'templates' },
      { id: 'usage', label: '成本', icon: Coins, section: 'usage' },
      { id: 'billing', label: '计费', icon: Receipt, section: 'billing' },
      { id: 'reports', label: '举报处理', icon: Flag, section: 'reports' },
      { id: 'feedback', label: '反馈', icon: MessageSquare, section: 'feedback' },
      { id: 'audit', label: '运行审计', icon: ScrollText, section: 'audit' },
      { id: 'system', label: '系统', icon: Settings2, section: 'system' },
    ],
  },
]

export const EDITION_BY_ID: Record<EditionId, EditionMeta> = EDITIONS.reduce(
  (accumulator, edition) => ({ ...accumulator, [edition.id]: edition }),
  {} as Record<EditionId, EditionMeta>,
)

export const DEFAULT_EDITION: EditionId = 'user'

export const EDITION_STORAGE_KEY = 'vq.edition'

/** 后台没有指定 section 时落在这里；路由与 App 共用，避免两处各写一个默认值。 */
export const DEFAULT_ADMIN_SECTION: AdminSection =
  (EDITION_BY_ID.admin.nav[0]?.section as AdminSection | undefined) ?? 'overview'

export type EditionResolution = {
  /** 地址栏查询串，直接传 window.location.search 即可；不带开头的 ? 也认。 */
  search: string
  /** localStorage 里的 vq.edition 原值；不是 admin/user 就忽略。 */
  stored: string | null
  /** 当前会话用户是否管理员。非管理员一律回用户生产版。 */
  isAdmin: boolean
}

/**
 * 形态判定的唯一真源（纯函数，Node 可直接测）。
 *
 * 顺序很重要：先看人，再看地址栏，最后才看本机记忆。
 * - 非管理员：无论 ?edition=admin 还是本机残留 vq.edition=admin，都只能停在用户版；
 * - 管理员：地址栏显式指定优先，其次沿用上次记忆，最后才是默认用户版。
 * 这里只做前端落点，不是安全边界；真正的数据权限仍由 /api/admin/* 的 isAdmin 校验。
 */
export function resolveEdition({ search, stored, isAdmin }: EditionResolution): EditionId {
  if (!isAdmin) return 'user'
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const requested = params.get('edition')
  if (requested === 'admin' || requested === 'user') return requested
  if (stored === 'admin' || stored === 'user') return stored
  return DEFAULT_EDITION
}

/** 只读本机记忆；存储不可用时按「没有记住」处理。 */
export function readStoredEdition(): string | null {
  try {
    return window.localStorage.getItem(EDITION_STORAGE_KEY)
  } catch {
    return null
  }
}

/** 记住形态。只应由管理员的会话调用；存储不可用时静默忽略。 */
export function rememberEdition(edition: EditionId): void {
  try {
    window.localStorage.setItem(EDITION_STORAGE_KEY, edition)
  } catch {
    // 隐私模式下写不进去，本次会话仍然按 resolveEdition 的结果走
  }
}

/**
 * 对外默认永远是用户生产版。后台只有一个入口：地址栏加 ?edition=admin。
 * 这样普通用户不会在自己的侧栏里发现「形态切换」，运维也不必记 localStorage 键。
 *
 * 首屏调用时还没有 /api/auth/me 的结果，isAdmin 只能传本地缓存里的角色；
 * 缓存不是权威，App 在会话校验完成后会用真实 kind 再校验一次。
 */
export function readInitialEdition(isAdmin = false): EditionId {
  try {
    const edition = resolveEdition({
      search: window.location.search,
      stored: window.localStorage.getItem(EDITION_STORAGE_KEY),
      isAdmin,
    })
    // 只有管理员才写形态记忆：普通账号即使手动加 ?edition=admin，也不留下这个开关。
    if (isAdmin) rememberEdition(edition)
    return edition
  } catch {
    // localStorage 不可用（隐私模式）时回到默认形态
    return DEFAULT_EDITION
  }
}

/**
 * 非管理员带 ?edition=admin 进来时，把这一项从地址栏拿掉，避免地址栏继续暗示后台。
 * 不动 vq.edition：那是这台机器的运维开关，管理员下次登录还要沿用。
 */
export function stripAdminEditionQuery(): void {
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get('edition') !== 'admin') return
    url.searchParams.delete('edition')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {
    // 地址栏不可写时忽略；页面已经停在用户版，不影响权限判断。
  }
}

/**
 * 后台路由门禁：只有管理员能渲染后台外壳。
 * 非管理员直接访问 #/admin/* 时由 App 给明确的无权限页，不挂后台导航。
 */
export function canAccessAdminRoute(route: { kind: string }, isAdmin: boolean): boolean {
  return route.kind !== 'admin' || isAdmin
}

export const EDITION_ICON = { user: Activity, admin: Gauge } as const
