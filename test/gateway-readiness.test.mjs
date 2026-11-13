import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 「能不能生成」是三个条件同时成立：平台额度开关、服务令牌、至少一把声明了出图 / 出视频能力的 Key。
// 2026-11-13 后台把「令牌已配、额度没开」显示成「通道已开启」，画布点生成却回 503；
// 这组测试盯的就是这个判断本身，别让后台再有第二次误报。
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-gateway-readiness-'))
const { gatewayReadiness } = await import('../server/gateway.mjs')

const ok = { open: true, configured: true, image: 1, video: 1 }

test('三样都在位才算能生成', () => {
  assert.deepEqual(gatewayReadiness(ok), { ready: true, missing: [] })
})

test('额度开关关着：令牌对也不能生成，先报开关', () => {
  assert.deepEqual(gatewayReadiness({ ...ok, open: false }), { ready: false, missing: ['open'] })
})

test('服务令牌没配：通道直接 503', () => {
  assert.deepEqual(gatewayReadiness({ ...ok, configured: false }), { ready: false, missing: ['token'] })
})

test('一把 Key 都没有：模型清单再全也生成不了', () => {
  assert.deepEqual(gatewayReadiness({ ...ok, image: 0, video: 0 }), { ready: false, missing: ['keys'] })
})

test('只有出图 Key、没有出视频 Key：出图通道仍算通', () => {
  assert.deepEqual(gatewayReadiness({ ...ok, image: 1, video: 0 }), { ready: true, missing: [] })
})

test('只有出视频 Key、没有出图 Key：同样算通', () => {
  assert.deepEqual(gatewayReadiness({ ...ok, image: 0, video: 2 }), { ready: true, missing: [] })
})

test('三样全缺：按「开关 → 令牌 → Key」的顺序报，后台照这个顺序修', () => {
  assert.deepEqual(gatewayReadiness({ open: false, configured: false, image: 0, video: 0 }), {
    ready: false,
    missing: ['open', 'token', 'keys'],
  })
  assert.deepEqual(gatewayReadiness({ open: false, configured: false, image: 1, video: 1 }).missing, ['open', 'token'])
})

test('参数缺省时按「都没配」处理，不抛错', () => {
  assert.deepEqual(gatewayReadiness(), { ready: false, missing: ['open', 'token', 'keys'] })
  assert.deepEqual(gatewayReadiness({}), { ready: false, missing: ['open', 'token', 'keys'] })
})
