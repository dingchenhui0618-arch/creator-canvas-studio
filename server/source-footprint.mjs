// 同一条原片在库里留下了什么：存成了几条模板、开出了几条作品、套用过几次。
//
// 两个地方共用这一套认法：
//   - 模板详情里那块「这条原片在库里」：同源的改编版、跨模板开出的作品，一次看清；
//   - 发现页检索卡片上的「库里已有」：别把同一条内容再收一遍，点到已有的那条模板。
//
// 认原片（identity）的优先级：
//   1) 平台 + 平台 id（模板的 sourceId / 检索条目的 id）：链接会被加分享参数、末尾斜杠或 #，id 不会；
//   2) 没有平台 id 时退回规范化链接——与发现页「库里的原片」同一套 originKey，不另写一份规则。
// 画布 / 智能体 / 作品沉淀出来的模板本来就没有原片，identity 为 null，两个地方都不出现。
import { originKey } from './taken-origins.mjs'
import { deliveredCurrent } from './project-status.mjs'

// 详情抽屉里最多列几条同源模板 / 几条作品：一块说明，不抢分镜表的位置
export const SIBLING_LIMIT = 6
export const ORIGIN_WORK_LIMIT = 4
// 一次最多问 50 条检索结果：一页就是 24 条，翻两页也够，再多就不是「这一屏」了
export const LIBRARY_MARK_MAX = 50

/**
 * 一条原片的身份：平台 + 平台 id 优先，其次规范化链接；两样都没有就是 null（它没有原片）。
 * 入参既可以是库里的模板（sourceId / sourceUrl），也可以是检索结果（id / platform / url）。
 */
export function sourceIdentity(input) {
  const platform = String(input?.platform || '').trim()
  const rawId = input?.sourceId === undefined || input?.sourceId === null ? input?.id : input.sourceId
  const sourceId = String(rawId ?? '').trim()
  const url = originKey({ sourceUrl: input?.sourceUrl === undefined ? input?.url : input.sourceUrl })
  if (platform && sourceId) return { key: platform + ':' + sourceId, platform, sourceId, url }
  if (url) return { key: 'url:' + url, platform, sourceId: '', url }
  return null
}

/** 同源模板的一行：够认出是哪条、从哪来、是不是官方示例。 */
function siblingView(item) {
  return {
    id: item.id,
    title: String(item.title || ''),
    source: String(item.source || ''),
    kind: String(item.kind || ''),
    shared: Boolean(item.shared),
    reuseCount: Number(item.reuseCount) || 0,
    createdAt: String(item.createdAt || ''),
  }
}

/** 作品的一行：够认出是哪条作品的哪一版、交没交。 */
function workView(project) {
  return {
    id: project.id,
    title: String(project.title || ''),
    version: Number(project.version) || 1,
    status: project.status === 'done' ? 'done' : 'active',
    // 详情用的作品行已经现算过 delivered（那行没有 deliveries 原文）；只有整条作品在手上时才自己算
    delivered: typeof project.delivered === 'boolean' ? project.delivered : Boolean(deliveredCurrent(project)),
    updatedAt: String(project.updatedAt || ''),
  }
}

/** 组里挑一条当代表：先挑能进作品的那条（已有作品的最有用），再挑自己的、最近存进来的。 */
function pickRepresentative(group = [], works = []) {
  const withWork = (item) => works.some((project) => project.templateId === item.id)
  return [...group].sort((a, b) => {
    const workDiff = (withWork(b) ? 1 : 0) - (withWork(a) ? 1 : 0)
    if (workDiff !== 0) return workDiff
    const sharedDiff = (a.shared ? 1 : 0) - (b.shared ? 1 : 0)
    if (sharedDiff !== 0) return sharedDiff
    return String(b.createdAt).localeCompare(String(a.createdAt))
  })[0] || null
}

