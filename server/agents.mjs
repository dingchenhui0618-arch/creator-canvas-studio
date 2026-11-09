import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'

// 智能体存储：data/agents.json，原子写与 templates.mjs 同一套范式。
export const AGENT_CATEGORIES = [
  { id: '内容复刻', label: '内容复刻', hint: '拆解爆款结构与表达' },
  { id: '视觉评审', label: '视觉评审', hint: '按规范检查画面与文案' },
  { id: '脚本分镜', label: '脚本分镜', hint: '把选题拆成脚本与分镜' },
  { id: '投放素材', label: '投放素材', hint: '产出多版投放文案与方向' },
]

export const AGENT_TOOLS = [
  { id: 'assets-read', label: '读取资产库', description: '读取工作区已整理的素材与引用', scope: '只读', state: 'ready' },
  { id: 'canvas-write', label: '写入画布', description: '把运行结果写回画布并建立引用', scope: '读写', state: 'ready' },
  { id: 'export-json', label: '导出 JSON', description: '把结构化结果导出为可复用配置', scope: '读写', state: 'ready' },
  { id: 'image-gen', label: '图片生成', description: '调用图像通道生成素材', scope: '读写', state: 'planned' },
  { id: 'web-read', label: '网页读取', description: '读取公开页面作为创作参考', scope: '只读', state: 'planned' },
]

const CATEGORY_IDS = AGENT_CATEGORIES.map((item) => item.id)
const TOOL_IDS = AGENT_TOOLS.map((item) => item.id)
const agentsFile = path.join(config.dataDir, 'agents.json')

let cache = null
let writeChain = Promise.resolve()

const now = () => new Date().toISOString()
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString()

function invalid(message, extra = {}) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_AGENT', ...extra })
}

function text(value, max = 4000) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max)
}

