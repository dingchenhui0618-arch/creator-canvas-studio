import {
  Activity,
  FlaskConical,
  Gauge,
  HeartPulse,
  KeyRound,
  LayoutTemplate,
  ScrollText,
  Settings2,
  ToggleLeft,
  Terminal,
  Users,
  type LucideIcon,
} from 'lucide-react'

// VisionQA 的三个形态：同一套设计语言，三份不同的导航与工作面。
// - user  用户生产版：检索 → 复刻 → 模板 → 智能体 → 画布 → 评审
// - admin 后台管理版：账号与配额、模型 Key、模板治理、运行审计、系统
// - lab   内测测试版：接口体检、样例对照、功能开关、诊断导出
export type EditionId = 'user' | 'admin' | 'lab'

export type AdminSection = 'overview' | 'users' | 'keys' | 'templates' | 'audit' | 'system'
export type LabSection = 'health' | 'fixtures' | 'flags' | 'diagnostics'

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
    hint: '给内容团队用：检索、复刻、模板、智能体、画布、评审',
    nav: [],
  },
  {
    id: 'admin',
    label: '后台管理版',
    mono: 'ADMIN',
    hint: '账号与配额、模型 Key、模板治理、运行审计、系统状态',
    nav: [
      { id: 'overview', label: '总览', icon: Gauge, section: 'overview' },
      { id: 'users', label: '账号与配额', icon: Users, section: 'users' },
      { id: 'keys', label: '模型 Key', icon: KeyRound, section: 'keys' },
      { id: 'templates', label: '模板治理', icon: LayoutTemplate, section: 'templates' },
      { id: 'audit', label: '运行审计', icon: ScrollText, section: 'audit' },
      { id: 'system', label: '系统', icon: Settings2, section: 'system' },
    ],
  },
  {
    id: 'lab',
    label: '内测测试版',
    mono: 'LAB',
    hint: '接口体检、样例对照、功能开关、诊断导出',
    nav: [
      { id: 'health', label: '接口体检', icon: HeartPulse, section: 'health' },
      { id: 'fixtures', label: '样例对照', icon: FlaskConical, section: 'fixtures' },
      { id: 'flags', label: '功能开关', icon: ToggleLeft, section: 'flags' },
      { id: 'diagnostics', label: '诊断导出', icon: Terminal, section: 'diagnostics' },
    ],
  },
]

export const EDITION_BY_ID: Record<EditionId, EditionMeta> = EDITIONS.reduce(
  (accumulator, edition) => ({ ...accumulator, [edition.id]: edition }),
  {} as Record<EditionId, EditionMeta>,
)

export const DEFAULT_EDITION: EditionId = 'user'

export const EDITION_STORAGE_KEY = 'vq.edition'

export function readStoredEdition(): EditionId {
  try {
    const stored = window.localStorage.getItem(EDITION_STORAGE_KEY)
    if (stored === 'user' || stored === 'admin' || stored === 'lab') return stored
  } catch {
    // localStorage 不可用（隐私模式）时回到默认形态
  }
  return DEFAULT_EDITION
}

export const EDITION_ICON = { user: Activity, admin: Gauge, lab: FlaskConical } as const
