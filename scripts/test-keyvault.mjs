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

const { createKey, listKeys, updateKey, deleteKey, resolveKey, reportKey, vaultModels } = await import('../server/keyvault.mjs')

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

deleteKey(created.id)
assert.equal(listKeys().items.length, 0)
assert.equal(resolveKey({ capability: 'text' }), null)

fs.rmSync(temp, { recursive: true, force: true })
console.log('PASS keyvault: 加密落盘 / 脱敏 / 模型匹配 / 冷却恢复 / 增删改')
