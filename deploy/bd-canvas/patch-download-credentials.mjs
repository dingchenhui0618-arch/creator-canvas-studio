#!/usr/bin/env node
// 给 BD Canvas 打一个最小补丁：浏览器里点「下载」要真的下到这台电脑。
//
// 背景（2026-11-13 生产实测）：canvas.wavisionai.cn 被画布当作「本机安装」（trusted host），
// 下载走的是 /api/workspace/download-asset —— 文件被存到**服务器**的 workspace/downloads，
// 浏览器这边一个文件都没有；「打开本地位置」打开的也是服务器目录。用户看到的就是「下载没反应」。
// 同时 nginx 给画布加了一道 Basic Auth 门（/__auth 种 bdc_auth cookie），
// 而下载分支的 fetch 用了 credentials: 'omit'，真走浏览器下载时又会 401。
// 企业媒体的受保护地址（/enterprise/api/media/<id>/preview|download）还需要 Bearer 令牌。
//
// 补丁三处（幂等，可重复执行；画布升级覆盖源码后重跑一次）：
//   A. 下载 fetch 带上 cookie 与 bd-enterprise-token；
//   B. https 页面（浏览器）走浏览器下载分支，不再把文件存到服务器；
//   C. 浏览器里藏掉「打开本地位置」（那是服务器目录，不是用户的电脑）。
//
// 用法（在服务器上；Vite dev 直接读源码，改完刷新画布页面即生效，不需要重新构建）：
//   node patch-download-credentials.mjs --root /opt/bdcanvas --check
//   node patch-download-credentials.mjs --root /opt/bdcanvas --dry-run
//   node patch-download-credentials.mjs --root /opt/bdcanvas --write
// 首次写入前留一份 src/main.ts.bak-vq-download；找不到任何目标片段会以退出码 1 报错，不会瞎改。
// 注意：画布源码是 CRLF，B 用正则匹配并沿用原来的换行符。
import fs from 'node:fs'
import path from 'node:path'

const A_FROM = "        const response = await fetch(url, { credentials: 'omit' })"
const A_TO_LINES = [
  "        // [VisionQA] 下载要带登录态：nginx 给画布加了 Basic Auth 门，fetch 不带 cookie 会 401；",
  "        // 企业媒体的受保护地址还要 Bearer 令牌。缺一个都会变成「点了下载没反应」。",
  "        const downloadToken = (() => { try { return localStorage.getItem('bd-enterprise-token') || '' } catch { return '' } })()",
  "        const response = await fetch(url, { credentials: 'include', headers: downloadToken ? { Authorization: 'Bearer ' + downloadToken } : {} })",
]
const A_TO = (eol) => A_TO_LINES.join(eol)
const B_FROM = /(  private async _downloadUrlSilent\(url: string, filename: string\): Promise<\{ok: boolean; path: string; error: string\}> \{)(\r?\n)(    if \(isPublicWebClient\(\)\)) \{/
const B_TO = "$1$2    // [VisionQA] https 页面一律走浏览器下载：trusted host 桌面分支会把文件存到服务器。$2    if (isPublicWebClient() || window.location.protocol === 'https:') {"
const C_FROM = "    if (!isPublicWebClient()) progressActions.appendChild(btnOpen)"
const C_TO = (eol) => "    // [VisionQA] 浏览器里「打开本地位置」打开的是服务器目录，藏掉。" + eol + "    if (!isPublicWebClient() && window.location.protocol !== 'https:') progressActions.appendChild(btnOpen)"

function buildRules(eol) {
  return [
    { key: 'A', from: A_FROM, to: A_TO(eol), mark: "credentials: 'include'" },
    { key: 'B', from: B_FROM, to: B_TO, mark: "window.location.protocol === 'https:'" },
    { key: 'C', from: C_FROM, to: C_TO(eol), mark: "window.location.protocol !== 'https:'" },
  ]
}

function parseArgs(argv) {
  const args = { root: '/opt/bdcanvas', mode: 'check' }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--root') args.root = argv[++i] || args.root
    else if (item === '--dry-run') args.mode = 'dry'
    else if (item === '--write') args.mode = 'write'
    else if (item === '--check') args.mode = 'check'
    else if (item === '-h' || item === '--help') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法: node patch-download-credentials.mjs --root /opt/bdcanvas [--check|--dry-run|--write]')
  process.exit(0)
}

const file = path.join(args.root, 'src', 'main.ts')
if (!fs.existsSync(file)) {
  console.error('[patch] 找不到 ' + file + '：--root 指到画布根目录（含 src/main.ts）')
  process.exit(1)
}
let source = fs.readFileSync(file, 'utf8')
const EOL = source.includes('\r\n') ? '\r\n' : '\n'
const missing = []
const changed = []
for (const rule of buildRules(EOL)) {
  if (typeof rule.from === 'string' ? source.includes(rule.from) : rule.from.test(source)) {
    source = source.replace(rule.from, rule.to)
    changed.push(rule.key)
    continue
  }
  if (source.includes(rule.mark)) continue
  missing.push(rule.key)
}

if (missing.length) {
  console.error('[patch] 找不到目标片段 ' + missing.join('/') + '：画布源码可能已升级，请人工核对后更新本脚本')
  process.exit(1)
}
if (!changed.length) {
  console.log('[patch] already applied（A/B/C 三处都在）')
  process.exit(0)
}
if (args.mode === 'check') {
  console.log('[patch] 未完全打补丁，待改：' + changed.join('/'))
  process.exit(1)
}
if (args.mode === 'dry') {
  console.log('[patch] 将修改 ' + file + '，片段：' + changed.join('/'))
  process.exit(0)
}
const backup = file + '.bak-vq-download'
if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
fs.writeFileSync(file, source, 'utf8')
console.log('[patch] 已写入 ' + file + '（' + changed.join('/') + '；原文件备份 ' + backup + '）')
console.log('[patch] Vite dev 直接读源码：刷新画布页面即可生效，不需要重新构建')
