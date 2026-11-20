// /api/storage：当前账号的素材占用。只回自己的数，不回别人的、也不回磁盘总量。
// 上线口径：帧图按模板归属算，公共示例（运营种子内容）不记在任何账号头上。
//
// r280 加了两条：/api/storage/shotframes（按作品拆开看工作流画面占了多少）与
// /api/storage/shotframes/clear（清空一条作品的画面 / 清掉没人引用的）。
// 有定额就得有对账的地方：不然到上限那一刻，用户只收到一句「到上限了」，没有下手的入口。
import { sendJson, readBody } from './_shared.mjs'
import { currentUser } from '../auth.mjs'
import { storageOf } from '../storage.mjs'
import { shotFrameUsage } from '../shot-frame-store.mjs'
import { clearOrphanShotFrames, clearShotFramesForProject, shotFrameOverview } from '../shot-frame-cleanup.mjs'

function requireUser(req, res) {
  const user = currentUser(req)
  if (!user) {
    sendJson(res, 401, { error: '未登录', loginRequired: true })
    return null
  }
  return user
}

export function createStorageRouter() {
  return {
    prefix: '/api/storage',
    async handle(req, res, url, pathname) {
      // 工作流画面按作品拆开（r280）：设置页那一栏的「管理」读这一条
      if (pathname === '/api/storage/shotframes') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '只支持 GET' })
          return true
        }
        const user = requireUser(req, res)
        if (!user) return true
        const overview = await shotFrameOverview(user)
        sendJson(res, 200, { ok: true, ...overview })
        return true
      }
      // 清理（r280）：{ projectId } 清一条作品的画面，{ scope: 'unused' } 清没人引用的
      if (pathname === '/api/storage/shotframes/clear') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '只支持 POST' })
          return true
        }
        const user = requireUser(req, res)
        if (!user) return true
        const body = await readBody(req)
        const scope = String(body?.scope || '')
        const projectId = String(body?.projectId || '')
        if (scope === 'unused') {
          const cleared = await clearOrphanShotFrames(user)
          sendJson(res, 200, { ok: true, scope: 'unused', removed: cleared.removed, bytes: cleared.bytes })
          return true
        }
        if (!projectId) {
          sendJson(res, 400, {
            code: 'CLEAR_TARGET',
            error: '要清哪一块：传 projectId（清一条作品的画面），或者 scope: "unused"（清没人引用的）',
          })
          return true
        }
        const result = await clearShotFramesForProject({ user, projectId })
        if (result.status !== 200) {
          sendJson(res, result.status, { code: result.code, error: result.error })
          return true
        }
        sendJson(res, 200, {
          ok: true,
          scope: 'project',
          projectId: result.projectId,
          title: result.title,
          shotsCleared: result.shotsCleared,
          removed: result.removed,
          bytes: result.bytes,
        })
        return true
      }
      if (pathname !== '/api/storage') return false
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: '只支持 GET' })
        return true
      }
      const user = requireUser(req, res)
      if (!user) return true
      // 工作流画面（r279）单独一栏：它存在自己的库里，不占「上传素材」那 20 张，
      // 但有每账号上限 —— 页面上看得见用量，才不会在贴满时只收到一句「到上限了」。
      const [storage, shotFrames] = await Promise.all([storageOf(user.id), shotFrameUsage(user.id)])
      sendJson(res, 200, { ok: true, ...storage, shotFrames })
      return true
    },
  }
}
