// r343 独立取证 #1/#2/#4：真起服务（临时 DATA_DIR）+ 真账号 + 本地假上游，0 次真实上游调用。
//
// 验三件事：
//  #1 多轮改参数：/生图 3:4 → 改成 16:9 必须复用上一条任务重出（假上游被打到第 2 次）、
//     比例真是 16:9、只扣一次生成积分；同一值再说一遍不重跑也不扣费。
//  #2 参考图：带附件生成必须走 multipart 的 /images/edits（有 image 文件部件与 model/size 字段），
//     这一轮不许再打到 /images/generations。
//  #4 模型自称：抓真实出站请求正文，system 消息含「VisionQA 通用模型」且不含任何上游厂牌；
//     假上游回固定文本，服务端不往里补厂牌；并证明发出去的就是 chat.mjs 导出的 SYSTEM_PROMPT。
import fs from 'node:fs'
import path from 'node:path'
import {
  ADMIN_EMAIL,
  ROOT,
  TINY_PNG,
  USER_EMAIL,
  api,
  createReport,
  dump,
  ensureDir,
  login,
  readBalance,
  seedEnv,
  startFakeUpstream,
  startServer,
  waitFor,
} from './verify-r343-harness.mjs'

const VENDOR = /deepseek|geteapi|seeapi|cgcm|openai|claude|anthropic|gemini|qwen|doubao|火山|moonshot|zhipu|minimax|grok|sora|midjourney|seedream|kling|hunyuan|ernie|codex|workbuddy/i
const MODELISH = /[a-z0-9]-(flash|pro|turbo|mini|vision)\b/i

const report = createReport('r343 · #1 多轮改参数 / #2 参考图 / #4 模型自称')
const work = ensureDir(path.join(ROOT, '.tmp-r343-verify'))
const dataDir = path.join(work, 'data-e2e')
fs.rmSync(dataDir, { recursive: true, force: true })
ensureDir(dataDir)

const fake = await startFakeUpstream({ reply: '我是 VisionQA 通用模型。' })
console.log('[fake] 假上游 ' + fake.origin)

const seed = await new Promise((resolve) => {
  // 播种走独立进程：与真服务共用同一份 DATA_DIR / VQ_KEY_SECRET
  import('node:child_process').then(({ spawn }) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', path.join(ROOT, 'scripts', 'verify-r343-seed.mjs'), 'seed', dataDir, fake.origin], {
      cwd: ROOT,
      env: { ...process.env, ...seedEnv(dataDir) },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('close', (code) => resolve({ code, out, err }))
  })
})
console.log('[seed] exit=' + seed.code + ' ' + seed.out.trim())
if (seed.code !== 0) {
  console.error(seed.err)
  process.exit(1)
}

const port = await new Promise((resolve, reject) => {
  import('node:net').then(({ default: net }) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port: got } = server.address()
      server.close(() => resolve(got))
    })
  })
})
const server = await startServer({ dataDir, port, fakeOrigin: fake.origin })
console.log('[server] ' + server.base)

const balance = async (email) => {
  const got = await readBalance({ dataDir, email })
  if (got.code !== 0) throw new Error('读余额失败：' + got.err)
  return JSON.parse(got.out.trim()).balance
}

const tag = (request) => {
  if (!request) return '（没有请求）'
  const body = request.json ? JSON.stringify(request.json) : ''
  const parts = request.parts ? request.parts.map((part) => part.name + (part.filename ? '(' + part.filename + ')' : '')).join(',') : ''
  return request.method + ' ' + request.url + ' · ' + (parts ? 'parts=' + parts : body.slice(0, 500))
}

