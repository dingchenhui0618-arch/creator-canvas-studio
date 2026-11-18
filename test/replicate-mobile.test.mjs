// 一键复刻弹窗在手机上的四条底线（r231）。
// 320/390 上原来是居中小窗：24px 外边距白扔 48px、正文一律 13px、关闭按钮 18px 宽，
// 「完成」那屏 5 张抽帧 392px 塞进 292px 的正文里整块横向溢出 124px。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(ROOT, 'src', 'App.css'), 'utf8')
const tsx = fs.readFileSync(path.join(ROOT, 'src', 'components', 'ReplicateModal.tsx'), 'utf8')

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

const phone = mediaBlocks('(max-width: 640px)', '.replicate-modal')[0]

test('手机上弹窗改成整宽底部面板：不留 24px 外边距，从底部升起', () => {
  assert.ok(phone, 'src/App.css 里应该有 @media (max-width: 640px) 的 .replicate-modal 规则')
  assert.match(phone, /\.modal-backdrop\s*\{[^}]*padding:\s*0/, '遮罩在手机上不该再留 24px 内边距')
  assert.match(phone, /\.modal-backdrop\s*\{[^}]*place-items:\s*end center/, '面板要贴底（place-items: end center）')
  assert.match(phone, /\.replicate-modal\s*\{[^}]*width:\s*100%/, '面板要占满宽度')
  assert.match(phone, /\.replicate-modal\s*\{[^}]*max-height:\s*92vh/, '面板高度给到 92vh，320 上标题换三行也放得下')
  assert.match(phone, /\.replicate-modal\s*\{[^}]*border-radius:\s*20px 20px 0 0/, '只圆上面两个角，贴底的两个角是直的')
})

test('手机上输入框 16px：13px 的输入框会让 iOS 聚焦时整页放大', () => {
  assert.match(phone, /\.replicate-field input\s*\{[^}]*font-size:\s*16px/, '输入框字号必须是 16px，否则 iOS 一聚焦就放大')
  assert.match(phone, /\.replicate-field input\s*\{[^}]*height:\s*48px/, '输入框高度 48px，手指好点')
  assert.match(phone, /\.replicate-field label\s*\{[^}]*font-size:\s*14px/, '字段标题 14px 起，13px 在手机上偏小')
})

test('手机上按钮与关闭都是够大的触控目标（48 / 40）', () => {
  assert.match(phone, /\.replicate-foot \.vq-button\s*\{[^}]*min-height:\s*48px/, '底部按钮至少 48px 高')
  assert.match(phone, /\.replicate-foot \.vq-button\s*\{[^}]*flex:\s*1/, '两个按钮等分整行，不要挤在右下角')
  assert.match(phone, /\.replicate-head \.vq-button--icon\s*\{[^}]*width:\s*40px/, '关闭按钮 40px 宽（原来只有 18px）')
  assert.match(phone, /\.replicate-head \.vq-button--icon\s*\{[^}]*height:\s*40px/, '关闭按钮 40px 高')
})

test('抽帧缩略图在手机上换行：5 张 72px 一排是 392px，塞不进 292px', () => {
  assert.match(phone, /\.replicate-preview\s*\{[^}]*flex-wrap:\s*wrap/, '预览行要能换行')
  assert.match(phone, /\.replicate-preview img\s*\{[^}]*width:\s*72px/, '390 上缩略图 72px 宽')
  const small = mediaBlocks('(max-width: 360px)', '.replicate-preview')[0]
  assert.ok(small, '320 以下要再小一档')
  assert.match(small, /\.replicate-preview img\s*\{[^}]*width:\s*64px/, '320 上缩略图 64px 宽，三张一行放得下')
})

test('正文不再一律 13px：说明、校验、步骤在手机上都 14px', () => {
  for (const [selector, label] of [
    ['.replicate-hint', '直链提示'],
    ['.replicate-checks', '三条校验'],
    ['.replicate-note', '底部说明'],
    ['.replicate-step strong, .replicate-step span', '进度步骤'],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/, /g, ',\\s*')
    assert.match(phone, new RegExp(escaped + '\\s*\\{[^}]*font-size:\\s*14px'), label + ' 在手机上应该是 14px')
  }
})

test('第一条日志还没回来时不画空框：手机上它会变成一条 16px 的灰条', () => {
  assert.match(tsx, /\(job\?\.logs \?\? \[\]\)\.length > 0/, '日志容器要等有内容再渲染')
})
