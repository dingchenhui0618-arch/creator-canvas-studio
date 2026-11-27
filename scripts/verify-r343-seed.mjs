// r343 verify · 播种/读数助手（不参与门禁；只在 verify 脚本里被 spawn）
// 用法：
//   node --experimental-sqlite scripts/verify-r343-seed.mjs seed    <dataDir> <fakeOrigin>
//   node --experimental-sqlite scripts/verify-r343-seed.mjs balance <dataDir> <email>
// 只写临时 DATA_DIR，不动仓库数据。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [action, dataDir, origin, emailArg] = process.argv.slice(2)

process.env.DATA_DIR = dataDir
process.env.VQ_KEY_SECRET = process.env.VQ_KEY_SECRET || 'verify-r343-secret'
process.env.VQ_CREDIT_WELCOME = '300'
process.env.VQ_REQUIRE_AUTH = '1'

const load = (name) => import(pathToFileURL(path.join(HERE, '..', 'server', name)).href)
const auth = await load('auth.mjs')
const credits = await load('credits.mjs')
const { createKey, listKeys } = await load('keyvault.mjs')

const PASSWORD = 'Passw0rd!demo'

if (action === 'sysprompt') {
  // 把 chat.mjs 导出的 SYSTEM_PROMPT 原样交出去：e2e 用它证明「出站 system 就是这份导出」
  const { SYSTEM_PROMPT } = await load('chat.mjs')
  console.log(JSON.stringify({ systemPrompt: SYSTEM_PROMPT, exported: true }))
  process.exit(0)
}

if (action === 'onboard') {
  // 把注册后引导收尾：否则每个账号第一次进来都会被「先确认你在做什么」挡住，界面取证量到的只有弹窗
  const who = origin || emailArg
  const user = auth.findUserByEmail(who)
  if (!user) {
    console.error('NO_USER ' + who)
    process.exit(2)
  }
  const onboarding = await load('onboarding.mjs')
  onboarding.saveIdentity(user.id, { identity: 'creator', category: '其他', direction: '' })
  onboarding.markComplete(user.id, { skipAssets: true })
  console.log(JSON.stringify({ id: user.id, onboarding: onboarding.onboardingOf(user.id) }))
  process.exit(0)
}

if (action === 'token') {
  // 给 UI 取证发一张会话 cookie（不经过登录页，浏览器里就是真登录态）
  const who = origin || emailArg
  const user = auth.findUserByEmail(who)
  if (!user) {
    console.error('NO_USER ' + who)
    process.exit(2)
  }
  const { token } = auth.createSession(user, { userAgent: 'verify-r343-ui', ip: '127.0.0.1' })
  console.log(JSON.stringify({ id: user.id, token }))
  process.exit(0)
}

if (action === 'balance') {
  // 第三个参数在这个动作下是邮箱（seed 动作下是假上游地址）
  const who = origin || emailArg
  const user = auth.findUserByEmail(who)
  if (!user) {
    console.error('NO_USER ' + who)
    process.exit(2)
  }
  console.log(JSON.stringify({ id: user.id, balance: credits.balanceOf(user.id) }))
  process.exit(0)
}

if (action !== 'seed') {
  console.error('unknown action: ' + action)
  process.exit(2)
}

function ensureUser(email, name, kind) {
  const found = auth.findUserByEmail(email)
  if (found) return found
  return auth.createUser({ email, password: PASSWORD, name, kind })
}

// 邮箱在运行时拼（工具链会把参数里的地址打码，写死字面量反而会坏）
const AT = String.fromCharCode(64)
const adminEmail = 'verify-admin-r343' + AT + 'verify.test'
const userEmail = 'verify-user-r343' + AT + 'verify.test'
const admin = ensureUser(adminEmail, '验证管理员', 'admin')
const user = ensureUser(userEmail, '验证用户', 'account')
for (const item of [admin, user]) {
  const balance = credits.balanceOf(item.id)
  if (balance < 200) credits.grant(item.id, 300 - balance, { note: 'r343 verify 播种', operator: 'verify' })
}

const existing = listKeys().items
const wanted = [
  {
    name: 'verify image (fake)',
    provider: 'geteapi',
    baseUrl: origin + '/v1',
    apiKey: 'sk-verify-fake-image-1234567890',
    models: ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.6'],
    capabilities: ['image'],
    priority: 10,
    weight: 100,
  },
  {
    name: 'verify text (fake)',
    provider: 'custom',
    baseUrl: origin + '/v1',
    apiKey: 'sk-verify-fake-text-1234567890',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    capabilities: ['text', 'vision'],
    priority: 10,
    weight: 100,
  },
  {
    name: 'verify video (fake)',
    provider: 'cgcm',
    baseUrl: origin + '/seeapi',
    apiKey: 'sk-verify-fake-video-1234567890',
    models: ['seedance-2.0', 'seedance-2.0-fast'],
    capabilities: ['video'],
    priority: 10,
    weight: 100,
  },
]
for (const key of wanted) {
  if (existing.some((item) => item.name === key.name)) continue
  createKey(key)
}

console.log(
  JSON.stringify({
    ok: true,
    admin: { email: admin.email, id: admin.id, balance: credits.balanceOf(admin.id) },
    user: { email: user.email, id: user.id, balance: credits.balanceOf(user.id) },
    keys: listKeys().items.map((item) => ({ name: item.name, capabilities: item.capabilities, models: item.models })),
  }),
)
