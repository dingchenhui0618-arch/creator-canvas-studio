// /api/auth/*：真实登录、注册、登出、当前用户
import { sendJson, readBody } from './_shared.mjs'
import { config } from '../config.mjs'
import {
  findUserByEmail,
  findUserById,
  createUser,
  createSession,
  currentUser,
  destroySession,
  parseCookies,
  publicUser,
  sessionCookie,
  clearCookie,
  tooManyAttempts,
  recordFailure,
  clearFailures,
  clientIp,
  verifyPassword,
  changePassword,
  setPassword,
  destroyOtherSessions,
  listLoginSessions,
  revokeLoginSession,
  signTotpChallenge,
  readTotpChallenge,
  totpInfo,
  startTotpSetup,
  pendingTotp,
  activateTotp,
  clearTotp,
  totpMaterial,
  saveTotpCounter,
  saveTotpBackup,
  deleteUser,
} from '../auth.mjs'
import { generateBackupCodes, generateSecret, matchBackupCode, otpauthUrl, verifyTotp } from '../totp.mjs'
import { logEvent } from '../log.mjs'
import { grant } from '../credits.mjs'
import { mailConfigured, smtpForSending } from '../mail-config.mjs'
import { sendMail } from '../mailer.mjs'
import {
  buildResetMail,
  consumeResetToken,
  createResetToken,
  peekResetToken,
  recordResetRequest,
  resetRequestBlocked,
} from '../password-reset.mjs'
import {
  claimInvite,
  clearInviteAttempts,
  findInviteByCode,
  inviteState,
  normalizeInviteCode,
  recordInviteAttempt,
  signupCountForIp,
  tooManyInviteAttempts,
} from '../invites.mjs'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200
const MAX_NAME = 40

function setCookie(res, value) {
  // 同一响应可能要同时写多 cookie，这里只有一条会话 cookie
  res.setHeader('Set-Cookie', value)
}

function fail(res, status, error, field) {
  sendJson(res, status, field ? { error, field } : { error })
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

function checkEmail(email) {
  if (!email) return '请输入邮箱'
  if (email.length > 190) return '邮箱过长'
  if (!EMAIL_PATTERN.test(email)) return '邮箱格式不正确'
  return ''
}

function checkPassword(password) {
  if (!password) return '请输入密码'
  if (password.length < MIN_PASSWORD) return '密码至少 ' + MIN_PASSWORD + ' 位'
  if (password.length > MAX_PASSWORD) return '密码过长'
  // 只有长度没有强度，等于把「12345678」放行。要求字母 + 数字两组。
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return '密码要同时包含字母和数字'
  return ''
}

// 重置链接失效原因直接翻成用户能懂的话；不区分「从没存在」和「被清掉」，
// 都指向「重新申请一封」，不让链接状态变成账号探针。
const RESET_REASON = {
  missing: '链接不完整，请从邮件里重新点一次',
  unknown: '这枚链接不认识，可能已经用过：请重新申请一封',
  used: '这枚链接已经改过口令了，请用新口令登录',
  expired: '链接已过期，请重新申请一封',
}

// 找回密码的邮件在后台发：SMTP 慢或挂掉时，用户不该盯着转圈等一个 20 秒超时。
// 结果只进日志；接口对所有情况回同一句话，否则响应差异会变成「这个邮箱有没有账号」的探针。
async function deliverResetMail({ to, link, ttlMinutes, email }) {
  const channel = await smtpForSending()
  if (!channel) {
    logEvent('mail-skipped', { to, kind: 'password-reset', reason: '邮件通道未配置' })
    return { sent: false, reason: 'no-channel' }
  }
  const mail = buildResetMail({ link, ttlMinutes, email, supportEmail: config.site.supportEmail })
  try {
    const result = await sendMail({ ...mail, to, from: channel.from }, channel.smtp, { timeoutMs: 20000 })
    logEvent('mail-sent', { to, kind: 'password-reset', ms: result.ms })
    return { sent: true, ms: result.ms }
  } catch (error) {
    logEvent('mail-failed', { to, kind: 'password-reset', error: error.message })
    return { sent: false, reason: error.message }
  }
}

// 同源校验：带 Origin 且与 Host 不一致的写请求直接拒绝（cookie 会话的最低成本 CSRF 防护）
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === req.headers.host
  } catch {
    return false
  }
}

