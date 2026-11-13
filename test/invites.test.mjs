import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

// 邀请码是内测开号的唯一入口：注册全局关着，持有效码的人也能自己开号。
// 这组测试盯住四条不变量：
//   1) 码规范化（大小写/空格/缺前缀）后能查到同一枚；
//   2) 次数是「条件占用」：1 次码用第二遍、被撤销、过期，都必须失败；
//   3) 注册走真实路由：关闭注册 + 邀请码 → 201 并登录，账本里单独一笔 invite；
//   4) 反滥用：同一来源 24h 计数、公开验码接口有尝试限流。

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-invites-'))
process.env.DATA_DIR = dir
delete process.env.VQ_REGISTRATION

const invites = await import('../server/invites.mjs')
const auth = await import('../server/auth.mjs')
const credits = await import('../server/credits.mjs')
const { config } = await import('../server/config.mjs')
const { createAuthRouter } = await import('../server/routes/auth.mjs')

const router = createAuthRouter()
const TERMS = config.site.termsVersion

function fakeReq(method, body, { ip = '203.0.113.9', ua = 'vq-test' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    method,
    headers: { host: '127.0.0.1:8899', 'user-agent': ua },
    socket: { remoteAddress: ip },
  })
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.statusCode = status
      Object.assign(this.headers, headers || {})
    },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk))
    },
    get body() {
      return Buffer.concat(this.chunks).toString('utf8')
    },
    get json() {
      return this.body ? JSON.parse(this.body) : null
    },
  }
}

async function call(method, pathname, body, { ip } = {}) {
  const res = fakeRes()
  // 路由拿到的永远是去掉查询串的 pathname（和 server/index.mjs 的分发一致）
  const pathOnly = pathname.split('?')[0]
  const allowed = await router.handle(fakeReq(method, body, ip ? { ip } : undefined), res, new URL('http://127.0.0.1:8899' + pathname), pathOnly)
  assert.equal(allowed, true, pathname + ' 必须被 auth 路由接住')
  return res
}

function signupBody(overrides = {}) {
  return {
    email: '[EMAIL:INVITE]',
    password: 'Passw0rd!demo',
    name: '受邀测试',
    acceptedTerms: true,
    termsVersion: TERMS,
    ...overrides,
  }
}

let emailSeq = 0
function nextEmail() {
  emailSeq += 1
  return 'invite' + emailSeq + '@example.com'
}

test('邀请码规范化：大小写、空格、缺前缀都指向同一枚码', () => {
  const invite = invites.createInvite({ createdBy: 'admin@example.com', maxUses: 1, days: 7, credits: 100 })
  assert.match(invite.code, /^VQ-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/, '码要去掉 0/O/1/I')
  assert.equal(invites.normalizeInviteCode(invite.code.toLowerCase()), invite.code)
  assert.equal(invites.normalizeInviteCode(' ' + invite.code + ' '), invite.code)
  assert.equal(invites.normalizeInviteCode(invite.code.slice(3)), invite.code, '缺 VQ- 前缀也要能认')
  assert.equal(invites.normalizeInviteCode('VQ-0000-0000'), '', '含 0 的码不是合法码')
  assert.equal(invites.normalizeInviteCode('VQ-ABC'), '')
  assert.equal(invites.normalizeInviteCode(''), '')
})

test('状态由次数/有效期/撤销推导，撤销永远优先', () => {
  const base = { max_uses: 1, used: 0, expires_at: null, revoked_at: null }
  assert.equal(invites.inviteStatus(base), 'active')
  assert.equal(invites.inviteStatus({ ...base, used: 1 }), 'used')
  assert.equal(invites.inviteStatus({ ...base, expires_at: '2000-01-01T00:00:00.000Z' }), 'expired')
  assert.equal(invites.inviteStatus({ ...base, used: 1, expires_at: '2000-01-01T00:00:00.000Z' }), 'used')
  assert.equal(invites.inviteStatus({ ...base, used: 1, revoked_at: '2026-01-01T00:00:00.000Z' }), 'revoked')
})

test('默认 1 次 / 7 天 / 100 积分；1 次码用第二遍必定失败', () => {
  const invite = invites.createInvite({ createdBy: 'admin@example.com' })
  assert.equal(invite.maxUses, 1)
  assert.equal(invite.credits, config.invites.defaultCredits)
  assert.equal(invite.remaining, 1)
  const days = Math.round((Date.parse(invite.expiresAt) - Date.now()) / 86400000)
  assert.ok(days >= 6 && days <= 7, '默认有效期 7 天，实际 ' + days)

  const first = invites.claimInvite(invite.id, { userId: 'usr_a', email: 'a@example.com', ip: '198.51.100.1' })
  assert.equal(first.ok, true)
  assert.equal(first.invite.status, 'used')
  const second = invites.claimInvite(invite.id, { userId: 'usr_b', email: 'b@example.com', ip: '198.51.100.1' })
  assert.equal(second.ok, false, '同一枚 1 次码不能被第二个人用掉')
  assert.equal(invites.inviteState(invite.code).reason, 'used')
})

