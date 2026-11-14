// 交付包里那几张分镜帧图：作品页导出与只读分享的离线包共用这一处。
//
// 只认分镜里记下的 /media/frames/<模板 id>/<文件名>，落地成 shot-03.jpg 这种按镜头编号命名的文件；
// 读不到的不补、不猜——返回的集合里没有它，纸上的那一镜就写「没存帧图」。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'

/**
 * @param {object|null} template 绑定的模板（已软删除的不会传进来）
 * @param {{limit?: number}} [options] limit=0 表示不截；分享页只给前 12 镜，包里也只放这 12 镜
 */
export async function storyboardFrames(template, { limit = 0 } = {}) {
  const all = Array.isArray(template?.storyboard) ? template.storyboard : []
  const shots = limit > 0 ? all.slice(0, limit) : all
  if (!template?.id || !shots.length) return []
  const out = []
  const seen = new Set()
  for (const [index, shot] of shots.entries()) {
    const matched = String(shot?.frameUrl || '').match(/^\/media\/frames\/([\w-]+)\/([\w.-]+)$/)
    if (!matched || matched[1] !== template.id) continue
    const name = 'shot-' + String(Number(shot.shotNo) || index + 1).padStart(2, '0') + '.jpg'
    if (seen.has(name)) continue
    try {
      const data = await fsp.readFile(path.join(config.framesDir, template.id, matched[2]))
      seen.add(name)
      // templateId/file 只为「评审评的是不是这一张」服务：是同一张就复用这个文件，不再复制一份
      out.push({ name, data, templateId: matched[1], file: matched[2] })
    } catch {
      // 抽帧目录被清过（模板回收站 / 过期清理）：这一镜没有图，别拿别的帧顶
    }
  }
  return out
}
