// 手机端工作流页面（r227 / v0.9.211）：390 宽原来摆着一块 272×309 的画布，
// 空状态（标题 + 两行说明 + 三个按钮 + 一句备注）比容器还高，直接压在缩放按钮和底部提示上；
// 节点面板打开时更糟——≤1024 的「1fr + 272px」两列还在生效，画布只剩 2px 宽。
// 现在 ≤760 一律把画布换掉，改成按执行顺序的步骤清单，并守住三条结构约定：
//   1. 顺序和服务端执行同一套拓扑排序（有环也要列出来，同时标出跑不起来）；
//   2. 只有手机把画布藏掉、换成清单，桌面还是画布；
//   3. 画布专属工具（自动布局 / 适应工作流 / 缩放）在手机上不出现。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { flowStepPlan } from '../src/domain/flow-steps.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')
const css = read('src', 'styles', 'canvas.css')
const page = read('src', 'pages', 'CanvasPage.tsx')

/** 取出查询里指定的所有 media 块（按大括号配对，够用且不依赖格式）。 */
function mediaBlocks(text, query) {
  const out = []
  let from = 0
  for (;;) {
    const at = text.indexOf(query, from)
    if (at < 0) return out
    const open = text.indexOf('{', at)
    if (open < 0) return out
    let depth = 0
    let i = open
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    out.push(text.slice(open + 1, i))
    from = i + 1
  }
}

/** 去掉所有 media 块，剩下的就是「任何宽度都生效」的规则。 */
function outsideMedia(text) {
  let rest = text
  for (;;) {
    const at = rest.indexOf('@media')
    if (at < 0) return rest
    const open = rest.indexOf('{', at)
    if (open < 0) return rest
    let depth = 0
    let i = open
    for (; i < rest.length; i += 1) {
      if (rest[i] === '{') depth += 1
      else if (rest[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    rest = rest.slice(0, at) + rest.slice(i + 1)
  }
}

test('执行顺序：一条直链按依赖依次排开', () => {
  const plan = flowStepPlan([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ])
  assert.deepEqual(plan.steps.map((step) => step.id), ['a', 'b', 'c'])
  assert.equal(plan.cyclic, false)
  assert.deepEqual(plan.steps[0].deps, [])
  assert.deepEqual(plan.steps[1].deps, [1])
  assert.deepEqual(plan.steps[2].deps, [2])
})

test('执行顺序：分支汇合时，汇合点在第 4 步、依赖第 2、3 步', () => {
  const plan = flowStepPlan(
    ['a', 'b', 'c', 'd'].map((id) => ({ id })),
    [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ],
  )
  assert.deepEqual(plan.steps.map((step) => step.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(plan.steps[3].deps, [2, 3])
})

test('执行顺序：没有连线的节点也照样列出来，不算失败', () => {
  const plan = flowStepPlan([{ id: 'x' }, { id: 'y' }, { id: 'z' }], [{ source: 'y', target: 'z' }])
  assert.deepEqual(plan.steps.map((step) => step.id), ['x', 'y', 'z'])
  assert.equal(plan.cyclic, false)
  assert.deepEqual(plan.steps[0].deps, [])
})

test('执行顺序：有环时按原顺序列出并标 cyclic，界面要能说清跑不起来', () => {
  const plan = flowStepPlan([{ id: 'a' }, { id: 'b' }], [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
  ])
  assert.equal(plan.cyclic, true)
  assert.deepEqual(plan.steps.map((step) => step.id), ['a', 'b'])
})

test('执行顺序：指向不存在节点、自己连自己的线跳过，才不会把顺序算歪', () => {
  const plan = flowStepPlan([{ id: 'a' }, { id: 'b' }], [
    { source: 'a', target: 'b' },
    { source: 'a', target: 'ghost' },
    { source: 'b', target: 'b' },
  ])
  assert.deepEqual(plan.steps.map((step) => step.id), ['a', 'b'])
  assert.deepEqual(plan.steps[1].deps, [1])
  assert.equal(plan.cyclic, false)
})

test('清单只在手机上顶替画布：任何宽度下 .cv-steps 默认不显示', () => {
  assert.match(outsideMedia(css), /\.cv-steps\s*\{\s*display:\s*none;?\s*\}/)
  // 桌面把清单藏起来、画布照旧：这两条只能在 ≤760 的媒体块里出现
  assert.equal(/\.cv-canvas\s*\{\s*display:\s*none/.test(outsideMedia(css)), false)
})

test('手机媒体块里藏画布、亮清单，并把面板改成单列三行', () => {
  const narrow = mediaBlocks(css, '@media (max-width: 760px)').join('\n')
  assert.match(narrow, /\.cv-canvas\s*\{\s*display:\s*none;?\s*\}/)
  assert.match(narrow, /\.cv-steps\s*\{[^}]*display:\s*flex/)
  // 面板打开时 ≤1024 的两列规则会赢，必须同时写列与行，否则清单只剩 2px 宽
  assert.match(narrow, /\.cv-workspace:has\(\.cv-palette\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(narrow, /\.cv-canvas-only\s*\{\s*display:\s*none;?\s*\}/)
})

test('页面结构：清单按执行顺序渲染，点一行选中那个节点', () => {
  assert.match(page, /import \{ flowStepPlan \} from '\.\.\/domain\/flow-steps'/)
  assert.match(page, /const stepPlan = useMemo\(\(\) => flowStepPlan\(nodes, edges\), \[nodes, edges\]\)/)
  assert.match(page, /<div className="cv-steps">/)
  assert.match(page, /<ol className="cv-steps-list">/)
  assert.match(page, /onClick=\{\(\) => selectNode\(step\.id\)\}/)
  assert.match(page, /依赖第 \{step\.deps\.join\('、'\)\} 步/)
  // 有环要说清楚跑不起来，不能只画个顺序骗人
  assert.match(page, /stepPlan\.cyclic \?/)
  assert.match(page, /这条流程有环，跑不起来/)
  // 手机上怎么加步骤、连线去哪做，写在清单底下
  assert.match(page, /连线、拖动与自动布局在电脑上做/)
})

test('画布专属工具在窄屏收起：自动布局 / 适应工作流 / 缩放百分比', () => {
  assert.match(page, /className="cv-tool cv-canvas-only" type="button" onClick=\{relayout\}/)
  assert.match(page, /<Maximize2 size=\{14\} \/>适应工作流/)
  assert.equal(/className="cv-tool" type="button" onClick=\{\(\) => rf\.fitView/.test(page), false)
  assert.match(page, /<span className="cv-zoom cv-canvas-only">/)
})

