// 口播时长预估与对账（hypit P0-1）：语速按中文 4.5 字/秒。
import assert from 'node:assert/strict'
import { estimateSpeechDuration, reconcileTimeline, speechStats, speechFit } from '../server/speech.mjs'

let checks = 0
const ok = (condition, message) => {
  checks += 1
  assert.ok(condition, message)
}

// 1) 空文本不估时长：返回 0 表示「没有台词可估」，不是「零秒」
ok(estimateSpeechDuration('') === 0, '空文本应为 0')
ok(estimateSpeechDuration('   ') === 0, '纯空白应为 0')

// 2) 中文字速：45 字 = 10 秒（4.5 字/秒），90 字 = 20 秒，线性可外推
ok(estimateSpeechDuration('口'.repeat(45)) === 10, '45 字应为 10 秒，实得 ' + estimateSpeechDuration('口'.repeat(45)))
ok(estimateSpeechDuration('口'.repeat(90)) === 20, '90 字应为 20 秒，实得 ' + estimateSpeechDuration('口'.repeat(90)))
const cjkSec = estimateSpeechDuration('开箱这款新品先说结论再讲细节最后给价格一共 199 元')
ok(cjkSec > 5 && cjkSec < 8, '一句话口播估在 5–8 秒，实得 ' + cjkSec)

// 3) 标点算停顿：同样字数，带句末标点的更长
const flat = '开箱这款新品先说结论再讲细节最后给价格'
const paused = '开箱这款新品。先说结论。再讲细节。最后给价格。'
ok(estimateSpeechDuration(paused) > estimateSpeechDuration(flat), '句末停顿应拉长估算')

// 4) 英文与数字按词算：不因为没汉字就估成 0
ok(estimateSpeechDuration('iPhone 15 Pro Max 开箱') > 1, '中英混排应有估算值')
const stats = speechStats('iPhone 15 开箱，3 个细节。')
ok(stats.cjk === 5 && stats.words === 1 && stats.numbers === 2, '分词统计：' + JSON.stringify(stats))

// 5) 下限与上限
ok(estimateSpeechDuration('好') === 0.8, '单字至少 0.8 秒')
ok(estimateSpeechDuration('字'.repeat(2000)) === 60, '再长的台词也封顶 60 秒')

// 6) 对账口径：念不完 = tight，空镜 = loose，都对得上 = ok
ok(speechFit(9, 3) === 'tight', '9 秒台词塞进 3 秒镜头 = tight')
ok(speechFit(2, 8) === 'loose', '2 秒台词占 8 秒镜头 = loose')
ok(speechFit(6, 6) === 'ok', '对得上 = ok')
ok(speechFit(5, 0) === 'untimed', '没有时长 = untimed')

// 7) 模型没给时长时用估算值补齐，不再退化成 0 秒
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

// 8) 整条汇总：台词总量明显超过片长 → tight，并算出超出多少
const over = reconcileTimeline(
  [
    { startSec: 0, endSec: 5, voiceover: '字'.repeat(60) },
    { startSec: 5, endSec: 10, voiceover: '字'.repeat(60) },
  ],
  { totalSec: 10, textOf: (beat) => beat.voiceover },
)
ok(over.summary.fit === 'tight', '120 字塞进 10 秒应判 tight')
ok(over.summary.overSec > 15, '超出秒数应算出来，实得 ' + over.summary.overSec)
ok(over.summary.tight === 2, '两段都标 tight，实得 ' + over.summary.tight)

// 9) 时长充足时不误报
const fit = reconcileTimeline([{ startSec: 0, endSec: 12, voiceover: '字'.repeat(45) }], { totalSec: 12, textOf: (beat) => beat.voiceover })
ok(fit.summary.fit === 'ok', '45 字 / 12 秒应判 ok，实得 ' + fit.summary.fit)
ok(fit.rows[0].fit === 'ok', '单段也应是 ok')

// 10) 接进视觉链路：复刻结果里每镜带 expectedSec / fit，整条带 timing 汇总
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
}
const normalized = normalizeResult(raw, frames)
ok(normalized.storyboard.every((shot) => typeof shot.expectedSec === 'number' && shot.fit), '每镜都带 expectedSec 与 fit')
ok(normalized.storyboard[0].fit === 'loose', '2 字字幕 / 4 秒镜头判 loose，实得 ' + normalized.storyboard[0].fit)
ok(normalized.storyboard[1].fit === 'tight', '40 字字幕 / 4 秒镜头判 tight，实得 ' + normalized.storyboard[1].fit)
ok(normalized.structure[1].fit === 'tight', '120 字口播塞 4 秒段落判 tight')
ok(normalized.timing && normalized.timing.fit === 'tight', '整条 timing 判 tight，实得 ' + JSON.stringify(normalized.timing))
ok(normalized.timing.durationSec === 20, '整条时长按最后一帧算 20 秒')
ok(normalized.timing.overSec >= 8, '超出秒数为正，实得 ' + normalized.timing.overSec)

// 11) 片长以真实视频时长为准，不受「最后一帧落在哪里」影响
const withDuration = normalizeResult(raw, frames, 18)
ok(withDuration.timing.durationSec === 18, '传入 18 秒片长时用它，实得 ' + withDuration.timing.durationSec)
ok(withDuration.storyboard.every((shot) => shot.endSec <= 18), '镜头时间不超过片长')

console.log('PASS 口播时长预估：' + checks + ' 项断言')
