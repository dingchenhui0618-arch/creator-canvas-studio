// 换页之后内容区停在哪儿（v0.9.43）。这一轮钉住三件事：
//   1. 换一个页面一定回到页头——以前 `.vq-content` 的 scrollTop 没人管，浏览器按新页高度夹一下，
//      于是从滚到底的作品页点「工作台」会停在最下面（页头与主卡都在上面），换个更短的页面又刚好回顶。
//   2. 抽屉与「同一页换参数」不算换页：模板库打开/关闭单条模板要保持在原位，画布换流程也不归外壳管。
//   3. 错误边界按「页」隔离，不再按整条地址重挂：重挂会把列表的搜索词、来源筛选和滚动一起清掉。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { planScroll } from '../src/domain/scroll.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const page = (name, extra = {}) => ({ kind: 'page', page: name, ...extra })

test('换一个页面一定回到页头', () => {
  assert.equal(planScroll(null, page('overview')), 'top', '首次渲染没有上一页')
  assert.equal(planScroll(page('overview'), page('projects')), 'top')
  assert.equal(planScroll(page('projects'), page('templates')), 'top')
  assert.equal(planScroll(page('templates'), page('radar')), 'top')
  // 后台、合规页、只读分享、智能体编辑器都是整屏，一律从上面开始
  assert.equal(planScroll(page('overview'), { kind: 'admin' }), 'top')
  assert.equal(planScroll({ kind: 'admin' }, page('overview')), 'top')
  assert.equal(planScroll({ kind: 'agent-editor' }, { kind: 'agent-editor' }), 'top')
})

test('同一页里换了参数，仍然从页头开始：作品列表 ↔ 作品详情、评审台 ↔ 单条评审', () => {
  assert.equal(planScroll(page('projects'), page('projects', { projectId: 'prj_1' })), 'top')
  assert.equal(planScroll(page('projects', { projectId: 'prj_1' }), page('projects')), 'top')
  assert.equal(planScroll(page('review'), page('review', { reviewId: 'rev_1' })), 'top')
  assert.equal(planScroll(page('review'), page('review', { projectId: 'prj_1' })), 'top')
})

test('抽屉与画布换流程不算换页：外壳不插手', () => {
  // 模板抽屉盖在列表上：打开/关闭它，背景那张列表不该跟着挪
  assert.equal(planScroll(page('templates'), page('templates', { templateId: 'tpl_1' })), 'keep')
  assert.equal(planScroll(page('templates', { templateId: 'tpl_1' }), page('templates')), 'keep')
  // 画布页自己管视口与缩放
  assert.equal(planScroll(page('canvas'), page('canvas', { flowId: 'f1' })), 'keep')
  assert.equal(planScroll(page('canvas', { flowId: 'f1' }), page('canvas', { flowId: 'f2' })), 'keep')
})

test('App 真的按这个判断归零：归零在浏览器绘制之前做，不留一帧旧位置', () => {
  const app = read('src', 'App.tsx')
  assert.match(app, /import \{ planScroll \} from '\.\/domain\/scroll'/)
  assert.match(app, /const contentRef = useRef<HTMLDivElement \| null>\(null\)/)
  assert.match(app, /<div className="vq-content" ref=\{contentRef\}>/)
  assert.match(app, /useLayoutEffect\(\(\) => \{/, '用 useLayoutEffect：绘制前归零，换页不会先闪一下旧位置')
  assert.match(app, /planScroll\(previous, route\) !== 'top'/)
  assert.match(app, /node\.scrollTop = 0/)
})

test('错误边界按「页」隔离：地址里的抽屉与参数变化不再把整页重挂', () => {
  const app = read('src', 'App.tsx')
  assert.match(app, /const pageBoundaryKey =/)
  assert.match(app, /'page:' \+ route\.page/)
  assert.match(app, /<ErrorBoundary key=\{pageBoundaryKey\}>/)
  assert.doesNotMatch(app, /<ErrorBoundary key=\{routeKey\(route\)\}>/, '按整条地址重挂会清掉列表的搜索词与滚动位置')
})

test('每种页面根节点都走同一段淡入；窄屏与「减少动态效果」下关掉', () => {
  const tokens = read('src', 'styles', 'tokens.css')
  for (const selector of ['.page', '.vq-content > .vq-page', '.vq-content > .runs-page', '.vq-content > .review-page', '.vq-content > .admin-page']) {
    assert.ok(tokens.includes(selector), '淡入规则少了 ' + selector)
  }
  assert.match(tokens, /@keyframes vq-page-in/)
  assert.match(tokens, /prefers-reduced-motion: reduce/)
  // tokens.css 的 reduce 分支里五种根节点都要关掉
  const reduce = tokens.slice(tokens.indexOf('prefers-reduced-motion: reduce'))
  for (const selector of ['.vq-content > .vq-page', '.vq-content > .runs-page', '.vq-content > .review-page', '.vq-content > .admin-page']) {
    assert.ok(reduce.includes(selector), '减少动态效果时没有关掉 ' + selector)
  }
})
