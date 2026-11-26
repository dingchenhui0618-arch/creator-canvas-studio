import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODAL_FOCUSABLE, planTab } from '../src/domain/focus-trap.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 身份引导自己那一份（r327 写的，带独立的一整套反证），这一轮故意没搬过来：
 * 那份刚在生产上验过 21/21，为了「统一实现」把它重写一遍不值得冒这个险。
 */
const ALLOW = new Map([['src/components/OnboardingGate.tsx', '身份引导自己那一份（r327）']])

/** 实现自己的两个文件：注释里就会写到 aria-modal 这行字，不算浮层。 */
const IMPLEMENTATION = new Set(['src/domain/focus-trap.ts', 'src/components/useModalFocus.ts'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

function lineOf(source, at) {
  return source.slice(0, at).split('\n').length
}

/**
 * 取 aria-modal 所在的那个标签本身：<div ... aria-modal="true" ... ref={x}>。
 * 不能只看前后 400 字符——相邻的另一个元素也有 ref，那样「新加一个没挂 ref 的浮层」就抓不到了。
 * 往右扫到这一层的 '>'，{} 里的箭头函数与三元里的 > 用括号配平跳过。
 */
function tagOf(source, at) {
  const start = source.lastIndexOf('<', at)
  let depth = 0
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
}

/** aria-modal 是对读屏的承诺：外面不能用了。兑现它要挂 ref（把焦点圈住）。 */
function ariaModalProblems(source, file) {
  const problems = []
  let at = source.indexOf('aria-modal="true"')
  while (at >= 0) {
    const tag = tagOf(source, at)
    if (!tag.includes('ref={')) {
      problems.push(file + ':' + lineOf(source, at) + ' 的 aria-modal 浮层没挂 ref，焦点圈不住')
    }
    at = source.indexOf('aria-modal="true"', at + 1)
  }
  return problems
}

/** 共用实现里的三件事：Tab 首尾循环、只有最上面那层管键盘、关掉之后还焦。 */
function hookProblems(hook) {
  const problems = []
  if (!hook.includes("document.addEventListener('keydown', onKey, true)")) {
    problems.push('Tab 兜底没挂在捕获阶段：页面上别的处理器会先吃掉这一下')
  }
  if (!hook.includes('if (trapStack[trapStack.length - 1] !== root) return')) {
    problems.push('两层浮层叠开时没有「只有最上面那层管键盘」，外层会把焦点从内层抢回去')
  }
  if (!hook.includes('el.getClientRects().length > 0')) {
    problems.push('判可见性没用 getClientRects：position: fixed 的祖先下 offsetParent 一律是 null')
  }
  // 钉住的是 Tab 那条分支里的拦截，不是别处（处理 Esc 的那段末尾也有一个 preventDefault）
  if (!/if \(plan === 'pass'\) return[\s\S]{0,120}event\.preventDefault\(\)/.test(hook)) {
    problems.push('Tab 到首尾没有拦默认行为：焦点照样会走出去')
  }
  if (!hook.includes('planTab(')) {
    problems.push('没有走统一的 planTab 判定')
  }
  if (!hook.includes('back.focus({ preventScroll: true })')) {
    problems.push('关掉之后没把焦点还回原来那颗按钮')
  }
  if (!hook.includes('scrollLocks')) {
    problems.push('背景锁滚没有引用计数：两层叠开先关哪一层都会把另一层的锁解开')
  }
  return problems
}

function scan() {
  const problems = []
  for (const path of walk(join(ROOT, 'src'))) {
    const file = relative(ROOT, path).replace(/\\/g, '/')
    if (IMPLEMENTATION.has(file)) continue
    const source = readFileSync(path, 'utf8')
    const dialogs = source.split('aria-modal="true"').length - 1
    if (!dialogs) continue
    problems.push(...ariaModalProblems(source, file))
    if (ALLOW.has(file)) continue
    const calls = source.split('useModalFocus(').length - 1
    if (calls < dialogs) {
      problems.push(file + ' 有 ' + dialogs + ' 个 aria-modal 浮层，却只调了 ' + calls + ' 次 useModalFocus')
    }
    if (!source.includes('useModalFocus }') && !source.includes('useModalFocus,')) {
      problems.push(file + ' 没 import useModalFocus')
    }
  }
  return problems
}

test('弹窗的键盘边界：一张真值表', () => {
  const base = { shift: false, count: 3, inside: true, onContainer: false, isFirst: false, isLast: false }
  assert.equal(planTab({ ...base, count: 0 }), 'hold', '一个能接焦点的元素都没有时，Tab 要留在弹窗上')
  assert.equal(planTab({ ...base, count: 0, shift: true }), 'hold')
  assert.equal(planTab({ ...base, inside: false }), 'pull-in', '焦点在弹窗外面要拉回来')
  assert.equal(planTab({ ...base, inside: false, shift: true }), 'pull-in')
  assert.equal(planTab({ ...base, onContainer: true }), 'pull-in', '焦点停在容器自己身上也算「不在里面」')
  assert.equal(planTab({ ...base, isFirst: true }), 'pass', '第一个上按 Tab 是正常往前走')
  assert.equal(planTab({ ...base, isMiddle: undefined, isLast: false }), 'pass', '停在中间不管')
  assert.equal(planTab({ ...base, isFirst: true, shift: true }), 'wrap-last', '第一个上按 Shift+Tab 要跳到最后一个')
  assert.equal(planTab({ ...base, isLast: true, shift: true }), 'pass', '最后一个上按 Shift+Tab 是正常往回走')
  assert.equal(planTab({ ...base, isLast: true }), 'wrap-first', '最后一个上按 Tab 要回到第一个')
  const single = { ...base, count: 1, isFirst: true, isLast: true }
  assert.equal(planTab(single), 'wrap-first', '只有一个元素时 Tab 应该原地不动')
  assert.equal(planTab({ ...single, shift: true }), 'wrap-last')
  // 选择器口径也是承诺的一部分：tabindex="-1" 不该占 Tab 的一站
  assert.ok(MODAL_FOCUSABLE.includes('tabindex]:not([tabindex="-1"])'))
  assert.ok(MODAL_FOCUSABLE.includes('button'))
  assert.ok(MODAL_FOCUSABLE.includes('input'))
})

test('每个 aria-modal 浮层都走同一个焦点兜底，且兜底的三件事都在', () => {
  const problems = scan()
  assert.deepEqual(problems, [], problems.join('\n'))
  // 防止「扫描走空」当成通过：真去数一遍带 aria-modal 的文件
  const files = walk(join(ROOT, 'src')).filter((p) => readFileSync(p, 'utf8').includes('aria-modal="true"'))
  assert.ok(files.length >= 13, '只扫到 ' + files.length + ' 个带 aria-modal 的文件，扫描多半走空了')
  const hook = readFileSync(join(ROOT, 'src/components/useModalFocus.ts'), 'utf8')
  const own = hookProblems(hook)
  assert.deepEqual(own, [], own.join('\n'))
  // 反面：兜底不能靠「顺手」活着——文件里得有真在用的钩子，不是只写了个空壳
  assert.ok(hook.includes('export function useModalFocus('))
})

test('反证：把兜底拆掉，上面这些检查必须变红', () => {
  const welcome = readFileSync(join(ROOT, 'src/components/WelcomeGuide.tsx'), 'utf8')
  const hook = readFileSync(join(ROOT, 'src/components/useModalFocus.ts'), 'utf8')
  const trash = readFileSync(join(ROOT, 'src/components/TrashModal.tsx'), 'utf8')

  // 1. 新加一个没挂 ref 的 aria-modal 浮层 → 覆盖检查要抓出来
  const newDialog = welcome + '\n<div role="dialog" aria-modal="true"><span>假的浮层</span></div>\n'
  assert.ok(ariaModalProblems(newDialog, 'x.tsx').length > 0, '凭空多一个 aria-modal 却当成没事')
  // 同一张夹具里已挂 ref 的那些不该被误报
  assert.deepEqual(ariaModalProblems(welcome, 'x.tsx'), [], '同一个文件的真浮层被误报了')

  // 2. 把某个浮层的 useModalFocus 删掉 → 次数对不上
  const noHook = welcome.replace('useModalFocus(dialogRef, true, {', 'void (dialogRef, true, {')
  assert.notEqual(noHook, welcome, '夹具没改到（WelcomeGuide 的调用行变了？）')
  const stillCalled = noHook.split('useModalFocus(').length - 1
  assert.ok(stillCalled < 1, '删掉调用之后还数得到 useModalFocus(')

  // 3. Tab 不拦默认行为 → 焦点照样走出去
  assert.ok(
    hookProblems(hook.replaceAll('event.preventDefault()', 'void 0')).some((p) => p.includes('Tab 到首尾')),
    '把 preventDefault 拿掉却没人管',
  )
  // 4. 监听退回冒泡阶段 → 页面上的处理器先吃掉
  assert.ok(
    hookProblems(hook.replace("addEventListener('keydown', onKey, true)", "addEventListener('keydown', onKey)")).some(
      (p) => p.includes('捕获阶段'),
    ),
    '退回冒泡阶段却没人管',
  )
  // 5. 两层叠开时不再只认最上面那层 → 外层会把焦点抢走
  assert.ok(
    hookProblems(hook.replace('if (trapStack[trapStack.length - 1] !== root) return', 'void 0')).some((p) =>
      p.includes('最上面那层'),
    ),
    '去掉最上层判断却没人管',
  )
  // 6. 用 offsetParent 判可见性 → fixed 祖先下全判成隐藏
  assert.ok(
    hookProblems(hook.replace('el.getClientRects().length > 0', 'el.offsetParent !== null')).some((p) =>
      p.includes('getClientRects'),
    ),
    '换回 offsetParent 却没人管',
  )
  // 7. 回收站这种浮层把锁滚拿掉 → 背景跟着滚，但覆盖检查看不出来（锁滚是运行时行为，
  //    由 scripts/shot-r328.mjs 在真浏览器里量）；这里只钉住「别把锁滚参数悄悄删了」
  assert.ok(trash.includes('lockScroll: true'), '回收站没锁背景滚动')
})