function stringList(value, allowed, { maxItems = 20, maxLength = 400 } = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid('这个字段必须是字符串数组')
  const cleaned = value
    .map((item) => text(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems)
  if (allowed) {
    const unknown = cleaned.filter((item) => !allowed.includes(item))
    if (unknown.length) throw invalid('包含不支持的选项：' + unknown.join('、'))
  }
  return cleaned
}

function seedAgents() {
  const model = config.vision.model
  return [
    {
      id: 'agt_replica01',
      name: '爆款结构复刻',
      category: '内容复刻',
      role: '把一条爆款拆成可复用的结构骨架，给出可套用的改写方向。',
      systemPrompt:
        '你是内容复刻智能体。用户会给你一条爆款视频的标题、口播或拆解记录，你要提炼它的结构骨架，并给出可套用的改写建议。\n\n工作方式：\n1. 先用 3 行摘要说明原片结构（钩子、展开、收尾）；\n2. 输出结构骨架表：段落 / 时长 / 作用 / 可替换内容；\n3. 给出 2 条可直接套用的改写方向，标明需要替换的变量；\n4. 只依据用户提供的素材，缺失的信息写「待确认」。\n\n用简体中文，结构清楚，不使用营销套话。',
      model,
      temperature: 0.4,
      knowledge: [
        '镜头切换按 3-4 秒一个节拍；口播每段不超过 25 字。',
        '品牌调性：克制、具体，不用夸张形容词。',
        '未知信息写「待确认」，不要编造卖点或数据。',
      ],
      tools: ['assets-read', 'export-json'],
      createdAt: daysAgo(6),
      updatedAt: daysAgo(6),
      runCount: 0,
      lastRunAt: null,
      lastModel: '',
    },
    {
      id: 'agt_review01',
      name: '封面视觉评审',
      category: '视觉评审',
      role: '按构图、信息层级、文案可读性与平台规范逐条评审封面。',
      systemPrompt:
        '你是封面视觉评审智能体。用户会描述封面画面、标题和投放场景，你按构图、信息层级、文案可读性、平台规范四项逐条评审。\n\n输出要求：\n- 先给三档结论：通过 / 待确认 / 问题，各不超过 2 条；\n- 每条问题必须写：问题在哪、为什么、怎么改（给具体位置和替换文案）；\n- 证据只能引用用户描述里出现过的信息，画面外的推断标「待确认」；\n- 结尾给 1 条最小改动的优先项。\n\n用简体中文，不写客套话。',
      model,
      temperature: 0.2,
      knowledge: [
        '评审结论只用 通过 / 待确认 / 问题 三档。',
        '证据要指到具体区域：左上、主体、右下角文案位。',
        '不要臆造画面里没有的元素。',
      ],
      tools: ['assets-read'],
      createdAt: daysAgo(4),
      updatedAt: daysAgo(4),
      runCount: 0,
      lastRunAt: null,
      lastModel: '',
    },
    {
      id: 'agt_story01',
      name: '口播脚本与分镜',
      category: '脚本分镜',
      role: '把一个选题拆成可直接拍摄的口播脚本和分镜表。',
      systemPrompt:
        '你是口播脚本与分镜智能体。用户给你一个选题、卖点或素材，你要产出可直接拍摄的口播脚本和分镜表。\n\n输出结构：\n1. 一句话立意（不超过 20 字）；\n2. 口播脚本：按段落写，标注每段时长，口语化，避免书面语；\n3. 分镜表：Markdown 表格，列为 镜头号 / 时长 / 景别 / 画面 / 台词或字幕；\n4. 拍摄提示：需要补拍的素材与注意事项。\n\n只使用用户给出的产品信息；没有的卖点写「待确认」，不要编造数据。',
      model,
      temperature: 0.5,
      knowledge: [
        '单条视频时长 30-60 秒，口播 220-320 字。',
        '分镜按镜头号递增，标注景别与运镜。',
        '开头 3 秒必须给结果或冲突。',
      ],
      tools: ['canvas-write', 'export-json'],
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
      runCount: 0,
      lastRunAt: null,
      lastModel: '',
    },
    {
      id: 'agt_ads01',
      name: '投放素材变体',
      category: '投放素材',
      role: '围绕同一卖点产出多版投放文案与素材方向。',
      systemPrompt:
        '你是投放素材智能体。用户给你卖点、目标人群和投放平台，你要产出可直接投放的文案与素材方向。\n\n输出结构：\n1. 人群与场景判断（2 行）；\n2. 3 条文案变体：每条 60 字以内，标注钩子类型（痛点 / 结果 / 反常识 / 身份）；\n3. 2 个素材方向：画面主体、拍摄方式、需要的道具；\n4. 风险提醒：不能写的承诺与需要确认的信息。\n\n不要编造价格、授权、销量或效果数据。',
      model,
      temperature: 0.7,
      knowledge: [
        '同一卖点最多输出 3 条变体，避免同质化。',
        '每条文案不超过 60 字，前 8 个字要能独立成立。',
        '不做价格、授权、效果的虚假承诺。',
      ],
      tools: ['assets-read', 'image-gen'],
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      runCount: 0,
      lastRunAt: null,
      lastModel: '',
    },
  ]
}

// 旧数据里可能写着已经不存在的模型名（早期示例里的 gpt-* 之类）：
// 读的时候统一折成服务端当前配置的模型，否则智能体每次对话都会先打一次不存在的模型再降级，
// 界面上也会显示一个假名字。
function knownModels() {
  return [
    ...new Set(
      [config.llm.model, ...config.llm.fallbacks, config.vision.model, ...config.vision.fallbacks].filter(Boolean),
    ),
  ]
}

function withKnownModel(agent) {
  const model = String(agent.model || '').trim()
  return knownModels().includes(model) ? agent : { ...agent, model: config.vision.model }
}

async function loadAll() {
  if (cache) return cache
  try {
    const raw = await fsp.readFile(agentsFile, 'utf8')
    const parsed = JSON.parse(raw)
    cache = (Array.isArray(parsed) ? parsed : []).map(withKnownModel)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      cache = seedAgents()
      await persist(cache)
    } else {
      // 文件损坏时不静默覆盖：先备份，再给内存一个空列表，下一次写入会生成新文件
      const backup = agentsFile + '.broken-' + Date.now()
      try {
        await fsp.rename(agentsFile, backup)
        console.error('[agents] agents.json 解析失败，已备份到 ' + backup)
      } catch {
        console.error('[agents] agents.json 解析失败：' + (error?.message || error))
      }
      cache = []
    }
  }
  return cache
}

function persist(list) {
  cache = list
  const snapshot = JSON.stringify(list, null, 2)
  const task = writeChain.then(async () => {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = agentsFile + '.tmp'
    await fsp.writeFile(tmp, snapshot, 'utf8')
    await fsp.rename(tmp, agentsFile)
  })
  writeChain = task.catch(() => {})
  return task
}

function normalizeInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw invalid('请求体必须是 JSON 对象')
  const out = {}
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key)

  if (!partial || has('name')) {
    const name = text(input.name, 40)
    if (name.length < 2) throw invalid('名称至少 2 个字')
    out.name = name
  }
  if (!partial || has('category')) {
    const category = text(input.category, 20)
    if (!CATEGORY_IDS.includes(category)) throw invalid('分类必须是：' + CATEGORY_IDS.join(' / '))
    out.category = category
  }
  if (!partial || has('role')) {
    const role = text(input.role, 120)
    if (role.length < 2) throw invalid('一句话职责至少 2 个字')
    out.role = role
  }
  if (!partial || has('systemPrompt')) {
    const systemPrompt = text(input.systemPrompt, 8000)
    if (systemPrompt.length < 10) throw invalid('系统提示词至少 10 个字，建议写清目标、禁止事项和未知信息的处理方式')
    out.systemPrompt = systemPrompt
  }
  if (!partial || has('model')) {
    const model = text(input.model, 80) || config.vision.model
    out.model = model
  }
  if (!partial || has('temperature')) {
    const raw = Number(input.temperature ?? 0.4)
    if (!Number.isFinite(raw)) throw invalid('温度必须是数字')
    out.temperature = Math.max(0, Math.min(1, Math.round(raw * 100) / 100))
  }
  if (!partial || has('knowledge')) out.knowledge = stringList(input.knowledge, null, { maxItems: 20, maxLength: 400 })
  if (!partial || has('tools')) out.tools = stringList(input.tools, TOOL_IDS, { maxItems: 12, maxLength: 40 })
  return out
}

export async function listAgents({ q = '', category = '' } = {}) {
  const list = await loadAll()
  const keyword = String(q).trim()
  return list
    .filter((item) => (category ? item.category === category : true))
    .filter((item) => (keyword ? (item.name + item.role + item.systemPrompt + item.knowledge.join(' ')).includes(keyword) : true))
    .sort((a, b) => String(b.lastRunAt || b.updatedAt || b.createdAt).localeCompare(String(a.lastRunAt || a.updatedAt || a.createdAt)))
}

export async function getAgent(id) {
  const list = await loadAll()
  return list.find((item) => item.id === id) || null
}

export async function createAgent(input) {
  const list = await loadAll()
  const data = normalizeInput(input)
  if (list.some((item) => item.name === data.name)) throw invalid('已有同名智能体：' + data.name)
  const createdAt = now()
  const agent = {
    id: 'agt_' + randomUUID().slice(0, 8),
    ...data,
    createdAt,
    updatedAt: createdAt,
    runCount: 0,
    lastRunAt: null,
    lastModel: '',
  }
  await persist([agent, ...list])
  return agent
}

export async function updateAgent(id, input) {
  const list = await loadAll()
  const current = list.find((item) => item.id === id)
  if (!current) return null
  const data = normalizeInput(input, { partial: true })
  if (data.name && list.some((item) => item.id !== id && item.name === data.name)) throw invalid('已有同名智能体：' + data.name)
  const updated = { ...current, ...data, updatedAt: now() }
  await persist(list.map((item) => (item.id === id ? updated : item)))
  return updated
}

export async function deleteAgent(id) {
  const list = await loadAll()
  const next = list.filter((item) => item.id !== id)
  if (next.length === list.length) return false
  await persist(next)
  return true
}

export async function recordRun(id, { model }) {
  const list = await loadAll()
  const current = list.find((item) => item.id === id)
  if (!current) return null
  const updated = {
    ...current,
    runCount: (current.runCount || 0) + 1,
    lastRunAt: now(),
    lastModel: text(model, 80),
    updatedAt: now(),
  }
  await persist(list.map((item) => (item.id === id ? updated : item)))
  return updated
}

export async function agentStats() {
  const list = await loadAll()
  const byCategory = {}
  for (const item of list) byCategory[item.category] = (byCategory[item.category] || 0) + 1
  return {
    total: list.length,
    runs: list.reduce((sum, item) => sum + (item.runCount || 0), 0),
    byCategory,
  }
}
