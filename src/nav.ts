// 侧栏导航的唯一真源（P2 导航收敛，2026-11-13；r313 再调整一次）。
//
// r313 的三条改动（用户要求）：
//   1. 「作品」改叫「我的作品」——这一页是你自己的东西，不是公共作品集；
//   2. 「我的资产」从工具区提到工作台之下：资产不是能力，是「我的东西」，和作品同一类；
//   3. 「工作流」收成 beta，只对管理员露出（见 domain/features.ts），普通账号连入口都看不到；
//      「运行记录」同时变成「积分记录」——用户要在那一页看到每笔扣了多少、扣在哪个节点。
//
// 两张画布仍然是两件东西：工作流（#/canvas，仅管理员）与无限画布（#/board，自由摆放素材）。
import {
  Activity,
  Bot,
  Boxes,
  Clapperboard,
  Compass,
  Grid2X2,
  Infinity as InfinityIcon,
  LayoutTemplate,
  MessagesSquare,
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
  /** 名字后面那枚小标签：只有 beta 能力才有，别拿它当装饰。 */
  chip?: string
}

/** 一级导航：五个去处，顺序就是用户每天的路径（r315 加了房间）。 */
export const PRIMARY_NAV: readonly NavEntry[] = [
  { id: 'overview', label: '工作台', hint: '平台能做什么、下一步点哪里', icon: Grid2X2, keywords: 'home 首页 下一步' },
  { id: 'projects', label: '我的作品', hint: '一条内容从脚本到评审走到哪了', icon: Clapperboard, keywords: 'project 作品 项目 进度' },
  { id: 'radar', label: '爆款雷达', hint: '检索抖音与小红书的爆款，拆出结构', icon: Compass, keywords: 'radar 爆款雷达 选题 搜索' },
  { id: 'templates', label: '模板库', hint: '可复用的脚本与分镜结构', icon: LayoutTemplate, keywords: 'template 模板 结构' },
  // 房间（r315）：一个房间里放你 + 几个智能体。Beta：接入还在接，先放出来看结构。
  { id: 'rooms', label: '聊天室', hint: '把几个智能体放进同一个房间', icon: MessagesSquare, keywords: 'chat room 聊天室 房间 群聊 智能体', chip: 'Beta' },
]

/** 工作台之下的一项：自己的商品图与数字人。渲染在一级导航里、紧跟工作台，视觉上缩一级。 */
export const ASSET_NAV: NavEntry = {
  id: 'assets',
  label: '我的资产',
  hint: '自己的商品图与数字人，生成时直接调用',
  icon: Boxes,
  keywords: 'assets 资产 商品 数字人 人像 模特',
}

/** 工具区：不再是目的地，而是从作品某一步带进来的能力。 */
export const TOOL_NAV: readonly NavEntry[] = [
  { id: 'agents', label: '快捷创作', hint: '对话、生图与生视频', icon: Bot, keywords: 'agent 助手 对话 生图 生视频 图片 视频' },
  { id: 'board', label: '无限画布', hint: '自由摆放素材，在画布上出图出视频', icon: InfinityIcon, keywords: 'board infinite 无限画布 画布 白板 外部画布' },
  { id: 'review', label: '视觉评审', hint: '按帧给结论，每条带证据', icon: ScanEye, keywords: 'review 评审 检查' },
  { id: 'runs', label: '积分记录', hint: '每笔扣费扣在哪、充值进了多少', icon: Activity, keywords: 'run 积分 记录 流水 扣费 充值 历史' },
]

/** 工作流：beta，只对管理员露出。普通账号这一项不渲染，直连 #/canvas 落到 Beta 页。 */
export const WORKFLOW_NAV: NavEntry = {
  id: 'canvas',
  label: '工作流',
  hint: '节点连成一条线，一次跑出这一版（Beta，仅管理员）',
  icon: Workflow,
  keywords: 'flow workflow 流程 节点 编排 画布 beta',
  chip: 'Beta',
}

/** 底部固定项：不进一级，也不进工具区。 */
export const SETTINGS_NAV: NavEntry = {
  id: 'settings',
  label: '设置',
  hint: '账号、头像与密码',
  icon: Settings2,
  keywords: 'settings 账号 积分 密码 头像',
}

/** 桌面端专属的一项：只有 Electron 外壳里存在，网页版侧栏不出现（也没有本地能力）。 */
export const DESKTOP_NAV: NavEntry = {
  id: 'local',
  label: '本地工作区',
  hint: '在本机读写文件、执行命令，每一步都能批准',
  icon: Monitor,
  keywords: 'desktop electron 本机 本地 文件夹 命令 终端 workspace',
}

const TOOL_IDS: readonly Page[] = [...TOOL_NAV.map((entry) => entry.id), ASSET_NAV.id, WORKFLOW_NAV.id]

/** 面包屑用它补一段「工具」，让「我在工具里」这件事在页头上也成立。 */
export function isToolPage(page: Page): boolean {
  return TOOL_IDS.includes(page)
}

/** 侧栏高亮：对话预设编辑器仍归到对话预设这一项，不让编辑器把侧栏全灭。 */
export function isNavActive(entry: NavEntry, page: Page): boolean {
  if (entry.id === 'agents') return page === 'agents' || page === 'agent-editor'
  return page === entry.id
}
