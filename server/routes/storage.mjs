// /api/storage：当前账号的素材占用。只回自己的数，不回别人的、也不回磁盘总量。
// 上线口径：帧图按模板归属算，公共示例（运营种子内容）不记在任何账号头上。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { storageOf } from '../storage.mjs'

export function createStorageRouter() {
  return {
    prefix: '/api/storage',
    async handle(req, res, url, pathname) {
      if (pathname !== '/api/storage') return false
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '只支持 GET' })
        return true
      }
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }
      sendJson(res, 200, { ok: true, ...(await storageOf(user.id)) })
      return true
    },
  }
}