let exitCode = 0
try {
  const cookie = await login(server.base, USER_EMAIL)
  console.log('[login] ' + USER_EMAIL + ' ok')

  // ── #1 第一步：/生图 3:4 ────────────────────────────────────────────────
  const conv = await api(server.base, '/api/chat/conversations', { method: 'POST', cookie, body: {} })
  const convId = conv.json?.conversation?.id
  report.check('#1.0 建会话', Boolean(convId), 'conversationId=' + convId)

  const generations = () => fake.of(/\/images\/generations$/).length
  const edits = () => fake.of(/\/images\/edits$/).length
  const balanceBefore = await balance(USER_EMAIL)
  const genBefore = generations()

  const first = await api(server.base, '/api/chat/conversations/' + convId + '/messages', {
    method: 'POST',
    cookie,
    body: { content: '/生图 3:4 白底产品图' },
  })
  const firstMedia = first.json?.media
  report.check(
    '#1.1 任务开出来了（/生图 3:4）',
    first.status === 200 && Boolean(firstMedia?.id),
    'status=' + first.status + ' media=' + JSON.stringify({ id: firstMedia?.id, ratio: firstMedia?.ratio, size: firstMedia?.size, cost: firstMedia?.credits?.cost }),
  )
  report.check('#1.2 第一版比例真是 3:4', firstMedia?.ratio === '3:4', 'ratio=' + firstMedia?.ratio + ' size=' + firstMedia?.size)
  report.check('#1.3 第一版尺寸 1152x1536（3:4 算出来的）', firstMedia?.size === '1152x1536', 'size=' + firstMedia?.size)
  report.check('#1.4 生成指令这一轮不扣对话积分', first.json?.cost === 0, 'cost=' + first.json?.cost)

  const firstUpstream = await waitFor(() => fake.of(/\/images\/generations$/).find((item) => item.json && item.json.prompt === '白底产品图'))
  report.check('#1.5 假上游真的收到第 1 次出图', Boolean(firstUpstream), tag(firstUpstream))
  if (firstUpstream) {
    report.check('#1.6 第 1 次正文 size=1152x1536', firstUpstream.json.size === '1152x1536', JSON.stringify(firstUpstream.json))
    report.check('#1.7 没选画质就不许带 quality', firstUpstream.json.quality === undefined, 'quality=' + JSON.stringify(firstUpstream.json.quality))
    report.check('#1.8 模型是内部通道名（服务端字段，不是界面文案）', firstUpstream.json.model === 'gpt-image-2.6', 'model=' + firstUpstream.json.model)
  }
  const balanceAfterFirst = await balance(USER_EMAIL)
  const costFirst = Number(firstMedia?.credits?.cost) || 0
  report.check(
    '#1.9 第 1 次按生成管线扣费一次',
    costFirst > 0 && balanceBefore - balanceAfterFirst === costFirst,
    'before=' + balanceBefore + ' after=' + balanceAfterFirst + ' cost=' + costFirst,
  )

  // ── #1 第二步：「改成 16:9」复用上一版重出 ──────────────────────────────
  const genBeforeSecond = generations()
  const second = await api(server.base, '/api/chat/conversations/' + convId + '/messages', {
    method: 'POST',
    cookie,
    body: { content: '改成 16:9' },
  })
  const secondMedia = second.json?.media
  report.check(
    '#1.10 「改成 16:9」按上一版重出了新任务',
    second.status === 200 && Boolean(secondMedia?.id) && secondMedia.id !== firstMedia?.id,
    'status=' + second.status + ' newId=' + secondMedia?.id + ' oldId=' + firstMedia?.id,
  )
  report.check('#1.11 新任务比例是 16:9', secondMedia?.ratio === '16:9', 'ratio=' + secondMedia?.ratio + ' size=' + secondMedia?.size)
  report.check('#1.12 新任务尺寸是 1536x1024（没被旧比例顶住）', secondMedia?.size === '1536x1024', 'size=' + secondMedia?.size)
  report.check(
    '#1.13 复用同一个提示词',
    secondMedia?.prompt === '白底产品图',
    'prompt=' + secondMedia?.prompt,
  )
  report.check(
    '#1.14 回答明确说「重出上一版」',
    String(second.json?.reply?.content || '').startsWith('按 16:9 重出上一版'),
    JSON.stringify(String(second.json?.reply?.content || '').slice(0, 60)),
  )
  const secondUpstream = await waitFor(() => fake.of(/\/images\/generations$/).slice(genBeforeSecond).find((item) => item.json && item.json.prompt === '白底产品图'))
  report.check('#1.15 假上游真的被打到第 2 次', Boolean(secondUpstream), 'generations 总次数=' + generations() + ' · ' + tag(secondUpstream))
  if (secondUpstream) {
    report.check('#1.16 第 2 次正文的 size 真是 1536x1024（16:9）', secondUpstream.json.size === '1536x1024', JSON.stringify(secondUpstream.json))
    report.check('#1.17 第 2 次正文没带旧尺寸', secondUpstream.json.size !== '1152x1536', 'size=' + secondUpstream.json.size)
  }
  const balanceAfterSecond = await balance(USER_EMAIL)
  const costSecond = Number(secondMedia?.credits?.cost) || 0
  report.check(
    '#1.18 重出一版只扣一次生成积分',
    costSecond > 0 && balanceAfterSecond === balanceAfterFirst - costSecond,
    'afterFirst=' + balanceAfterFirst + ' afterSecond=' + balanceAfterSecond + ' cost=' + costSecond,
  )

  // ── #1 第三步：同一值再说一遍 → 不重跑、不扣费 ───────────────────────────
  const genBeforeThird = generations()
  const balanceBeforeThird = await balance(USER_EMAIL)
  const third = await api(server.base, '/api/chat/conversations/' + convId + '/messages', {
    method: 'POST',
    cookie,
    body: { content: '改成 16:9' },
  })
  report.check('#1.19 同一值再说一遍不建新任务', third.status === 200 && !third.json?.media, 'status=' + third.status + ' media=' + JSON.stringify(third.json?.media || null))
  report.check(
    '#1.20 回答是「上一版已经是 16:9，没有重出」',
    String(third.json?.reply?.content || '').startsWith('上一版已经是 16:9，没有重出'),
    JSON.stringify(String(third.json?.reply?.content || '').slice(0, 60)),
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  report.check('#1.21 假上游没有被再打一次', generations() === genBeforeThird, 'generations ' + genBeforeThird + ' → ' + generations())
  const balanceAfterThird = await balance(USER_EMAIL)
  report.check('#1.22 不二次扣费：余额一分没动', balanceAfterThird === balanceBeforeThird, 'before=' + balanceBeforeThird + ' after=' + balanceAfterThird)

  // 会话里留档：mediaDefaults / lastMediaTask 都对
  const stored = await api(server.base, '/api/chat/conversations/' + convId, { cookie })
  report.check(
    '#1.23 会话记住当前设置 ratio=16:9',
    stored.json?.conversation?.mediaDefaults?.ratio === '16:9',
    JSON.stringify(stored.json?.conversation?.mediaDefaults),
  )
  report.check(
    '#1.24 上一版指向第 2 条任务',
    stored.json?.conversation?.lastMediaTask?.id === secondMedia?.id,
    'lastMediaTask=' + stored.json?.conversation?.lastMediaTask?.id + ' second=' + secondMedia?.id,
  )

  // ── #2 参考图走 /images/edits（multipart）───────────────────────────────
  const conv2 = await api(server.base, '/api/chat/conversations', { method: 'POST', cookie, body: {} })
  const conv2Id = conv2.json?.conversation?.id
  const upload = await api(server.base, '/api/chat/files', {
    method: 'POST',
    cookie,
    raw: TINY_PNG,
    headers: { 'Content-Type': 'image/png', 'x-file-name': encodeURIComponent('参考图.png') },
  })
  const fileId = upload.json?.file?.id
  report.check('#2.1 参考图真的上传成功', upload.status === 200 && Boolean(fileId), 'status=' + upload.status + ' file=' + JSON.stringify(upload.json?.file && { id: upload.json.file.id, name: upload.json.file.name, kind: upload.json.file.kind }))

  const genBeforeRef = generations()
  const editBefore = edits()
  const ref = await api(server.base, '/api/chat/conversations/' + conv2Id + '/messages', {
    method: 'POST',
    cookie,
    body: { content: '/生图 1:1 照着这张画 白底产品图', files: [fileId] },
  })
  report.check(
    '#2.2 带参考图的生成开出了任务',
    ref.status === 200 && Boolean(ref.json?.media?.id),
    'status=' + ref.status + ' media=' + JSON.stringify(ref.json?.media && { id: ref.json.media.id, mode: ref.json.media.mode, assets: ref.json.media.assets }),
  )
  console.log('[mem] before edits-wait heap=' + Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB serverLog=' + server.log().length + 'B')
  const editRequest = await waitFor(() => fake.of(/\/images\/edits$/)[editBefore], 12000)
  console.log('[mem] after edits-wait heap=' + Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB')
  report.check('#2.3 假上游收到 /images/edits', Boolean(editRequest), tag(editRequest))
  if (editRequest) {
    report.check(
      '#2.4 Content-Type 是 multipart/form-data 且带 boundary',
      /^multipart\/form-data; boundary=/.test(editRequest.contentType),
      editRequest.contentType,
    )
    const byName = new Map((editRequest.parts || []).map((part) => [part.name, part]))
    const imagePart = byName.get('image')
    report.check('#2.5 有 image 文件部件', Boolean(imagePart), imagePart ? 'name=image filename=' + imagePart.filename + ' type=' + imagePart.contentType : '（没有 image 部件）')
    report.check('#2.6 image 部件带文件名 reference.png', imagePart?.filename === 'reference.png', 'filename=' + imagePart?.filename)
    report.check(
      '#2.7 文件字节真的传上去了（= 上传的那张 PNG）',
      Boolean(imagePart) && imagePart.bytes.length === TINY_PNG.length && imagePart.bytes.toString('hex') === TINY_PNG.toString('hex'),
      'bytes=' + (imagePart?.bytes?.length ?? -1) + ' expect=' + TINY_PNG.length,
    )
    report.check('#2.8 有 model 字段且是内部通道名', byName.get('model')?.bytes.toString('utf8') === 'gpt-image-2.6', 'model=' + byName.get('model')?.bytes.toString('utf8'))
    report.check('#2.9 有 size 字段 1024x1024', byName.get('size')?.bytes.toString('utf8') === '1024x1024', 'size=' + byName.get('size')?.bytes.toString('utf8'))
    report.check('#2.10 有 prompt 字段且含提示词', /白底产品图/.test(byName.get('prompt')?.bytes.toString('utf8') || ''), 'prompt=' + byName.get('prompt')?.bytes.toString('utf8'))
    report.check('#2.11 有 n / response_format 字段', byName.get('n')?.bytes.toString('utf8') === '1' && byName.get('response_format')?.bytes.toString('utf8') === 'b64_json', 'n/response_format ok')
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
  report.check('#2.12 这一轮没有打到 /images/generations', generations() === genBeforeRef, 'generations ' + genBeforeRef + ' → ' + generations())
  report.check('#2.13 这一轮只打了 1 次 /images/edits', edits() === editBefore + 1, 'edits ' + editBefore + ' → ' + edits())

  // ── #4 模型自称：抓真实出站正文 ────────────────────────────────────────
  const conv3 = await api(server.base, '/api/chat/conversations', { method: 'POST', cookie, body: {} })
  const conv3Id = conv3.json?.conversation?.id
  const chatBefore = fake.of(/\/chat\/completions$/).length
  const chat = await api(server.base, '/api/chat/conversations/' + conv3Id + '/messages', {
    method: 'POST',
    cookie,
    body: { content: '你是什么模型？' },
  })
  const chatRequest = await waitFor(() => fake.of(/\/chat\/completions$/)[chatBefore])
  report.check('#4.1 假文本上游真的收到一次请求', Boolean(chatRequest), tag(chatRequest))
  const systemText = String(chatRequest?.json?.messages?.[0]?.content || '')
  report.check('#4.2 第 1 条是 system 消息', chatRequest?.json?.messages?.[0]?.role === 'system', 'role=' + chatRequest?.json?.messages?.[0]?.role)
  report.check('#4.3 system 里自称「VisionQA 通用模型」', systemText.includes('VisionQA 通用模型'), JSON.stringify(systemText.slice(0, 80)))
  report.check('#4.4 system 里没有任何上游厂牌', !VENDOR.test(systemText), VENDOR.test(systemText) ? '命中：' + (systemText.match(VENDOR) || [])[0] : '0 命中')
  report.check('#4.5 system 里没有 xxx-flash / xxx-pro 形态', !MODELISH.test(systemText), MODELISH.test(systemText) ? '命中：' + (systemText.match(MODELISH) || [])[0] : '0 命中')

  const sysDump = await new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['--experimental-sqlite', path.join(ROOT, 'scripts', 'verify-r343-seed.mjs'), 'sysprompt', dataDir], {
        cwd: ROOT,
        env: { ...process.env, ...seedEnv(dataDir) },
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.on('close', () => resolve(out.trim()))
    })
  })
  let exportedPrompt = ''
  try {
    exportedPrompt = JSON.parse(sysDump).systemPrompt
  } catch {}
  report.check(
    '#4.6 出站 system 与 chat.mjs 导出的 SYSTEM_PROMPT 完全一致',
    Boolean(exportedPrompt) && systemText === exportedPrompt,
    'exportedLen=' + exportedPrompt.length + ' outboundLen=' + systemText.length,
  )
  report.check(
    '#4.7 假上游回固定文本，服务端不补厂牌：回答与上游原文逐字相同',
    chat.json?.reply?.content === '我是 VisionQA 通用模型。',
    JSON.stringify(chat.json?.reply?.content || '').slice(0, 120),
  )
  report.check('#4.8 出站 model 仍是内部名（服务端字段）', chatRequest?.json?.model === 'deepseek-flash', 'model=' + chatRequest?.json?.model)

  dump(path.join(work, 'e2e-upstream.json'), JSON.stringify(fake.requests.map((item) => ({
    method: item.method,
    url: item.url,
    contentType: item.contentType,
    json: item.json,
    parts: item.parts ? item.parts.map((part) => ({ name: part.name, filename: part.filename, contentType: part.contentType, bytes: part.bytes.length })) : null,
  })), null, 2))
  console.log('[evidence] .tmp-r343-verify/e2e-upstream.json（' + fake.requests.length + ' 个假上游请求）')
} catch (error) {
  report.check('执行过程没有抛错', false, String(error?.stack || error).slice(0, 1200))
} finally {
  exitCode = report.finish()
  await server.close()
  await fake.close()
}
process.exit(exitCode)
