import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PACE_RATES,
  countSyllables,
  describeTiming,
  estimateSpeechDuration,
  rateForPace,
  reconcileTimeline,
  speechFit,
  speechUnits,
} from '../server/speech.mjs'

// 语速口径来自 @hypit/speech-estimate@0.1.1（见 docs/research/hypit-2026-11-11.md），
// 这组断言就是「别再把 4.5 字/秒拍回来」的护栏。

test('语速表与 hypit 口径一致', () => {
  assert.deepEqual(PACE_RATES.zh, { slow: 4.2, normal: 5.25, fast: 6.5625 })
  assert.deepEqual(PACE_RATES.en, { slow: 4.2, normal: 4.6, fast: 5.6 })
  assert.equal(rateForPace('中'), 5.25)
  assert.equal(rateForPace('快'), 6.5625)
  assert.equal(rateForPace('慢', 'zh'), 4.2)
  assert.equal(rateForPace('unknown'), 5.25)
})

test('中文按汉字、英文按音节数单位', () => {
  const zh = speechUnits('今天我们来拆这条爆款')
  assert.equal(zh.han, 10)
  assert.equal(zh.total, 10)
  const mixed = speechUnits('用 VisionQA 拆解')
  assert.equal(mixed.han, 3)
  assert.ok(mixed.latin >= 2, 'VisionQA 按音节算，不只是当一个词')
  assert.equal(speechUnits('').total, 0)
  assert.equal(speechUnits(null).total, 0)
})

test('countSyllables 的启发式边界', () => {
  assert.equal(countSyllables(''), 0)
  assert.equal(countSyllables('a'), 1)
  assert.equal(countSyllables('cat'), 1)
  assert.equal(countSyllables('vision'), 2)
  assert.equal(countSyllables('12'), 1)
})

test('估算时长：空文本 0，短句有下限，长句截到上限', () => {
  assert.equal(estimateSpeechDuration(''), 0)
  assert.equal(estimateSpeechDuration('好'), 0.8)
  const oneLine = estimateSpeechDuration('今天我们来拆这条爆款视频的结构')
  assert.ok(oneLine > 1 && oneLine < 10)
  assert.equal(estimateSpeechDuration('啊'.repeat(600)), 60)
  const fast = estimateSpeechDuration('今天我们来拆这条爆款视频的结构', { pace: '快' })
  const slow = estimateSpeechDuration('今天我们来拆这条爆款视频的结构', { pace: '慢' })
  assert.ok(fast < slow)
})

test('speechFit 的 1.2 / 0.55 阈值', () => {
  assert.equal(speechFit(0, 5), 'ok')
  assert.equal(speechFit(3, 0), 'untimed')
  assert.equal(speechFit(6.1, 5), 'tight')
  assert.equal(speechFit(6, 5), 'ok')
  assert.equal(speechFit(2.7, 5), 'loose')
  assert.equal(speechFit(3, 5), 'ok')
})

test('reconcileTimeline 补齐缺失的结束时间并汇总', () => {
  const { rows, summary } = reconcileTimeline(
    [
      { startSec: 0, endSec: 2, caption: '开场' },
      { startSec: 0, endSec: 0, caption: '第二镜' },
    ],
    { totalSec: 18 },
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[1].startSec, 2)
  assert.ok(rows[1].endSec > 2)
  assert.equal(summary.durationSec, 18)
  assert.equal(summary.pace, 'normal')
  assert.equal(summary.rate, 5.25)
  assert.ok(summary.estimatedSec > 0)
})

test('describeTiming 说人话，不出现术语', () => {
  assert.equal(describeTiming(null), '')
  assert.match(describeTiming({ estimatedSec: 25.5, durationSec: 18, fit: 'tight', overSec: 7.5, tight: 7 }), /多 \d+ 秒/)
  assert.match(describeTiming({ estimatedSec: 9, durationSec: 18, fit: 'loose', overSec: 0, tight: 0 }), /空镜/)
  assert.match(describeTiming({ estimatedSec: 18, durationSec: 18, fit: 'ok', overSec: 0, tight: 0 }), /匹配/)
})
