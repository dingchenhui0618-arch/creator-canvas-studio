// /api/onboarding 与 /api/assets：注册后的身份引导与自有资产（r311）。
//
// 一条原则：这里所有读写都先验登录，再按归属取数据；别人的资产一律 404（不解释「存在但你没权限」）。
// 生成是异步的：POST /generate 立刻回 generating，界面轮询 GET /api/assets/:id，关页不丢任务。
import { sendJson, readBody } from './_shared.mjs'
import { sendAuthImage } from '../image-response.mjs'
import { currentUser } from '../auth.mjs'
import { refusalResponse } from '../public-error.mjs'
import { logEvent } from '../log.mjs'
import { markComplete, onboardingView, saveIdentity } from '../onboarding.mjs'
import { listAssetRefOptions } from '../asset-ref.mjs'
import {
  ASSET_LIMITS,
  assetImageCredits,
  countAssets,
  createAsset,
  deleteAsset,
  getAsset,
  listAssets,
  resolveRefFile,
  startAssetGeneration,
  updateAsset,
} from '../assets.mjs'

const ASSET_PATH = /^\/api\/assets\/([A-Za-z0-9_]{6,80})(?:\/(generate|files\/([a-z]{3,10})))?$/

function sendRefusal(res, error) {
  const mapped = refusalResponse(error)
  if (mapped) {
    sendJson(res, mapped.status, mapped.body)
    return true
  }
  return false
}

function clampCount(value) {
  return Math.max(0, Math.trunc(Number(value) || 0))
}

export function createAssetsRouter() {
  return {
    prefix: '/api/assets',
    extraPrefixes: ['/api/onboarding'],
    async handle(req, res, url, pathname) {
      const user = currentUser(req)
      if (!user) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }

      // ── 身份引导 ────────────────────────────────────────────────────
      if (pathname === '/api/onboarding' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...onboardingView(user.id, await countAssets(user.id)) })
        return true
      }

      if (pathname === '/api/onboarding' && req.method === 'PUT') {
        try {
          const body = await readBody(req)
          const identity = String(body.identity || '')
          if (!identity) {
            sendJson(res, 400, { error: '先选一个身份：自媒体创作者 / 电商产品生产 / 品牌代运营', code: 'ONBOARDING_IDENTITY' })
            return true
          }
          const saved = saveIdentity(user.id, {
            identity,
            category: body.category,
            direction: body.direction,
          })
          if (!saved.identity) {
            sendJson(res, 400, { error: '这个身份不在可选范围里', code: 'ONBOARDING_IDENTITY' })
            return true
          }
          logEvent('onboarding.identity', { by: user.email, identity: saved.identity, category: saved.category })
          sendJson(res, 200, { ok: true, ...onboardingView(user.id, await countAssets(user.id)) })
          return true
        } catch (error) {
          if (sendRefusal(res, error)) return true
          throw error
        }
      }

      if (pathname === '/api/onboarding/complete' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}))
        const view = onboardingView(user.id, await countAssets(user.id))
        if (!view.identity) {
          sendJson(res, 400, { error: '先选一个身份再继续', code: 'ONBOARDING_IDENTITY' })
          return true
        }
        markComplete(user.id, { skipAssets: Boolean(body.skipAssets) })
        logEvent('onboarding.complete', { by: user.email, skipAssets: Boolean(body.skipAssets) })
        sendJson(res, 200, { ok: true, ...onboardingView(user.id, await countAssets(user.id)) })
        return true
      }

      // ── 资产 ────────────────────────────────────────────────────────
      if (pathname === '/api/assets' && req.method === 'GET') {
        const kind = String(url.searchParams.get('kind') || 'all')
        const items = await listAssets(user.id, { kind })
        sendJson(res, 200, {
          ok: true,
          items,
          limits: {
            product: ASSET_LIMITS.product,
            avatar: ASSET_LIMITS.avatar,
            sourcesProduct: ASSET_LIMITS.sourcesProduct,
            sourcesAvatar: ASSET_LIMITS.sourcesAvatar,
            slots: ASSET_LIMITS.slots,
            freeSlots: ASSET_LIMITS.slots,
            paidCreditsPerImage: assetImageCredits(),
          },
        })
        return true
      }

      if (pathname === '/api/assets' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const asset = await createAsset({
            ownerId: user.id,
            kind: body.kind,
            name: body.name,
            category: body.category,
            sourceAssetIds: body.sourceAssetIds,
          })
          logEvent('asset.create', { by: user.email, kind: asset.kind, id: asset.id, sources: asset.sources.length })
          sendJson(res, 200, { ok: true, asset })
          return true
        } catch (error) {
          if (sendRefusal(res, error)) return true
          throw error
        }
      }

      // 资产引用清单（r312）：模板出图、工作流节点、出视频的选择器都照这张表画。
      // 只列「已经有图」的槽位，没生成的槽位不出现——选了才知道没图是让用户白点一次。
      if (pathname === '/api/assets/refs' && req.method === 'GET') {
        const kind = String(url.searchParams.get('kind') || '')
        const wanted = kind === 'product' || kind === 'avatar' ? kind : ''
        const rows = await listAssetRefOptions(user.id)
        sendJson(res, 200, { ok: true, refs: wanted ? rows.filter((row) => row.kind === wanted) : rows })
        return true
      }

      const match = pathname.match(ASSET_PATH)
      if (match) {
        const assetId = match[1]
        const action = match[2] || ''

        // 图片预览：登录 + 归属，别人的当不存在
        if (action.startsWith('files/')) {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: '只支持 GET' })
            return true
          }
          const found = await resolveRefFile(user.id, assetId, match[3])
          if (!found || !(await sendAuthImage(req, res, found.file, found.mime))) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end('not found')
          }
          return true
        }

        if (action === 'generate' && req.method === 'POST') {
          try {
            const asset = await startAssetGeneration({ ownerId: user.id, assetId })
            logEvent('asset.generate', { by: user.email, id: asset.id, kind: asset.kind, free: asset.free, total: asset.progress.total })
            sendJson(res, 200, { ok: true, asset })
            return true
          } catch (error) {
            if (sendRefusal(res, error)) return true
            throw error
          }
        }

        if (!action && req.method === 'GET') {
          const asset = await getAsset(user.id, assetId)
          if (!asset) {
            sendJson(res, 404, { error: '这个资产不存在', code: 'ASSET_NOT_FOUND' })
            return true
          }
          sendJson(res, 200, { ok: true, asset })
          return true
        }

        if (!action && req.method === 'PATCH') {
          try {
            const body = await readBody(req)
            const asset = await updateAsset(user.id, assetId, { name: body.name, category: body.category })
            sendJson(res, 200, { ok: true, asset })
            return true
          } catch (error) {
            if (sendRefusal(res, error)) return true
            throw error
          }
        }

        if (!action && req.method === 'DELETE') {
          try {
            await deleteAsset(user.id, assetId)
            logEvent('asset.delete', { by: user.email, id: assetId })
            sendJson(res, 200, { ok: true })
            return true
          } catch (error) {
            if (sendRefusal(res, error)) return true
            throw error
          }
        }

        sendJson(res, 405, { error: '这个资产的 ' + req.method + ' 不支持' })
        return true
      }

      return false
    },
  }
}

export { clampCount }
