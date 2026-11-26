// 生产一次性截图会话：签发（与 prod-shot-session-revoke-once.mjs 成对使用）。
//
// 为什么要有它：生产真渲染要用一个真管理员会话，但令牌不能进上下文、更不能进仓库。
// 这个脚本在**生产机上**跑，令牌只写进 0600 的文件，脚本只打印用户 id 与文件路径。
// 拍完必须立刻跑 revoke 脚本把这条会话删掉——签发与撤销是一对，不许只做一半。
//
// 用法（生产机）：node scripts/prod-shot-session-once.mjs /root/.vq-shot-token r320-prod-shot
// 撤销必须 `cd /opt/visionqa` 再跑：在别的目录下 DATA_DIR 会落到 cwd 下的空库，
// 打印出来的 before 0 / removed 0 看着像「本来就干净」，其实那条会话还在（r325 实测）。

import fs from 'node:fs'
import { createSession, listUsers } from '../server/auth.mjs'

const file = process.argv[2] || '/root/.vq-shot-token'
const userAgent = process.argv[3] || 'prod-shot'
// 用户 id 写「同名的 -user 文件」：/root/.vq-shot-token → /root/.vq-shot-user
const userFile = process.argv[4] || file.replace(/token/g, 'user')
const admin = listUsers().find((user) => user.kind === 'admin')
if (!admin) throw new Error('生产上找不到管理员账号，先确认库里有没有 kind=admin 的用户')

const { token, expiresAt } = createSession(admin, { userAgent, ip: '127.0.0.1' })
fs.writeFileSync(file, token, { mode: 0o600 })
fs.writeFileSync(userFile, admin.id, { mode: 0o600 })
console.log(JSON.stringify({ minted: admin.id, file, userFile, userAgent, expiresAt, tokenLength: token.length }))
