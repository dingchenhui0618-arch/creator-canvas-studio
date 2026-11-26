// r334：给量具自己上守卫。
//
// 这一轮的结论是「按下有反馈但还是硬切的按钮 32 → 0」，数字全靠 scripts/audit-press.mjs 里
// 那几行读 computed transition 的代码。把读数改回只读元素六个属性、或者把判据改成恒假，
// 报告一样会打印「硬切 0」——那不是页面变好了，是量具瞎了。所以这里逐条钉住它们，并逐条配反证。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.join(process.cwd(), 'scripts/audit-press.mjs'), 'utf8')

const GUARDS = [
  { needle: 'transitionProperty: cs.transitionProperty,', why: '按下要变的属性，得知道自己这条过渡表' },
  { needle: 'transitionDuration: cs.transitionDuration,', why: 'duration 为 0 等于没有过渡，必须一起读' },
  { needle: 'transitionProperty: ps.transitionProperty,', why: '::after 有自己的过渡表（伪元素不继承元素的 transition）' },
  { needle: 'transitionDuration: ps.transitionDuration,', why: '同上' },
  { needle: 'function transitionOf(state, after, prop) {', why: '属性 → 过渡表 的查表函数' },
  { needle: "let at = props.indexOf(prop)", why: '先按属性名查' },
  { needle: "if (at < 0) at = props.indexOf('all')", why: 'all 也算覆盖（浏览器给的默认值就是 all / 0s）' },
  { needle: "if (at < 0) at = props.findIndex((name) => (SHORTHAND_COVERS[name] || []).indexOf(prop) >= 0)", why: '简写也算覆盖（写 background 时动的是 background-color）' },
  { needle: 'const SHORTHAND_COVERS = {', why: '简写 → 长属性 的对照表' },
  { needle: 'function hardCutProps(changed, state) {', why: '把「变了但没过渡」的挑出来' },
  { needle: 'if (!found.declared || found.ms <= 0) rows.push(', why: '判据：没声明、或声明了但 duration 0，都算硬切' },
  { needle: "const isAfter = item.prop.indexOf('::after ') === 0", why: '带 ::after 前缀的那几项要查伪元素那张表，别查错表' },
  { needle: 'out.hardCuts = hardCutProps(out.changed, out.pressed)', why: '每一颗的硬切进产物（press.json 的 buttons[].hardCuts）' },
  { needle: 'hardCuts: buttons.filter((row) => (row.hardCuts || []).length > 0).length,', why: '硬切数进 summary' },
  { needle: "console.log('---- 有反馈但还是硬切（' + hardCutRows.length + ' 个）----')", why: '硬切清单要打印出来（不然只有翻 JSON 才看得到）' },
  { needle: "hardCut: '变了、但这条属性不在 computed transition-property 里", why: 'probe 元数据里要写清这一层判的是什么' },
]

const missingFrom = (source) => GUARDS.filter((guard) => !source.includes(guard.needle)).map((guard) => guard.needle)

test('r334 · 量具：硬切这一层要读 computed transition（元素与 ::after 各一份）', () => {
  assert.deepEqual(missingFrom(SRC), [], '这些量具的代码被改掉了：\n' + missingFrom(SRC).join('\n'))
})

test('r334 · 量具：单条断言删掉之后检查必须变成「缺了它」', () => {
  for (const guard of GUARDS) {
    const broken = SRC.split(guard.needle).join('')
    assert.notEqual(broken, SRC, guard.needle + ' 在源码里找不到（守卫写的是不存在的字符串）')
    assert.ok(missingFrom(broken).includes(guard.needle), guard.why + '：删掉这一段之后守卫没有报出来')
  }
})

test('r334 · 量具：判据不是恒假的（把 duration 那一半删掉要能看出来）', () => {
  const broken = SRC.replace('if (!found.declared || found.ms <= 0) rows.push(', 'if (false) rows.push(')
  assert.notEqual(broken, SRC, '改坏用的锚点没匹配到')
  assert.ok(missingFrom(broken).includes('if (!found.declared || found.ms <= 0) rows.push('), '判据被改成恒假，守卫没发现')
})
