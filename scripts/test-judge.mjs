// 判断层（TypeSafe / Jev）集成测试：假 TypeSafe + 假视觉上游，走真实代码路径。
// 验证：只问四个判断、答案映射、判断结果挂在评审结果上、判断失败不影响评审、没配 Key 时明确 disabled。
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-judge-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'test-secret-for-judge'
process.env.VISION_API_KEY = ''
process.env.VISION_BASE_URL = 'http://127.0.0.1:1/v1'
process.env.LLM_MODEL = 'fake-vision'
process.env.LLM_FALLBACKS = ''
process.env.VISION_MODEL = 'fake-vision'
process.env.VISION_MODELS = 'fake-vision'
process.env.VISION_FALLBACKS = ''
process.env.VISIONQA_SERVICE_URL = 'http://127.0.0.1:1'

let typesafeMode = 'ok'
const judgeRequests = []

const REVIEW = {
  verdict: 'needs_review',
  summary: '封面主标题对比度偏低，主体与背景的层次不清。',
  observations: [
    { dimension: 'contrast', severity: 'major', statement: '标题文字与背景明度接近，缩到手机尺寸后难以辨认。', evidence: { x: 0.1, y: 0.05, w: 0.5, h: 0.12 }, confidence: 0.8 },
    { dimension: 'hierarchy', severity: 'minor', statement: '主体与副标题字号差只有一级，第一落点不明确。', evidence: { x: 0.2, y: 0.3, w: 0.4, h: 0.3 }, confidence: 0.6 },
  ],
  fixes: [{ title: '提高标题对比', detail: '标题改纯白并给背景加深色蒙版，对比度到 4.5:1 以上。' }],
  notAssessable: ['没有提供投放尺寸，无法判断裁切安全区。'],
}

const vision = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REVIEW) }, finish_reason: 'stop' }] }))
    })
    return
  }
  res.writeHead(404).end('{}')
})
const judge = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    judgeRequests.push({ url: req.url, auth: req.headers.authorization, body })
    if (req.url !== '/v1/systemone') return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}')
    if (typesafeMode === 'fail') return res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"upstream busy"}')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      model: 'jev-test',
      answers: {
        evidence_consistent: { type: 'noul', noul: 0.82 },
        verdict_supported: { type: 'choice', choice: 'supported', confidence: 0.71, probabilities: { supported: 0.78, too_strict: 0.14, too_lenient: 0.08 } },
        actionable: { type: 'noul', noul: 0.9 },
        publish_risk: { type: 'score', score: 1.2, confidence: 0.6, legend: { 0: '可以直接发布', 1: '小修后可以发布', 2: '必须先解决问题再发布' }, probabilities: { 0: 0.2, 1: 0.7, 2: 0.1 } },
      },
      usage: { input_tokens: 320, output_tokens: 24 },
    }))
  })
})
await new Promise((resolve) => vision.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => judge.listen(0, '127.0.0.1', resolve))
const visionBase = 'http://127.0.0.1:' + vision.address().port + '/v1'
const judgeBase = 'http://127.0.0.1:' + judge.address().port + '/v1'

const { createKey, deleteKey, listRoutes } = await import('../server/keyvault.mjs')
const { judgeReview, judgeStatus } = await import('../server/judge.mjs')
const { reviewVisual } = await import('../server/review.mjs')

createKey({
  name: '假视觉 Key',
  provider: 'custom',
  baseUrl: visionBase,
  apiKey: 'sk-vision-1234567890',
  models: ['fake-vision'],
  capabilities: ['text', 'vision'],
  priority: 10,
  weight: 100,
})
const judgeKey = createKey({
  name: '假判断 Key（Jev）',
  provider: 'typesafe',
  baseUrl: judgeBase,
  apiKey: 'ts-judge-1234567890',
  models: ['jev-test'],
  capabilities: ['judge'],
  priority: 10,
  weight: 100,
})

