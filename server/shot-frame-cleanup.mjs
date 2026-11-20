// 工作流画面的「看与清」（r280）：设置页那一栏点「管理」之后用到的三个动作。
//
// 为什么补这一块：r279 给工作流画面划了自己的定额（每账号 800 张 / 1.2 GB），
// 到顶之后贴回分镜会被 409 拒掉，而此前唯一的出路是「一镜一镜撤画面」或「彻底删作品」。
// 有定额就得有对账的地方：哪条作品占了多少、有没有白占的文件、要腾地方该按哪儿。
//
// 三条边界：
//  1) 只算、只清自己账号目录里的东西（画面库按账号分目录，拼路径的地方在 shot-frame-store 里钉死）；
//  2) 「清空某条作品的画面」先摘记录、后删文件：反过来会留下读不出来的破图；
//  3) 回收站里的作品算「还在用」：恢复要连画面一起回来，不能当孤儿清掉。
import { listProjects, revokeProjectShotFrames, trashShotFrames } from './projects.mjs'
import { parseShotMedia } from './project-shots.mjs'
import {
  clearProjectShotFrames,
  collectUnreferencedShotFrames,
  shotFrameBreakdown,
  shotFrameOrphans,
  shotFrameUsage,
} from './shot-frame-store.mjs'

/** 还被记录指着的画面：{ 作品编号: [media, ...] }，活动作品与回收站里的一起算。 */
function referenceMap(active, trash) {
  const out = {}
  const add = (rows) => {
    for (const project of Array.isArray(rows) ? rows : []) {
      const parsedId = String(project?.id || '')
      if (!parsedId) continue
      const frames = project.shots && typeof project.shots === 'object' ? project.shots : {}
      const media = []
      for (const value of Object.values(frames)) {
        const parsed = parseShotMedia(value?.media)
        if (parsed?.kind !== 'store') continue
        if (parsed.projectId && parsed.projectId !== parsedId) continue
        media.push(value.media)
      }
      const list = out[parsedId] || (out[parsedId] = [])
      list.push(...media)
    }
  }
  add(active)
  add(trash)
  return out
}

/**
 * 面板要的那一份：总量、按作品拆开、以及「有 N 张没人引用」。
 * 标题从作品库现取；画面还在、作品已经不在的目录，如实写「已删除的作品」，不假装有归属。
 */
export async function shotFrameOverview(user) {
  const [usage, breakdown, active, trash] = await Promise.all([
    shotFrameUsage(user.id),
    shotFrameBreakdown(user.id),
    listProjects(user),
    trashShotFrames(user),
  ])
  const known = new Map()
  for (const project of active) known.set(String(project.id), { title: project.title || '未命名作品', inTrash: false })
  for (const project of trash) known.set(String(project.id), { title: project.title || '未命名作品', inTrash: true })
  const projects = breakdown.projects.map((row) => {
    const found = known.get(row.projectId)
    return {
      projectId: row.projectId,
      title: found?.title || '已删除的作品',
      inTrash: Boolean(found?.inTrash),
      files: row.files,
      bytes: row.bytes,
      newestAt: row.newestAt,
    }
  })
  const orphans = await shotFrameOrphans({ userId: user.id, referenced: referenceMap(active, trash) })
  return { usage, projects, orphans: { files: orphans.files, bytes: orphans.bytes } }
}

/**
 * 一键清空一条作品的画面：先摘记录（分镜回到原片帧），再删文件。
 * 手贴的画面（uploads/…）不动：那不是工作流的产物，也不是这次要腾的空间。
 */
export async function clearShotFramesForProject({ user, projectId }) {
  const revoked = await revokeProjectShotFrames(String(projectId || ''), user)
  if (revoked.status !== 200) return revoked
  const cleared = await clearProjectShotFrames(user.id, String(projectId || ''))
  return {
    status: 200,
    projectId: String(projectId || ''),
    title: revoked.project?.title || '未命名作品',
    shotsCleared: revoked.cleared,
    removed: cleared.removed,
    bytes: cleared.bytes,
  }
}

/** 清掉没人引用的画面（先数、再删，不猜）。 */
export async function clearOrphanShotFrames(user) {
  const [active, trash] = await Promise.all([listProjects(user), trashShotFrames(user)])
  const cleared = await collectUnreferencedShotFrames({ userId: user.id, referenced: referenceMap(active, trash) })
  return { removed: cleared.removed, bytes: cleared.bytes }
}
