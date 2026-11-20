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
  assert.equal(image.model, 'gpt-image-2')
  assert.equal(image.ratio, '9:16')
  assert.equal(image.prompt, '咖啡店门口的雨夜海报', '比例不该留在提示词里')
  assert.equal(image.duration, null)

  const video = parseMediaIntent('/生视频 16:9 8秒 480p 雨夜街头的橘猫')
  assert.equal(video.kind, 'video')
  assert.equal(video.model, 'seedance-2.0')
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

test('只有指令没有提示词：回一句怎么用，而不是扣钱生成', () => {
  const empty = parseMediaIntent('/生图')
  assert.equal(empty.code, 'MEDIA_PROMPT')
  assert.match(empty.error, /后面写清要画什么/)
  assert.match(empty.error, /例如/)

  const natural = parseMediaIntent('生成一张图')
  assert.equal(natural.code, 'MEDIA_PROMPT')
  assert.match(natural.error, /生成一张图」后面写清要画什么/)
})

test('模型不支持的比例 / 时长 / 清晰度：按默认值走，并如实说明改了什么', () => {
  const ratio = parseMediaIntent('生成一张图片 4:3 海报')
  assert.equal(ratio.ratio, '1:1')
  assert.match(ratio.notes[0], /没有 4:3/)
  assert.match(ratio.notes[0], /按 1:1 生成/)

  const duration = parseMediaIntent('/生视频 10秒 海边日落')
  assert.equal(duration.duration, 4)
  assert.match(duration.notes.join(''), /只能 4 秒 \/ 8 秒/)

  const resolution = parseMediaIntent('/生视频 1080p 海边日落')
  assert.equal(resolution.resolution, '720p')
  assert.match(resolution.notes.join(''), /只出 720p \/ 480p/)
})

test('极速模型认得出；提示词过长截到 1200 字并说明', () => {
  const fast = parseMediaIntent('/生视频 seedance 2.0 fast 海边日落')
  assert.equal(fast.model, 'seedance-2.0-fast')
  assert.equal(fast.prompt, '海边日落')

  const long = parseMediaIntent('/生图 ' + '晚霞'.repeat(800))
  assert.equal(long.prompt.length, 1200)
  assert.match(long.notes.join(''), /只把前 1200 字/)
})

test('普通聊天里提到「生图」但不在开头：不当成指令', () => {
  assert.equal(parseMediaIntent('我想知道平台怎么生图'), null)
  assert.equal(parseMediaIntent('你说的生图是在哪个页面'), null)
})
