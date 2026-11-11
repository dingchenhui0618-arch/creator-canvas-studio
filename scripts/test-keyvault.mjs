// 平台 Key 池单测：加密落盘、脱敏、路由、冷却、增删改。
// 用临时数据目录，不碰线上 data/。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-keyvault-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'test-secret-for-keyvault'
process.env.VISION_API_KEY = ''

const { createKey, listKeys, updateKey, deleteKey, resolveKey, reportKey, vaultModels, planRoute, previewRoute, recordRoute, listRoutes } = await import('../server/keyvault.mjs')

const plaintext = 'sk-test-1234567890abcdef'
const created = createKey({
  name: '测试 Key',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1/',
  apiKey: plaintext,
  models: ['deepseek-flash'],
  capabilities: ['text', 'vision'],
  priority: 10,
  weight: 200,
})
assert.equal(created.masked, 'sk-t••••cdef')
assert.ok(!JSON.stringify(listKeys()).includes(plaintext), '列表不能出现明文')

const raw = fs.readFileSync(path.join(temp, 'model-keys.json'), 'utf8')
assert.ok(!raw.includes(plaintext), '落盘文件不能出现明文')
assert.ok(raw.includes('enc:v1:'), '落盘必须是密文')

const resolved = resolveKey({ capability: 'text', model: 'deepseek-flash' })
assert.equal(resolved.id, created.id)
assert.equal(resolved.apiKey, plaintext, '解密后应能拿到原 Key')
assert.deepEqual(vaultModels('text'), ['deepseek-flash'])

// 模型不匹配时不应把专用 Key 拿去用
assert.equal(resolveKey({ capability: 'text', model: 'other-model' })?.id, undefined)

// 连续失败 3 次 → 冷却，路由跳过
reportKey(created.id, false, 'boom')
reportKey(created.id, false, 'boom')
reportKey(created.id, false, 'boom')
assert.equal(resolveKey({ capability: 'text', model: 'deepseek-flash' }), null, '冷却中的 Key 不应被选中')
assert.equal(listKeys().items[0].cooling, true)

// 后台要看得见「为什么这把 Key 没被用」：失败次数、最近错误、冷却剩余秒数
const cooling = listKeys().items[0]
assert.equal(cooling.usage.fail, 3, '失败的调用要计数')
assert.equal(cooling.usage.lastError, 'boom')
assert.equal(cooling.usage.lastErrorAt.length > 0, true)
assert.ok(cooling.usage.cooldownSec > 0 && cooling.usage.cooldownSec <= 60, '冷却剩余秒数要在 1–60 之间')
assert.equal(listKeys().summary.usage.fail, 3)

// 成功后恢复
reportKey(created.id, true)
assert.equal(resolveKey({ capability: 'text', model: 'deepseek-flash' })?.id, created.id)
const recovered = listKeys().items[0]
assert.equal(recovered.cooling, false)
assert.equal(recovered.usage.cooldownSec, 0)
assert.equal(recovered.usage.ok, 1, '成功调用要计数')
assert.equal(listKeys().summary.usage.ok, 1)

const updated = updateKey(created.id, { enabled: false })
assert.equal(updated.enabled, false)
assert.equal(resolveKey({ capability: 'text' }), null)

updateKey(created.id, { enabled: true, priority: 5 })
assert.equal(listKeys().summary.counts.text, 1)
assert.equal(listKeys().summary.counts.vision, 1)

// 路由解释：预演与真实调用共用同一套判定，后台说走哪把，实际就按这个选
const plan = planRoute({ capability: 'text', model: 'deepseek-flash' })
assert.equal(plan.keys.length, 1)
assert.equal(plan.keys[0].state, 'eligible')
assert.equal(plan.group.length, 1)
assert.equal(plan.group[0].share, 100)
assert.match(previewRoute({ capability: 'text', model: 'deepseek-flash' }).description, /会用/)
assert.equal(previewRoute({ capability: 'image' }).group.length, 0, '没有出图能力的 Key 不能假装可用')

// 模型白名单不匹配要说清是哪一项不对，而不是只回「没有可用 Key」
const miss = planRoute({ capability: 'text', model: 'other-model' })
assert.equal(miss.keys[0].state, 'model')
assert.match(miss.keys[0].reason, /other-model/)

// 路由日志：最新在前、按 Key 聚合、绝不带 Key 明文
recordRoute({ capability: 'text', model: 'deepseek-flash', keyId: created.id, keyName: created.name, source: 'pool', reason: '测试成功', ms: 42, ok: true })
recordRoute({ capability: 'text', model: 'deepseek-flash', source: 'env', reason: '池里没有可用 Key', ms: 900, ok: false, error: 'HTTP 402 {"error":{"message":"Insufficient Balance"}}' })
const routes = listRoutes(10)
assert.equal(routes.summary.total, 2)
assert.equal(routes.summary.ok, 1)
assert.equal(routes.summary.fail, 1)
assert.equal(routes.summary.env, 1)
assert.equal(routes.summary.avgMs, 471)
assert.equal(routes.summary.byKey.length, 2)
assert.equal(routes.items[0].source, 'env', '最新的记录排在最前')
assert.equal(routes.items[0].keyId, '', '回落环境变量时不记 Key id')
assert.equal(JSON.stringify(routes).includes(plaintext), false, '路由日志不能带 Key 明文')
// 给管理员看的是人话，原始上游报错留在 detail 里
assert.equal(routes.items[0].error, '额度不足（HTTP 402）')
assert.match(routes.items[0].detail, /Insufficient Balance/)

deleteKey(created.id)
assert.equal(listKeys().items.length, 0)
assert.equal(resolveKey({ capability: 'text' }), null)

fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS keyvault: 加密落盘 / 脱敏 / 模型匹配 / 冷却恢复 / 增删改 / 路由预演 / 路由日志')
