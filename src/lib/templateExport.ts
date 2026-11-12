import type { ReplicaTemplate } from '../domain/radar'
import { describeTiming, paceLabel } from '../domain/radar'
import { formatCount, formatDuration } from '../api/radar'

// 导出是「把拆解结果拿出工作台」的唯一出口：编导要能贴进飞书、发给剪辑、打印成纸质稿。
// 这里只做纯函数（Markdown 文本 + 文件名），DOM 下载与打印放在页面里，便于单测。

const clock = (value?: number | null) => formatDuration(value ?? 0)

const cell = (value: unknown) =>
  String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()

const line = (label: string, value?: string | null) => {
  const text = (value ?? '').trim()
  return text ? '- ' + label + '：' + text : ''
}

const stamp = (now: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
}

const statsTable = (template: ReplicaTemplate) => {
  const stats = template.stats || ({} as ReplicaTemplate['stats'])
  const head = ['播放', '点赞', '收藏', '评论', '转发']
  const row = [
    formatCount(stats.plays || 0),
    formatCount(stats.likes || 0),
    formatCount(stats.collects || 0),
    formatCount(stats.comments || 0),
    formatCount(stats.shares || 0),
  ]
  return [
    '| ' + head.join(' | ') + ' |',
    '| ' + head.map(() => '---').join(' | ') + ' |',
    '| ' + row.join(' | ') + ' |',
  ].join('\n')
}

function flowMarkdown(template: ReplicaTemplate): string[] {
  const nodes = template.flowNodes || []
  const rules = template.analysis?.reusableRules || []
  return [
    '# ' + template.title,
    '',
    line('类型', '画布工作流 · ' + nodes.length + ' 个节点'),
    line('平台', template.platformLabel),
    line('保存时间', template.createdAt ? template.createdAt.slice(0, 10) : ''),
    line('模板编号', template.id),
    '',
    '## 流程节点',
    '',
    ...nodes.map((node, index) => String(index + 1) + '. ' + node.title + (node.kind ? '（' + node.kind + '）' : '')),
    ...(rules.length ? ['', '## 节点提示词', '', ...rules.map((rule) => '- ' + rule)] : []),
    '',
    '## 怎么用',
    '',
    '这条是画布上另存的工作流：在模板库点「在画布打开」，会开回一张同样的新画布，把输入换成自己的素材就能跑。',
  ]
}

function replicaMarkdown(template: ReplicaTemplate): string[] {
  const parsed = template.kind !== 'saved'
  const out: string[] = ['# ' + template.title, '']
  out.push(line('平台', template.platformLabel + (template.author ? ' · ' + template.author : '')))
  out.push(line('原片时长', clock(template.durationSec)))
  if (template.contentType) out.push(line('内容类型', template.contentType))
  if (template.tags?.length) out.push(line('标签', template.tags.join(' / ')))
  if (template.publishedAt) out.push(line('发布时间', template.publishedAt))
  if (template.sourceUrl) out.push(line('原视频', template.sourceUrl))
  out.push(line('模板编号', template.id), '')
  out.push('## 互动数据', '', statsTable(template), '')

  if (!parsed) {
    out.push(
      '## 还没解析',
      '',
      '这条只存了链接与互动数据，脚本结构与分镜要跑一次解析才有。在工作台模板库点开它 →「去解析这条」。',
      '',
      '## 来源',
      '',
      line('原视频', template.sourceUrl) || '- 原链接缺失',
      line('作者', template.author),
      '',
      '> 由 VisionQA 导出。未下载或转存原视频，复刻请用自己的素材并遵守原平台规则。',
    )
    return out
  }

  if (template.hook || template.hookType) {
    out.push('## 开头钩子' + (template.hookType ? '（' + template.hookType + '）' : ''), '')
    if (template.hook) out.push('> ' + template.hook, '')
  }

  const timing = template.timing
  if (timing && timing.estimatedSec > 0) {
    out.push(
      '## 时长对账',
      '',
      '台词约需 ' + timing.estimatedSec + ' 秒，原片 ' + timing.durationSec + ' 秒，按' + paceLabel(timing.pace) + '速估（' + (timing.rate ?? 0) + ' 字/秒）。' + describeTiming(timing),
      '',
    )
  }

  const beats = template.structure || []
  if (beats.length) {
    out.push('## 脚本结构', '', '| 时间 | 段落 | 口播 | 屏幕字 | 目的 |', '| --- | --- | --- | --- | --- |')
    for (const beat of beats) {
      out.push(
        '| ' + beat.startSec + 's–' + beat.endSec + 's | ' + cell(beat.beat) + ' | ' + cell(beat.voiceover) + ' | ' + cell(beat.onScreen) + ' | ' + cell(beat.purpose) + ' |',
      )
    }
    out.push('')
  }

  const shots = template.storyboard || []
  if (shots.length) {
    out.push('## 分镜表', '')
    for (const shot of shots) {
      const head = '### 镜头 ' + shot.shotNo + ' · ' + shot.startSec + 's–' + shot.endSec + 's'
      out.push(head, '')
      const rows = [
        line('画面', shot.visual),
        line('机位', shot.camera),
        line('字幕', shot.caption),
        line('音频', shot.audio),
        line('用途', shot.purpose),
        line('建议时长', shot.expectedSec ? '念完约 ' + shot.expectedSec + ' 秒' + (shot.fit === 'tight' ? '（这段偏多）' : '') : ''),
      ].filter(Boolean)
      out.push(...rows, '')
    }
  }

  const analysis = template.analysis
  if (analysis && (analysis.viralPoints?.length || analysis.reusableRules?.length || analysis.targetAudience)) {
    out.push('## 爆款分析', '')
    if (analysis.pacing) out.push('- 节奏：' + analysis.pacing)
    if (analysis.targetAudience) out.push('- 目标受众：' + analysis.targetAudience)
    if (analysis.viralPoints?.length) out.push('', '### 爆点', '', ...analysis.viralPoints.map((point) => '- ' + point))
    if (analysis.reusableRules?.length) out.push('', '### 可复用规则', '', ...analysis.reusableRules.map((rule) => '- ' + rule))
    out.push('')
  }

  out.push(
    '## 来源与用途',
    '',
    line('原视频', template.sourceUrl) || '- 原链接缺失',
    line('作者', template.author),
    line('互动数据取自', '检索当时的平台公开数据'),
    '',
    '> 由 VisionQA 整理这条公开视频的脚本结构与分镜，未下载或转存原视频；复刻时请用自己的素材，并遵守原平台规则。',
  )
  return out
}

export function templateToMarkdown(template: ReplicaTemplate, now: Date = new Date()): string {
  const body = template.kind === 'flow' ? flowMarkdown(template) : replicaMarkdown(template)
  const meta = ['', '---', '', '导出于 ' + stamp(now) + ' · VisionQA']
  return body.concat(meta).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function templateFileName(template: ReplicaTemplate, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const day = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
  const safe = (template.title || '模板')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
  return 'VisionQA-' + safe + '-' + day + '.md'
}

export function downloadTemplateMarkdown(template: ReplicaTemplate) {
  const blob = new Blob([templateToMarkdown(template)], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = templateFileName(template)
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return anchor.download
}
