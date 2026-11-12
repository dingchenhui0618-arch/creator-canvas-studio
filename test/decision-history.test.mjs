// 拍板记录回看（v0.9.26）：一条作品名下每一次拍板都留着，页面要能回答「上一版我为什么放行」。
// 这一组盯两件事：
//   1. 每条拍板「还算不算数」由服务端算，页面不许自己再算一遍（current / stale / past 三种）；
//   2. 撤销只拿走这一版这一次评审的那条，早先几版的记录留在历史里——要清干净是另一个动作。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-decision-log-'))
process.env.DATA_DIR = dir

const at = (day, hour) => '2026-11-' + String(day).padStart(2, '0') + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z'

// 作品现在是第 2 版，这一版最近一次评审在 11-12 10:00。
//   dec_now    第 2 版、这次评审上拍通过   → 管这一版
//   dec_stale  第 2 版、更早一次评审上拍不过 → 这一版重评过，已失效
//   dec_v1     第 1 版的拍板               → 早先那一版
//   dec_legacy 版本划分之前（version 0）的拍板 → 折进第 1 版，仍是早先那一版
//   dec_broken decision 不是通过 / 不通过 → 不可信，不往历史里排
const seeded = [
  { id: 'dec_now', projectId: 'prj_log', version: 2, reviewAt: at(12, 10), verdict: 'needs_review', decision: 'pass', note: '可以发', at: at(12, 12), ownerId: 'u_a' },
  { id: 'dec_stale', projectId: 'prj_log', version: 2, reviewAt: at(10, 9), verdict: 'fail', decision: 'reject', note: '镜头太慢', at: at(10, 11), ownerId: 'u_a' },
  { id: 'dec_v1', projectId: 'prj_log', version: 1, reviewAt: at(8, 9), verdict: 'fail', decision: 'pass', note: '', at: at(8, 10), ownerId: 'u_a' },
  { id: 'dec_legacy', projectId: 'prj_log', version: 0, reviewAt: at(2, 9), verdict: 'fail', decision: 'reject', note: '', at: at(2, 10), ownerId: 'u_a' },
  { id: 'dec_broken', projectId: 'prj_log', version: 2, reviewAt: at(9, 9), verdict: 'fail', decision: 'maybe', note: '', at: at(9, 10), ownerId: 'u_a' },
  // 别的作品、别的账号：不该出现在这条作品的历史里（本组只测纯函数，两条都由调用方先筛过）
  { id: 'dec_other', projectId: 'prj_other', version: 1, reviewAt: at(8, 9), verdict: 'fail', decision: 'pass', note: '', at: at(8, 11), ownerId: 'u_b' },
  // 没有 ownerId 的老记录：全站按公共数据算（谁看得见谁能撤、谁能覆盖）
  { id: 'dec_public', projectId: 'prj_pub', version: 1, reviewAt: at(6, 9), verdict: 'fail', decision: 'pass', note: '', at: at(6, 10), ownerId: '' },
  { id: 'dec_public2', projectId: 'prj_pub', version: 1, reviewAt: at(5, 9), verdict: 'fail', decision: 'reject', note: '', at: at(5, 10), ownerId: '' },
]
fs.writeFileSync(path.join(dir, 'review-decisions.json'), JSON.stringify(seeded), 'utf8')

const { decisionHistory } = await import('../server/project-status.mjs')
const { clearDecision, listDecisions, saveDecision } = await import('../server/review-decisions.mjs')

const me = { id: 'u_a' }
const mine = () => seeded
  .filter((entry) => entry.ownerId === 'u_a' && entry.projectId === 'prj_log')
  .sort((a, b) => String(b.at).localeCompare(String(a.at)))

test('三种状态：管这一版 / 这一版重评过 / 早先那一版', () => {
  const log = decisionHistory(mine(), { version: 2, reviewAt: at(12, 10) })
  const byId = new Map(log.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('dec_now').state, 'current', '时间对得上才是管这一版')
  assert.equal(byId.get('dec_stale').state, 'stale', '同一版但那次评审后来又被评过：已失效')
  assert.equal(byId.get('dec_v1').state, 'past', '第 1 版的拍板是上一版的事')
  assert.equal(byId.get('dec_legacy').state, 'past', '版本划分之前的记录算第 1 版')
  assert.equal(byId.get('dec_legacy').version, 1, '版次 0 折进 v1，与评审 / 运行 / 交付同一套口径')
})

