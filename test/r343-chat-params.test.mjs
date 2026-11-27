// r343：对话里接着说一句改参数（「改成 8 秒」「换成 16:9」）+ 会话级「当前生成设置」。
//
// 这一轮要守住三件事（改坏任何一件，下面都有用例会红）：
//  1) 「只改参数」要认得出来，并且接得上上一版就按新参数重出一版（同一个提示词、新任务、照旧扣费/退款）；
//  2) 接不上上一版 / 类型不兼容时只记设置、不建任务、不扣费；
//  3) 普通聊天不许被误判成改参数（「这段 8 秒的片子怎么剪」「3:4 是什么意思」
//     「帮我写个 16:9 的标题」）——误判的代价是白扣一次生成积分。
//
// 生成链路走本地假上游（1×1 PNG / 假视频任务号），不调用真实上游、不消耗额度；
// 文本那一路用假 SSE / JSON，和 test/chat-send.test.mjs 同一套骨架。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-r343-params-'))
process.env.DATA_DIR = dir
process.env.VISION_API_KEY = 'test-key'
process.env.VQ_KEY_SECRET = 'test-secret-r343'
process.env.VQ_CREDIT_CHAT = '1'
process.env.VQ_REQUIRE_AUTH = '1'

const tinyPng = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
)

// 假上游：出图 / 出视频 / 文本模型都在这一台。记下真正发出去的正文，断言参数不是「看起来对」。
let lastImageBody = null
let lastVideoBody = null
let imageAttempts = 0
let videoAttempts = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse(text || '{}')
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '收到，这一步就这样做。' } }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      send(200, {
        model: 'visionqa-text',
        choices: [{ message: { role: 'assistant', content: '收到，这一步就这样做。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      })
      return
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      imageAttempts += 1
      const body = JSON.parse(text || '{}')
      lastImageBody = body
      if (String(body.prompt || '').includes('图失败')) return send(500, { error: { message: '上游拒绝这次生图' } })
      return send(200, { created: 1, data: [{ b64_json: 'data:image/png;base64,' + tinyPng.toString('base64') }] })
    }
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      return send(200, { created: 1, data: [{ b64_json: 'data:image/png;base64,' + tinyPng.toString('base64') }] })
    }
    if (req.method === 'POST' && req.url === '/seeapi/v1/video/generations') {
      videoAttempts += 1
      const body = JSON.parse(text || '{}')
      lastVideoBody = body
      if (!body.aspect_ratio) return send(400, { error: { code: 'validation_error', message: 'aspect_ratio is required.' } })
      return send(200, { id: 'up_ok', status: 'queued' })
    }
    if (req.method === 'POST' && req.url === '/seeapi/v1/assets/references/upload') {
      return send(200, { asset_uri: 'asset://image' })
    }
    send(404, { error: 'not found' })
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
process.env.VISION_BASE_URL = origin + '/v1'
test.after(() => new Promise((resolve) => server.close(resolve)))

const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const { createKey } = await import('../server/keyvault.mjs')
const { createConversation, getConversation, saveConversation } = await import('../server/chat-store.mjs')
const { sendChatMessage, SYSTEM_PROMPT } = await import('../server/chat.mjs')
const {
  applyMediaDefaults,
  mergeMediaDefaults,
  parseMediaIntent,
  parseParamChange,
  planFromMediaParams,
  sanitizeMediaDefaults,
} = await import('../server/media-intent.mjs')
const { resetMediaGenRateLimit } = await import('../server/routes/media-gen.mjs')

createKey({
  name: 'r343 假生图',
  provider: 'geteapi',
  baseUrl: origin + '/v1',
  apiKey: 'sk-test-r343-image-1234567890',
  models: ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6'],
  capabilities: ['image'],
  priority: 10,
  weight: 100,
})
createKey({
  name: 'r343 假生视频',
  provider: 'cgcm',
  baseUrl: origin + '/seeapi',
  apiKey: 'sk-test-r343-video-1234567890',
  models: ['seedance-2.0', 'seedance-2.0-fast'],
  capabilities: ['video'],
  priority: 10,
  weight: 100,
})

function newUser(name) {
  const user = auth.createUser({ email: name + '@r343.test', password: 'Passw0rd!demo', name })
  credits.grant(user.id, 300, { note: 'r343 test' })
  return user
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 出图是后台任务：请求可能比 sendChatMessage 返回晚几十毫秒，断言前等它真的到上游。 */
async function waitFor(check, tries = 200, gap = 20) {
  for (let index = 0; index < tries; index += 1) {
    if (check()) return true
    await sleep(gap)
  }
  return false
}

function mediaMessages(conv) {
  return conv.messages.filter((item) => item && item.meta && item.meta.media)
}

// 用户能看到的文案里不许出现上游厂牌 / 型号 / 英文报文（r343 的硬规则）
const VENDOR = /(deepseek|gpt|claude|qwen|doubao|geteapi|seeapi|seedance|openai|anthropic|gemini)/i
function assertNoVendor(text) {
  assert.equal(VENDOR.test(String(text)), false, '文案里不该出现上游厂牌或型号：' + text)
}

// ── 一、纯函数：认得出 / 认得准 ───────────────────────────────────────────────
test('改参数的说法：改 / 换 / 调 / 用 / 来 / 要 + 参数都认；值取最后说定的那个', () => {
  const cases = [
    ['改成 8 秒', { duration: 8 }],
    ['时长改成 8 秒', { duration: 8 }],
    ['换成 16:9', { ratio: '16:9' }],
    ['比例用 9:16', { ratio: '9:16' }],
    ['时长要用 8 秒', { duration: 8 }],
    ['我要 16:9', { ratio: '16:9' }],
    ['来 16:9', { ratio: '16:9' }],
    ['要 8 秒', { duration: 8 }],
    ['画质改高清', { quality: 'high' }],
    ['分辨率换成 720p', { resolution: '720p' }],
    ['改成竖屏', { ratio: '9:16' }],
    ['能不能把时长改成 8 秒', { duration: 8 }],
    ['换成 3：4 的比例', { ratio: '3:4' }],
  ]
  for (const [text, values] of cases) {
    const change = parseParamChange(text)
    assert.ok(change, text + ' 应该被认成改参数')
    assert.deepEqual(change.values, values, text)
  }
  // 一句里改两个：都记下来
  const both = parseParamChange('换成 16:9，时长改成 8 秒')
  assert.deepEqual(both.values, { ratio: '16:9', duration: 8 })
})

test('普通聊天不许误判：问怎么剪、问 3:4 什么意思、写个 16:9 的标题都不算改参数', () => {
  for (const text of [
    '这段 8 秒的片子怎么剪',
    '3:4 是什么意思',
    '帮我写个 16:9 的标题',
    '要 8 秒的背景音乐',
    '我要 16:9 的封面',
    '这段 8 秒的片子换成横屏会不会更好',
    '今天天气不错',
  ]) {
    assert.equal(parseParamChange(text), null, text + ' 不该被当成改参数')
  }
  // 开头就是生成指令的走生成那条路，这一层不抢
  assert.equal(parseParamChange('生成一张图 改成 16:9'), null)
})

// ── 二、纯函数：会话当前设置的合并顺序 ────────────────────────────────────────
test('会话当前设置：只收形状对的值；旧会话缺字段回 {}；没参数时一个键都不加', () => {
  assert.deepEqual(sanitizeMediaDefaults(undefined), {}, '旧会话没有这个字段 = {}，不是错误')
  assert.deepEqual(sanitizeMediaDefaults(null), {})
  assert.deepEqual(sanitizeMediaDefaults({}), {})
  assert.deepEqual(
    sanitizeMediaDefaults({ ratio: '16：9', quality: 'HIGH', duration: '8', resolution: '720P', size: '1024x1024' }),
    { ratio: '16:9', quality: 'high', duration: 8, resolution: '720p' },
    '全角比例 / 大小写 / 字符串数字都要归一；尺寸不进长期记忆',
  )
  assert.deepEqual(sanitizeMediaDefaults({ ratio: '烂', quality: 'ultra', duration: 120, resolution: 'p' }), {})
  assert.deepEqual(mergeMediaDefaults({ ratio: '1:1', duration: 4 }, { ratio: '9:16' }), { ratio: '9:16', duration: 4 })

  // 这次没说、会话也没有：一个键都不许凭空塞
  const plain = parseMediaIntent('/生图 白底产品图')
  const empty = applyMediaDefaults('image', plain, {})
  assert.deepEqual(empty.explicitValues, {})
  assert.deepEqual(empty.applied, [])
  assert.equal(empty.plan.ratio, '1:1', '这是解析器自己的默认档，不是从记忆里塞的')
  assert.deepEqual(empty.plan.locked, {})

  // 会话设置 < 这次说的：说过的以这次为准，只有没说过的键才借会话设置
  const said = parseMediaIntent('/生图 9:16 白底产品图')
  const over = applyMediaDefaults('image', said, { ratio: '1:1', quality: 'high' })
  assert.equal(over.plan.ratio, '9:16', '这次说的盖过会话设置')
  assert.equal(over.plan.quality, 'high', '这次没说的键才借会话设置')
  assert.deepEqual(over.explicitValues, { ratio: '9:16' }, '只写回这次明确说的键')
  assert.deepEqual(over.applied, ['quality'])

  // 会话设置越过白名单：照样按「写死」提交，不假装上游一定收
  const outside = applyMediaDefaults('image', parseMediaIntent('/生图 白底产品图'), { ratio: '4:5' })
  assert.equal(outside.plan.ratio, '4:5')
  assert.equal(outside.plan.locked.ratio, true)

  // 图片的生成不吃视频的时长 / 分辨率
  const imageOnly = applyMediaDefaults('image', parseMediaIntent('/生图 白底产品图'), { duration: 8, resolution: '720p' })
  assert.equal(imageOnly.plan.duration, null)
  assert.equal(imageOnly.plan.resolution, '')
  assert.deepEqual(imageOnly.applied, [])
})

test('上一版重出：参数按模型档位重新标 locked；比例改了就不再带旧尺寸', () => {
  const image = planFromMediaParams('image', { ratio: '3:4', quality: 'high' })
  assert.equal(image.ratio, '3:4')
  assert.equal(image.size, '', '按比例算出来的尺寸不写死，改比例才跟得上')
  assert.equal(image.locked.ratio, true)
  assert.equal(image.locked.quality, true)
  const normal = planFromMediaParams('video', { ratio: '16:9', duration: 8, resolution: '720p' })
  assert.deepEqual(normal.locked, {}, '表内档位不算写死')
  const outside = planFromMediaParams('video', { ratio: '16:9', duration: 12, resolution: '1080p' })
  assert.equal(outside.locked.duration, true)
  assert.equal(outside.locked.resolution, true)
})

// ── 三、模型自称（r343 用户明确要求）──────────────────────────────────────────
test('系统提示词：自称 VisionQA 通用模型，且不出现任何上游厂牌或型号', () => {
  assert.match(SYSTEM_PROMPT, /你是 VisionQA 通用模型/)
  assert.match(SYSTEM_PROMPT, /被问到/)
  assert.match(SYSTEM_PROMPT, /只回答「我是 VisionQA 通用模型」/)
  assert.match(SYSTEM_PROMPT, /不许提到任何上游厂牌或型号/)
  assert.match(SYSTEM_PROMPT, /不许说「我底层是/)
  assertNoVendor(SYSTEM_PROMPT)
})

// ── 四、会话存储：旧会话不许因为缺字段报错 ────────────────────────────────────
test('会话存储：旧文件没有 mediaDefaults / lastMediaTask 也读得出来，存回去补成 {}', () => {
  const user = newUser('store')
  const conv = createConversation(user.id, { title: '旧会话' })
  const file = path.join(dir, 'chat', user.id, conv.id + '.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete raw.mediaDefaults
  delete raw.lastMediaTask
  fs.writeFileSync(file, JSON.stringify(raw))

  const back = getConversation(user.id, conv.id)
  assert.deepEqual(back.mediaDefaults, {}, '缺字段 = {}，不许抛错')
  assert.equal(back.lastMediaTask, null)
  const saved = saveConversation(user.id, back)
  assert.deepEqual(saved.mediaDefaults, {})
})

// ── 五、端到端：生成 → 接着说一句改参数 ───────────────────────────────────────
const flowUser = newUser('flow')
const flow = { conv: null, firstTask: '', secondTask: '' }

test('出完一条图：会话上记下当前设置和「上一版」，这一轮不扣对话积分', async () => {
  resetMediaGenRateLimit()
  flow.conv = createConversation(flowUser.id, { title: 'r343 流程' })
  const attemptsBefore = imageAttempts
  const result = await sendChatMessage(flowUser, { conversationId: flow.conv.id, content: '/生图 白底产品图' })
  assert.equal(result.cost, 0, '走生成管线：对话那 1 积分不扣')
  assert.ok(result.media && result.media.id, '要真的开出任务')
  assert.match(result.reply.content, /已开始生成图片/)
  assertNoVendor(result.reply.content)

  const conv = getConversation(flowUser.id, flow.conv.id)
  assert.deepEqual(conv.mediaDefaults, {}, '没带参数就不许凭空塞值')
  assert.equal(conv.lastMediaTask.kind, 'image')
  assert.equal(conv.lastMediaTask.prompt, '白底产品图')
  assert.equal(conv.lastMediaTask.at, conv.messages[0].id, '上一版挂在开任务那条用户消息上')
  assert.equal(conv.lastMediaTask.params.ratio, '1:1')
  assert.equal(conv.lastMediaTask.params.size, '', '按比例算出来的尺寸不写死')

  // 出图是后台任务：等这一次请求真的到上游，别读到上一条用例留下的正文
  assert.ok(await waitFor(() => imageAttempts > attemptsBefore))
  assert.equal(lastImageBody.prompt, '白底产品图')
  assert.equal(lastImageBody.size, '1024x1024')
  assert.equal(lastImageBody.quality, undefined, '没选画质就不许发 quality 字段')
  flow.firstTask = result.media.id
})

test('接着说「换成 9:16」：按新参数重出上一版（同提示词、新任务、照旧扣费）', async () => {
  resetMediaGenRateLimit()
  const before = credits.balanceOf(flowUser.id)
  const attemptsBefore = imageAttempts
  const result = await sendChatMessage(flowUser, { conversationId: flow.conv.id, content: '换成 9:16' })

  assert.equal(result.cost, 0)
  assert.ok(result.media && result.media.id)
  assert.notEqual(result.media.id, flow.firstTask, '要开一个新任务，不是把旧任务改一改')
  assert.equal(result.media.prompt, '白底产品图', '同一个提示词')
  assert.equal(result.media.ratio, '9:16')
  assert.match(result.reply.content, /^按 9:16 重出上一版，上一版还留在上面。/)
  assertNoVendor(result.reply.content)

  const cost = Number(result.media.credits.cost)
  assert.ok(cost > 0)
  assert.equal(credits.balanceOf(flowUser.id), before - cost, '重出一版照样按生成管线扣费')

  const conv = getConversation(flowUser.id, flow.conv.id)
  assert.equal(conv.mediaDefaults.ratio, '9:16', '这次说的要记进会话当前设置')
  assert.equal(conv.lastMediaTask.id, result.media.id, '上一版换成新这条，下一句继续改')
  assert.equal(conv.lastMediaTask.params.ratio, '9:16')

  assert.ok(await waitFor(() => imageAttempts > attemptsBefore && lastImageBody.size === '1024x1536'))
  flow.secondTask = result.media.id
})

test('上一版是图片、却要改时长：不建任务、不扣费，但把这一档记进会话设置', async () => {
  const before = credits.balanceOf(flowUser.id)
  const convBefore = getConversation(flowUser.id, flow.conv.id)
  const messagesBefore = mediaMessages(convBefore).length
  const attemptsBefore = imageAttempts

  const result = await sendChatMessage(flowUser, { conversationId: flow.conv.id, content: '时长改成 8 秒' })
  assert.equal(result.cost, 0, '没建任务，一分钱都不该扣')
  assert.equal(result.media, undefined)
  assert.equal(credits.balanceOf(flowUser.id), before, '不建任务就不扣费')
  assert.match(result.reply.content, /上一版是图片/)
  assert.match(result.reply.content, /没有时长这一档/)
  assert.match(result.reply.content, /已记下：下一段按 8 秒出/)
  assertNoVendor(result.reply.content)

  const conv = getConversation(flowUser.id, flow.conv.id)
  assert.equal(mediaMessages(conv).length, messagesBefore, '不许偷偷开一张新卡片')
  assert.equal(conv.lastMediaTask.id, flow.secondTask, '上一版还是上一版')
  assert.equal(conv.mediaDefaults.duration, 8, '能落的那部分要记进会话设置')
  assert.equal(imageAttempts, attemptsBefore, '一个上游请求都不该发')
})

test('同一档再说一遍：只确认，不为一条一模一样的上一版再扣一次生成积分', async () => {
  const before = credits.balanceOf(flowUser.id)
  const convBefore = getConversation(flowUser.id, flow.conv.id)
  const taskBefore = convBefore.lastMediaTask.id
  const result = await sendChatMessage(flowUser, { conversationId: flow.conv.id, content: '换成 9:16' })
  assert.equal(result.media, undefined)
  assert.equal(result.cost, 0)
  assert.equal(credits.balanceOf(flowUser.id), before, '参数没变就不该再扣一次')
  assert.match(result.reply.content, /^上一版已经是 9:16，没有重出/)
  const conv = getConversation(flowUser.id, flow.conv.id)
  assert.equal(conv.lastMediaTask.id, taskBefore)
})

test('同一会话再生成：没带参数时沿用会话设置，而且不会反过来改写它', async () => {
  resetMediaGenRateLimit()
  const attemptsBefore = imageAttempts
  const result = await sendChatMessage(flowUser, { conversationId: flow.conv.id, content: '/生图 白底产品图' })
  assert.equal(result.media.ratio, '9:16', '会话当前设置要铺到下一次生成上')
  assert.ok(await waitFor(() => imageAttempts > attemptsBefore && lastImageBody.size === '1024x1536'))
  const conv = getConversation(flowUser.id, flow.conv.id)
  assert.deepEqual(conv.mediaDefaults, { ratio: '9:16', duration: 8 }, '这次没说参数：设置一个字都不改')
})

test('普通聊天不许被误判成改参数（最近 6 条里确实有一版，也不许重出）', async () => {
  const before = credits.balanceOf(flowUser.id)
  const convBefore = getConversation(flowUser.id, flow.conv.id)
  const taskBefore = convBefore.lastMediaTask.id
  const messagesBefore = mediaMessages(convBefore).length
  const attemptsBefore = imageAttempts

  for (const text of ['这段 8 秒的片子怎么剪', '3:4 是什么意思', '帮我写个 16:9 的标题']) {
    const result = await sendChatMessage(flowUser, { conversationId: flow.conv.id, content: text })
    assert.equal(result.cost, 1, text + '：这是普通聊天，照常扣 1 积分')
    assert.equal(result.media, undefined, text + '：不许重出')
  }
  assert.equal(credits.balanceOf(flowUser.id), before - 3)
  const conv = getConversation(flowUser.id, flow.conv.id)
  assert.equal(mediaMessages(conv).length, messagesBefore, '一张新卡片都不许出现')
  assert.equal(conv.lastMediaTask.id, taskBefore)
  assert.equal(imageAttempts, attemptsBefore)
})

// ── 六、没有上一版：只记设置 ──────────────────────────────────────────────────
test('没有可改的上一版：只更新会话设置，不建任务、不扣费，下一张按它出', async () => {
  resetMediaGenRateLimit()
  const user = newUser('noprev')
  const conv = createConversation(user.id, { title: '没有上一版' })
  const before = credits.balanceOf(user.id)
  const result = await sendChatMessage(user, { conversationId: conv.id, content: '换成 16:9' })
  assert.equal(result.cost, 0)
  assert.equal(result.media, undefined)
  assert.equal(credits.balanceOf(user.id), before)
  assert.match(result.reply.content, /^已记下：下一张按 16:9 出/)
  assertNoVendor(result.reply.content)

  const stored = getConversation(user.id, conv.id)
  assert.deepEqual(stored.mediaDefaults, { ratio: '16:9' })
  assert.equal(stored.lastMediaTask, null)

  const attemptsBefore = imageAttempts
  const gen = await sendChatMessage(user, { conversationId: conv.id, content: '/生图 白底产品图' })
  assert.equal(gen.media.ratio, '16:9')
  assert.ok(await waitFor(() => imageAttempts > attemptsBefore))
  assert.equal(lastImageBody.size, '1536x1024')
})

test('上一版太久（超过最近 6 条）：也不许按它扣费重出，只记设置', async () => {
  const user = newUser('stale')
  const conv = createConversation(user.id, { title: '很久以前' })
  const messages = []
  for (let index = 0; index < 10; index += 1) {
    messages.push({ id: 'm' + index, role: index % 2 ? 'assistant' : 'user', content: '第 ' + index + ' 句', at: Date.now() })
  }
  saveConversation(user.id, {
    ...conv,
    messages,
    lastMediaTask: { id: 'mgen_stale01', kind: 'image', prompt: '旧图', params: { ratio: '1:1' }, refIds: [], at: messages[0].id },
  })
  const before = credits.balanceOf(user.id)
  const result = await sendChatMessage(user, { conversationId: conv.id, content: '换成 16:9' })
  assert.equal(result.media, undefined)
  assert.equal(result.cost, 0)
  assert.equal(credits.balanceOf(user.id), before)
  assert.match(result.reply.content, /^已记下：下一张按 16:9 出/)
  const stored = getConversation(user.id, conv.id)
  assert.equal(stored.lastMediaTask.id, 'mgen_stale01', '旧的上一版原样留着')
  assert.equal(stored.mediaDefaults.ratio, '16:9')
})

// ── 七、视频：会话设置铺到时长上，这次说的盖过它 ──────────────────────────────
test('视频：会话里记下的 8 秒铺到下一次生成，这次明确写 4 秒就以 4 秒为准', async () => {
  resetMediaGenRateLimit()
  const user = newUser('video')
  const conv = createConversation(user.id, { title: '视频设置' })

  const record = await sendChatMessage(user, { conversationId: conv.id, content: '改成 8 秒' })
  assert.equal(record.media, undefined)
  assert.match(record.reply.content, /^已记下：下一段按 8 秒出/)
  assert.equal(getConversation(user.id, conv.id).mediaDefaults.duration, 8)

  const gen = await sendChatMessage(user, { conversationId: conv.id, content: '/生视频 海边日落' })
  assert.equal(gen.media.duration, 8, '没写时长就沿用会话设置')
  assert.equal(lastVideoBody.duration, 8)
  assert.equal(lastVideoBody.aspect_ratio, '9:16')

  const explicit = await sendChatMessage(user, { conversationId: conv.id, content: '/生视频 4秒 海边日落' })
  assert.equal(explicit.media.duration, 4, '这次说的盖过会话设置')
  assert.equal(lastVideoBody.duration, 4)
  // 这次明确说了 4 秒：会话当前设置跟着改成 4
  assert.equal(getConversation(user.id, conv.id).mediaDefaults.duration, 4)

  // 上一版是视频，却要改画质：不建任务，只记设置
  const before = credits.balanceOf(user.id)
  const bad = await sendChatMessage(user, { conversationId: conv.id, content: '画质改高清' })
  assert.equal(bad.media, undefined)
  assert.equal(credits.balanceOf(user.id), before)
  assert.match(bad.reply.content, /上一版是视频/)
  assert.match(bad.reply.content, /没有画质这一档/)
  assert.equal(getConversation(user.id, conv.id).mediaDefaults.quality, 'high')
})

// ── 八、既有行为不许回退：r342 的参数识别照旧 ────────────────────────────────
test('r342 不回退：写死的 3:4 按 1152x1536 发出去，没选画质就不带 quality', async () => {
  resetMediaGenRateLimit()
  const user = newUser('legacy')
  const conv = createConversation(user.id, { title: 'r342' })
  const attemptsBefore = imageAttempts
  const result = await sendChatMessage(user, { conversationId: conv.id, content: '/生图 3:4 白底产品图' })
  assert.equal(result.media.ratio, '3:4')
  assert.ok(await waitFor(() => imageAttempts > attemptsBefore))
  assert.equal(lastImageBody.prompt, '白底产品图')
  assert.equal(lastImageBody.size, '1152x1536')
  assert.equal(lastImageBody.quality, undefined)
  assert.equal(getConversation(user.id, conv.id).mediaDefaults.ratio, '3:4', '写死的参数同样记进会话设置')
})
