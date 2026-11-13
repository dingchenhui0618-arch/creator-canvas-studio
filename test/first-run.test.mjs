// 新账号的第一屏（v0.9.42）。这一轮钉住三件事：
//   1. 「还什么都没有」只在六路计数全都读到、并且都是 0 时才成立——
//      任何一路读失败都不许当 0，读失败时说「空」等于把故障说成「你还没做过」。
//   2. 空账号那一屏不许再铺四块空的：四块的名字必须对得上页面里那四块的真名字，
//      而且它们只在「不是空账号」的分支里渲染。
//   3. 空作品页的下一步要看模板库有没有东西：模板库也空时，不能把人送进一个空库。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { isFirstRun, FIRST_RUN_KEYS } from '../src/domain/first-run.ts'
import { canvasErrorMessage } from '../server/bdc.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const EMPTY = { projects: 0, canvases: 0, templates: 0, runs: 0, deliveries: 0, shares: 0 }

test('六路都读到且都是 0，才算「什么都没有」', () => {
  assert.deepEqual([...FIRST_RUN_KEYS], ['projects', 'canvases', 'templates', 'runs', 'deliveries', 'shares'])
  assert.equal(isFirstRun({ counts: EMPTY }), true)
  assert.equal(isFirstRun({ counts: EMPTY, failed: 0 }), true)
})

test('任何一路读失败都不算空：不拿 0 冒充未知', () => {
  assert.equal(isFirstRun({ counts: EMPTY, failed: 1 }), false, '有一路没读到，就不能说账号是空的')
  assert.equal(isFirstRun({ counts: null, failed: 0 }), false, '整体没读到也不能说空')
  assert.equal(isFirstRun(null), false)
  assert.equal(isFirstRun(undefined), false)
})

test('少一路计数 / 任意一路有数据，都不算空', () => {
  const missing = { ...EMPTY }
  delete missing.shares
  assert.equal(isFirstRun({ counts: missing }), false, '少读到一路不能悄悄当成 0')
  for (const key of FIRST_RUN_KEYS) {
    assert.equal(isFirstRun({ counts: { ...EMPTY, [key]: 1 } }), false, key + ' 有数据时不该判成空账号')
  }
})

test('画布服务没连上时，界面上出现的是中文可行动的话，不是 fetch failed', () => {
  const down = canvasErrorMessage(new Error('fetch failed'))
  assert.match(down, /画布服务没有连上/)
  assert.doesNotMatch(down, /fetch failed/)
  assert.match(canvasErrorMessage(new Error('connect ECONNREFUSED 127.0.0.1:5312')), /画布服务没有连上/)
  // 真的业务错误照原文传出去：不要把「这张画布不存在」也翻成「服务没连上」
  assert.equal(canvasErrorMessage(new Error('canvas not found')), 'canvas not found')
})

test('工作台的「空账号」分支接的是六个真实计数，四块名字对得上页面里那四块', () => {
  const page = read('src', 'pages', 'OverviewPage.tsx')
  assert.match(page, /import \{ isFirstRun \} from '\.\.\/domain\/first-run'/)
  assert.match(page, /const firstRun = !loading && isFirstRun\(\{/)
  for (const field of ['projects', 'canvases', 'templates', 'runs', 'deliveries', 'shares']) {
    assert.match(page, new RegExp('\\b' + field + ':'), '空账号判据少了 ' + field + ' 这一路')
  }
  assert.match(page, /deliveries: deliveryTotal/, '交付这一路要读服务端的总条数，不是本页取回的那一页长度')
  assert.match(page, /failed: errors\.length/, '读失败的接口数必须参与判断')
  for (const title of ['评审等你看的', '交出去的', '最近运行', '分享出去的链接']) {
    const count = page.split("'" + title + "'").length - 1
    assert.ok(count >= 1, '第一屏承诺出现的区块在页面里找不到：' + title)
  }
})

test('空账号那一屏不再渲染评审 / 交付 / 运行 / 分享四块，四块只在非空分支里', () => {
  const page = read('src', 'pages', 'OverviewPage.tsx')
  const firstRunAt = page.indexOf('{firstRun ? (')
  assert.ok(firstRunAt > 0, '找不到空账号分支')
  const elseAt = page.indexOf(') : (', firstRunAt)
  assert.ok(elseAt > firstRunAt, '空账号分支后面没有 else 分支')
  const reviewAt = page.indexOf('vq-section vq-review-queue"')
  const shareAt = page.indexOf('vq-section vq-share-summary"')
  const footAt = page.indexOf('vq-overview-foot')
  assert.ok(reviewAt > elseAt, '评审队列没有被关进「非空账号」分支')
  assert.ok(shareAt > elseAt, '分享汇总没有被关进「非空账号」分支')
  assert.ok(footAt > shareAt, '页脚要在条件分支后面（它两边都显示）')
  // 页头不再把「新建画布」按成实心主按钮：这一屏的主按钮是主卡里那个
  assert.doesNotMatch(page, /className="vq-button vq-button--primary" onClick=\{onCreateCanvas\}/)
})

test('空作品页按模板库条数分流：模板库也空就去发现，而不是送进空库', () => {
  const page = read('src', 'pages', 'ProjectsPage.tsx')
  assert.match(page, /import \{ listTemplates \} from '\.\.\/api\/radar'/)
  assert.match(page, /const \[templateTotal, setTemplateTotal\] = useState<number \| null>\(null\)/)
  assert.match(page, /templateTotal === 0 \?/, '模板库为空时要单独一个分支')
  assert.match(page, /templateTotal === null \?/, '条数没读到时不能断言模板库是空的')
  assert.match(page, /onClick=\{onDiscover\}/, '这一屏要能把人送到发现页')
  const app = read('src', 'App.tsx')
  assert.match(app, /onDiscover=\{\(\) => go\('radar'\)\}/, 'App 没把空作品页的「去发现」接上')
})
