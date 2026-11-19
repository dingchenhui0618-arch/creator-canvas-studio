// r263 / v0.9.246：用户侧的报错只说人话
//
// 背景：对话失败时界面上写着「建议：在项目 .env 里配置 VISION_API_KEY，或确认本机 ~/.codex/auth.json 存在」，
// 工作台横幅写着「无限画布服务没有连上（本机 5312）…确认无限画布服务已启动」，下载失败时直接把浏览器的
// 英文「Failed to fetch」丢出来。这些都是给开发/运维看的话，普通账号没有 .env，也没有那台机器的 shell。
//
// 这里守三件事：① 生产口径的对话失败文案不出现开发者话术；② 内部口径仍保留排障线索（不然运维瞎了）；
// ③ 前端所有请求都经过 safeFetch，网络层失败不再把英文原文透给用户。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-plain-language-'))
process.env.DATA_DIR = dir
process.env.VISION_API_KEY = ''
// 不设 VQ_UI_MODE：默认就是对外生产口径
delete process.env.VQ_UI_MODE

const { chatErrorCopy } = await import('../server/agentChat.mjs')
const { canvasErrorMessage } = await import('../server/bdc.mjs')

// 这些词只会出现在排障语境里：.env 变量名、本机端口、服务进程名、家目录文件
const DEV_WORDS = /\.env|VISION_[A-Z_]+|~\/\.codex|OpenCodex|127\.0\.0\.1|本机 5312|启动服务/

const KINDS = ['no_model', 'no_candidates', 'timeout', 'network', 'auth', 'not_found', 'rate_limit', 'server', 'empty', 'generic']

test('生产口径：对话失败的提示与建议里没有开发者话术', () => {
  for (const kind of KINDS) {
    const copy = chatErrorCopy(kind, { internal: false, detail: 'fetch failed' })
    assert.ok(copy.suggestion && copy.suggestion.length >= 6, kind + ' 要有能给用户看的建议')
    assert.doesNotMatch(copy.message || '', DEV_WORDS, kind + ' 的 message 不该出现排障话术')
    assert.doesNotMatch(copy.suggestion, DEV_WORDS, kind + ' 的 suggestion 不该出现排障话术')
  }
})

test('生产口径：连不上模型服务时说清「没发出去 + 下一步」，不报本地端点', () => {
  const copy = chatErrorCopy('network', { internal: false, detail: 'connect ECONNREFUSED 127.0.0.1:10100' })
  assert.match(copy.message, /没有发出去/)
  assert.match(copy.suggestion, /重试|管理员/)
  assert.doesNotMatch(copy.message + copy.suggestion, /10100|VISION_BASE_URL/)
})

test('内部口径：排障线索还在（.env / Key / 端口 / 超时参数）', () => {
  assert.match(chatErrorCopy('no_model', { internal: true }).suggestion, /\.env|VISION_API_KEY/)
  assert.match(chatErrorCopy('network', { internal: true }).suggestion, /127\.0\.0\.1|VISION_BASE_URL/)
  assert.match(chatErrorCopy('network', { internal: true }).message, /本地模型端点/)
  assert.match(chatErrorCopy('timeout', { internal: true }).suggestion, /VISION_TIMEOUT_MS/)
})

test('无限画布连不上：生产不说端口与服务名，内部仍给 5312', () => {
  const prod = canvasErrorMessage(new Error('fetch failed'), { internal: false })
  assert.match(prod, /无限画布/)
  assert.match(prod, /不受影响/)
  assert.doesNotMatch(prod, /5312|服务已启动/)

  const dev = canvasErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:5312'), { internal: true })
  assert.match(dev, /本机 5312/)
})

test('不是网络错误就原样透传，不吞服务端的话', () => {
  assert.equal(canvasErrorMessage(new Error('canvas not found'), { internal: false }), 'canvas not found')
  assert.equal(canvasErrorMessage('某个真实错误', { internal: true }), '某个真实错误')
})

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

test('前端请求统一走 safeFetch：网络失败翻译成中文，原始串留在 detail', () => {
  const client = read('src/api/client.ts')
  assert.match(client, /export function networkError/)
  assert.match(client, /连不上服务：检查网络后重试。/)
  assert.match(client, /export async function safeFetch/)
  // 主动取消要原样抛回，不能被当成「连不上」
  assert.match(client, /isAbortError/)

  for (const rel of ['src/api/radar.ts', 'src/api/chat.ts', 'src/api/account.ts', 'src/api/projects.ts', 'src/api/flows.ts']) {
    const source = read(rel)
    assert.match(source, /safeFetch/, rel + ' 要走 safeFetch')
    assert.doesNotMatch(source, /await fetch\(/, rel + ' 不该再直接 await fetch')
  }
})

test('下载与附件预览也翻译网络错误', () => {
  for (const rel of ['src/components/WorksWall.tsx', 'src/pages/AgentsPage.tsx', 'src/components/QuickChat.tsx']) {
    const source = read(rel)
    assert.match(source, /safeFetch/, rel + ' 要走 safeFetch')
    assert.doesNotMatch(source, /await fetch\(/, rel + ' 不该再直接 await fetch')
  }
})

test('publicError 把配置类原文也翻成结论，不留变量名', async () => {
  const { publicError } = await import('../server/public-error.mjs')
  for (const raw of ['未配置模型凭证（VISION_API_KEY 或本地 OpenCodex）', '在 .env 里设置 VISION_MODEL', '读不到 ~/.codex/auth.json']) {
    const text = publicError(new Error(raw))
    assert.doesNotMatch(text, DEV_WORDS, raw + ' → ' + text)
    assert.match(text, /模型服务/)
  }
})

test('对话流式与非流式都过 publicError（不在路由里原样透出 error.message）', () => {
  const route = read('src/../server/routes/chat.mjs')
  assert.match(route, /publicError\(error, '这次没有回上来'\)/)
  assert.equal(/error: error\?\.message \|\| '这次没有回上来'/.test(route), false)
})

test('技术细节仍只在内部环境显示（失败详情与这一轮同一口径）', () => {
  assert.match(read('src/pages/AgentsPage.tsx'), /internal && failure\.detail/)
})
