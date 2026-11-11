// 画布信任票据单测：签名、时效、篡改、受众、角色映射。
// 不碰线上数据，也不需要画布在跑。
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.VQ_CANVAS_SHARED_SECRET = 'canvas-test-secret'

const { mintCanvasTicket, verifyCanvasTicket, canvasTrustEnabled } = await import('../server/canvas-session.mjs')

const user = { id: 'u_1', email: 'a@example.com', name: '张三', kind: 'account' }
const admin = { id: 'u_2', email: 'b@example.com', name: '管理员', kind: 'admin' }

assert.equal(canvasTrustEnabled(), true)

const ticket = mintCanvasTicket(user)
assert.equal(ticket.issuer, 'visionqa')
assert.equal(ticket.audience, 'bd-canvas')
assert.ok(ticket.token.split('.').length === 3, '必须是三段式 JWT')
assert.ok(ticket.expiresAt > Date.now(), '过期时间必须在未来')

const checked = verifyCanvasTicket(ticket.token)
assert.equal(checked.ok, true)
assert.equal(checked.payload.sub, 'u_1')
assert.equal(checked.payload.email, 'a@example.com')
assert.equal(checked.payload.role, 'member')
assert.equal(checked.payload.iss, 'visionqa')

// 管理员映射成 admin，画布里需要它决定是否显示管理入口
assert.equal(verifyCanvasTicket(mintCanvasTicket(admin).token).payload.role, 'admin')

// 改一个字符就签名不符
const tampered = ticket.token.slice(0, -2) + 'aa'
assert.deepEqual(verifyCanvasTicket(tampered), { ok: false, code: 'BAD_SIGNATURE' })

// 用别的密钥签的同款载荷必须被拒
function forge(payload, secret) {
  const b64 = (v) => Buffer.from(v).toString('base64url')
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify(payload))
  const data = head + '.' + body
  return data + '.' + crypto.createHmac('sha256', secret).update(data).digest('base64url')
}
assert.deepEqual(verifyCanvasTicket(forge(checked.payload, 'other-secret')), { ok: false, code: 'BAD_SIGNATURE' })

// 过期票据、受众不对、issuer 不对都要拒
const now = Math.floor(Date.now() / 1000)
const base = { iss: 'visionqa', aud: 'bd-canvas', sub: 'u_1' }
assert.deepEqual(verifyCanvasTicket(forge({ ...base, exp: now - 10 }, 'canvas-test-secret')), { ok: false, code: 'EXPIRED' })
assert.deepEqual(verifyCanvasTicket(forge({ ...base, aud: 'other-app', exp: now + 60 }, 'canvas-test-secret')), { ok: false, code: 'BAD_AUDIENCE' })
assert.deepEqual(verifyCanvasTicket(forge({ ...base, iss: 'other', exp: now + 60 }, 'canvas-test-secret')), { ok: false, code: 'BAD_ISSUER' })
assert.deepEqual(verifyCanvasTicket('not-a-jwt'), { ok: false, code: 'MALFORMED' })

// 时效上限：传一个超大 ttl 也不会签出一张三小时的票
const capped = mintCanvasTicket(user, { ttlSec: 999999 })
assert.ok(capped.expiresAt - Date.now() <= 601_000, '票据时效必须封顶在 10 分钟内')

console.log('PASS canvas-session: 签名 / 过期 / 篡改 / 受众 / 角色 / 时效上限')
