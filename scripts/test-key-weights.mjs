// 权重分配单测：同优先级的 Key 按权重抽，抽出来的比例要接近权重比，
// 而不是「永远选第一把」——后台预演里写的百分比得是真的。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-weights-'))
process.env.DATA_DIR = temp
process.env.VQ_KEY_SECRET = 'test-secret-for-weights'

const { createKey, resolveKey, resolveKeyCandidates, previewRoute, deleteKey } = await import('../server/keyvault.mjs')

const light = createKey({ name: '轻权重', provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-light-000000001', models: ['fake-model'], capabilities: ['text'], priority: 50, weight: 100 })
const heavy = createKey({ name: '重权重', provider: 'custom', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'sk-heavy-000000002', models: ['fake-model'], capabilities: ['text'], priority: 50, weight: 300 })

// 1) 后台预演的顺序与份额：两把同优先级，按权重 25% / 75%
const preview = previewRoute({ capability: 'text', model: 'fake-model' })
assert.equal(preview.group.length, 2)
const shares = Object.fromEntries(preview.group.map((row) => [row.name, row.share]))
assert.deepEqual([shares['轻权重'], shares['重权重']], [25, 75], '预演份额要按权重算')
assert.match(preview.description, /按权重随机/)
assert.match(preview.description, /轻权重 25%/)
assert.match(preview.description, /重权重 75%/)

// 2) 真抽 2000 次，比例要落在权重比附近（±5 个百分点），证明不是永远第一把
const rounds = 2000
let lightHits = 0
for (let i = 0; i < rounds; i += 1) {
  const picked = resolveKey({ capability: 'text', model: 'fake-model' })
  if (!picked) throw new Error('同优先级两把都可用时不应选不出 Key')
  if (picked.id === light.id) lightHits += 1
}
const lightRatio = lightHits / rounds
assert.ok(lightRatio > 0.2 && lightRatio < 0.3, '轻权重占比应接近 25%，实测 ' + (lightRatio * 100).toFixed(1) + '%')

// 3) 故障回退候选：同优先级两把都要在候选里，且不放回（不出现重复 Key）
const candidates = resolveKeyCandidates({ capability: 'text', model: 'fake-model', limit: 3 })
assert.equal(candidates.length, 2)
assert.equal(new Set(candidates.map((item) => item.id)).size, 2, '候选不能有重复的 Key')
assert.deepEqual(candidates.map((item) => item.attempt), [1, 2], '候选要按尝试顺序编号')
assert.match(candidates[0].reason, /首选/)
assert.match(candidates[1].reason, /失败后回退/)

// 4) 优先级高的先试：再加一把 P10 的，它永远排在两个 P50 之前
const priority = createKey({ name: '高优先级', provider: 'custom', baseUrl: 'http://127.0.0.1:3/v1', apiKey: 'sk-pri-0000000003', models: ['fake-model'], capabilities: ['text'], priority: 10, weight: 1 })
const ordered = resolveKeyCandidates({ capability: 'text', model: 'fake-model', limit: 3 })
assert.equal(ordered[0].id, priority.id, '优先级小的先试，哪怕权重最小')
assert.equal(ordered[1].priority, 50)
assert.equal(ordered[2].priority, 50)
deleteKey(priority.id)

// 5) 停用的 Key 不进候选，也不影响份额
const disabled = createKey({ name: '停用', provider: 'custom', baseUrl: 'http://127.0.0.1:4/v1', apiKey: 'sk-off-0000000004', models: ['fake-model'], capabilities: ['text'], priority: 50, weight: 5000, enabled: false })
assert.equal(previewRoute({ capability: 'text', model: 'fake-model' }).group.length, 2, '停用的 Key 不参与抽签')
assert.ok(!resolveKeyCandidates({ capability: 'text', model: 'fake-model', limit: 3 }).some((item) => item.id === disabled.id))
assert.ok(light.id && heavy.id)

fs.rmSync(temp, { recursive: true, force: true })
console.log(
  'PASS key-weights: 预演份额 25/75 · 真实抽取 ' + (lightRatio * 100).toFixed(1) + '% : ' + ((1 - lightRatio) * 100).toFixed(1) +
    '%（2000 次）/ 候选不重复 / 优先级优先 / 停用不参与',
)