test('不可信的记录不往历史里排：decision 只有通过 / 不通过两种', () => {
  const log = decisionHistory(mine(), { version: 2, reviewAt: at(12, 10) })
  assert.equal(log.some((entry) => entry.id === 'dec_broken'), false)
  assert.equal(log.length, 4)
})

test('没有当前评审就谁都不算管这一版（不硬挑一条当现行）', () => {
  const log = decisionHistory(mine(), { version: 2, reviewAt: '' })
  assert.deepEqual(log.filter((entry) => entry.state === 'current'), [])
  // 开新版 / 这一版还没评过时，仍然能看到旧记录
  const v3 = decisionHistory(mine(), { version: 3, reviewAt: '' })
  assert.deepEqual(v3.map((entry) => entry.state), ['past', 'past', 'past', 'past'])
})

test('空历史与坏输入：返回空表，不改入参', () => {
  assert.deepEqual(decisionHistory([], { version: 1, reviewAt: at(1, 1) }), [])
  assert.deepEqual(decisionHistory(null, { version: 1 }), [])
  const input = mine()
  const copy = JSON.parse(JSON.stringify(input))
  decisionHistory(input, { version: 2, reviewAt: at(12, 10) })
  assert.deepEqual(input, copy, '纯函数：不就地改调用方的记录')
})

test('撤销只拿走这一版这一次评审的那条，早先几版的记录留着', async () => {
  const before = (await listDecisions(me)).filter((entry) => entry.projectId === 'prj_log')
  assert.equal(before.length, 5, '含那条不可信的：清点只按记录，不按结论对不对来判断')

  const removed = await clearDecision('prj_log', at(12, 10), me)
  assert.equal(removed, 1)
  const after = (await listDecisions(me)).filter((entry) => entry.projectId === 'prj_log')
  assert.equal(after.length, 4)
  assert.equal(after.some((entry) => entry.id === 'dec_now'), false, '撤掉的那条不在历史里了')
  assert.equal(after.some((entry) => entry.id === 'dec_stale'), true, '这一版更早那次拍的还在：那是历史')
  assert.equal(after.some((entry) => entry.id === 'dec_v1'), true, '上一版的拍板还在')
  assert.equal(await clearDecision('prj_log', at(12, 10), me), 0, '再撤一次是 0，不报错')
})

test('撤销按账号隔离：别人碰不到我的记录', async () => {
  const removed = await clearDecision('prj_log', at(8, 9), { id: 'u_b' })
  assert.equal(removed, 0)
  const after = (await listDecisions(me)).filter((entry) => entry.projectId === 'prj_log')
  assert.equal(after.some((entry) => entry.id === 'dec_v1'), true)
})

test('缺作品或缺评审时间一律不动手（不猜人要撤哪条）', async () => {
  assert.equal(await clearDecision('', at(8, 9), me), 0)
  assert.equal(await clearDecision('prj_log', '', me), 0)
  assert.equal((await listDecisions(me)).filter((entry) => entry.projectId === 'prj_log').length, 4)
})

test('没有 ownerId 的老记录：新拍板覆盖它，不留下同一版同一次评审的两条', async () => {
  await saveDecision({ projectId: 'prj_pub', version: 1, reviewAt: at(6, 9), verdict: 'fail', decision: 'reject', note: '再改一版' }, me)
  const rows = (await listDecisions(me)).filter((entry) => entry.projectId === 'prj_pub')
  assert.equal(rows.length, 2, '覆盖的是那一条，另一条公共记录还在')
  const cover = rows.find((entry) => entry.reviewAt === at(6, 9))
  assert.equal(cover.decision, 'reject')
  assert.equal(cover.ownerId, 'u_a', '覆盖之后这条算我的：以后再改主意是按我的记录改')
})

test('公共记录（没有 ownerId）登录账号撤得掉：与列表一样按「看得见」算', async () => {
  const removed = await clearDecision('prj_pub', at(5, 9), me)
  assert.equal(removed, 1)
  assert.equal((await listDecisions(me)).some((entry) => entry.id === 'dec_public2'), false)
})

test('管理员撤得掉别人拍的那条：不是他拍的，但他看得见', async () => {
  assert.equal(await clearDecision('prj_other', at(8, 9), { id: 'u_admin', kind: 'admin' }), 1)
})
