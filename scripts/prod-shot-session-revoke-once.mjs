// 生产一次性截图会话：按 user_agent 撤销（与 prod-shot-session-once.mjs 成对使用）。
//
// 只删 user_agent 里带 prod-shot 的会话行，不碰任何人的真实登录。
// 打印删掉了几条、还剩几条同样的行，方便把「0 条」写进发版记录。
//
// 用法（生产机）：node scripts/prod-shot-session-revoke-once.mjs r320-prod-shot
// 撤销必须 `cd /opt/visionqa` 再跑：在别的目录下 DATA_DIR 会落到 cwd 下的空库，
// 打印出来的 before 0 / removed 0 看着像「本来就干净」，其实那条会话还在（r325 实测）。

import fs from 'node:fs'
import { openDb } from '../server/auth.mjs'

const pattern = '%' + (process.argv[2] || 'prod-shot') + '%'
// 会话删干净了，令牌文件也不能留在生产上：默认删这一对（路径可用 argv[3] 覆盖）
const tokenFile = process.argv[3] || '/root/.vq-shot-token'
const removedFiles = [tokenFile, tokenFile.replace(/token/g, 'user')].filter((file) => {
  if (!fs.existsSync(file)) return false
  fs.rmSync(file, { force: true })
  return true
})
const db = openDb()
const before = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_agent LIKE ?').get(pattern).n
const removed = db.prepare('DELETE FROM sessions WHERE user_agent LIKE ?').run(pattern).changes
const after = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_agent LIKE ?').get(pattern).n
console.log(JSON.stringify({ pattern, before, removed, after, removedFiles }))
