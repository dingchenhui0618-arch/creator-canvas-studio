// /api/auth/*：真实登录、注册、登出、当前用户
import { sendJson, readBody } from './_shared.mjs'
import { config } from '../config.mjs'
import {
  findUserByEmail,
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
} from '../auth.mjs'

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
          minPasswordLength: MIN_PASSWORD,
          // 注册页照着这句显示规则，改策略只改服务端一处
          passwordPolicy: '至少 ' + MIN_PASSWORD + ' 位，且同时包含字母和数字',
        })
        return true
      }

      if (pathname === '/api/auth/me') {
        const row = currentUser(req)
        if (!row) return (sendJson(res, 401, { error: '未登录' }), true)
        sendJson(res, 200, { user: publicUser(row) })
        return true
      }

      if (req.method === 'POST' && !sameOrigin(req)) {
        fail(res, 403, '来源不被信任')
        return true
      }

      if (pathname === '/api/auth/register' && req.method === 'POST') {
        if (!config.auth.registrationEnabled) {
          fail(res, 403, '当前未开放注册，请联系管理员开通账号')
          return true
        }
        const body = await readBody(req)
        const email = normalizeEmail(body.email)
        const password = String(body.password || '')
        const name = String(body.name || '').trim().slice(0, MAX_NAME)

        const emailError = checkEmail(email)
        if (emailError) return (fail(res, 400, emailError, 'email'), true)
        const passwordError = checkPassword(password)
        if (passwordError) return (fail(res, 400, passwordError, 'password'), true)
        if (findUserByEmail(email)) return (fail(res, 409, '这个邮箱已经注册过了', 'email'), true)

        const user = createUser({ email, password, name })
        const { token } = createSession(user, {
          userAgent: req.headers['user-agent'] || '',
          ip: clientIp(req),
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
