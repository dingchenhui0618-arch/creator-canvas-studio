// /api/storage：当前账号的素材占用。只回自己的数，不回别人的、也不回磁盘总量。
// 上线口径：帧图按模板归属算，公共示例（运营种子内容）不记在任何账号头上。
import { sendJson } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { storageOf } from '../storage.mjs'
import { shotFrameUsage } from '../shot-frame-store.mjs'

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
      // 工作流画面（r279）单独一栏：它存在自己的库里，不占「上传素材」那 20 张，
      // 但有每账号上限 —— 页面上看得见用量，才不会在贴满时只收到一句「到上限了」。
      const [storage, shotFrames] = await Promise.all([storageOf(user.id), shotFrameUsage(user.id)])
      sendJson(res, 200, { ok: true, ...storage, shotFrames })
      return true
    },
  }
}
