import test from 'node:test'
import assert from 'node:assert/strict'

// 复刻链路最假的一步：「口播」是视觉模型看画面编的，却被当成原片说过的话存进模板。
// 这一组钉住两点：①提示词不许再要求编造原文；②音轨实测事实（停顿）要真进到分镜里。

const { normalizeResult, SYSTEM_PROMPT } = await import('../server/vision.mjs')

const frames = [{ index: 1, t: 0 }, { index: 2, t: 4 }, { index: 3, t: 8 }]
const audio = {
  hasTrack: true,
  durationSec: 12,
  speechSec: 9,
  silenceSec: 3,
  pauses: 1,
  segments: [{ start: 3, end: 6 }],
  meanDb: -22.3,
  peakDb: -17.7,
  rangeDb: 4.6,
  bed: 'paused',
  note: '音轨 12 秒 · 1 处停顿共 3 秒',
}
const rawAnalysis = {
  title: '测试片',
  contentType: '口播干货',
  tags: ['测试'],
  hook: '开头一句',
  hookType: '痛点提问',
  structure: [
    { beat: '开场', startSec: 0, endSec: 2.9, voiceover: '大家好', voiceoverSource: 'on-screen', onScreen: '开场白', purpose: '抓注意' },
    { beat: '留白', startSec: 3, endSec: 6, voiceover: '我们建议这里停一下', onScreen: '', purpose: '留白' },
    { beat: '结尾', startSec: 6, endSec: 12, voiceover: '点击下方链接' },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 3, frameIndex: 1, visual: '人物', camera: '中景', caption: '开场', audio: '人声' },
    { shotNo: 2, startSec: 3.2, endSec: 5.8, frameIndex: 2, visual: '产品特写', camera: '特写', caption: '', audio: '' },
    { shotNo: 3, startSec: 6, endSec: 12, frameIndex: 3, visual: '人物', camera: '中景', caption: '结尾', audio: '人声' },
  ],
  analysis: { pacing: '中', viralPoints: [], reusableRules: [], targetAudience: '测试' },
}

test('提示词不再要求「即使没有人声也要编口播」', () => {
  assert.equal(SYSTEM_PROMPT.includes('即使原片没有人声'), false, '这句话就是「编原话」的源头，不许回来')
  assert.match(SYSTEM_PROMPT, /voiceoverSource/)
  assert.match(SYSTEM_PROMPT, /on-screen/)
  assert.match(SYSTEM_PROMPT, /inferred/)
  assert.match(SYSTEM_PROMPT, /不要把「建议口播」写成原片说过的原话/)
  // 也别让它声称听见了声音：模型只有画面
  assert.match(SYSTEM_PROMPT, /听不到这条片子的声音/)
})

test('音轨事实原样带进分析结果', () => {
  const result = normalizeResult(rawAnalysis, frames, 12, audio)
  assert.deepEqual(result.audio, audio)
  assert.match(result.audio.note, /1 处停顿/)
})

test('口播来源：模型标了字幕就认字幕，没标的一律算画面推断', () => {
  const result = normalizeResult(rawAnalysis, frames, 12, audio)
  assert.equal(result.structure[0].voiceoverSource, 'on-screen')
  assert.equal(result.structure[1].voiceoverSource, 'inferred')
  // 模型自称 asr 也不行：我们并没有做语音识别，落库前统一降级成推断
  const claiming = normalizeResult({
    ...rawAnalysis,
    structure: [{ beat: 'x', startSec: 0, endSec: 3, voiceover: '编的', voiceoverSource: 'asr' }],
  }, frames, 12, audio)
  assert.equal(claiming.structure[0].voiceoverSource, 'inferred', '模型不许自称做过语音识别')
  // 没有口播文本就不该有来源标记，界面上不能出现一个空的「画面推断」
  const empty = normalizeResult({
    ...rawAnalysis,
    structure: [{ beat: 'x', startSec: 0, endSec: 3, voiceover: '' }],
  }, frames, 12, audio)
  assert.equal(empty.structure[0].voiceoverSource, '')
})

test('落在原片停顿里的段落与镜头会被标成 audioGap', () => {
  const result = normalizeResult(rawAnalysis, frames, 12, audio)
  assert.equal(result.structure[0].audioGap, false)
  assert.equal(result.structure[1].audioGap, true, '3–6 秒是实测停顿')
  assert.equal(result.structure[2].audioGap, false)
  assert.equal(result.storyboard[1].audioGap, true)
  assert.equal(result.storyboard[0].audioGap, false)
})

test('没有音轨时 audio 还是给出去（带说明），但不逐段刷「无声」', () => {
  const mute = {
    hasTrack: false, durationSec: 0, speechSec: 0, silenceSec: 0, pauses: 0, segments: [],
    meanDb: null, peakDb: null, rangeDb: null, bed: 'unknown', note: '原片没有音轨',
  }
  const result = normalizeResult(rawAnalysis, frames, 12, mute)
  assert.equal(result.audio.note, '原片没有音轨')
  assert.deepEqual(result.structure.map((beat) => beat.audioGap), [false, false, false])
})

test('老调用（没传音轨）不炸，audio 为 null、也不标留白', () => {
  const result = normalizeResult(rawAnalysis, frames, 12)
  assert.equal(result.audio, null)
  assert.deepEqual(result.storyboard.map((shot) => shot.audioGap), [false, false, false])
})
