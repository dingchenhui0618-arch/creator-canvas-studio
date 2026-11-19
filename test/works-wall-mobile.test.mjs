// 作品流在手机上的几条底线（r233）。
// 「作品」默认打开的就是这一条流：390 下两列卡片 139px（320 下 106px），
// 原来卡片正文 13px、标题 14px、时间与动作 12px、动作只有 24px 高，
// 筛选胶囊 12.5px / 29px、大图关闭按钮 32px —— 读不清也点不准。
// 这里锁住抬上去的档位，也锁住「两列 + 按比例排版」这条定过的口径没被顺手改掉。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'works.css'), 'utf8')
// r262：「看大图」换成和快捷创作共用的浮层，手机那几条（44px 关闭按钮、画面边距）跟着搬到了这里
const lightboxCss = fs.readFileSync(path.join(ROOT, 'src', 'styles', 'media-lightbox.css'), 'utf8')

/** 取一段 @media 块（按花括号配对），可选再加一层「必须包含某个选择器」的过滤。 */
function blocksIn(source, query, mustContain) {
  const out = []
  let from = 0
  for (;;) {
    const start = source.indexOf('@media ' + query, from)
    if (start < 0) break
    let depth = 0
    const open = source.indexOf('{', start)
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      if (source[index] === '}') {
        depth -= 1
        if (depth === 0) {
          out.push(source.slice(open, index + 1))
          from = index + 1
          break
        }
      }
    }
    if (from <= start) break
  }
  return mustContain ? out.filter((block) => block.includes(mustContain)) : out
}

const phone = blocksIn(css, '(max-width: 560px)', '.works-action')[0]
const small = blocksIn(css, '(max-width: 380px)', '.works-grid')[0]

function rule(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(escaped + '\\s*\\{[^}]*\\}'))
  assert.ok(match, '缺少规则：' + selector)
  return match[0]
}

test('手机作品流的正文抬到 15/14px：标题原来是 14px、说明 13px', () => {
  assert.ok(phone, 'src/styles/works.css 里应该有 @media (max-width: 560px) 的作品流规则')
  assert.match(rule(phone, '.works-title'), /font-size:\s*15px/, '卡片标题 15px')
  assert.match(rule(phone, '.works-summary'), /font-size:\s*14px/, '工作流那句摘要是唯一的说明文字，14px')
  assert.match(rule(phone, '.works-time'), /font-size:\s*13px/, '时间与模型名 13px（原来 12px）')
  assert.match(rule(phone, '.works-fallback'), /font-size:\s*14px/, '没有封面时的占位文字 14px')
  assert.match(rule(phone, '.works-more'), /font-size:\s*13px/, '「已经到底了」13px')
})

test('卡片上的动作用 44px 触控区：24px 高的文字链接手机上点不中', () => {
  const action = rule(phone, '.works-action')
  assert.match(action, /min-height:\s*44px/, '用作参考 / 下载 至少 44px 高')
  assert.match(action, /font-size:\s*14px/, '动作文字 14px（原来 12px）')
  assert.match(action, /align-items:\s*flex-end/, '字坐到底部，底下那条下划线才贴着字')
  assert.match(rule(phone, '.works-more.is-button'), /min-height:\s*44px/, '「看更早的」同样 44px')
})

test('筛选胶囊 40px 高、14px 字：12.5px / 29px 的胶囊在手机上又小又难点', () => {
  const chip = rule(phone, '.works-chip')
  assert.match(chip, /min-height:\s*40px/, '胶囊至少 40px 高')
  assert.match(chip, /font-size:\s*14px/, '胶囊文字 14px')
  assert.match(chip, /padding:\s*8px 16px/, '胶囊内边距走 4/8 栅格')
})

test('大图浮层（r262 起与快捷创作共用）：关闭按钮 44×44，画面边距收到 8px', () => {
  const phoneLightbox = blocksIn(lightboxCss, '(max-width: 560px)', '.vq-lightbox-close')[0]
  assert.ok(phoneLightbox, 'media-lightbox.css 里应该有手机那一条')
  const close = rule(phoneLightbox, '.vq-lightbox-close')
  assert.match(close, /width:\s*44px/, '关闭按钮 44px 宽（原来 32px）')
  assert.match(close, /height:\s*44px/, '关闭按钮 44px 高')
  // 手机上画面优先：卡片内边距与浮层边距都收到 8px，390 下画面本身仍有 356px
  assert.match(rule(phoneLightbox, '.vq-lightbox'), /padding:\s*var\(--space-2\)/, '浮层边距 8px')
  assert.match(rule(phoneLightbox, '.vq-lightbox-card'), /padding:\s*var\(--space-2\)/, '卡片内边距 8px')
  // 说明文字 13px 是产品字号地板（--text-mono），不再往下掉
  assert.match(lightboxCss, /\.vq-lightbox-note \{[^}]*font-size:\s*var\(--text-mono\)/, '浮层小字走 13px 地板')
})

test('两列与按比例排版的口径不许被顺手改掉', () => {
  assert.match(css, /@media \(max-width:1080px\) \{ \.works-grid \{ grid-template-columns:repeat\(3,minmax\(0,1fr\)\); \} \}/, '1440 四列、1080 以下三列')
  assert.match(css, /@media \(max-width:768px\) \{ \.works-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \} \}/, '768 起两列')
  assert.match(css, /@media \(max-width:480px\) \{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[\s\S]*?\}/, '390 仍是两列，不改成整宽一列')
  assert.match(css, /\.is-portrait \.works-thumb \{ aspect-ratio:9\/16; \}/, '9:16 仍是默认比例')
  assert.match(rule(phone.length ? phone : css, '.works-chip'), /min-height:\s*40px/)
})

test('320 上两列之间收 4px：卡片从 104 变成 106', () => {
  assert.ok(small, '≤380px 要有单独一档')
  assert.match(rule(small, '.works-grid'), /gap:\s*8px/, '320 列间距 8px')
})
