// r288：对话框里「一句话直接生成」的指令解析。纯函数，不起服务、不打上游。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-media-intent-'))
process.env.DATA_DIR = dir

const { parseMediaIntent } = await import('../server/media-intent.mjs')

test('斜杠指令：比例、时长、清晰度都认出来，参数词从提示词里拿掉', () => {
  const image = parseMediaIntent('/生图 9:16 咖啡店门口的雨夜海报')
  assert.equal(image.kind, 'image')
  assert.equal(image.model, 'visionqa-image')
  assert.equal(image.ratio, '9:16')
  assert.equal(image.prompt, '咖啡店门口的雨夜海报', '比例不该留在提示词里')
  assert.equal(image.duration, null)

  const video = parseMediaIntent('/生视频 16:9 8秒 480p 雨夜街头的橘猫')
  assert.equal(video.kind, 'video')
  assert.equal(video.model, 'visionqa-video')
  assert.equal(video.ratio, '16:9')
  assert.equal(video.duration, 8)
  assert.equal(video.resolution, '480p')
  assert.equal(video.prompt, '雨夜街头的橘猫')
})

test('自然语言指令：客气话能剥掉，指令后面要有个断点', () => {
  const polite = parseMediaIntent('帮我生成一张图 16:9 一只橘猫')
  assert.equal(polite.kind, 'image')
  assert.equal(polite.ratio, '16:9')
  assert.equal(polite.prompt, '一只橘猫')

  const noSpace = parseMediaIntent('生成一张图片，1:1，白底产品图')
  assert.equal(noSpace.kind, 'image')
  assert.equal(noSpace.prompt, '白底产品图')

  // 「生成视频教程的文案」不是在要视频：后面没断点，按普通对话处理
  assert.equal(parseMediaIntent('生成视频教程的文案'), null)
})

test('问句不触发：问怎么生成、问要多久，都不该先花掉积分', () => {
  for (const text of ['怎么生成图？', '生成一张图要多久', '生成一张图要多少钱', '生图工具怎么用', '生成视频能有多长', '/生图要多久']) {
    // 斜杠那一条是例外：用户明确敲了指令，后面跟的是提示词，不算问句
    if (text === '/生图要多久') {
      assert.equal(parseMediaIntent(text).prompt, '要多久')
      continue
    }
    assert.equal(parseMediaIntent(text), null, text + ' 不该被当成生成指令')
  }
  assert.equal(parseMediaIntent('今天天气不错'), null)
})

test('只有指令没有提示词：交给对话层去补提示词，不在这里回错误', () => {
  // r293：以前这里直接回 MEDIA_PROMPT 错误让用户自己补；现在标记 needsPrompt，
  // 由 server/media-prompt.mjs 用文本模型把这句话写成提示词（写不出来才回那句话）。
  const empty = parseMediaIntent('/生图')
  assert.equal(empty.needsPrompt, true)
  assert.match(empty.usage, /后面写清要画什么/)
  assert.match(empty.usage, /例如/)

  const natural = parseMediaIntent('生成一张图')
  assert.equal(natural.needsPrompt, true)
  assert.match(natural.usage, /生成一张图」后面写清要画什么/)
  assert.equal(natural.prompt, '')
})

test('写死的比例 / 秒数 / 清晰度：原样保留并标记 locked，不再被默认档位顶掉（r293）', () => {
  const ratio = parseMediaIntent('生成一张图片 4:3 海报')
  assert.equal(ratio.ratio, '4:3')
  assert.equal(ratio.locked.ratio, true)
  assert.equal(ratio.notes.length, 0, '不改写就不该有「按 1:1 生成」这种说明')

  const duration = parseMediaIntent('/生视频 10秒 海边日落')
  assert.equal(duration.duration, 10)
  assert.equal(duration.locked.duration, true)

  const resolution = parseMediaIntent('/生视频 1080p 海边日落')
  assert.equal(resolution.resolution, '1080p')
  assert.equal(resolution.locked.resolution, true)

  // 表里的档位照旧不标 locked：那不是「用户越过白名单」，是正常选择
  const normal = parseMediaIntent('/生视频 8秒 720p 海边日落')
  assert.equal(normal.locked.duration, undefined)
  assert.equal(normal.locked.resolution, undefined)
})