/**
 * 作品按 id 去重（同一条原片的两条模板被同一条作品用着时只算一条）。
 * 同一条作品出现两次时取最近改动的那条：换过模板指针的作品，后一次才是它现在的样子。
 */
function uniqueWorks(projects = [], ids = new Set()) {
  const seen = new Map()
  for (const project of projects) {
    if (!project?.id || !project.templateId || !ids.has(project.templateId)) continue
    const current = seen.get(project.id)
    if (!current || String(project.updatedAt) > String(current.updatedAt)) seen.set(project.id, project)
  }
  return [...seen.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/**
 * 库里的这条模板 → 这条原片的全貌。模板详情抽屉用。
 * 没有原片（画布 / 智能体 / 作品沉淀）返回 null：抽屉里就一个字都不多写。
 */
export function originFootprint(templates = [], projects = [], target = {}) {
  const identity = sourceIdentity(target)
  if (!identity || !target?.id) return null
  const group = (templates || []).filter(
    (item) => item && item.id && !item.deletedAt && sourceIdentity(item)?.key === identity.key,
  )
  // 目标自身一定算在组里：它就在库里，统计口径不能因为调用方漏传一条就少算一条
  if (!group.some((item) => item.id === target.id)) group.push(target)
  const ids = new Set(group.map((item) => item.id))
  const works = uniqueWorks(projects, ids)
  const others = group
    .filter((item) => item.id !== target.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const lastTemplate = group.reduce((latest, item) => (String(item.createdAt) > latest ? String(item.createdAt) : latest), '')
  const lastWork = works.reduce((latest, item) => (String(item.updatedAt) > latest ? String(item.updatedAt) : latest), '')
  return {
    key: identity.key,
    platform: identity.platform,
    platformLabel: String(target.platformLabel || ''),
    sourceId: identity.sourceId,
    templateId: target.id,
    templateCount: group.length,
    siblings: others.slice(0, SIBLING_LIMIT).map(siblingView),
    siblingTotal: others.length,
    workCount: works.length,
    works: works.slice(0, ORIGIN_WORK_LIMIT).map(workView),
    // 套用过几次是组内计数器之和：同一条原片的改编版各自记过次数，加起来才是这条原片被用了几次
    applied: group.reduce((sum, item) => sum + (Number(item.reuseCount) || 0), 0),
    // 整组都是官方示例：说清「这条不是你自己带回来的」，不冒充
    shared: group.length > 0 && group.every((item) => Boolean(item.shared)),
    lastAt: lastWork > lastTemplate ? lastWork : lastTemplate,
  }
}

/**
 * 检索结果 → 哪几条已经在库里。发现页每张卡片上的「库里已有」用。
 * 返回值只带命中的条目；没命中的不返回，前端按 id 查表。
 */
export function libraryMarks(templates = [], projects = [], entries = []) {
  const groups = new Map()
  for (const item of templates || []) {
    if (!item?.id || item.deletedAt) continue
    const identity = sourceIdentity(item)
    if (!identity) continue
    const list = groups.get(identity.key) || []
    list.push(item)
    groups.set(identity.key, list)
  }
  const asked = Array.isArray(entries) ? entries.slice(0, LIBRARY_MARK_MAX) : []
  const items = []
  for (const entry of asked) {
    const identity = sourceIdentity(entry)
    if (!identity) continue
    const group = groups.get(identity.key) || []
    if (!group.length) continue
    const ids = new Set(group.map((item) => item.id))
    const works = uniqueWorks(projects, ids)
    const chosen = pickRepresentative(group, works)
    if (!chosen) continue
    items.push({
      id: String(entry?.id || ''),
      templateId: chosen.id,
      title: String(chosen.title || ''),
      source: String(chosen.source || ''),
      shared: Boolean(chosen.shared),
      workCount: works.length,
      project: works.length ? { id: works[0].id, title: works[0].title, version: Number(works[0].version) || 1 } : null,
    })
  }
  return { total: asked.length, matched: items.length, items }
}
