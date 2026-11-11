// 存量模板的时长重算：换语速口径（如这次改用 hypit 的密度表）后，
// 不必重新花积分复刻一遍，直接把已落库的 structure / storyboard 重算 expectedSec 与 timing。
// 用法：node scripts/recalc-timing.mjs [数据目录] [--write] [--pace 快|中|慢]
import fs from 'node:fs'
import path from 'node:path'
import { reconcileTimeline } from '../server/speech.mjs'

const args = process.argv.slice(2)
const write = args.includes('--write')
const paceArg = args.includes('--pace') ? args[args.indexOf('--pace') + 1] : ''
const dir = args.find((arg) => !arg.startsWith('--') && arg !== paceArg) || process.env.DATA_DIR || 'data'
const file = path.join(dir, 'templates.json')

if (!fs.existsSync(file)) {
  console.error('找不到模板库：' + file)
  process.exit(1)
}
const list = JSON.parse(fs.readFileSync(file, 'utf8'))
let changed = 0
for (const item of list) {
  if (!Array.isArray(item.structure) || !item.structure.length) continue
  if (!Array.isArray(item.storyboard) || !item.storyboard.length) continue
  const pace = paceArg || item.analysis?.pacing || '中'
  const totalSec = Number(item.durationSec) || Number(item.video?.duration) || 0
  const beats = reconcileTimeline(item.structure, { totalSec, pace, textOf: (beat) => beat.voiceover || beat.onScreen })
  const shots = reconcileTimeline(item.storyboard, { totalSec, pace, textOf: (shot) => shot.caption })
  const timing = beats.summary.estimatedSec > 0 ? beats.summary : shots.summary
  console.log(item.id + ' ' + String(item.title).slice(0, 20) + '：台词 ' + (item.timing?.estimatedSec ?? '-') + 's → ' + timing.estimatedSec + 's，片长 ' + timing.durationSec + 's，' + (item.timing?.fit ?? '-') + ' → ' + timing.fit)
  item.structure = beats.rows
  item.storyboard = shots.rows
  item.timing = timing
  changed += 1
}
if (!changed) {
  console.log('没有可重算的模板（需要已解析、带脚本与分镜的条目）')
  process.exit(0)
}
if (!write) {
  console.log('试算完成（未落盘）：' + changed + ' 条；加 --write 才写回')
  process.exit(0)
}
fs.writeFileSync(file, JSON.stringify(list, null, 2))
console.log('已写回 ' + file + '：' + changed + ' 条')