test('极速模型认得出；提示词过长截到 1200 字并说明', () => {
  const fast = parseMediaIntent('/生视频 seedance 2.0 fast 海边日落')
  assert.equal(fast.model, 'visionqa-video')
  assert.equal(fast.prompt, '海边日落')

  const long = parseMediaIntent('/生图 ' + '晚霞'.repeat(800))
  assert.equal(long.prompt.length, 1200)
  assert.match(long.notes.join(''), /只把前 1200 字/)
})

test('普通聊天里提到「生图」但不在开头：不当成指令', () => {
  assert.equal(parseMediaIntent('我想知道平台怎么生图'), null)
  assert.equal(parseMediaIntent('你说的生图是在哪个页面'), null)
})

test('口语也当成指令（r293）：出个视频、做条短视频、来一段都算', () => {
  const short = parseMediaIntent('帮我出个视频')
  assert.equal(short.kind, 'video')
  assert.equal(short.needsPrompt, true, '没写画面就等改写补，不是当聊天')

  const withSubject = parseMediaIntent('帮我出个视频，咖啡店门口的雨夜')
  assert.equal(withSubject.kind, 'video')
  assert.equal(withSubject.prompt, '咖啡店门口的雨夜')

  // 名词被参数隔在后面也算：量词不必贴着名词
  const loose = parseMediaIntent('帮我做一个 30 秒的抖音爆款视频，卖毛衣收纳袋')
  assert.equal(loose.kind, 'video')
  assert.equal(loose.duration, 30)
  assert.equal(loose.locked.duration, true)
  assert.equal(loose.prompt, '抖音爆款视频 卖毛衣收纳袋', '「的」与秒数都要从提示词里清掉')

  const nounAtEnd = parseMediaIntent('帮我做个卖毛衣收纳袋的短视频')
  assert.equal(nounAtEnd.prompt, '卖毛衣收纳袋', '句尾的「的短视频」是句式外壳')

  const imageCover = parseMediaIntent('帮我做张封面图')
  assert.equal(imageCover.kind, 'image')
  assert.equal(imageCover.needsPrompt, true)
})

test('口语但不是在要生成：名词后面接「的…」或问句，都不算指令', () => {
  for (const text of ['做个视频的脚本', '生成视频教程的文案', '帮我出个视频吗', '怎么做个视频', '我想知道帮我出个视频要多久']) {
    assert.equal(parseMediaIntent(text), null, text + ' 不该被当成生成指令')
  }
})

test('尺寸写死：图片直接当 size 提交，视频换算成比例与清晰度', () => {
  const square = parseMediaIntent('/生图 2048x2048 白底产品图')
  assert.equal(square.size, '2048x2048')
  assert.equal(square.locked.size, true)
  assert.equal(square.prompt, '白底产品图')

  const k2 = parseMediaIntent('/生图 2K 竖屏 咖啡店雨夜')
  assert.equal(k2.size, '1152x2048')
  assert.equal(k2.ratio, '9:16')

  const hd = parseMediaIntent('/生视频 海边日落 1920x1080')
  assert.equal(hd.ratio, '16:9')
  assert.equal(hd.resolution, '1080p')
  assert.equal(hd.locked.resolution, true, '1080p 不在表里，要标 locked 才能原样提交')

  const portrait = parseMediaIntent('/生视频 海边日落 竖屏')
  assert.equal(portrait.ratio, '9:16')
})

test('秒数超出 1–60：不猜，说明后按默认值走', () => {
  const tooLong = parseMediaIntent('/生视频 120秒 海边日落')
  assert.equal(tooLong.duration, 4)
  assert.match(tooLong.notes.join(''), /1–60/)
  assert.equal(tooLong.locked.duration, undefined)
})
