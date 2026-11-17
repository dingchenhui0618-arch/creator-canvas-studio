// 第二轮诊断（不重试，每个通道默认只调一次）：把上一轮失败的原因落到具体字段。
import { keyMaterial, listKeys } from '/opt/visionqa/server/keyvault.mjs'
import { chatCompletion } from '/opt/visionqa/server/chatcall.mjs'
import { createVideoTask, pollVideoTask } from '/opt/visionqa/server/gateway.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...args) => console.log(...args)

const seeapi = listKeys().items.find((k) => k.id === 'k_79990923fd0d')
const geteText = listKeys().items.find((k) => k.id === 'k_9c707d679518')

// 1) SeeAPI 的 /v1/models：证明 testKey 探的是 /models（404），真实路径是 /v1/models
try {
  const res = await fetch('https://api.cgcm-api.com/v1/models', { headers: { Authorization: 'Bearer ' + keyMaterial(seeapi.id).apiKey } })
  const body = await res.text()
  let count = 0
  try { count = (JSON.parse(body).data || []).length } catch {}
  log('[SeeAPI /v1/models]', res.status, 'models=' + count)
} catch (e) { log('[SeeAPI /v1/models] FAIL', e.message) }

// 2) GeteAPI 文本 Key 实际能服务哪些模型
let geteModels = []
try {
  const res = await fetch('https://www.geteapi.com/v1/models', { headers: { Authorization: 'Bearer ' + keyMaterial(geteText.id).apiKey } })
  const body = await res.text()
  try { geteModels = (JSON.parse(body).data || []).map((m) => String(m.id || '')) } catch {}
  log('[Gete models]', res.status, 'models=' + geteModels.length, geteModels.slice(0, 12).join(','))
} catch (e) { log('[Gete models] FAIL', e.message) }

// 3) 用上游真列出来的一个文本模型试一次（没有就跳过）
const pick = ['gpt-5.6-luna', 'gpt-5.2-chat-latest', 'gpt-5.2', 'gpt-5-mini', 'gpt-4o-mini'].find((m) => geteModels.includes(m)) || geteModels[0] || ''
if (pick) {
  try {
    const out = await chatCompletion({ model: pick, messages: [{ role: 'user', content: '只回复两个字：接通' }], maxTokens: 64, capability: 'text', maxKeys: 1 })
    log('[Gete text]', pick, 'ok', String(out?.text || '').slice(0, 30), 'ms=' + out?.ms)
  } catch (e) { log('[Gete text]', pick, 'FAIL', e.message) }
} else {
  log('[Gete text] 上游没有列出任何模型，跳过')
}

// 4) DeepSeek 文本 / 视觉：max_tokens 给足（推理型模型会先吃推理 token）
try {
  const out = await chatCompletion({ model: 'deepseek-flash', messages: [{ role: 'user', content: '只回复两个字：接通' }], maxTokens: 200, capability: 'text', maxKeys: 1 })
  log('[DeepSeek text] ok', String(out?.text || '').slice(0, 20), 'ms=' + out?.ms)
} catch (e) { log('[DeepSeek text] FAIL', e.message) }

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
try {
  const out = await chatCompletion({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '这张图是什么颜色？' }, { type: 'image_url', image_url: { url: PIXEL } }] }],
    maxTokens: 200,
    capability: 'vision',
    maxKeys: 1,
  })
  log('[DeepSeek vision] ok', String(out?.text || '').slice(0, 40), 'ms=' + out?.ms)
} catch (e) { log('[DeepSeek vision] FAIL', e.message) }

// 5) 出视频：按 SeeAPI 的真实契约补齐 aspect_ratio / count / generate_audio
try {
  const created = await createVideoTask({
    model: 'seedance-2.0',
    prompt: '一只白色陶瓷杯在木桌上缓慢旋转，纯色背景，无文字',
    duration: 4,
    resolution: '480p',
    aspect_ratio: '16:9',
    count: 1,
    generate_audio: false,
  })
  const id = String(created?.id || '')
  log('[video] 建任务', id || JSON.stringify(created).slice(0, 200))
  const deadline = Date.now() + 8 * 60 * 1000
  let last = null
  while (Date.now() < deadline) {
    await sleep(6000)
    last = await pollVideoTask(id)
    log('[video] 状态', last?.status, '已用 ' + Math.round((Date.now() - (deadline - 8 * 60 * 1000)) / 1000) + 's')
    if (['succeeded', 'failed', 'refunded', 'canceled'].includes(String(last?.status || ''))) break
  }
  log('[video] 终态', JSON.stringify(last).slice(0, 500))
} catch (e) { log('[video] FAIL', e.message, e.detail ? String(e.detail).slice(0, 400) : '') }
