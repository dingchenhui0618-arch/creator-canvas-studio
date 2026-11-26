// 提示条语气（r325）：类型上写了语气，页面上也必须真传——否则等于没做。
//
// 这里扫的是真源码，不是夹具：全站提示只有 onToast 一条路，凡是落在
// 「catch 块」或「.catch(回调)」里的提示，语气必须是 fail。
// 这类「声明 ≠ 挂载」的坑踩过一次（白名单里有、界面上没人用），所以给声明配一条真挂载的断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function matchPair(source, open, openChar = '(', closeChar = ')') {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === openChar) depth += 1
    else if (source[i] === closeChar) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** 「动作没做成」的代码区间：catch 块，以及 .catch(回调) 的整段回调。 */
function failureRanges(source) {
  const ranges = []
  for (const match of source.matchAll(/\bcatch\s*(\([^)]*\))?\s*\{/g)) {
    const open = source.indexOf('{', match.index + match[0].length - 1)
    const close = matchPair(source, open, '{', '}')
    if (close > 0) ranges.push([open, close])
  }
  for (const match of source.matchAll(/\.catch\s*\(/g)) {
    const open = match.index + match[0].length - 1
    const close = matchPair(source, open)
    if (close > 0) ranges.push([open, close])
  }
  return ranges
}

// 全站提示只有 onToast 一条路；工作流页还有一层自己的 toast()（第二层包装），
// 它不传语气就等于把语气丢了，所以一起扫。
function onToastCalls(source) {
  const calls = []
  for (const match of source.matchAll(/(^|[^\w.])(onToast|toast)\s*\(/g)) {
    const open = match.index + match[0].length - 1
    const close = matchPair(source, open)
    if (close > 0) calls.push({ start: open, end: close, text: source.slice(open, close + 1) })
  }
  return calls
}

const TONE = /'fail'|'info'|'ok'/

/** 哪些提示落在失败区间里却没说自己是失败。 */
function untonedFailureToasts(source) {
  const ranges = failureRanges(source)
  return onToastCalls(source)
    .filter((call) => !TONE.test(call.text))
    .filter((call) => ranges.some(([start, end]) => call.start > start && call.start < end))
    .map((call) => call.text)
}

/** 老写法：onToast 的类型当场写一遍 (message: string) => void。 */
function legacyDeclarations(source) {
  return [...source.matchAll(/onToast\??:\s*\([^)]*\)\s*=>\s*void/g)].map((m) => m[0])
}

test('反证：漏传语气的失败提示会被抓出来', () => {
  const fixture = [
    'async function save() {',
    '  try {',
    "    await put(); onToast('已保存')",
    '  } catch (caught) {',
    '    onToast(caught.message)',
    '  }',
    '}',
  ].join('\n')
  const found = untonedFailureToasts(fixture)
  assert.equal(found.length, 1, { found })
  assert.match(found[0], /caught\.message/)
})

test('反证：工作流页那层 toast() 漏传语气也会被抓', () => {
  const fixture = [
    'async function start() {',
    '  try {',
    "    await apply(); toast('已新建流程')",
    '  } catch (error) {',
    "    toast('新建失败：' + error.message)",
    '  }',
    '}',
  ].join('\n')
  assert.equal(untonedFailureToasts(fixture).length, 1)
  const fixed = fixture.replace("error.message)", "error.message, 'fail')")
  assert.deepEqual(untonedFailureToasts(fixed), [])
})

test('反证：补上语气之后同一条就不再报', () => {
  const fixture = "fetch('/a').catch((e) => onToast(e.message, 'fail'))"
  assert.deepEqual(untonedFailureToasts(fixture), [])
})

test('反证：老的单参声明会被抓出来', () => {
  assert.deepEqual(legacyDeclarations('onToast?: (message: string) => void'), ['onToast?: (message: string) => void'])
  assert.deepEqual(legacyDeclarations('onToast?: ToastFn'), [])
})

test('真源码：失败提示都说了自己是失败', () => {
  const offenders = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const text of untonedFailureToasts(source)) {
      offenders.push(relative(SRC, file) + ' → ' + text.replace(/\s+/g, ' ').slice(0, 90))
    }
  }
  assert.deepEqual(offenders, [])
})

test('真源码：提示函数的签名只有一处真源', () => {
  const offenders = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const decl of legacyDeclarations(source)) offenders.push(relative(SRC, file) + ' → ' + decl)
  }
  assert.deepEqual(offenders, [])
})

test('真源码：三种语气都用到了，不是只加了个类型', () => {
  const all = sourceFiles(SRC).map((file) => readFileSync(file, 'utf8')).join('\n')
  assert.match(all, /, 'fail'\)/, { message: '没找到任何一处 fail 语气' })
  assert.match(all, /, 'info'\)|: 'info'\)/, { message: '没找到任何一处 info 语气' })
})

test('真源码：工作流页那层包装没有把语气吃掉', () => {
  const canvas = readFileSync(join(SRC, 'pages', 'CanvasPage.tsx'), 'utf8')
  assert.match(canvas, /const toast = useCallback\(\(message: string, tone\?: ToastTone\) => onToast\?\.\(message, tone\)/, {
    message: '工作流页的 toast() 必须把语气透给 onToast',
  })
})

test('真渲染：图标跟着语气换，播报方式也跟着换', () => {
  const app = readFileSync(join(SRC, 'App.tsx'), 'utf8')
  assert.match(app, /role=\{toastRole\(toast\.tone\)\}/)
  assert.match(app, /data-tone=\{toast\.tone\}/)
  // 三种语气三种图标：形状先分清，颜色只是补一层
  assert.match(app, /toast\.tone === 'fail' \? <X size=\{14\} \/>/)
  assert.match(app, /toast\.tone === 'info' \? <Info size=\{14\} \/>/)
  assert.match(app, /<Check size=\{14\} \/>/)
})
