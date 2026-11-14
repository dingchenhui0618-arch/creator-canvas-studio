// 模板帧图：GET /media/frames/<模板 id>/<文件名>（v0.9.88）
//
// 以前这条只校验路径形状：不看登录、也不知道这个 id 属于谁。任何拿到模板 id 的人
// （分享页的 JSON 里就带着 id）都能把整条片子的抽帧一张张下走，不需要任何凭证。
// 上一轮「传一张自己的图直接评」把上传图做成私有的（uploads/<账号>/ + 归属闸）之后，
// 同一个媒体目录里还剩这一口——模板帧是「作品 / 素材」，同样不该匿名可读。
//
// 现在跟其它接口一套口径：
//   - 生产（VQ_REQUIRE_AUTH=1）必须登录，匿名一律 401；本地演示（=0）不认人，照常可用
//   - 登录后只能看自己看得见的模板：别人的私有模板回 404，连存在性都不告诉；管理员可看全部
//   - 只发图片（jpg / png / webp）；模板已不在库里的孤儿帧也回 404
//   - private 缓存：浏览器可以存一小时，中间层不许存（帧图现在跟登录态绑定）
//
// 分享页与交付包不受影响：它们拿的是带 token 的地址（/api/share/<token>/frame/<序号>、
// /api/share/project/<token>/frame/<序号>），token 本身就是凭证，不经过这条路由。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sendJson } from './_shared.mjs'
import { config } from '../config.mjs'
import { currentUser } from '../auth.mjs'
import { getTemplate } from '../templates.mjs'

const FRAME_PATH = /^\/media\/frames\/([\w-]+)\/([\w.-]+)$/
const IMAGE_FILE = /\.(?:jpe?g|png|webp)$/i
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end('frame not found')
}

export function createFramesRouter() {
  return {
    prefix: '/media/frames',
    async handle(req, res, url, pathname) {
      const match = pathname.match(FRAME_PATH)
      if (!match) return false
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        sendJson(res, 405, { error: '只支持 GET' })
        return true
      }
      const [, templateId, fileName] = match
      // 登录门：index.mjs 的 needsLogin 只盖 /api/*，/media 这一支得自己挡
      const user = currentUser(req)
      if (!user && config.auth.requireAuth) {
        sendJson(res, 401, { error: '未登录', loginRequired: true })
        return true
      }
      // 归属：只认「这个账号看得见的模板」。匿名（本地演示）不做隔离，与 canAccess 的口径一致
      if (user && !(await getTemplate(templateId, user))) {
        notFound(res)
        return true
      }
      // 只发图片：frames 目录里将来多出别的文件（json / txt / 原始视频）也不该被这条读走
      if (!IMAGE_FILE.test(fileName)) {
        notFound(res)
        return true
      }
      const file = path.join(config.framesDir, templateId, fileName)
      try {
        const bytes = await fsp.readFile(file)
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(fileName).toLowerCase()] || 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(bytes)
        return true
      } catch {
        notFound(res)
        return true
      }
    },
  }
}
