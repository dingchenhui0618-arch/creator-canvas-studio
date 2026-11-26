import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

// 复刻链路过去对原片声音一无所知，口播是视觉模型看画面编的。
// 这一组测试盯住新加的音轨事实层：测不到的东西不许写成结论（不写「检测到人声」），
// 测得到的东西（停顿位置、响度）必须准——分镜表要靠它标「这段原片没人声」。

const {
  parseSilence, parseVolume, classifyAudio, overlapsSilence, analyzeAudio, hasAudioStream,
  SILENCE_DB, MIN_SILENCE_SEC,
} = await import('../server/audio.mjs')

const run = promisify(execFile)

test('静音段：成对的 silence_start/end 各自成段', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 3.02',
    '[silencedetect @ 0x1] silence_end: 6.01 | silence_duration: 2.99',
    '[silencedetect @ 0x1] silence_start: 9.5',
    '[silencedetect @ 0x1] silence_end: 10.2 | silence_duration: 0.7',
  ].join('\n')
  assert.deepEqual(parseSilence(stderr, 12), [{ start: 3.02, end: 6.01 }, { start: 9.5, end: 10.2 }])
})

test('静音段：以静音收尾时用总时长补齐，不能把结尾那段丢掉', () => {
  const stderr = '[silencedetect @ 0x1] silence_start: 7.4'
  assert.deepEqual(parseSilence(stderr, 12), [{ start: 7.4, end: 12 }])
  // 没有总时长就补不出来，这时宁可不报，也不要报一个 end 0 的空段
  assert.deepEqual(parseSilence(stderr, 0), [])
})

test('响度：两个统计值都能解出来，缺了就是 null 而不是 0', () => {
  const stderr = [
    '[Parsed_volumedetect_0 @ 0x1] mean_volume: -22.3 dB',
    '[Parsed_volumedetect_0 @ 0x1] max_volume: -17.7 dB',
  ].join('\n')
  assert.deepEqual(parseVolume(stderr), { meanDb: -22.3, peakDb: -17.7 })
  assert.deepEqual(parseVolume('什么都没有'), { meanDb: null, peakDb: null })
})

test('分类：整条几乎没有声音，不许说成「有停顿的口播」', () => {
  const facts = classifyAudio({ durationSec: 10, segments: [{ start: 0, end: 10 }], meanDb: -47.1, peakDb: -43.5 })
  assert.equal(facts.bed, 'silent')
  assert.equal(facts.soundSec, 0)
  assert.match(facts.note, /几乎没有声音/)
  // 音量很低要单独说，用户看到「整条没有声音」第一反应是片子坏了
  assert.match(facts.note, /音量很低/)
})

test('分类：有停顿就算 paused，全程铺底才算 continuous', () => {
  const paused = classifyAudio({ durationSec: 12, segments: [{ start: 3, end: 6 }], meanDb: -22.3, peakDb: -17.7 })
  assert.equal(paused.bed, 'paused')
  assert.equal(paused.silenceSec, 3)
  assert.equal(paused.soundSec, 9)
  assert.match(paused.note, /1 处停顿共 3 秒/)

  const continuous = classifyAudio({ durationSec: 10, segments: [], meanDb: -27.1, peakDb: -23.2 })
  assert.equal(continuous.bed, 'continuous')
  assert.match(continuous.note, /响度平缓/)
  assert.match(continuous.note, /全程有声/)
  // 响度起伏很小的全程底噪更像铺底音乐，别把停顿说成「口播」
  assert.equal(continuous.pauses, 0)
})

test('分类：字段名只讲可测量的东西，没有「人声」这种结论字段', () => {
  const facts = classifyAudio({ durationSec: 12, segments: [{ start: 3, end: 6 }], meanDb: -22.3, peakDb: -17.7 })
  assert.equal(Object.hasOwn(facts, 'voice'), false, '测不到人声就不许给人声下结论')
  assert.deepEqual(
    Object.keys(facts).sort(),
    ['bed', 'durationSec', 'hasTrack', 'meanDb', 'note', 'pauses', 'peakDb', 'rangeDb', 'segments', 'silenceSec', 'soundSec'].sort(),
  )
})

test('分镜落到静音里：过半数没声音才算留白', () => {
  const audio = { hasTrack: true, segments: [{ start: 3, end: 6 }] }
  assert.equal(overlapsSilence(audio, 3.5, 5.5), true)
  assert.equal(overlapsSilence(audio, 0.5, 2.5), false)
  assert.equal(overlapsSilence(audio, 2.5, 4.5), true)
  // 擦边的 0.2 秒不算这一段是留白
  assert.equal(overlapsSilence(audio, 5.8, 8), false)
  assert.equal(overlapsSilence({ hasTrack: false, segments: [] }, 3.5, 5.5), false)
  assert.equal(overlapsSilence(audio, 5, 5), false, '零长度不算')
})

// 真跑 ffmpeg 的两个用例：解析逻辑对了不代表命令对了（滤镜顺序、-map 写法都会挂）
test('真读一条有停顿的片子：拿到停顿的秒数，不是空壳', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-audio-'))
  const file = path.join(dir, 'talking.mp4')
  await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-af', "volume=enable='between(t,3,6)':volume=0",
    '-shortest', '-pix_fmt', 'yuv420p', file,
  ], { maxBuffer: 8 * 1024 * 1024 })

  assert.equal(await hasAudioStream(file), true)
  const facts = await analyzeAudio(file, { durationSec: 12 })
  assert.equal(facts.hasTrack, true)
  assert.equal(facts.pauses, 1)
  assert.equal(facts.silenceSec, 3)
  assert.equal(facts.soundSec, 9)
  assert.ok(facts.segments[0].start > 2.8 && facts.segments[0].start < 3.2, '停顿起点要对得上第 3 秒')
  assert.ok(facts.peakDb !== null && facts.meanDb !== null, '响度要真测出来')
  assert.match(facts.note, /音轨 12 秒/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('真读一条没音轨的片子：说没有音轨，不是解码失败', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-audio-'))
  const file = path.join(dir, 'mute.mp4')
  await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=5',
    '-an', '-pix_fmt', 'yuv420p', file,
  ], { maxBuffer: 8 * 1024 * 1024 })

  assert.equal(await hasAudioStream(file), false)
  const facts = await analyzeAudio(file, { durationSec: 5 })
  assert.equal(facts.hasTrack, false)
  assert.equal(facts.note, '原片没有音轨')
  assert.deepEqual(facts.segments, [])
  // 阈值是给真实素材定的，改动时这里会提醒你：它们也是对外口径的一部分
  assert.equal(SILENCE_DB, -35)
  assert.equal(MIN_SILENCE_SEC, 0.35)
  fs.rmSync(dir, { recursive: true, force: true })
})
