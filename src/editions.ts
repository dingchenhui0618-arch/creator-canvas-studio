import {
  Activity,
  Frame,
  Gauge,
  KeyRound,
  LayoutTemplate,
  ScrollText,
  Settings2,
  Users,
  type LucideIcon,
} from 'lucide-react'

// 两个形态：用户生产版是唯一对外形态；后台管理版只给运维用，从 URL 进入，不在用户导航里露出。
// 之前的「内测测试版」（接口体检 / 样例对照 / 功能开关 / 诊断导出）整块删除：
// 那一整个人面全是未接线的开关和示例数据，对外发布时属于演示残留。
export type EditionId = 'user' | 'admin'

export type AdminSection = 'overview' | 'users' | 'canvas' | 'keys' | 'templates' | 'audit' | 'system'

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
    hint: '检索、复刻、模板、智能体、画布、评审',
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
      { id: 'canvas', label: '画布', icon: Frame, section: 'canvas' },
      { id: 'keys', label: '模型 Key', icon: KeyRound, section: 'keys' },
      { id: 'templates', label: '模板治理', icon: LayoutTemplate, section: 'templates' },
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

/**
 * 对外默认永远是用户生产版。后台只有一个入口：地址栏加 ?edition=admin。
 * 这样普通用户不会在自己的侧栏里发现「形态切换」，运维也不必记 localStorage 键。
 */
export function readInitialEdition(): EditionId {
  try {
    const param = new URLSearchParams(window.location.search).get('edition')
    if (param === 'admin' || param === 'user') {
      window.localStorage.setItem(EDITION_STORAGE_KEY, param)
      return param
    }
    const stored = window.localStorage.getItem(EDITION_STORAGE_KEY)
    if (stored === 'admin' || stored === 'user') return stored
  } catch {
    // localStorage 不可用（隐私模式）时回到默认形态
  }
  return DEFAULT_EDITION
}

export const EDITION_ICON = { user: Activity, admin: Gauge } as const
