// /api/preferences：账号级偏好的读写（目前只有首选模型）。
// 只影响默认值，不改变权限：模型清单与可用性仍由服务端 /api/models 决定。
import { sendJson, readBody } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { modelCatalog } from '../models.mjs'
import { preferenceOf, setPreference } from '../preferences.mjs'

export function createPreferencesRouter() {
  return {
    prefix: '/api/preferences',
    async handle(req, res, url, pathname) {
      if (!pathname.startsWith('/api/preferences')) return false
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }
      if (pathname === '/api/preferences' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...preferenceOf(user.id) })
        return true
      }
      if (pathname === '/api/preferences' && req.method === 'PUT') {
        const body = await readBody(req)
        const model = String(body.model ?? '').trim()
        const ids = modelCatalog().models.map((item) => item.id)
        if (model && !ids.includes(model)) {
          sendJson(res, 400, { error: '这个模型不在当前可用列表', code: 'MODEL_NOT_AVAILABLE', models: ids })
          return true
        }
        sendJson(res, 200, { ok: true, ...setPreference(user.id, { model }) })
        return true
      }
      sendJson(res, 404, { error: '未知的偏好接口：' + req.method + ' ' + pathname })
      return true
    },
  }
}
