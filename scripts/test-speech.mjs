// 口播时长预估与对账：语速口径照 @hypit/speech-estimate（zh 慢 4.2 / 中 5.25 / 快 6.5625 字每秒）。
import assert from 'node:assert/strict'
import { estimateSpeechDuration, reconcileTimeline, speechFit, speechUnits, rateForPace } from '../server/speech.mjs'

let checks = 0
const ok = (condition, message) => {
  checks += 1
  assert.ok(condition, message)
}

// 1) 空文本不估时长：返回 0 表示「没有台词可估」，不是「零秒」
ok(estimateSpeechDuration('') === 0, '空文本应为 0')
ok(estimateSpeechDuration('   ') === 0, '纯空白应为 0')

// 2) 中文字速按 hypit 口径：45 字 / 5.25 字每秒 = 8.6 秒
ok(estimateSpeechDuration('口'.repeat(45)) === 8.6, '45 字中速应为 8.6 秒，实得 ' + estimateSpeechDuration('口'.repeat(45)))
ok(estimateSpeechDuration('口'.repeat(90)) === 17.1, '90 字中速应为 17.1 秒，实得 ' + estimateSpeechDuration('口'.repeat(90)))

// 3) 三档语速：快 < 中 < 慢，且与 vendor 的密度一致
const fast = estimateSpeechDuration('口'.repeat(45), { pace: '快' })
const normal = estimateSpeechDuration('口'.repeat(45), { pace: '中' })
const slow = estimateSpeechDuration('口'.repeat(45), { pace: '慢' })
ok(fast < normal && normal < slow, '快 < 中 < 慢，实得 ' + [fast, normal, slow].join(' / '))
ok(rateForPace('快') === 6.5625 && rateForPace('中') === 5.25 && rateForPace('慢') === 4.2, '三档密度与 vendor 一致')
ok(rateForPace('未知档位') === 5.25, '未知档位回落中速')

// 4) 标点不加时（vendor 的密度已含停顿）：只按单位数算
const flat = '开箱这款新品先说结论再讲细节'
const paused = '开箱这款新品，先说结论，再讲细节。'
ok(estimateSpeechDuration(flat) === estimateSpeechDuration(paused), '标点不额外加时（与 vendor 同口径）')

// 5) 单位口径：汉字 + 英文/数字音节
const units = speechUnits('开箱这款新品一共 199 元')
ok(units.han === 9, '汉字 9 个，实得 ' + units.han)
ok(units.total === 10, '199 记 1 个单位，合计 10，实得 ' + units.total)
ok(speechUnits('iPhone 15 Pro Max').total === 5, 'i(Phone) 2 + 15 1 + Pro 1 + Max 1 = 5 音节')
ok(estimateSpeechDuration('iPhone 15 Pro Max') > 0.8, '纯英数也有估算值')

// 6) 下限与上限
ok(estimateSpeechDuration('好') === 0.8, '单字至少 0.8 秒')
ok(estimateSpeechDuration('字'.repeat(2000)) === 60, '再长的台词也封顶 60 秒')

// 7) 对账口径：念不完 = tight，空镜 = loose，都对得上 = ok
ok(speechFit(9, 3) === 'tight', '9 秒台词塞进 3 秒镜头 = tight')
ok(speechFit(2, 8) === 'loose', '2 秒台词占 8 秒镜头 = loose')
ok(speechFit(6, 6) === 'ok', '对得上 = ok')
ok(speechFit(5, 0) === 'untimed', '没有时长 = untimed')

// 8) 模型没给时长时用估算值补齐，不再退化成 0 秒
const missing = reconcileTimeline(
  [
    { shotNo: 1, startSec: 0, endSec: 0, caption: '开箱这款新品先说结论再讲细节最后给价格' },
    { shotNo: 2, startSec: 0, endSec: 0, caption: '价格是 199 元' },
  ],
  { totalSec: 20, textOf: (shot) => shot.caption },
)
ok(missing.rows[0].endSec > 3, '缺时长的镜头按台词估算补齐，实得 ' + missing.rows[0].endSec)
ok(missing.rows[1].startSec === missing.rows[0].endSec, '未给时间的镜头按上一镜结束时间顺排')
ok(missing.rows.every((row) => row.expectedSec > 0 && row.fit), '每镜都带 expectedSec 与 fit')

// 9) 整条汇总：台词总量明显超过片长 → tight，并算出超出多少
const over = reconcileTimeline(
  [
    { startSec: 0, endSec: 5, voiceover: '字'.repeat(60) },
    { startSec: 5, endSec: 10, voiceover: '字'.repeat(60) },
  ],
  { totalSec: 10, textOf: (beat) => beat.voiceover },
)
ok(over.summary.fit === 'tight', '120 字塞进 10 秒应判 tight')
ok(over.summary.overSec > 10, '超出秒数应算出来，实得 ' + over.summary.overSec)
ok(over.summary.tight === 2, '两段都标 tight，实得 ' + over.summary.tight)
ok(over.summary.pace === 'normal' && over.summary.rate === 5.25, '汇总带上语速档位')

