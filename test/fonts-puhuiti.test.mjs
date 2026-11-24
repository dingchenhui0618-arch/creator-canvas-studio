// r308（2026-11-24）：中文统一到阿里巴巴普惠体 3.0（45 Light 正文 / 65 Medium 强调）。
// 用户原话：「调整下生产端全部的字体类型 Alibaba PuHuiTi 3.0 45 Light 用这个字体
// 整体统一替换掉现在的中文字体」。
// 这些断言钉住四件事：
//   1. 字体栈里普惠体必须在拉丁字体之后、在任何系统中文之前 —— 拉丁仍走 Figtree；
//   2. 两处 --font-ui 都要改（tokens.css 的 :root 与 shell.css 的 .vq-scope），
//      只改一处的话工作台里还是旧字体，这是本轮真实踩过的坑；
//   3. 分片文件必须都在仓库里、每一片都不大（分片的意义就是按需下载）；
//   4. 字重映射：45 Light 覆盖 100–400、65 Medium 覆盖 500–900，正文 400 落 Light、
//      600/700 落 Medium，不触发浏览器伪粗。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const cssDir = path.join(ROOT, 'public', 'fonts', 'puhuiti')
const cssFile = path.join(cssDir, 'puhuiti.css')
const css = fs.readFileSync(cssFile, 'utf8')
const tokens = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8')
const shell = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'shell.css'), 'utf8')
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')

function fontUi(source) {
  const m = /--font-ui:\s*([^;]+);/.exec(source)
  assert.ok(m, '找不到 --font-ui')
  return m[1]
}

test('font-ui：普惠体排在 Figtree / Geist 之后，排在所有系统中文之前', () => {
  const stack = fontUi(tokens)
  const puhui = stack.indexOf("'Alibaba PuHuiTi 3.0'")
  assert.ok(puhui > 0, '--font-ui 里没有普惠体')
  assert.ok(stack.indexOf("'Figtree'") < puhui, '拉丁字体应该仍在最前（只管拉丁）')
  for (const legacy of ["'PingFang SC'", "'Microsoft YaHei'", "system-ui"]) {
    const at = stack.indexOf(legacy)
    assert.ok(at === -1 || at > puhui, '系统中文不能排在普惠体前面：' + legacy)
  }
  assert.ok(!stack.includes("'Noto Sans SC'"), '旧的 Noto Sans SC 又回栈里了')
})

test('两处 --font-ui 都要改：tokens 的 :root 与 shell 的 .vq-scope', () => {
  const scoped = fontUi(shell)
  assert.ok(scoped.includes("'Alibaba PuHuiTi 3.0'"), 'shell.css 的 .vq-scope 没换（工作台会仍用旧字体）')
  // 只看声明，不看注释（注释里会提到旧栈的名字，那是有意留的说明）
  const decls = [...shell.matchAll(/--font-[a-z]+:\s*([^;]+);/g)].map((m) => m[1])
  assert.ok(!decls.some((d) => d.includes('Noto Sans SC')), 'shell.css 里还留着 Noto Sans SC 那套旧栈')
  const mono = /--font-mono:\s*([^;]+);/.exec(shell)[1]
  assert.ok(mono.includes("'Alibaba PuHuiTi 3.0'"), '等宽栈里漏了中文，等宽元素里的中文会掉回系统字体')
})

test('样式表由 index.html 单独 link，不塞进应用主样式', () => {
  assert.match(html, /<link rel="stylesheet" href="\/fonts\/puhuiti\/puhuiti\.css" \/>/)
})

test('每一条 url() 都指向仓库里真实存在的分片，且每片都不大', () => {
  const urls = [...css.matchAll(/url\("\.\/([^"]+\.woff2)"\)/g)].map((m) => m[1])
  assert.ok(urls.length > 200, '分片数量不对：' + urls.length)
  const sizes = urls.map((name) => {
    const file = path.join(cssDir, name)
    assert.ok(fs.existsSync(file), '缺分片文件：' + name)
    return fs.statSync(file).size
  })
  const biggest = Math.max(...sizes)
  assert.ok(biggest < 100 * 1024, '单片超过 100KB，按需下载就失效了：' + biggest)
  const total = sizes.reduce((a, b) => a + b, 0)
  assert.ok(total < 13 * 1024 * 1024, '分片总量异常：' + Math.round(total / 1048576) + 'MB')
})

test('字重映射：正文 400 落 45 Light，600/700 落 65 Medium，不触发伪粗', () => {
  const light = [...css.matchAll(/font-weight:([^;}]+)/g)].map((m) => m[1].trim())
  assert.ok(light.includes('100 400'), '45 Light 的覆盖区间不是 100–400')
  assert.ok(light.includes('500 900'), '65 Medium 的覆盖区间不是 500–900')
  assert.ok(!css.includes('local('), 'CSS 里留了 local()：装了这个字体的机器会用自己的那份，渲染不一致')
  const styles = [tokens, shell].join('\n')
  assert.ok(!/font-family:\s*['"]?PingFang/.test(styles), '还有地方硬写苹方')
  assert.ok(!/font-family:\s*['"]?Microsoft YaHei/.test(styles), '还有地方硬写微软雅黑')
})
