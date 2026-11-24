// 侧栏导航的唯一真源（P2 导航收敛，2026-11-13）。
// 一级只回答「产品有哪四个去处」：工作台 / 作品 / 发现 / 模板库。
// 对话预设、工作流、无限画布、视觉评审、运行记录是「能力」——从作品或模板的某一步被带进去，
// 所以退到工具区，仍是独立路由（收藏、历史链接都不变）。
//
// 两张画布从 v0.9.163 起是两件东西，不再共用一个入口（用户 2026-11-16 明确要求）：
//   · 工作流（#/canvas）   VisionQA 自己的节点编排：输入 / 大模型 / 工具 / 条件 / 输出连成一条线；
//   · 无限画布（#/board）  外部那张自由画布（canvas.wavisionai.cn）：素材随便摆，出图出视频在那边发生。
// 名字分开、地址分开、页面分开，谁也不再藏在谁的「内置编排」里。
import {
  Activity,
  Bot,
  Boxes,
  Clapperboard,
  Compass,
  Grid2X2,
  Infinity as InfinityIcon,
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
  { id: 'radar', label: '爆款雷达', hint: '检索抖音与小红书的爆款，拆出结构', icon: Compass, keywords: 'radar 爆款雷达 选题 搜索' },
  { id: 'templates', label: '模板库', hint: '可复用的脚本与分镜结构', icon: LayoutTemplate, keywords: 'template 模板 结构' },
]

/** 工具区：不再是目的地，而是从作品某一步带进来的能力。 */
export const TOOL_NAV: readonly NavEntry[] = [
  { id: 'assets', label: '我的资产', hint: '自己的商品图与数字人，生成时直接调用', icon: Boxes, keywords: 'assets 资产 商品 数字人 人像 模特' },
  { id: 'agents', label: '快捷创作', hint: '对话、生图与生视频', icon: Bot, keywords: 'agent 助手 对话 生图 生视频 图片 视频' },
  { id: 'canvas', label: '工作流', hint: '节点连成一条线，一次跑出这一版', icon: Workflow, keywords: 'flow workflow 流程 节点 编排 画布' },
  { id: 'board', label: '无限画布', hint: '自由摆放素材，在画布上出图出视频', icon: InfinityIcon, keywords: 'board infinite 无限画布 画布 白板 外部画布' },
  { id: 'review', label: '视觉评审', hint: '按帧给结论，每条带证据', icon: ScanEye, keywords: 'review 评审 检查' },
  { id: 'runs', label: '运行记录', hint: '每次跑工作流的输入、输出与积分', icon: Activity, keywords: 'run 记录 日志 历史' },
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

/** 侧栏高亮：对话预设编辑器仍归到对话预设这一项，不让编辑器把侧栏全灭。 */
export function isNavActive(entry: NavEntry, page: Page): boolean {
  if (entry.id === 'agents') return page === 'agents' || page === 'agent-editor'
  return page === entry.id
}
