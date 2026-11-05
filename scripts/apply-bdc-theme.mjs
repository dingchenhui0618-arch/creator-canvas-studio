#!/usr/bin/env node
/**
 * apply-bdc-theme.mjs —— 把 VisionQA 的墨色主题覆盖层应用到本地 BD Canvas。
 *
 * 做什么：
 *   1) 把仓库留档的 deploy/bd-canvas/vq-theme.css 复制到 <bd-canvas>/public/vq-theme.css
 *      （Vite 把 public/ 映射到站点根，所以 index.html 用 href="/vq-theme.css" 就能取到）
 *   2) 在 <bd-canvas>/index.html 的 </head> 前插入或校正唯一一个
 *      <link id="vq-bdc-theme" rel="stylesheet" href="/vq-theme.css">
 *
 * 幂等性保证：
 *   - 已经存在 id="vq-bdc-theme" 的标签时只校正它的 href，不会插入第二个；
 *   - index.html 采用「字符串切片插入/替换」，除该标签外不产生任何字节变化
 *     （换行符、BOM、注释、版权声明全部原样保留）；
 *   - 不触碰 logo、版本号、水印、LICENSE 等任何归属标识（License 4.3 / 5.1）。
 *
 * 用法：
 *   node scripts/apply-bdc-theme.mjs                     # 默认 D:\Projects\bd-canvas
 *   node scripts/apply-bdc-theme.mjs --bd-canvas <dir>   # 指定其它检出目录
 *   node scripts/apply-bdc-theme.mjs --check             # 只检查，不写入
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const THEME_SRC = join(REPO, 'deploy', 'bd-canvas', 'vq-theme.css')

const LINK_ID = 'vq-bdc-theme'
const LINK_HREF = '/vq-theme.css'

function parseArgs(argv) {
  const out = { bdCanvas: process.env.BD_CANVAS_DIR || 'D:\\Projects\\bd-canvas', check: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--bd-canvas') out.bdCanvas = argv[++i]
    else if (a === '--check') out.check = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('usage: node scripts/apply-bdc-theme.mjs [--bd-canvas <dir>] [--check]')
  process.exit(0)
}

const bdCanvas = resolve(args.bdCanvas)
const indexHtml = join(bdCanvas, 'index.html')
const themeDest = join(bdCanvas, 'public', 'vq-theme.css')

async function exists(p) {
  try { await access(p); return true } catch { return false }
}

/** 只替换/插入我们的 link 标签，其余字节原样保留 */
function patchHtmlOnce(html) {
  // 只认带本主题 id 的标签（属性顺序不敏感），避免误伤文件里别的 <link>
  const tagRe = new RegExp('<link\\b[^>]*\\bid=["\']' + LINK_ID + '["\'][^>]*>', 'i')
  const existing = html.match(tagRe)

  if (existing) {
    const tag = existing[0]
    if (tag.includes('href="' + LINK_HREF + '"')) return { html, changed: false, mode: 'unchanged' }
    const fixed = tag.replace(/\bhref=["'][^"']*["']/i, 'href="' + LINK_HREF + '"')
    const at = html.indexOf(tag)
    return { html: html.slice(0, at) + fixed + html.slice(at + tag.length), changed: true, mode: 'href-fixed' }
  }

  const at = html.lastIndexOf('</head>')
  if (at === -1) throw new Error('index.html 中找不到 </head>，拒绝写入')
  const nl = html.includes('\r\n') ? '\r\n' : '\n'
  const insert = '  <link id="' + LINK_ID + '" rel="stylesheet" href="' + LINK_HREF + '">' + nl
  return { html: html.slice(0, at) + insert + html.slice(at), changed: true, mode: 'inserted' }
}

async function main() {
  if (!(await exists(THEME_SRC))) throw new Error('主题源文件不存在：' + THEME_SRC)
  if (!(await exists(indexHtml))) throw new Error('找不到 BD Canvas 的 index.html：' + indexHtml)

  const css = await readFile(THEME_SRC)
  const before = await readFile(indexHtml, 'utf8')
  const patched = patchHtmlOnce(before)

  if (args.check) {
    const cssSame = (await exists(themeDest)) && Buffer.compare(await readFile(themeDest), css) === 0
    console.log(JSON.stringify({
      bdCanvas,
      themeSource: THEME_SRC,
      themeTarget: themeDest,
      cssInSync: cssSame,
      linkState: patched.mode,
      htmlWillChange: patched.changed,
    }, null, 2))
    return
  }

  await mkdir(dirname(themeDest), { recursive: true })
  const destBefore = (await exists(themeDest)) ? await readFile(themeDest) : null
  const cssChanged = !destBefore || Buffer.compare(destBefore, css) !== 0
  if (cssChanged) await writeFile(themeDest, css)

  if (patched.changed) await writeFile(indexHtml, patched.html, 'utf8')

  console.log('theme  -> ' + themeDest + ' (' + css.length + ' bytes, ' + (cssChanged ? 'updated' : 'unchanged') + ')')
  console.log('link   -> ' + indexHtml + ' (' + patched.mode + ')')
  console.log('done. 重新加载 BD Canvas 页面即可看到墨色主题。')
}

main().catch((err) => {
  console.error('apply-bdc-theme failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
