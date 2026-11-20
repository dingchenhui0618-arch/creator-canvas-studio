// 分镜 → 出图提示词（v0.9.164）。这一组盯的是「拼出来的东西能直接用、也没有偷偷编东西」：
//   1) 比例只在认得出竖屏平台时才写，直链不猜；
//   2) 这一镜取哪一段脚本要按时间对得上，落缝里取前面那段；
//   3) 提示词正文里不出现镜头号、时长——模型读到编号会去画字；
//   4) 没有画面也没有脚本时不硬编内容，但仍然给一条能用的提示词；
//   5) 「复制全部」的抬头、编号与段间空行是给人看的，顺序不能乱。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allShotPrompts,
  beatForShot,
  shotAspect,
  shotPrompt,
  shotPromptHint,
} from '../src/domain/shot-prompt.ts'

const shot = {
  shotNo: 2,
  startSec: 1,
  endSec: 2,
  visual: '彩条测试画面，色块变化',
  camera: '中景固定',
  caption: '先给结论',
}
const beats = [
  { beat: '钩子', startSec: 0, endSec: 2, voiceover: '这条片子只有六秒，但三个段落都在。' },
  { beat: '展开', startSec: 2, endSec: 4, voiceover: '第一段给结论，第二段给做法。' },
]

test('画幅只认得出的平台才写：抖音与小红书竖屏、B 站横屏、直链不猜', () => {
  assert.equal(shotAspect('douyin'), '竖屏 9:16')
  assert.equal(shotAspect('xiaohongshu'), '竖屏 9:16')
  assert.equal(shotAspect('xhs'), '竖屏 9:16')
  assert.equal(shotAspect('bilibili'), '横屏 16:9')
  assert.equal(shotAspect('direct'), '')
  assert.equal(shotAspect(''), '')
  assert.equal(shotAspect(undefined), '')
})

test('这一镜取哪一段脚本：按时间对得上，落缝里取前面那段，没有就是 null', () => {
  assert.equal(beatForShot({ startSec: 1.4 }, beats)?.beat, '钩子')
  assert.equal(beatForShot({ startSec: 2 }, beats)?.beat, '展开', '边界归后一段')
  assert.equal(beatForShot({ startSec: 9 }, beats)?.beat, '展开', '超出总长取最后一段')
  assert.equal(beatForShot({ startSec: 0, endSec: 1 }, []), null)
  assert.equal(beatForShot({ startSec: 0 }, null), null)
})

test('一镜一条提示词：比例、机位、画面与脚本原话都在，编号与时长不在', () => {
  const text = shotPrompt(shot, beats[0], { platform: 'douyin', scriptSource: 'own' })
  assert.match(text, /^竖屏 9:16，中景固定，彩条测试画面，色块变化。/)
  assert.match(text, /画面按这条作品自己的脚本：这条片子只有六秒，但三个段落都在。/)
  assert.match(text, /不要出现文字、Logo、水印、界面截图。$/)
  assert.doesNotMatch(text, /第 ?0?2 ?镜/)
  assert.doesNotMatch(text, /1–2 秒/)
  assert.doesNotMatch(text, /\.\./, '不叠句号')
})

test('脚本不是作品自己的那份：写成「原片这一段口播」，不冒充自己的脚本', () => {
  const text = shotPrompt(shot, beats[0], { platform: 'douyin', scriptSource: 'template' })
  assert.match(text, /画面按原片这一段口播：这条片子只有六秒，但三个段落都在。/)
  assert.doesNotMatch(text, /自己的脚本/)
  const unknown = shotPrompt(shot, beats[0], { platform: 'douyin' })
  assert.match(unknown, /画面按这段口播：/)
})

test('直链不写比例：提示词里没有竖屏也没有横屏', () => {
  const text = shotPrompt(shot, null, { platform: 'direct' })
  assert.doesNotMatch(text, /竖屏|横屏|9:16|16:9/)
  assert.match(text, /中景固定，彩条测试画面，色块变化。/)
})

test('没有脚本就只按分镜拼，不编一句旁白出来', () => {
  const text = shotPrompt(shot, null, { platform: 'douyin' })
  assert.doesNotMatch(text, /这条作品自己的脚本/)
  assert.equal(text, '竖屏 9:16，中景固定，彩条测试画面，色块变化。实拍质感，自然光，色彩克制；不要出现文字、Logo、水印、界面截图。')
})

