// 侧栏导航的唯一真源（P2 导航收敛，2026-11-13）。
// 一级只回答「产品有哪四个去处」：工作台 / 作品 / 发现 / 模板库。
// 智能体、画布、视觉评审、运行记录是「能力」——从作品或模板的某一步被带进去，
// 所以退到工具区，仍是独立路由（收藏、历史链接都不变）。
import {
  Activity,
  Bot,
  Clapperboard,
  Compass,
  Grid2X2,
  LayoutTemplate,
  Monitor,
  ScanEye,
  Settings2,
  Workflow,
} from 'lucide-react'
import type { IconComponent, Page } from './domain/types'

export type NavEntry = {
  id: Page
  label: string
  /** 命令面板里的第二行说明；侧栏不显示（侧栏只放得下一个词）。 */
  hint: string
  icon: IconComponent
  /** 命令面板的额外匹配词：旧名字、英文、口语说法。 */
  keywords?: string
}

/** 一级导航：四个去处，顺序就是用户每天的路径。 */
export const PRIMARY_NAV: readonly NavEntry[] = [
  { id: 'overview', label: '工作台', hint: '下一步该点哪里', icon: Grid2X2, keywords: 'home 首页 下一步' },
  { id: 'projects', label: '作品', hint: '一条内容从脚本到评审走到哪了', icon: Clapperboard, keywords: 'project 项目 进度' },
  { id: 'radar', label: '发现', hint: '检索抖音与小红书的爆款，拆出结构', icon: Compass, keywords: 'radar 爆款雷达 选题 搜索' },
  { id: 'templates', label: '模板库', hint: '可复用的脚本与分镜结构', icon: LayoutTemplate, keywords: 'template 模板 结构' },
]

/** 工具区：不再是目的地，而是从作品某一步带进来的能力。 */
export const TOOL_NAV: readonly NavEntry[] = [
  { id: 'agents', label: '智能体', hint: '起草脚本、分镜与文案', icon: Bot, keywords: 'agent 助手 对话' },
  { id: 'canvas', label: '画布', hint: '节点连起来，跑出这一版', icon: Workflow, keywords: 'flow 流程 节点 编排' },
  { id: 'review', label: '视觉评审', hint: '按帧给结论，每条带证据', icon: ScanEye, keywords: 'review 评审 检查' },
  { id: 'runs', label: '运行记录', hint: '每次跑画布的输入、输出与积分', icon: Activity, keywords: 'run 记录 日志 历史' },
]

/** 底部固定项：不进一级，也不进工具区。 */
export const SETTINGS_NAV: NavEntry = {
  id: 'settings',
  label: '设置',
  hint: '账号、积分与模型入口',
  icon: Settings2,
  keywords: 'settings 账号 积分 密码',
}

/** 桌面端专属的一项：只有 Electron 外壳里存在，网页版侧栏不出现（也没有本地能力）。 */
export const DESKTOP_NAV: NavEntry = {
  id: 'local',
  label: '本地工作区',
  hint: '在本机读写文件、执行命令，每一步都能批准',
  icon: Monitor,
  keywords: 'desktop electron 本机 本地 文件夹 命令 终端 workspace',
}

const TOOL_IDS: readonly Page[] = TOOL_NAV.map((entry) => entry.id)

/** 面包屑用它补一段「工具」，让「我在工具里」这件事在页头上也成立。 */
export function isToolPage(page: Page): boolean {
  return TOOL_IDS.includes(page)
}

/** 侧栏高亮：智能体编辑器仍归到智能体这一项，不让编辑器把侧栏全灭。 */
export function isNavActive(entry: NavEntry, page: Page): boolean {
  if (entry.id === 'agents') return page === 'agents' || page === 'agent-editor'
  return page === entry.id
}
