// 后台「测试」按钮的凭证探活地址：SeeAPI 在 /v1/models，其它按 baseUrl 拼 /models。
// 2026-11-17 生产实测：SeeAPI 的 baseUrl 写成 https://api.cgcm-api.com（不带 /v1）时，
// 旧实现探 https://api.cgcm-api.com/models → 404，界面提示「检查 baseUrl 是否带 /v1」，误导管理员。
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelsProbeUrl } from '../server/keyvault.mjs'

test('SeeAPI：两种 baseUrl 写法都归到 /v1/models', () => {
  assert.equal(modelsProbeUrl('https://api.cgcm-api.com'), 'https://api.cgcm-api.com/v1/models')
  assert.equal(modelsProbeUrl('https://api.cgcm-api.com/'), 'https://api.cgcm-api.com/v1/models')
  assert.equal(modelsProbeUrl('https://api.cgcm-api.com/v1'), 'https://api.cgcm-api.com/v1/models')
})

test('OpenAI 兼容中转：baseUrl 已带 /v1，不再重复', () => {
  assert.equal(modelsProbeUrl('https://www.geteapi.com/v1'), 'https://www.geteapi.com/v1/models')
})

test('方舟与其它：按 baseUrl 拼 /models', () => {
  assert.equal(modelsProbeUrl('https://ark.cn-beijing.volces.com/api/v3'), 'https://ark.cn-beijing.volces.com/api/v3/models')
})
