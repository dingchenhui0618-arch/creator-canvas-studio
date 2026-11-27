// r342：对话框里生成的参数要跟用户选的走——别锁死、别写进提示词、参考图要跟得上。
//
// 三条都来自 2026-11-27 生产上的真事（会话 cmwyhsl8s9d38b8 + 任务 mgen_kYh89pp_iWka）：
//  1) 用户写「生成一张欧美女星带首饰的图 3：4的比例」——全角冒号没被认出来，出图按 1:1，
//     提示词还留着「3 4的比例」被当成画面描述；
//  2) 用户传了商品图、下一句「生成一张…」没带附件——参考图丢了，成了纯文生图；
//  3) 图片画质（quality）根本没有参数，用户选不了。
//
// 纯函数，不起服务、不打上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-r342-params-'))
process.env.DATA_DIR = dir

const { parseMediaIntent } = await import('../server/media-intent.mjs')
const { resolveSelection } = await import('../server/media-models.mjs')
const { latestConversationImage } = await import('../server/chat-store.mjs')

test('生产原句：全角「3：4的比例」要认出比例，而且不能留在提示词里', () => {
  const plan = parseMediaIntent('生成一张欧美女星带首饰的图 3：4的比例')
  assert.equal(plan.kind, 'image')
  assert.equal(plan.ratio, '3:4')
  assert.equal(plan.locked.ratio, true, '表外比例按「写死」处理：原样提交、上游不收就全额退回')
  assert.equal(plan.prompt, '欧美女星带首饰', '改前是「欧美女星带首饰的图 3 4的比例」')
  const selection = resolveSelection({ kind: 'image', ratio: plan.ratio, locked: plan.locked })
  assert.equal(selection.size, '1152x1536', '3:4 要按比例算一个尺寸，不是 1024x1024')
})

test('全角数字、全角冒号、「比」写法都认；参数后面的连接词一起吃掉', () => {
  for (const text of ['生成一张图 ３：４', '生成一张图 3：4 的比例', '生成一张图 3比4的比例']) {
    const plan = parseMediaIntent(text)
    assert.equal(plan.ratio, '3:4', text)
    assert.equal(plan.prompt, '', text + ' 的参数与连接词都要从提示词里消失')
  }
})

test('对话框里选的比例盖过提示词里写的那份，两份都不进提示词', () => {
  const plan = parseMediaIntent('生成一张欧美女星带首饰的图 1:1', { ratio: '9:16' })
  assert.equal(plan.ratio, '9:16')
  assert.deepEqual(plan.locked, {}, '表内三档是白名单，不算写死')
  assert.ok(!plan.prompt.includes('1:1'))
  assert.ok(!plan.prompt.includes('9:16'))

  const outside = parseMediaIntent('生成一张图', { ratio: '4:5' })
  assert.equal(outside.ratio, '4:5')
  assert.equal(outside.locked.ratio, true, '表外比例选了也要说清楚：原样提交')
})

test('画质：话里写「高清」认下来、选了盖过话里的、都从提示词里拿掉', () => {
  const said = parseMediaIntent('生成一张图 高清 白底产品图')
  assert.equal(said.quality, 'high')
  assert.equal(said.prompt, '白底产品图')
  assert.equal(said.locked.quality, true)

  const picked = parseMediaIntent('生成一张图 高清 白底产品图', { quality: 'low' })
  assert.equal(picked.quality, 'low', '对话框里选的说了算')
  assert.equal(picked.prompt, '白底产品图')

  assert.equal(parseMediaIntent('生成一张图 白底产品图').quality, '')
  // 「标准」这种光秃秃的词不当画质：「标准流程」是画面描述，不是参数
  assert.equal(parseMediaIntent('生成一张图 标准流程的车间').quality, '')
})

test('画质只认 low / medium / high：界面传错值不该把一次生成做成失败', () => {
  assert.equal(resolveSelection({ kind: 'image', quality: 'medium' }).quality, 'medium')
  assert.equal(resolveSelection({ kind: 'image' }).quality, '')
  assert.throws(() => resolveSelection({ kind: 'image', quality: '超清' }), /画质只能是/)
  assert.equal(resolveSelection({ kind: 'image', quality: 'ultra', locked: { quality: true } }).quality, 'ultra')
  assert.equal(resolveSelection({ kind: 'video' }).quality, '', '视频没有画质这一档')
})

test('视频：对话框里选的秒数与清晰度也盖过话里的那份', () => {
  const plan = parseMediaIntent('/生视频 4秒 480p 海边日落', { duration: 8, resolution: '720p' })
  assert.equal(plan.duration, 8)
  assert.equal(plan.resolution, '720p')
  assert.equal(plan.prompt, '海边日落')
  assert.deepEqual(plan.locked, {}, '表内档位不算写死')

  const outside = parseMediaIntent('/生视频 海边日落', { duration: 12, resolution: '1080p' })
  assert.equal(outside.duration, 12)
  assert.equal(outside.locked.duration, true)
  assert.equal(outside.locked.resolution, true)
})

test('参考图沿用：回看这条对话里用户最近发过的那张图，助手回答里的不算', () => {
  const conv = {
    messages: [
      { role: 'assistant', files: [{ id: 'a1', kind: 'image', name: '助手不该算' }] },
      { role: 'user', content: '这是我的商品图', files: [{ id: 'f1', kind: 'image', name: '白底图.JPG' }] },
      { role: 'user', content: '这个怎么样' },
      { role: 'user', content: '生成一张图', files: [{ id: 'f2', kind: 'image', name: '近景.JPG' }] },
    ],
  }
  assert.equal(latestConversationImage(conv).id, 'f2', '取最近一张用户发的图')
  // 太久以前的那张不算：一上来传的图，隔了十几句之后再生成，不该还在照它画
  const old = { messages: [{ role: 'user', files: [{ id: 'old', kind: 'image', name: '很久以前.png' }] }] }
  for (let index = 0; index < 8; index += 1) old.messages.push({ role: 'user', content: '继续 ' + index })
  assert.equal(latestConversationImage(old), null, '只看最近 6 条')
  assert.equal(latestConversationImage(old, 20)?.id, 'old', '放宽窗口就能找到')
  assert.equal(latestConversationImage({ messages: [{ role: 'user', files: [{ id: 'd1', kind: 'doc', name: '脚本.txt' }] }] }), null)
  assert.equal(latestConversationImage({}), null)
  assert.equal(latestConversationImage(null), null)
})