export function createAuthRouter() {
  return {
    prefix: '/api/auth',
    async handle(req, res, url, pathname) {
      if (pathname === '/api/auth/config') {
        // 只下发界面需要的开关。任何口令都不出现在未鉴权的响应里——
        // 之前的演示账号把邮箱和口令直接发给每个访客，等于公开后门。
        sendJson(res, 200, {
          registrationEnabled: config.auth.registrationEnabled,
          // 邀请制始终可用：注册全局关闭时，持有效邀请码的人仍能自助开号。
          // 登录页据此在「注册」入口上显示「有邀请码」这一条路径。
          inviteRegistration: true,
          minPasswordLength: MIN_PASSWORD,
          // 注册页照着这句显示规则，改策略只改服务端一处
          passwordPolicy: '至少 ' + MIN_PASSWORD + ' 位，且同时包含字母和数字',
          // 配了邮件通道才能自助找回口令；没配时登录页如实说「找管理员」，不摆一个点了没用的入口。
          passwordReset: await mailConfigured(),
        })
        return true
      }

      if (pathname === '/api/auth/me') {
        const row = currentUser(req)
        if (!row) return (sendJson(res, 401, { error: '未登录' }), true)
        sendJson(res, 200, { user: publicUser(row) })
        return true
      }

      // 注册页先验码：只回「能不能用、还剩几次、送多少积分」，不回创建人、备注与使用者。
      // 限流按来源做，避免有人拿这个接口扫邀请码。
      if (pathname === '/api/auth/invite' && req.method === 'GET') {
        const ip = clientIp(req)
        if (tooManyInviteAttempts('invite-lookup|' + ip)) {
          fail(res, 429, '查询次数过多，请 10 分钟后再试')
          return true
        }
        const state = inviteState(url.searchParams.get('code'))
        if (!state.valid) recordInviteAttempt('invite-lookup|' + ip)
        else clearInviteAttempts('invite-lookup|' + ip)
        sendJson(res, state.valid ? 200 : 410, state)
        return true
      }

      if (req.method === 'POST' && !sameOrigin(req)) {
        fail(res, 403, '来源不被信任')
        return true
      }

      if (pathname === '/api/auth/register' && req.method === 'POST') {
        const body = await readBody(req)
        const ip = clientIp(req)
        const rawInvite = String(body.inviteCode || '').trim()
        const inviteCode = normalizeInviteCode(rawInvite)
        const attemptKey = 'register-invite|' + ip

        // 两道门：全局注册开着，或者手里有一枚有效邀请码。注册关闭时不再把门焊死。
        if (!config.auth.registrationEnabled && !rawInvite) {
          fail(res, 403, '当前未开放自助注册；有邀请码请在「邀请码」一栏填入，或联系管理员开通账号')
          return true
        }
        if (rawInvite && !inviteCode) {
          fail(res, 400, '邀请码格式不正确，请核对后填入完整邀请码', 'code')
          return true
        }

        let invite = null
        if (inviteCode) {
          if (tooManyInviteAttempts(attemptKey)) {
            fail(res, 429, '邀请码尝试次数过多，请 10 分钟后再试')
            return true
          }
          invite = findInviteByCode(inviteCode)
          if (!invite || invite.status !== 'active') {
            recordInviteAttempt(attemptKey)
            const message =
              !invite
                ? '邀请码无效，请核对完整邀请码'
                : invite.status === 'revoked'
                  ? '这枚邀请码已被撤销，请联系管理员换一枚'
                  : invite.status === 'used'
                    ? '这枚邀请码已经用完了，请联系管理员再要一枚'
                    : '这枚邀请码已过期，请联系管理员换一枚'
            fail(res, 410, message, 'code')
            return true
          }
          clearInviteAttempts(attemptKey)
          // 反滥用：同一来源 24 小时内最多开 N 个号（默认 3），不靠肉眼盯注册量。
          if (signupCountForIp(ip) >= config.invites.maxPerIp) {
            fail(res, 429, '同一网络今天通过邀请码开通的账号已达上限，请明天再试或联系管理员')
            return true
          }
        }

        const email = normalizeEmail(body.email)
        const password = String(body.password || '')
        const name = String(body.name || '').trim().slice(0, MAX_NAME)

        const emailError = checkEmail(email)
        if (emailError) return (fail(res, 400, emailError, 'email'), true)
        const passwordError = checkPassword(password)
        if (passwordError) return (fail(res, 400, passwordError, 'password'), true)
        if (findUserByEmail(email)) return (fail(res, 409, '这个邮箱已经注册过了', 'email'), true)

        // 条款留痕：必须真的勾了，且同意的就是当前这一版；版本对不上说明页面是旧的，让用户刷新重看。
        const acceptedTerms = body.acceptedTerms === true
        const termsVersion = String(body.termsVersion || '').trim()
        if (!acceptedTerms) return (fail(res, 400, '请先阅读并勾选同意服务条款与隐私说明', 'terms'), true)
        if (termsVersion !== config.site.termsVersion) {
          return (fail(res, 400, '服务条款已更新，请刷新页面后重新阅读并确认', 'terms'), true)
        }

        const user = createUser({ email, password, name, terms: { version: termsVersion, at: new Date().toISOString() } })
        if (invite) {
          // 占用放在建号之后才能带上 userId；占用失败（并发抢最后一格）就把刚建的号收回，
          // 免得出现「码没用上、号已经建好」的中间态。
          const claimed = claimInvite(invite.id, { userId: user.id, email, ip })
          if (!claimed.ok) {
            deleteUser(user.id)
            fail(res, 410, '这枚邀请码刚刚被用掉了，请换一枚或联系管理员', 'code')
            return true
          }
          if (invite.credits > 0) {
            grant(user.id, invite.credits, {
              kind: 'invite',
              note: '邀请码赠送（' + invite.code.slice(0, 7) + '••••）',
              operator: 'invite',
            })
          }
          logEvent('register-invite', { email, invite: invite.code.slice(0, 7) + '••••', credits: invite.credits })
        }

        const { token } = createSession(user, {
          userAgent: req.headers['user-agent'] || '',
          ip,
          remember: false,
        })
        setCookie(res, sessionCookie(token, config.auth.sessionDays * 24 * 3600))
        sendJson(res, 201, { user: publicUser(user) })
        return true
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req)
        const email = normalizeEmail(body.email)
        const password = String(body.password || '')
        const remember = Boolean(body.remember)
        const key = clientIp(req) + '|' + email

        if (tooManyAttempts(key)) {
          fail(res, 429, '尝试次数过多，请 10 分钟后再试')
          return true
        }

        const emailError = checkEmail(email)
        if (emailError) return (fail(res, 400, emailError, 'email'), true)
        if (!password) return (fail(res, 400, '请输入密码', 'password'), true)

        const row = findUserByEmail(email)
        // 用户不存在也走一次 scrypt，避免用响应时间探测邮箱是否注册
        const ok = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, 'scrypt$16384$8$1$00$00')
        if (!row || !ok || !row.is_active) {
          recordFailure(key)
          fail(res, 401, '邮箱或密码不正确', 'form')
          return true
        }

        clearFailures(key)

        // 开了两步验证：这一步只发一个 5 分钟有效的 challenge，不建会话。
        // 口令正确但验证码不对，同样拿不到任何 cookie。
        if (row.totp_enabled_at) {
          logEvent('login-2fa-challenge', { email: row.email })
          sendJson(res, 200, {
            twoFactorRequired: true,
            challenge: signTotpChallenge(row.id, remember),
            expiresInSec: 300,
          })
          return true
        }

        const days = remember ? config.auth.rememberDays : config.auth.sessionDays
        const { token } = createSession(row, {
          userAgent: req.headers['user-agent'] || '',
          ip: clientIp(req),
          remember,
        })
        setCookie(res, sessionCookie(token, days * 24 * 3600))
        sendJson(res, 200, { user: publicUser(row) })
        return true
      }


      // 登录第二步：6 位 TOTP 或一次性备用码，验过才建会话
      if (pathname === '/api/auth/login/totp' && req.method === 'POST') {
        const body = await readBody(req)
        const challenge = readTotpChallenge(body.challenge)
        if (!challenge) return (fail(res, 401, '验证步骤已过期，请重新登录', 'form'), true)
        const row = findUserById(challenge.userId)
        if (!row || !row.is_active) return (fail(res, 401, '账号不可用', 'form'), true)
        if (!row.totp_enabled_at) return (fail(res, 400, '这个账号没有开启两步验证，请重新登录', 'form'), true)

        const limitKey = clientIp(req) + '|totp|' + row.id
        if (tooManyAttempts(limitKey)) return (fail(res, 429, '验证码错误次数过多，请 10 分钟后再试'), true)

        const material = totpMaterial(row.id)
        if (!material?.secret) return (fail(res, 400, '两步验证状态异常，请重新登录后再试', 'form'), true)

        const verified = verifyTotp(material.secret, String(body.code || ''), { lastCounter: material.lastCounter })
        let passed = verified.ok
        let backupUsed = false
        if (!passed) {
          const backup = matchBackupCode(material.backup, String(body.code || ''))
          if (backup.ok) {
            passed = true
            backupUsed = true
            saveTotpBackup(row.id, backup.remaining)
          }
        }
        if (!passed) {
          recordFailure(limitKey)
          return (fail(res, 401, '验证码不正确，请用认证器里的 6 位数字或一枚备用码', 'code'), true)
        }

        clearFailures(limitKey)
        if (verified.ok) saveTotpCounter(row.id, verified.counter)
        logEvent('login-2fa', { email: row.email, backup: backupUsed })
        const { token } = createSession(row, {
          userAgent: req.headers['user-agent'] || '',
          ip: clientIp(req),
          remember: challenge.remember,
        })
        const days = challenge.remember ? config.auth.rememberDays : config.auth.sessionDays
        setCookie(res, sessionCookie(token, days * 24 * 3600))
        sendJson(res, 200, { user: publicUser(row), backupCodeUsed: backupUsed })
        return true
      }

      // 两步验证状态：只回布尔、时间与剩余备用码数量，永不回 secret
      if (pathname === '/api/auth/totp' && req.method === 'GET') {
        const row = currentUser(req)
        if (!row) return (fail(res, 401, '请先登录'), true)
        sendJson(res, 200, totpInfo(row.id))
        return true
      }

      // 第一步：生成 secret 与备用码，先存成 pending（此时 2FA 还没生效）
      if (pathname === '/api/auth/totp/setup' && req.method === 'POST') {
        const row = currentUser(req)
        if (!row) return (fail(res, 401, '请先登录'), true)
        if (row.totp_enabled_at) return (fail(res, 400, '两步验证已经开启，先关闭再重新设置'), true)
        const secret = generateSecret()
        const backupCodes = generateBackupCodes()
        startTotpSetup(row.id, { secret, backupCodes })
        logEvent('totp-setup', { email: row.email })
        sendJson(res, 200, {
          secret,
          otpauth: otpauthUrl({ issuer: 'VisionQA', account: row.email, secret }),
          backupCodes,
        })
        return true
      }

      // 第二步：用认证器里的 6 位确认，确认后才真正生效
      if (pathname === '/api/auth/totp/enable' && req.method === 'POST') {
        const row = currentUser(req)
        if (!row) return (fail(res, 401, '请先登录'), true)
        const body = await readBody(req)
        const pending = pendingTotp(row.id)
        if (!pending?.secret) return (fail(res, 400, '没有待确认的两步验证设置，请重新开始', 'form'), true)
        const verified = verifyTotp(pending.secret, String(body.code || ''), { lastCounter: 0 })
        if (!verified.ok) return (fail(res, 400, '验证码不正确：确认认证器里是「VisionQA」这一条，再输入当前 6 位数字', 'code'), true)
        activateTotp(row.id)
        // 确认用的这一步不算「登录已用过的步长」：否则当场验证完，30 秒内第一次登录会
        // 因为同一个步长被当成重放而失败。真正的重放保护从第一次登录开始记。
        saveTotpCounter(row.id, 0)
        const info = totpInfo(row.id)
        logEvent('totp-enable', { email: row.email })
        sendJson(res, 200, { ok: true, ...info })
        return true
      }

      // 关闭：口令 + 当前验证码（或备用码）双要素，防止会话被劫持后直接关掉
      if (pathname === '/api/auth/totp/disable' && req.method === 'POST') {
        const row = currentUser(req)
        if (!row) return (fail(res, 401, '请先登录'), true)
        if (!row.totp_enabled_at) return (fail(res, 400, '这个账号没有开启两步验证'), true)
        const body = await readBody(req)
        if (!verifyPassword(String(body.password || ''), row.password_hash)) {
          return (fail(res, 400, '口令不正确', 'password'), true)
        }
        const material = totpMaterial(row.id)
        // 关闭不再套「同一步长不能复用」：这一步已经有会话 + 口令两道，且验证码用完即失效；
        // 真按重放规则卡，用户刚登录完 30 秒内想关掉会被自己的码挡回来。
        const verified = material ? verifyTotp(material.secret, String(body.code || ''), { lastCounter: 0 }) : { ok: false }
        let passed = Boolean(verified.ok)
        if (!passed && material) {
          const backup = matchBackupCode(material.backup, String(body.code || ''))
          if (backup.ok) {
            passed = true
            saveTotpBackup(row.id, backup.remaining)
          }
        }
        if (!passed) return (fail(res, 400, '验证码不正确，请用认证器里的 6 位数字或一枚备用码', 'code'), true)
        clearTotp(row.id)
        logEvent('totp-disable', { email: row.email })
        sendJson(res, 200, { ok: true, enabled: false })
        return true
      }

      if (pathname === '/api/auth/password' && req.method === 'POST') {
        const row = currentUser(req)
        if (!row) return (fail(res, 401, '请先登录'), true)
        const body = await readBody(req)
        const current = String(body.currentPassword || '')
        const next = String(body.newPassword || '')
        if (!current) return (fail(res, 400, '请输入当前密码', 'password'), true)
        const passwordError = checkPassword(next)
        if (passwordError) return (fail(res, 400, passwordError, 'password'), true)
        if (current === next) return (fail(res, 400, '新密码不能和当前密码相同', 'password'), true)
        const result = changePassword(row.id, current, next)
        if (!result.ok) {
          if (result.code === 'NOT_FOUND') return (fail(res, 404, '账号不存在'), true)
          return (fail(res, 400, '当前密码不正确', 'password'), true)
        }
        // 其它设备上的会话立即失效；当前这条保留，避免改完口令就被踢回登录页
        const token = parseCookies(req)[config.auth.cookieName]
        const signedOut = destroyOtherSessions(row.id, token)
        logEvent('password-change', { by: row.email, signedOut })
        sendJson(res, 200, { ok: true, signedOut })
        return true
      }

      // 找回密码第一步：发一封带一次性链接的邮件。
      // 无账号、没配通道、发信失败都回同一句话——响应差异不能变成「这个邮箱存不存在」的探针。
      if (pathname === '/api/auth/password/forgot' && req.method === 'POST') {
        const body = await readBody(req)
        const email = normalizeEmail(body.email)
        const emailError = checkEmail(email)
        if (emailError) return (fail(res, 400, emailError, 'email'), true)
        const ip = clientIp(req)
        const gate = resetRequestBlocked(email, ip)
        if (gate.blocked) {
          res.setHeader('Retry-After', String(gate.retryAfterSec))
          return (fail(res, 429, '申请太频繁了，请 ' + Math.ceil(gate.retryAfterSec / 60) + ' 分钟后再试', 'form'), true)
        }
        recordResetRequest(email, ip)
        const row = findUserByEmail(email)
        if (row && row.is_active) {
          const { token, ttlMinutes } = createResetToken(row.id, { ip })
          const link = config.site.publicBaseUrl + '/#/reset?token=' + encodeURIComponent(token)
          // 不 await：发信是后台的事，接口立刻回话
          void deliverResetMail({ to: row.email, link, ttlMinutes, email: row.email })
          logEvent('password-forgot', { email: row.email })
        }
        sendJson(res, 200, {
          ok: true,
          message: '如果这个邮箱有账号，重置邮件已经发出；没收到就看一眼垃圾邮件，或者让管理员重置。',
        })
        return true
      }

      // 找回密码第二步（探测）：重置页打开时先问「这枚链接还能用吗」，不消费。
      if (pathname === '/api/auth/password/reset' && req.method === 'GET') {
        const token = String(url.searchParams.get('token') || '')
        const state = peekResetToken(token)
        sendJson(res, 200, {
          valid: state.valid,
          expiresAt: state.expiresAt || null,
          reason: state.valid ? '' : state.reason || 'unknown',
          message: state.valid ? '' : RESET_REASON[state.reason] || RESET_REASON.unknown,
        })
        return true
      }

      // 找回密码第三步：用 token 换新口令。改完注销这个账号的全部会话（包括可能被劫持的那条）。
      if (pathname === '/api/auth/password/reset' && req.method === 'POST') {
        const body = await readBody(req)
        const token = String(body.token || '').trim()
        if (!token) return (fail(res, 400, '链接里没有重置凭据，请从邮件里重新点一次', 'form'), true)
        const next = String(body.password || '')
        const passwordError = checkPassword(next)
        if (passwordError) return (fail(res, 400, passwordError, 'password'), true)
        const consumed = consumeResetToken(token)
        if (!consumed.ok) return (fail(res, 400, RESET_REASON[consumed.reason] || RESET_REASON.unknown, 'form'), true)
        const row = findUserById(consumed.userId)
        if (!row || !row.is_active) return (fail(res, 400, '账号已停用，请联系管理员', 'form'), true)
        setPassword(row.id, next)
        const signedOut = destroyOtherSessions(row.id)
        logEvent('password-reset', { email: row.email, by: 'email-link', signedOut })
        sendJson(res, 200, { ok: true, signedOut })
        return true
      }

      // 登录设备：只回本账号的会话，id 是派生值；当前这一条单独标出来。
      if (pathname === '/api/auth/sessions' && req.method === 'GET') {
        const row = currentUser(req)
        if (!row) return (sendJson(res, 401, { error: '未登录' }), true)
        const token = parseCookies(req)[config.auth.cookieName]
        const { sessions, total } = listLoginSessions(row.id, token)
        sendJson(res, 200, { sessions, total, current: sessions.find((item) => item.current)?.id || '' })
        return true
      }

      // 一键退出其它所有设备：改口令之外，用户自己也该有这条路。
      if (pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
        const row = currentUser(req)
        if (!row) return (sendJson(res, 401, { error: '未登录' }), true)
        const token = parseCookies(req)[config.auth.cookieName]
        const signedOut = destroyOtherSessions(row.id, token)
        logEvent('session-revoke-others', { email: row.email, signedOut })
        sendJson(res, 200, { ok: true, signedOut })
        return true
      }

      // 退出指定设备：当前设备不允许从这里踢，避免按钮点错把自己踢下线。
      const sessionMatch = /^\/api\/auth\/sessions\/([0-9a-f]{8,32})$/.exec(pathname)
      if (sessionMatch && req.method === 'DELETE') {
        const row = currentUser(req)
        if (!row) return (sendJson(res, 401, { error: '未登录' }), true)
        const token = parseCookies(req)[config.auth.cookieName]
        const result = revokeLoginSession(row.id, sessionMatch[1], token)
        if (!result.ok && result.code === 'NOT_FOUND') {
          sendJson(res, 404, { error: '这台设备已经不在登录列表里' })
          return true
        }
        if (!result.ok && result.code === 'CURRENT') {
          sendJson(res, 400, { error: '当前设备请用「退出登录」' })
          return true
        }
        logEvent('session-revoke', { email: row.email })
        sendJson(res, 200, { ok: true })
        return true
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const token = parseCookies(req)[config.auth.cookieName]
        destroySession(token)
        setCookie(res, clearCookie())
        res.writeHead(204, { 'Cache-Control': 'no-store' })
        res.end()
        return true
      }

      sendJson(res, 404, { error: 'auth route not found' })
      return true
    },
  }
}
