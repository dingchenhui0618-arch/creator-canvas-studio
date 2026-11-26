// r333：量具自己的门禁。r331/r332 的巡检只读被按元素自身的六个 computed 属性，而 r326/r329 给
// 「整卡可点」的按钮定的按下反馈画在 ::after 上（给它加 transform 会毁掉整卡热区，只能用底色）——
// 量具看不见这一类，于是在 v0.9.304 的产物上把 6 行「其实有反馈」记成了「无反馈」：
// 「还剩几个」这个数字本身是错的。r333 给 readState 加了 ::after 读取（content 为 none 时跳过）。
//
// 这条门禁只钉一件事：量具不许静默退回盲区。真正的证据是同一份脚本跑出来的 before/after 两份产物，
// 不是这里几行断言——所以它只做文本层守卫，不假装自己是取证。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/audit-press.mjs'), 'utf8')

const AFTER_PROP_NAMES = [
  '::after background-color',
  '::after box-shadow',
  '::after transform',
  '::after opacity',
]

/** 出一份问题清单；空数组 = 量具还在读 ::after。 */
function probeGuardProblems(src) {
  const problems = []
  if (!src.includes("getComputedStyle(el, '::after')")) {
    problems.push('readState 没有读伪元素（getComputedStyle(el, \'::after\')）——整卡热区那一类的反馈又回到盲区')
  }
  // r334：名字只在 AFTER_PROPS 那个数组块里找，不再在整份源码里找 ——
  // r334 的注释里也写着 '::after background-color' 这几个字，整份源码 contains 会把它当成
  // 「AFTER_PROPS 还在」，下面那条反证于是就变不红了（守卫看着还在，其实已经失灵）。
  const block = src.match(/AFTER_PROPS\s*=\s*\[([\s\S]*?)\n\]/)
  if (!block) {
    problems.push('没有 AFTER_PROPS 这一组')
  } else {
    for (const name of AFTER_PROP_NAMES) {
      if (!block[1].includes("'" + name + "'")) problems.push('AFTER_PROPS 里缺了 ' + name)
    }
  }
  if (!/content\)\s*!==\s*'none'/.test(src)) {
    problems.push('diffProps 没有「content 为 none 就跳过」的守卫——页面上绝大多数按钮没有 ::after，会给它们各添一条空 diff')
  }
  for (const label of ['hover', 'pressed', 'settled']) {
    if (!src.includes(label + '.after')) problems.push(label + ' 这一拍没有把 ::after 的读数带进产物')
  }
  if (!src.includes('AFTER_PROPS.map')) problems.push('产物头部的 probe.props 没有列出 ::after 那一组（口径要能自述）')
  return problems
}

test('按下量具读得到 ::after 上的反馈（r326 那一类）', () => {
  assert.deepEqual(probeGuardProblems(SRC), [])
})

test('量具门禁不是恒真断言：把读取改回盲区必须变红', () => {
  const mutations = [
    ['readState 不再读伪元素', "getComputedStyle(el, '::after')", "getComputedStyle(el)"],
    ['AFTER_PROPS 里丢掉背景那一项', "['backgroundColor', '::after background-color'],", ''],
    ['去掉 content 守卫', "content) !== 'none'", "content) === 'none'"],
    ['按下那一拍不再带上 ::after 读数', 'after: pressed.after,', ''],
    ['产物头部不再自述 ::after 口径', 'AFTER_PROPS.map', 'PROPS.filter(Boolean).map'],
  ]
  for (const [label, from, to] of mutations) {
    // 用 split/join 而不是 replace：同一条守卫在源码里出现两次（before / after 各一次），
    // 只换第一处的话第二处还撑着，反证会「看着没变红」。
    const mutated = SRC.split(from).join(to)
    assert.notEqual(mutated, SRC, '反证没改到源码（锚点漂了）：' + label)
    assert.notDeepEqual(probeGuardProblems(mutated), [], '反证没让门禁变红：' + label)
  }
})
