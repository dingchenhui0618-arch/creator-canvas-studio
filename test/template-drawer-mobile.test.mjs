// 模板详情抽屉在手机上的几条底线（r232）。
// 抽屉在 ≤820px 已经是整宽，但里面仍是桌面排版：正文 12.5–13px、关闭按钮 28×32
// （320 上 22×32）、底部四个按钮 32px 高还右对齐成两行错位，320 上「播放 128.4万」
// 还会被三列网格断成两行。这里锁住放大后的档位与两列布局。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'App.css'), 'utf8')

/** 取一段 @media 块（按花括号配对），可选再加一层「必须包含某个选择器」的过滤。 */
function mediaBlocks(query, mustContain) {
  const out = []
  let from = 0
  for (;;) {
    const start = css.indexOf('@media ' + query, from)
    if (start < 0) break
    let depth = 0
    const open = css.indexOf('{', start)
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      if (css[index] === '}') {
        depth -= 1
        if (depth === 0) {
          out.push(css.slice(open, index + 1))
          from = index + 1
          break
        }
      }
    }
    if (from <= start) break
  }
  return mustContain ? out.filter((block) => block.includes(mustContain)) : out
}

const phone = mediaBlocks('(max-width: 640px)', '.template-drawer .drawer-foot')[0]
const small = mediaBlocks('(max-width: 380px)', '.template-drawer .drawer-stats')[0]

function rule(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(escaped + '\\s*\\{[^}]*\\}'))
  assert.ok(match, '缺少规则：' + selector)
  return match[0]
}

test('手机抽屉的正文抬到 16px：这是「拆结构」读得最久的一屏', () => {
  assert.ok(phone, 'src/App.css 里应该有 @media (max-width: 640px) 的模板抽屉规则')
  for (const [selector, label] of [
    ['.template-drawer .drawer-quote', '开头钩子'],
    ['.template-drawer .beat-item p', '口播正文'],
    ['.template-drawer .beat-item strong', '节拍名'],
    ['.template-drawer .shot-copy strong', '分镜画面'],
    ['.template-drawer .drawer-list', '爆款分析'],
  ]) {
    assert.match(rule(phone, selector), /font-size:\s*16px/, label + ' 在手机上应该是 15px（原来是 13px）')
  }
  assert.match(rule(phone, '.template-drawer .drawer-head strong'), /font-size:\s*18px/, '抽屉标题 18px')
  assert.match(rule(phone, '.template-drawer .drawer-sub'), /font-size:\s*14px/, '副标题这类元信息 13px，比正文低一档')
})

test('手机抽屉的触控目标：关闭 40×40，底部按钮 48px', () => {
  const close = rule(phone, '.template-drawer .drawer-head .vq-button--icon')
  assert.match(close, /width:\s*40px/, '关闭按钮 40px 宽（320 上原来只有 22px）')
  assert.match(close, /height:\s*40px/, '关闭按钮 40px 高')
  const foot = rule(phone, '.template-drawer .drawer-foot :is(.vq-button)')
  assert.match(foot, /height:\s*48px/, '底部按钮 48px 高（原来是 32px，删除按钮 28px）')
  assert.match(foot, /font-size:\s*16px/, '底部按钮字号 15px')
})

test('底部四个按钮改成等宽两列：主操作第一格，删除固定在右下角', () => {
  const grid = rule(phone, '.template-drawer .drawer-foot')
  assert.match(grid, /display:\s*grid/, '用网格，别让 flex 把按钮挤成右对齐的锯齿')
  assert.match(grid, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '两列等宽')
  assert.match(rule(phone, '.template-drawer .drawer-foot :is(.vq-button--primary)'), /order:\s*-1/, '主操作排第一格')
  assert.match(rule(phone, '.template-drawer .drawer-foot :is(.vq-button--danger)'), /grid-column:\s*2/, '删除固定在第二列（右下角）')
})

test('互动数据不再被挤断：390 三列、320 退两列且数字不换行', () => {
  assert.match(rule(phone, '.template-drawer .drawer-stats'), /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/, '390 上三列对齐')
  assert.match(rule(phone, '.template-drawer .drawer-stats span'), /white-space:\s*nowrap/, '数字不许从中折断')
  assert.ok(small, '320 以下要退成两列')
  assert.match(rule(small, '.template-drawer .drawer-stats'), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '320 上两列，「播放 128.4万」才放得下')
})

test('改编模式的输入框 17px：15px 的输入框会让 iOS 聚焦时整页放大', () => {
  assert.match(rule(phone, '.template-drawer .adapt-input'), /font-size:\s*17px/, '改编输入框 16px')
  assert.match(rule(phone, '.template-drawer .adapt-input'), /min-height:\s*48px/, '输入框至少 48px 高')
  assert.match(rule(phone, '.template-drawer .drawer-share-input'), /font-size:\s*17px/, '只读分享链接输入框也一样')
})

test('抽屉里的说明文字都要 15px 起：12.5px 的等着实看不清', () => {
  for (const [selector, label] of [
    ['.template-drawer .drawer-section-head h3', '分组标题'],
    ['.template-drawer .drawer-source', '来源一行'],
    ['.template-drawer .drawer-origin-count', '原片在库里的计数'],
    ['.template-drawer .drawer-export-note, .template-drawer .drawer-share-note, .template-drawer .adapt-note', '导出与分享说明'],
  ]) {
    const found = rule(phone, selector)
    assert.match(found, /font-size:\s*(1[5-9]|2\d)px/, label + ' 在手机上不该低于 15px')
  }
})
