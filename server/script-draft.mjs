// 复刻画布草稿：把「这条作品现在的脚本」变成一张能跑的画布（2026-11-12，P1）。
//
// 画布只有两个节点：原始素材（输入）+ 复刻脚本（LLM 提示词）。
// 作品页开画布、模板库套用模板都走这里；作品页改脚本时也用它重写提示词，
// 保证「作品页改的脚本」和「画布跑的东西」是同一份，不再各说各话。
export const AUTO_PROMPT_PREFIX = '按模板结构复写一条同类型脚本'

const clip = (value, max) => String(value ?? '').trim().slice(0, max)

// 模板可能真的不在了（删掉 / 换账号看不到）：脚本本身仍属于作品，
// 没有模板就只按脚本生成提示词，不能因为一个可选来源整条保存失败。
const asTemplate = (template) => (template && typeof template === 'object' ? template : {})

function beatsOf(template, script) {
  if (Array.isArray(script?.structure) && script.structure.length) return script.structure
  return Array.isArray(template?.structure) ? template.structure : []
}

const beatName = (beat) => (typeof beat === 'string' ? beat : beat?.beat || beat?.title || '')

/**
 * 复刻节点提示词：结构、可复用规则、开头钩子、每段口播要念几秒。
 * 有作品脚本时用作品脚本（口播是用户改过的词），没有就照模板。
 */
export function buildReplicatePrompt({ template = {}, script = null } = {}) {
  const tpl = asTemplate(template)
  const structure = beatsOf(tpl, script)
  const hook = clip(script?.hook || tpl.hook, 400)
  const rules = (tpl.analysis?.reusableRules || []).join('；')
  // 分镜时长按台词量估过：念不完的段落先删口播再加时长，别把整条塞爆
  const beatsWithTiming = structure.filter((beat) => Number(beat?.expectedSec) > 0)
  const timingNote = beatsWithTiming
    .slice(0, 12)
    .map((beat) => {
      const name = beatName(beat)
      return (name ? name + '：' : '') + '这句要念 ' + beat.expectedSec + 's：' + String(beat.voiceover || '').replace(/[。；;，,]+$/, '')
    })
    .join('；')
  const timingLine = timingNote
    ? '口播与镜头时长对账：' + timingNote + '。镜头时长必须容得下台词（中文口播 4.2–6.5 字/秒，按慢/中/快三档）。'
    : ''
  const structureText = structure.map(beatName).filter(Boolean).join(' → ')
  return AUTO_PROMPT_PREFIX + '：' +
    (structureText || tpl.contentType || '结构未标注') +
    '。' +
    (rules ? '可复用规则：' + rules + '。' : '') +
    '开头钩子参考：' +
    (hook || '未标注') +
    '。' +
    (timingLine ? timingLine : '') +
    '输出可以直接进入画布继续改。'
}

export function buildReplicateDraft({ template = {}, script = null, name = '', description = '' } = {}) {
  const tpl = asTemplate(template)
  const structure = beatsOf(tpl, script)
  const inputText = clip(script?.hook || tpl.hook || tpl.title, 500)
  return {
    name: clip(name || tpl.title || '复刻脚本', 60),
    description: clip(
      description || ('来自模板 · ' + (tpl.contentType || '脚本') + ' · 脚本 ' + structure.length + ' 段'),
      240,
    ),
    nodes: [
      {
        id: 'n_input',
        type: 'input',
        position: { x: 80, y: 140 },
        data: { kind: 'input', title: '原始素材', config: { text: inputText } },
      },
      {
        id: 'n_llm',
        type: 'llm',
        position: { x: 420, y: 140 },
        data: { kind: 'llm', title: '复刻脚本', config: { systemPrompt: buildReplicatePrompt({ template: tpl, script }) } },
      },
    ],
    edges: [{ id: 'e_input_llm', source: 'n_input', target: 'n_llm' }],
  }
}

/**
 * 把新脚本写进已经存在的画布：只认「我们生成的」复刻节点。
 * 用户手改过提示词（开头不是自动生成的那句）就整块跳过，不覆盖别人的字；
 * 输入节点也只在里面还是旧钩子/模板名时才跟着换，用户自己填的素材不动。
 */
export function patchCanvasScript(nodes, { template = {}, script = null, prevHook = '' } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return { nodes, changed: false, promptUpdated: false }
  const tpl = asTemplate(template)
  const prompt = buildReplicatePrompt({ template: tpl, script })
  const hook = clip(script?.hook || tpl.hook || tpl.title, 500)
  const templateTitle = clip(tpl.title, 500)
  let changed = false
  // 提示词是不是真的换掉了：只有这个字段能说「画布用的是新脚本」，
  // 输入节点跟着换不算——用户手改过提示词时，画布的复刻逻辑还是旧的。
  let promptUpdated = false
  const next = nodes.map((node) => {
    const data = node?.data || {}
    const config = data.config || {}
    if (data.kind === 'llm' && data.title === '复刻脚本' && String(config.systemPrompt || '').startsWith(AUTO_PROMPT_PREFIX)) {
      if (config.systemPrompt === prompt) {
        promptUpdated = true
        return node
      }
      changed = true
      promptUpdated = true
      return { ...node, data: { ...data, config: { ...config, systemPrompt: prompt } } }
    }
    if (data.kind === 'input' && data.title === '原始素材') {
      const current = String(config.text || '')
      if (current && current !== prevHook && current !== templateTitle) return node
      if (current === hook) return node
      changed = true
      return { ...node, data: { ...data, config: { ...config, text: hook } } }
    }
    return node
  })
  return { nodes: next, changed, promptUpdated }
}