// 1) 能力别名：judgment / jev / typesafe / 判断 都落到「判断」
const aliasKey = createKey({ name: '别名判断 Key', provider: 'typesafe', baseUrl: judgeBase, apiKey: 'ts-alias-123456', models: ['jev-test'], capabilities: ['jev'] })
assert.deepEqual(aliasKey.capabilities, ['judge'])
deleteKey(aliasKey.id)

// 2) 有判断 Key 时：评审结果挂上结构化判断
assert.equal(judgeStatus().configured, true)
const first = await reviewVisual({ imageBytes: Buffer.from('fake-image-bytes'), mime: 'image/png', intent: '评审这张内容封面' })
assert.equal(first.judge.status, 'ok')
assert.equal(first.judge.model, 'jev-test')
assert.equal(first.judge.evidenceConsistent, 0.82)
assert.equal(first.judge.actionable, 0.9)
assert.equal(first.judge.verdictSupport.choice, 'supported')
assert.equal(first.judge.publishRisk.score, 1.2)
assert.equal(first.judge.publishRisk.legend['1'], '小修后可以发布')
// 判断只挂依据，不改视觉结论
assert.equal(first.verdict, 'needs_review')
assert.equal(first.observations.length, 2)

// 3) 发给 TypeSafe 的请求：四个问题、状态里带评审结论与问题清单、用判断 Key 的凭证
const sent = JSON.parse(judgeRequests[0].body)
assert.equal(judgeRequests[0].url, '/v1/systemone')
assert.equal(judgeRequests[0].auth, 'Bearer ts-judge-1234567890')
assert.deepEqual(Object.keys(sent.questions).sort(), ['actionable', 'evidence_consistent', 'publish_risk', 'verdict_supported'])
assert.equal(sent.state.verdict, 'needs_review')
assert.equal(sent.state.problems.length, 2)
assert.equal(sent.state.problems[0].hasEvidence, true)
assert.equal(sent.questions.verdict_supported.type, 'choice')
assert.equal(sent.questions.publish_risk.type, 'score')
assert.equal(sent.model, 'jev-test')

// 4) 判断调用落进路由日志（后台能看到判断层走了哪把）
const judgeRoutes = listRoutes(20).items.filter((item) => item.capability === 'judge')
assert.equal(judgeRoutes.length, 1)
assert.equal(judgeRoutes[0].ok, true)
assert.equal(judgeRoutes[0].keyName, '假判断 Key（Jev）')

// 5) 判断层失败：评审照常返回，judge.status = failed，原因进日志
typesafeMode = 'fail'
const second = await reviewVisual({ imageBytes: Buffer.from('fake-image-bytes'), mime: 'image/png', intent: '评审这张内容封面' })
assert.equal(second.judge.status, 'failed')
assert.match(second.judge.error, /503|上游/)
assert.equal(second.observations.length, 2, '判断失败不能把评审结论一起弄丢')
const failedRoutes = listRoutes(20).items.filter((item) => item.capability === 'judge')
assert.equal(failedRoutes[0].ok, false)

// 6) 没配判断 Key：明确 disabled，不假装成功，也不卡评审
typesafeMode = 'ok'
deleteKey(judgeKey.id)
assert.equal(judgeStatus().configured, false)
const disabled = await judgeReview({ verdict: 'pass', summary: 'ok', observations: [], fixes: [] }, { intent: '' })
assert.equal(disabled.status, 'disabled')
assert.match(disabled.note, /还没接入/)

// 7) 日志里不能出现 Key 明文
assert.equal(JSON.stringify(listRoutes(50)).includes('ts-judge-1234567890'), false)
assert.equal(JSON.stringify(listRoutes(50)).includes('sk-vision-1234567890'), false)

vision.close()
judge.close()
fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS judge: 能力别名 / 四问映射 / 结果挂载不改结论 / 请求形态 / 路由留痕 / 失败不拖垮评审 / 未启用明确')
