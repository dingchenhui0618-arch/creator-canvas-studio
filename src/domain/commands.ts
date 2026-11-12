// 快速跳转的纯数据与匹配规则。
// 放在 domain 里而不是组件文件里：一是不让组件文件混出非组件导出（fast refresh），
// 二是匹配规则本身与 React 无关，改它不用碰渲染。
import type { IconComponent } from './types'

export type PaletteCommand = {
  id: string
  label: string
  hint?: string
  /** 分组标题（页面 / 工具 / 设置 / 动作），空查询时按组显示。 */
  group: string
  icon: IconComponent
  /** 额外的匹配词：旧页面名、英文、口语说法。 */
  keywords?: string
  run: () => void
}

/** 多个词要全中（AND），空查询返回全部；大小写不敏感。 */
export function matchCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length) return commands
  return commands.filter((command) => {
    const haystack = [command.label, command.hint ?? '', command.keywords ?? '', command.group].join(' ').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}