test('多次码按次占用；撤销后立刻不可用', () => {
  const invite = invites.createInvite({ createdBy: 'admin@example.com', maxUses: 2, credits: 0 })
  assert.equal(invites.claimInvite(invite.id, { userId: 'usr_a', ip: '198.51.100.2' }).ok, true)
  assert.equal(invites.claimInvite(invite.id, { userId: 'usr_b', ip: '198.51.100.2' }).ok, true)
  assert.equal(invites.claimInvite(invite.id, { userId: 'usr_c', ip: '198.51.100.2' }).ok, false)
  assert.equal(invites.getInvite(invite.id).used, 2)

  const revoked = invites.createInvite({ createdBy: 'admin@example.com', maxUses: 1, credits: 0 })
  assert.equal(invites.revokeInvite(revoked.id).ok, true)
  assert.equal(invites.revokeInvite(revoked.id).ok, false, '重复撤销不该再改时间')
  assert.equal(invites.getInvite(revoked.id).status, 'revoked')
  assert.equal(invites.claimInvite(revoked.id, { userId: 'usr_d', ip: '198.51.100.2' }).ok, false)
})

test('过期的码不能再占用（按库里的 expires_at 判定）', () => {
  const invite = invites.createInvite({ createdBy: 'admin@example.com', maxUses: 1, credits: 0 })
  auth.openDb().prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', invite.id)
  assert.equal(invites.inviteState(invite.code).reason, 'expired')
  assert.equal(invites.claimInvite(invite.id, { userId: 'usr_e', ip: '198.51.100.3' }).ok, false)
  assert.equal(invites.getInvite(invite.id).used, 0, '过期失败不能扣次数')
})

test('同一来源计数：窗口内按 IP 哈希统计，换 IP 归零', () => {
  const invite = invites.createInvite({ createdBy: 'admin@example.com', maxUses: 5, credits: 0 })
  const before = invites.signupCountForIp('192.0.2.50')
  for (let index = 0; index < 3; index += 1) {
    assert.equal(invites.claimInvite(invite.id, { userId: 'usr_ip_' + index, email: 'ip' + index + '@example.com', ip: '192.0.2.50' }).ok, true)
  }
  assert.equal(invites.signupCountForIp('192.0.2.50'), before + 3)
  assert.equal(invites.signupCountForIp('192.0.2.51'), 0, '换一个来源不该共享计数')
  const hash = invites.hashIp('192.0.2.50')
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.ok(!hash.includes('192.0.2.50'), '库里不能留明文 IP')
})

test('公开验码接口：有效码 200 + 赠送积分；无效码 410 且不泄露创建人', async () => {
  const invite = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 120, note: '不该出现在这里' })
  const ok = await call('GET', '/api/auth/invite?code=' + encodeURIComponent(invite.code.toLowerCase()))
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json.valid, true)
  assert.equal(ok.json.credits, 120)
  assert.equal(ok.json.createdBy, undefined)
  assert.equal(ok.json.note, undefined)

  invites.revokeInvite(invite.id)
  const bad = await call('GET', '/api/auth/invite?code=' + encodeURIComponent(invite.code))
  assert.equal(bad.statusCode, 410)
  assert.equal(bad.json.valid, false)
  assert.equal(bad.json.reason, 'revoked')
  assert.equal(bad.json.createdBy, undefined)
})

test('注册关闭时：没有邀请码 403，格式错 400', async () => {
  assert.equal(config.auth.registrationEnabled, false, '这组测试要覆盖「注册关闭」的真实默认')
  const closed = await call('POST', '/api/auth/register', signupBody({ email: nextEmail() }))
  assert.equal(closed.statusCode, 403)
  assert.match(closed.json.error, /邀请码/)

  const malformed = await call('POST', '/api/auth/register', signupBody({ email: nextEmail(), inviteCode: 'VQ-ABC' }))
  assert.equal(malformed.statusCode, 400)
  assert.equal(malformed.json.field, 'code')
})

test('注册关闭时凭邀请码开号：201、登录态、积分与账本都对', async () => {
  const invite = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 100 })
  const email = nextEmail()
  const res = await call('POST', '/api/auth/register', signupBody({ email, inviteCode: invite.code.toLowerCase(), name: '受邀人' }))
  assert.equal(res.statusCode, 201, JSON.stringify(res.json))
  assert.ok(res.headers['set-cookie'], '注册成功必须直接下发会话 cookie')
  assert.match(String(res.headers['set-cookie']), /vq_session=/)
  assert.equal(res.json.user.email, email)

  const user = auth.findUserByEmail(email)
  assert.equal(Number(user.credits), config.credits.welcome + 100, '欢迎额度 + 邀请赠送各一笔')
  const ledger = credits.ledgerOf(user.id, 10)
  assert.ok(ledger.some((row) => row.kind === 'welcome'), '欢迎额度照常记')
  const inviteRow = ledger.find((row) => row.kind === 'invite')
  assert.equal(inviteRow?.delta, 100)
  assert.equal(invites.getInvite(invite.id).status, 'used')
  assert.equal(invites.listInvites({}).find((row) => row.id === invite.id).uses[0].email, email)

  // 同一枚码换个人再注册：410，不能再开号
  const reused = await call('POST', '/api/auth/register', signupBody({ email: nextEmail(), inviteCode: invite.code }), { ip: '203.0.113.77' })
  assert.equal(reused.statusCode, 410)
  assert.equal(reused.json.field, 'code')
  const saved = auth.findUserByEmail(email)
  assert.equal(Number(saved.credits), config.credits.welcome + 100, '失败的重放不能多送积分')
})

