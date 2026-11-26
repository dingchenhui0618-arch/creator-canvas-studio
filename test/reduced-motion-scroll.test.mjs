// r339：「减弱动态效果」那条口径的两条守卫。
//
// 这一轮把 JS 侧的平滑滚动收成一个函数（src/domain/motion.ts 的 scrollToSoft），修掉四处写死
// behavior: 'smooth' 的调用点 —— 全局 CSS 那条「* { scroll-behavior: auto !important }」
// 拦不住显式传的 behavior（显式选项优先）。这不是推断：scripts/audit-press.mjs 的 --motion 那一层
// 会在真页面上滚一次，同一个容器 hard 量到 smooth 要十几帧、auto 只要一帧，减弱动态效果开着也一样。
//
// 所以判据只能写在调用方。这里钉两件事，并各配一条反证：
//   ① 全站只有 src/domain/motion.ts 里能出现写死的 behavior: 'smooth'；
//   ② 扫描器与开关都不是恒真恒假的（塞一个写死的调用点、把开关换成恒 smooth，都要看得出来）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const MOTION_REL = path.join('src', 'domain', 'motion.ts')
const MOTION = path.join(ROOT, MOTION_REL)
const MOTION_SRC = fs.readFileSync(MOTION, 'utf8')

// 写死的平滑滚动：这一条正则就是判据（注释里出现也算，口径从宽——宁可多报一条）
const RAW_SMOOTH = /behavior:\s*'smooth'|behavior:\s*"smooth"/g
function rawSmoothHits(source) {
  return (source.match(RAW_SMOOTH) || []).length
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

test('r339 · 减弱动态效果：写死的 behavior: s\'smooth\' 只能出现在 motion.ts 里', () => {
  const files = walk(path.join(ROOT, 'src'))
  assert.ok(files.length > 100, '源码文件数不对：' + files.length)
  const offenders = []
  for (const file of files) {
    const rel = path.relative(ROOT, file)
    if (path.normalize(rel) === path.normalize(MOTION_REL)) continue
    if (rawSmoothHits(fs.readFileSync(file, 'utf8'))) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], '这些文件里还有写死的平滑滚动（开了减弱动态效果也照样动）：' + offenders.join('、'))
  // 扫描器自己不是恒假的：motion.ts 里那条说明注释必然命中
  assert.ok(rawSmoothHits(MOTION_SRC) >= 1, '扫描器扫不出任何东西 —— 这条判据已经形同虚设')
})

test('r339 · 减弱动态效果：扫描器不是恒假的（塞一个写死的调用点必须扫得出来）', () => {
  const sample = "export const jump = (el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' })\n"
  assert.equal(rawSmoothHits(sample), 1, '写死的 behavior: smooth 没被扫出来')
  const fixed = "export const jump = (el) => scrollToSoft(el, { block: 'start' })\n"
  assert.equal(rawSmoothHits(fixed), 0, '改成 scrollToSoft 之后还在报')
})

test('r339 · 减弱动态效果：开关真的会换成 auto（不是恒 smooth）', () => {
  const from = "target.scrollIntoView({ ...options, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })"
  const broken = MOTION_SRC.replace(from, "target.scrollIntoView({ ...options, behavior: 'smooth' })")
  assert.notEqual(broken, MOTION_SRC, '改坏用的锚点没匹配到')
  assert.ok(!broken.includes("prefersReducedMotion() ? 'auto'"), '把开关换成恒 smooth 之后守卫没发现')
  // 读系统的那个函数本身也要在，而且只在这里读
  assert.ok(MOTION_SRC.includes("query('(prefers-reduced-motion: reduce)').matches"), 'motion.ts 里没读系统设置')
})

test('r339 · 减弱动态效果：scrollToSoft 在两种系统设置下分别给 auto / smooth', async () => {
  const mod = await import('../src/domain/motion.ts')
  const calls = []
  const fake = { scrollIntoView: (options) => calls.push(options) }
  const original = globalThis.window
  try {
    globalThis.window = { matchMedia: () => ({ matches: true }) }
    assert.equal(mod.prefersReducedMotion(), true, '开了减弱动态效果却读成 false')
    mod.scrollToSoft(fake, { block: 'start' })
    assert.equal(calls.at(-1).behavior, 'auto', '开了减弱动态效果还在平滑滚')
    assert.equal(calls.at(-1).block, 'start', 'block 选项被吞了')
    globalThis.window = { matchMedia: () => ({ matches: false }) }
    assert.equal(mod.prefersReducedMotion(), false, '没开减弱动态效果却读成 true')
    mod.scrollToSoft(fake, { block: 'nearest' })
    assert.equal(calls.at(-1).behavior, 'smooth', '没开减弱动态效果时不平滑了')
  } finally {
    if (original === undefined) delete globalThis.window
    else globalThis.window = original
  }
  // 没有 window（服务端 / 单测环境）时不炸，读成 false
  assert.equal(mod.prefersReducedMotion(), false)
  mod.scrollToSoft(null)
  mod.scrollToSoft({})
})

test('r339 · 减弱动态效果：原来四处写死 smooth 的调用点都改成了 scrollToSoft', () => {
  const sites = [
    ['src/pages/ProjectPage.tsx', 'archiveOpen'],
    ['src/pages/ReviewPage.tsx', 'togglePin'],
    ['src/pages/AgentsPage.tsx', 'selectFromCard'],
    ['src/pages/admin/PromosCard.tsx', 'pendingFocus'],
  ]
  for (const [rel, why] of sites) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    assert.ok(source.includes('scrollToSoft('), rel + ' 里没有用 scrollToSoft（' + why + ' 那一段）')
    assert.equal(rawSmoothHits(source), 0, rel + ' 里还留着写死的平滑滚动')
  }
  // AgentsPage 两处（选卡、恢复历史）都要在
  const agents = fs.readFileSync(path.join(ROOT, 'src/pages/AgentsPage.tsx'), 'utf8')
  assert.equal((agents.match(/scrollToSoft\(/g) || []).length, 2, 'AgentsPage 应该有两处 scrollToSoft（选预设卡、恢复历史）')
})
