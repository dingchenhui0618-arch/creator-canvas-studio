import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 画布下载补丁（2026-11-13）：用户在 https 画布里点「下载」，文件被画布的 trusted-host
// 桌面分支存到了**服务器**；切到浏览器下载分支后，fetch 又因为 credentials: 'omit'
// 被 nginx 的 Basic Auth 打成 401。补丁改三处（凭据、https 分支、藏掉服务器目录按钮），
// 这组测试盯的是：补丁能重复执行、不重复改、只改该改的，CRLF 不能被改坏，
// 画布升级换了写法时脚本要明确失败而不是默默改错。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(root, 'deploy', 'bd-canvas', 'patch-download-credentials.mjs')

const SOURCE = [
  'class App {',
  '  private async _downloadUrlSilent(url: string, filename: string): Promise<{ok: boolean; path: string; error: string}> {',
  '    if (isPublicWebClient()) {',
  '      try {',
  "        const response = await fetch(url, { credentials: 'omit' })",
  "        if (!response.ok) throw new Error('HTTP ' + response.status)",
  '      } catch (error) {',
  '        // fallback',
  '      }',
  '    }',
  "    return { ok: false, path: '', error: 'x' }",
  '  }',
  '  private run(progressActions: HTMLElement, btnOpen: HTMLElement) {',
  '    if (!isPublicWebClient()) progressActions.appendChild(btnOpen)',
  '  }',
  '}',
  '',
].join('\n')

function makeFixture(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-bdc-patch-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), text, 'utf8')
  return dir
}

function runPatch(dir, mode) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', dir, mode], { encoding: 'utf8' })
  return { code: result.status, out: (result.stdout || '') + (result.stderr || '') }
}

test('未打补丁时 --check 明确返回 1，并说出缺哪几处', () => {
  const dir = makeFixture(SOURCE)
  const result = runPatch(dir, '--check')
  assert.equal(result.code, 1)
  assert.match(result.out, /未完全打补丁/)
  assert.match(result.out, /A\/B\/C/)
})

test('--write 只改三处：凭据、https 浏览器分支、服务器目录按钮', () => {
  const dir = makeFixture(SOURCE)
  assert.equal(runPatch(dir, '--write').code, 0)
  const text = fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8')
  assert.match(text, /credentials: 'include'/)
  assert.match(text, /bd-enterprise-token/)
  assert.match(text, /isPublicWebClient\(\) \|\| window.location.protocol === 'https:'/)
  assert.match(text, /window.location.protocol !== 'https:'/)
  // 原始片段必须消失，避免「改一半」还显示成功
  assert.equal(text.includes("credentials: 'omit'"), false)
  assert.equal(fs.existsSync(path.join(dir, 'src', 'main.ts.bak-vq-download')), true)
})

test('重复执行幂等：第二次 --write 不改文件，--check 返回 0', () => {
  const dir = makeFixture(SOURCE)
  assert.equal(runPatch(dir, '--write').code, 0)
  const first = fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8')
  const again = runPatch(dir, '--write')
  assert.equal(again.code, 0)
  assert.match(again.out, /already applied/)
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8'), first)
  assert.equal(runPatch(dir, '--check').code, 0)
})

test('CRLF 源码打完后仍全是 CRLF，不会混进裸 LF', () => {
  const dir = makeFixture(SOURCE.replace(/\n/g, '\r\n'))
  assert.equal(runPatch(dir, '--write').code, 0)
  const text = fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8')
  assert.equal((text.match(/(?<!\r)\n/g) || []).length, 0)
  assert.match(text, /credentials: 'include'/)
})

test('画布升级换了写法：找不到片段就退出 1，文件一个字节都不动', () => {
  const dir = makeFixture('class App {\n  // nothing to patch here\n}\n')
  const before = fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8')
  const result = runPatch(dir, '--write')
  assert.equal(result.code, 1)
  assert.match(result.out, /找不到目标片段/)
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'main.ts'), 'utf8'), before)
})

test('--root 指错目录：直接报错退出 1', () => {
  const result = runPatch(path.join(os.tmpdir(), 'vq-bdc-missing-' + Date.now()), '--write')
  assert.equal(result.code, 1)
  assert.match(result.out, /找不到 .*main\.ts/)
})