test('被撤销的码立刻拒绝注册，不建号', async () => {
  const invite = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 50 })
  invites.revokeInvite(invite.id)
  const email = nextEmail()
  const res = await call('POST', '/api/auth/register', signupBody({ email, inviteCode: invite.code }), { ip: '203.0.113.78' })
  assert.equal(res.statusCode, 410)
  assert.match(res.json.error, /撤销/)
  assert.equal(auth.findUserByEmail(email), null, '没开成的号不能留在库里')
  assert.equal(invites.getInvite(invite.id).used, 0)
})

test('全局注册开着时，邀请码可选；填了无效码要明确拒绝而不是静默丢掉', async () => {
  config.auth.registrationEnabled = true
  try {
    const plain = await call('POST', '/api/auth/register', signupBody({ email: nextEmail() }), { ip: '203.0.113.80' })
    assert.equal(plain.statusCode, 201, '注册开着时没码也能开号')
    const user = auth.findUserByEmail(plain.json.user.email)
    assert.equal(credits.ledgerOf(user.id, 10).some((row) => row.kind === 'invite'), false)

    const badCode = await call('POST', '/api/auth/register', signupBody({ email: nextEmail(), inviteCode: 'VQ-ZZZZ-ZZZZ' }), { ip: '203.0.113.81' })
    assert.equal(badCode.statusCode, 410)
    assert.equal(badCode.json.field, 'code')
  } finally {
    config.auth.registrationEnabled = false
  }
})

test('同一来源第 4 个邀请号被拒：反批量领额度', async () => {
  const previous = invites.signupCountForIp('203.0.113.99')
  const need = Math.max(0, config.invites.maxPerIp - previous)
  for (let index = 0; index < need; index += 1) {
    const invite = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 0 })
    const res = await call('POST', '/api/auth/register', signupBody({ email: nextEmail(), inviteCode: invite.code }), { ip: '203.0.113.99' })
    assert.equal(res.statusCode, 201, '第 ' + (index + 1) + ' 个应该放行：' + JSON.stringify(res.json))
  }
  const invite = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 0 })
  const blocked = await call('POST', '/api/auth/register', signupBody({ email: nextEmail(), inviteCode: invite.code }), { ip: '203.0.113.99' })
  assert.equal(blocked.statusCode, 429)
  assert.match(blocked.json.error, /上限/)
  assert.equal(invites.getInvite(invite.id).used, 0, '被限流时不能先把码占掉')
})

test('公开验码接口的尝试限流：同一来源 20 次后 429', async () => {
  const ip = '203.0.113.123'
  for (let index = 0; index < 20; index += 1) {
    invites.recordInviteAttempt('invite-lookup|' + ip)
  }
  assert.equal(invites.tooManyInviteAttempts('invite-lookup|' + ip), true)
  const res = await call('GET', '/api/auth/invite?code=VQ-ZZZZ-ZZZZ', null, { ip })
  assert.equal(res.statusCode, 429)
  invites.clearInviteAttempts('invite-lookup|' + ip)
  assert.equal(invites.tooManyInviteAttempts('invite-lookup|' + ip), false)
})

test('后台汇总：可用/用完/撤销/过期分开计数，列表带最近使用', () => {
  const before = invites.inviteSummary()
  const active = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 2, credits: 10 })
  const used = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 10 })
  invites.claimInvite(used.id, { userId: 'usr_x', email: 'used@example.com', ip: '192.0.2.77' })
  const revoked = invites.createInvite({ createdBy: 'owner@example.com', maxUses: 1, credits: 10 })
  invites.revokeInvite(revoked.id)
  const summary = invites.inviteSummary()
  assert.ok(summary.active >= before.active + 1)
  assert.ok(summary.used >= before.used + 1)
  assert.ok(summary.revoked >= before.revoked + 1)
  assert.equal(summary.total, invites.listInvites({ limit: 500 }).length)
  assert.equal(summary.limits.maxPerIp, config.invites.maxPerIp)
  const usedRow = summary.items.find((row) => row.id === used.id)
  assert.equal(usedRow.status, 'used')
  assert.equal(usedRow.uses[0].email, 'used@example.com')
  assert.equal(usedRow.uses[0].ip.length, 8, '列表只露来源哈希前 8 位')
  assert.equal(summary.items.find((row) => row.id === active.id).remaining, 2)
})

test.after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上 sqlite 句柄可能还没释放，临时目录留给系统清理
  }
})
