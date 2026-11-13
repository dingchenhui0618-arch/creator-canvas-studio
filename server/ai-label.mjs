// AI 生成内容标识（《人工智能生成合成内容标识办法》，2025-09-01 施行）。
//
// 交付物一旦出了工作台——Markdown 交付稿、A4 三张纸、只读分享页——脚本、分镜与评审结论
// 都是模型给的，收件人有权知道，平台也有义务标出来。所以每个出口都带两种标识：
//  - 显式标识：看得见的一行文字（「AI 生成」+ 一句说明），打印、转发、截图都不丢；
//  - 隐式标识：HTML 的 meta 与分享接口里的字段，机器也读得到「谁生成的、按哪一版规则标的」。
//
// 只标事实：生成者写 VisionQA，不宣称人工审核过；有没有人拍板，别处已经在写了
// （交付稿抬头「人工复核」、评审纸纸脚），这里不重复、也不替它下结论。

export const AI_LABEL = 'AI 生成'
export const AI_GENERATOR = 'VisionQA'
// 标识措辞的版本：改文案时一起改，出口产物里能对上「是按哪一版标的」
export const AI_LABEL_VERSION = '1'
export const AI_LABEL_REGULATION = '《人工智能生成合成内容标识办法》（2025-09-01 施行）'
export const AI_LABEL_NOTICE =
  '脚本、分镜与评审结论由 VisionQA 依据公开数据与所配置的模型生成，属于 AI 生成内容；发布前请人工核对事实、人名与数据。'

/** 结构化标识：分享接口与后台都用同一份，前端不必自己拼文案。 */
export function aiLabelMeta(extra = {}) {
  return {
    label: AI_LABEL,
    generator: AI_GENERATOR,
    aiGenerated: true,
    regulation: AI_LABEL_REGULATION,
    notice: AI_LABEL_NOTICE,
    version: AI_LABEL_VERSION,
    ...extra,
  }
}

/** Markdown 交付稿的显式标识：放在抬头第一段后面，读稿的人第一眼就看见。 */
export function aiLabelMarkdown() {
  return '> **' + AI_LABEL + '**：' + AI_LABEL_NOTICE
}

/** 隐式标识：拼进纸张的 <head>，机器可读（显式标识另由页面正文承担）。 */
export function aiLabelMetaTags() {
  return [
    '<meta name="ai-generated" content="true">',
    '<meta name="ai-generator" content="' + AI_GENERATOR + '">',
    '<meta name="ai-label" content="' + AI_LABEL + '">',
    '<meta name="ai-label-version" content="' + AI_LABEL_VERSION + '">',
  ].join('\n')
}

/** 纸上的显式标识胶囊：跟在品牌行右侧，打印时也留得下。 */
export function aiLabelBadge() {
  return '<span class="sheet-ai" title="' + escapeAttr(AI_LABEL_NOTICE) + '">' + AI_LABEL + '</span>'
}

/** 纸脚落款处的那一段：截一段发出去也不会丢标识。 */
export function aiLabelFootText() {
  return AI_LABEL + ' · ' + AI_GENERATOR
}

// 只给 title 属性用：这一段是常量，但仍然转义，免得以后把用户可控的文字塞进来时忘了
function escapeAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