test('画面与脚本都空：给一条能接上的提示词，不硬编内容', () => {
  const text = shotPrompt({ shotNo: 5, startSec: 4, endSec: 5 }, null, { platform: 'douyin' })
  assert.equal(text, '竖屏 9:16，按第 5 镜的位置补一个能接上前后镜头的画面。实拍质感，自然光，色彩克制；不要出现文字、Logo、水印、界面截图。')
})

test('复制全部：抬头说清是哪条作品几镜，每镜一段、编号补零、段间空行', () => {
  const text = allShotPrompts([shot, { shotNo: 3, startSec: 2, endSec: 3, visual: '画面切成方格', camera: '近景固定' }], beats, { platform: 'douyin', title: '毛衣折叠收纳法' })
  const parts = text.split('\n')
  assert.equal(parts[0], '分镜提示词 · 毛衣折叠收纳法（2 镜）')
  assert.match(parts[1], /点「出这一镜」就地画一张（花你自己的积分）/)
  assert.equal(parts[2], '')
  assert.equal(parts[3], '第 02 镜 · 1–2 秒')
  assert.match(parts[4], /^竖屏 9:16，中景固定/)
  assert.equal(parts[5], '')
  assert.equal(parts[6], '第 03 镜 · 2–3 秒')
  assert.match(parts[7], /画面切成方格/)
  assert.match(parts[7], /第一段给结论，第二段给做法。/)
})

test('没有分镜就不给一段空文本', () => {
  assert.equal(allShotPrompts([], beats, { title: 'x' }), '')
  assert.equal(allShotPrompts(null, null), '')
})

test('面板那句说明：脚本从哪来就怎么说，永远说清没有模型改写、会花额度', () => {
  assert.match(shotPromptHint('own'), /这条作品自己的脚本/)
  assert.match(shotPromptHint('template'), /模板那一段脚本/)
  assert.doesNotMatch(shotPromptHint('none'), /脚本/)
  for (const source of ['own', 'template', 'none']) {
    assert.match(shotPromptHint(source), /没有经过模型改写/)
    // r276：出图这一步已经收进作品页，说明里要给出「就地画」与「复制走」两个出口
    assert.match(shotPromptHint(source), /点「出这一镜」/)
    assert.match(shotPromptHint(source), /花你自己的积分/)
  }
})

// r277：服务端有一份逐条镜像（server/shot-prompt.mjs），因为 node 端不能 import .ts。
// 开工作流时给每一镜建的出图节点，用的必须与作品页「出这一镜」是同一条提示词——
// 这里把所有分支都跑一遍逐字比，谁改了一边忘了另一边，这条会直接红。
test('服务端镜像与前端逐字一致：开工作流的出图节点不会拼出另一条提示词', async () => {
  const server = await import('../server/shot-prompt.mjs')
  const platforms = ['douyin', 'xiaohongshu', 'xhs', 'bilibili', 'youtube', 'direct', '', undefined]
  const sources = ['own', 'template', undefined]
  const shots = [
    shot,
    { shotNo: 3, startSec: 2, endSec: 3, visual: '画面切成方格', camera: '近景固定' },
    { shotNo: 4, startSec: 0.5, visual: '只有画面没有机位' },
    { shotNo: 5, startSec: 1.5 },
    { shotNo: 6, startSec: 9, endSec: 10, camera: '推近' },
    { shotNo: 7, startSec: 0, visual: '句号已经在结尾。', camera: '' },
  ]
  const beatCases = [beats, [], null, [{ beat: '无时长', voiceover: '只有一句话' }]]

  for (const platform of platforms) {
    assert.equal(server.shotAspect(platform), shotAspect(platform), '画幅判断一致：' + String(platform))
    for (const list of beatCases) {
      for (const item of shots) {
        const mine = beatForShot(item, list)
        const theirs = server.beatForShot(item, list)
        assert.equal(theirs?.beat, mine?.beat, '这一镜对到哪一段一致')
        for (const source of sources) {
          const options = { platform, scriptSource: source }
          assert.equal(
            server.shotPrompt(item, theirs, options),
            shotPrompt(item, mine, options),
            '提示词一致：第 ' + item.shotNo + ' 镜 · ' + String(platform) + ' · ' + String(source),
          )
        }
      }
    }
  }
})
