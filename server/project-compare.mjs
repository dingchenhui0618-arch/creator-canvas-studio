// 任意两版对照（v0.9.117）的取数：只读，方向是 base → target。
//
// 这段逻辑原来只活在 /api/projects/:id/versions/compare 的路由里。v0.9.121 起，
// 同一份对照要同时给页面弹窗和 A4 对照纸用：两处必须读到同一组数字、同一句总结，
// 不能一个说「主要少 1 个」、纸上说别的。所以抽到这里，路由只负责校验与回包。
//
// 边界：
//  1. 当前版读现在的工作流与脚本；归档版读开版时存下的快照；哪一侧读不到就如实给 null。
//  2. 评审按版次统计，版本划分前的老评审折进 v1（与作品页同一套 reviewsForVersion）。
//  3. 交付只认这一版自己的记录；交时评审照写当初，不拿后来重评覆盖（v0.9.120）。
//  4. 不改任何东西：不写作品、不写工作流、不写评审、不扣积分。
import { getFlow } from './flows.mjs'
import { getTemplate } from './templates.mjs'
import { scriptView } from './project-script.mjs'
import { reviewSummaryByVersion } from './reviews.mjs'
import { reviewsForVersion } from './project-status.mjs'
import { reviewChangeOf, reviewSideOf, versionCompareOf } from './version-diff.mjs'

/**
 * 取两版对照的只读视图。
 * 返回 { ok: true, view } 或 { ok: false, missing: n }（该版没有归档记录）。
 * 版次是否合法、是否同一版由调用方先校验。
 */
export async function versionCompareView(project, user, baseNo, targetNo, { hideWorkflow = false } = {}) {
  // 工作流 beta（r313）：普通账号的对照只比脚本。节点一个都不读，名字也不带出工作流名，
  // 所以下面每一处都先看 hideWorkflow，再决定要不要碰工作流。
  const resolveSide = async (n) => {
    if (n === project.version) {
      const [flow, template] = await Promise.all([
        !hideWorkflow && project.flowId ? getFlow(project.flowId, user) : null,
        project.templateId ? getTemplate(project.templateId, user) : null,
      ])
      const script = scriptView(project, template)
      return {
        n,
        name: project.title,
        current: true,
        nodes: flow && Array.isArray(flow.nodes) ? flow.nodes : null,
        canvasAvailable: Boolean(flow && Array.isArray(flow.nodes)),
        script,
        scriptAvailable: Boolean(script && Array.isArray(script.structure)),
        beats: Array.isArray(script?.structure) ? script.structure.length : 0,
      }
    }
    const entry = project.versions.find((item) => item.n === n)
    if (!entry) return null
    const flow = !hideWorkflow && entry.flowId ? await getFlow(entry.flowId, user) : null
    return {
      n,
      // 归档名就是当时那块工作流的名字：普通账号读到的版本名一律写中性的「第 N 版」
      name: hideWorkflow ? '第 ' + n + ' 版' : entry.name,
      current: false,
      nodes: flow && Array.isArray(flow.nodes) ? flow.nodes : null,
      canvasAvailable: Boolean(flow && Array.isArray(flow.nodes)),
      script: entry.script || null,
      scriptAvailable: Boolean(entry.script && Array.isArray(entry.script.structure)),
      beats: Array.isArray(entry.script?.structure) ? entry.script.structure.length : 0,
    }
  }

  const [baseSide, targetSide] = await Promise.all([resolveSide(baseNo), resolveSide(targetNo)])
  if (!baseSide) return { ok: false, missing: baseNo }
  if (!targetSide) return { ok: false, missing: targetNo }

  const diff = versionCompareOf({
    baseNodes: baseSide.nodes,
    targetNodes: targetSide.nodes,
    baseScript: baseSide.script,
    targetScript: targetSide.script,
  })

  const notes = []
  if (!hideWorkflow && (!baseSide.canvasAvailable || !targetSide.canvasAvailable)) notes.push('有一版的工作流已被删除：工作流这一侧不比，脚本仍按快照比。')
  if (!baseSide.scriptAvailable || !targetSide.scriptAvailable) {
    notes.push(hideWorkflow
      ? '有一版没存脚本快照：脚本这一侧不比。'
      : '有一版没存脚本快照：脚本这一侧不比，工作流仍按节点比。')
  }
  if (!diff.script && baseSide.scriptAvailable && targetSide.scriptAvailable) notes.push('有一版的脚本没有分段：脚本这一侧没有可比的口播。')
  if (!diff.summary) {
    notes.push(hideWorkflow ? '这两版没有可比的数据：脚本读不到。' : '这两版没有可比的数据：工作流与脚本都读不到。')
  }

  // 评审与交付（v0.9.119）：两版各自读这一版最近一评，交付只认这一版的记录。
  // 评审按版次统计，版本划分前的老评审折进 v1（与作品页同一套 reviewsForVersion）。
  const versionCounts = await reviewSummaryByVersion(project.id, user)
  const deliveryOfVersion = (n) => {
    const list = Array.isArray(project.deliveries) ? project.deliveries : []
    const entry = list.filter((item) => item.version === n).pop()
    if (entry) {
      // review 三种状态原样带出去：对象 = 交时评过；null = 当时还没评；字段不存在 = 升级前没记。
      // 不在这里补一次「拿现在评审当交时」——那会把历史改写成交付后的结论（v0.9.120）。
      const at = String(entry.at || '')
      return entry.review === undefined ? { at } : { at, review: entry.review }
    }
    // 交付记录是后来才有的：老数据没有条目，但状态是已交付且指的是当前这一版，
    // 与作品页 deliveredCurrent 同一口径——写「交付过 · 时间没记录」，不写成没交。
    if (project.status === 'done' && project.version > 0 && n === project.version) return { at: '' }
    return null
  }
  const sideView = (side) => ({
    n: side.n,
    name: side.name,
    current: side.current,
    // 普通账号：节点数不报，也不说「工作流还能打开」——那一侧对他不存在
    nodes: hideWorkflow ? 0 : (Array.isArray(side.nodes) ? side.nodes.length : 0),
    beats: side.beats,
    canvasAvailable: hideWorkflow ? false : side.canvasAvailable,
    scriptAvailable: side.scriptAvailable,
    review: reviewSideOf(reviewsForVersion(versionCounts, side.n)),
    delivery: deliveryOfVersion(side.n),
  })

  return {
    ok: true,
    view: {
      base: sideView(baseSide),
      target: sideView(targetSide),
      summary: diff.summary,
      canvas: diff.canvas,
      script: diff.script,
      reviewChange: reviewChangeOf(
        reviewsForVersion(versionCounts, baseNo),
        reviewsForVersion(versionCounts, targetNo),
      ),
      notes,
    },
  }
}
