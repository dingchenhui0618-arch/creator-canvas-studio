// /api/account/*：账号自助——导出自己的数据、注销账号。
// 两个动作都只作用于「当前登录的这个人」，不需要管理员。
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import { readBody, sendJson } from './_shared.mjs'
import { clearCookie, currentUser, isAdmin, verifyPassword } from '../auth.mjs'
import { deleteOwnAccount, exportAccount, exportFileName } from '../account.mjs'
import { AVATAR_LIMITS, avatarFile, avatarView, removeAvatar, saveAvatar } from '../avatar.mjs'
import { refusalResponse } from '../public-error.mjs'
import { logEvent } from '../log.mjs'

const AVATAR_PATH = /^\/api\/account\/avatar\/([A-Za-z0-9_-]{3,64})$/
const AVATAR_MAX = AVATAR_LIMITS.bytes

export function createAccountRouter() {
  return {
    prefix: '/api/account',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/account')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '请先登录', loginRequired: true })
        return true
      }

      // 头像上传：multipart 单文件字段 avatar。解析交给标准 FormData，
      // 边界、文件名与编码都不自己手拆；文件类型仍以服务端读到的文件头为准。
      if (pathname === '/api/account/avatar' && req.method === 'POST') {
        try {
          const contentType = String(req.headers['content-type'] || '')
          if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
            sendJson(res, 400, { error: '头像要用 multipart/form-data 上传' })
            return true
          }
          const declaredLength = Number(req.headers['content-length'] || 0)
          // multipart 还有边界与头部开销；留 64 KB 余量，真正的 2 MB 上限在 saveAvatar 里再判一次
          if (Number.isFinite(declaredLength) && declaredLength > AVATAR_MAX + 64 * 1024) {
            sendJson(res, 413, { error: '头像不能超过 2 MB', code: 'AVATAR_TOO_LARGE' })
            return true
          }
          const form = await new Response(Readable.toWeb(req), {
            headers: { 'content-type': contentType },
          }).formData()
          const file = form.get('avatar')
          if (!file || typeof file === 'string') {
            sendJson(res, 400, { error: '请选择一张头像图片', code: 'AVATAR_FILE_REQUIRED' })
            return true
          }
          const buffer = Buffer.from(await file.arrayBuffer())
          const avatar = await saveAvatar(user.id, buffer, file.type)
          logEvent('account-avatar-save', { userId: user.id, bytes: buffer.length })
          sendJson(res, 200, { ok: true, avatar })
          return true
        } catch (error) {
          const mapped = refusalResponse(error)
          if (mapped) {
            sendJson(res, mapped.status, mapped.body)
            return true
          }
          throw error
        }
      }

      // 删除自己的头像：文件、版本号一起清
      if (pathname === '/api/account/avatar' && req.method === 'DELETE') {
        await removeAvatar(user.id)
        logEvent('account-avatar-remove', { userId: user.id })
        sendJson(res, 200, { ok: true, avatar: { has: false, url: '', version: '' } })
        return true
      }

      // 读头像：本人或管理员；别人一律 404，不泄露「这个人有没有头像」
      const avatarMatch = pathname.match(AVATAR_PATH)
      if (avatarMatch && req.method === 'GET') {
        const targetId = avatarMatch[1]
        if (targetId !== user.id && !isAdmin(user)) {
          sendJson(res, 404, { error: '头像不存在' })
          return true
        }
        const found = await avatarFile(targetId)
        if (!found) {
          sendJson(res, 404, { error: '头像不存在' })
          return true
        }
        const buffer = await fsp.readFile(found.file)
        res.writeHead(200, {
          'Content-Type': found.mime,
          'Content-Length': buffer.length,
          // 版本号已经在 URL 里；允许浏览器私有缓存一年，换图时换 URL
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(buffer)
        return true
      }

      // 导出：直接给一个 JSON 附件，浏览器落盘；内容只含这个账号自己的数据
      if (pathname === '/api/account/export' && req.method === 'GET') {
        const data = await exportAccount(user)
        const body = JSON.stringify(data, null, 2)
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + exportFileName(user) + '"',
          'Cache-Control': 'no-store',
        })
        res.end(body)
        logEvent('account-export', {
          by: user.email,
          templates: data.templates.length,
          flows: data.flows.length,
          agents: data.agents.length,
          reviews: data.reviews.length,
          bytes: Buffer.byteLength(body),
        })
        return true
      }

      // 注销：口令 + 手输「注销」两个字；可选连内容一起删
      if (pathname === '/api/account/delete' && req.method === 'POST') {
        const body = await readBody(req)
        if (String(body.confirm || '').trim() !== '注销') {
          return (sendJson(res, 400, { error: '请输入「注销」两个字确认', field: 'confirm' }), true)
        }
        if (!verifyPassword(String(body.password || ''), user.password_hash)) {
          return (sendJson(res, 400, { error: '口令不正确', field: 'password' }), true)
        }
        const result = await deleteOwnAccount(user, { deleteContent: body.deleteContent !== false })
        if (!result.ok) {
          if (result.code === 'LAST_ADMIN') {
            return (sendJson(res, 400, {
              error: '这是最后一个管理员账号：先把另一个账号设为管理员，再注销自己',
              code: 'LAST_ADMIN',
            }), true)
          }
          return (sendJson(res, 404, { error: '账号不存在' }), true)
        }
        res.setHeader('Set-Cookie', clearCookie())
        // 账号删了，头像文件也不该留在盘上
        await removeAvatar(user.id)
        logEvent('account-delete', { by: user.email, deleteContent: result.deleteContent, ...result.removed })
        sendJson(res, 200, { ok: true, removed: result.removed, deleteContent: result.deleteContent })
        return true
      }

      sendJson(res, 404, { error: '未知的账号接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