// 10) 时长充足时不误报；同样台词在「快」档下更宽松
const fit = reconcileTimeline([{ startSec: 0, endSec: 12, voiceover: '字'.repeat(45) }], { totalSec: 12, textOf: (beat) => beat.voiceover })
ok(fit.summary.fit === 'ok', '45 字 / 12 秒应判 ok，实得 ' + fit.summary.fit)
const fitFast = reconcileTimeline([{ startSec: 0, endSec: 9, voiceover: '字'.repeat(45) }], { totalSec: 9, pace: '快', textOf: (beat) => beat.voiceover })
ok(fitFast.summary.fit === 'ok', '同样的台词按快档念，9 秒就够（实得 ' + fitFast.summary.fit + '）')
const fitSlow = reconcileTimeline([{ startSec: 0, endSec: 7.5, voiceover: '字'.repeat(45) }], { totalSec: 7.5, pace: '慢', textOf: (beat) => beat.voiceover })
ok(fitSlow.summary.fit === 'tight', '同样的台词按慢档念，7.5 秒不够（实得 ' + fitSlow.summary.fit + '）')
const fitMid = reconcileTimeline([{ startSec: 0, endSec: 7.5, voiceover: '字'.repeat(45) }], { totalSec: 7.5, pace: '中', textOf: (beat) => beat.voiceover })
ok(fitMid.summary.fit === 'ok', '同一句台词按中档念，7.5 秒刚好（实得 ' + fitMid.summary.fit + '）')

// 11) 接进视觉链路：复刻结果里每镜带 expectedSec / fit，整条带 timing 汇总
const { normalizeResult } = await import('../server/vision.mjs')
const frames = [0, 4, 8, 12, 16, 20].map((t, index) => ({ index: index + 1, t, name: 'frame-' + (index + 1) + '.jpg', file: 'x.jpg' }))
const raw = {
  title: '开箱测试',
  structure: [
    { beat: '钩子', startSec: 0, endSec: 4, voiceover: '这款新品有个反常识的设计' },
    { beat: '展开', startSec: 4, endSec: 8, voiceover: '字'.repeat(120) },
  ],
  storyboard: [
    { shotNo: 1, startSec: 0, endSec: 4, caption: '开箱', visual: '手部特写', camera: '近景', audio: '人声', purpose: '开场' },
    { shotNo: 2, startSec: 4, endSec: 8, caption: '字'.repeat(40), visual: '桌面平铺', camera: '俯拍', audio: '人声', purpose: '细节' },
  ],
  analysis: { pacing: '中' },
}
const normalized = normalizeResult(raw, frames)
ok(normalized.storyboard.every((shot) => typeof shot.expectedSec === 'number' && shot.fit), '每镜都带 expectedSec 与 fit')
ok(normalized.storyboard[0].fit === 'loose', '2 字字幕 / 4 秒镜头判 loose，实得 ' + normalized.storyboard[0].fit)
ok(normalized.storyboard[1].fit === 'tight', '40 字字幕 / 4 秒镜头判 tight，实得 ' + normalized.storyboard[1].fit)
ok(normalized.structure[1].fit === 'tight', '120 字口播塞 4 秒段落判 tight')
ok(normalized.timing && normalized.timing.fit === 'tight', '整条 timing 判 tight，实得 ' + JSON.stringify(normalized.timing))
ok(normalized.timing.durationSec === 20, '整条时长按最后一帧算 20 秒')
ok(normalized.timing.overSec >= 5, '超出秒数为正，实得 ' + normalized.timing.overSec)

// 12) 片长以真实视频时长为准，不受「最后一帧落在哪里」影响
const withDuration = normalizeResult(raw, frames, 18)
ok(withDuration.timing.durationSec === 18, '传入 18 秒片长时用它，实得 ' + withDuration.timing.durationSec)
ok(withDuration.storyboard.every((shot) => shot.endSec <= 18), '镜头时间不超过片长')

// 13) 节奏「快」会让同一份口播的估算变短（复刻密度跟着原片节奏走）
const fastRaw = { ...raw, analysis: { pacing: '快' } }
const fastNorm = normalizeResult(fastRaw, frames, 20)
ok(fastNorm.timing.estimatedSec < normalized.timing.estimatedSec, '快节奏下估算更短：' + fastNorm.timing.estimatedSec + ' < ' + normalized.timing.estimatedSec)

console.log('PASS 口播时长预估：' + checks + ' 项断言')
