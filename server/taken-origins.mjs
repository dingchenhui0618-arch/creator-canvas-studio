// 发现页开场那块「库里的原片」：库里已经有哪些原片、哪一条已经开成作品。
//
// 口径（全部现算，不落库）：
//   - 「原片」= 模板上留着原片链接（sourceUrl）；画布 / 智能体 / 作品沉淀出来的模板本来就没有原片，不进来；
//   - 同一条原片存成多条模板（比如以它为底存的改编版）只算一条原片，一行里给「存成了几条模板」；
//   - 官方示例照实标出来（shared），不冒充「你带回来的」；
//   - 作品那侧只有模板指针：按 templateId 现查，一条作品多版只算一条，多版取最近改过的那条；
//   - 原片是谁、多少互动，直接读模板上存的原始值（不拿复用次数那种计数器凑）。
import { originEntry, originPending } from './origin-entry.mjs'
import { originStats } from './project-source.mjs'

export const ORIGIN_PLATFORM_LABEL = { douyin: '抖音', xiaohongshu: '小红书' }
export const ORIGIN_LIMIT = 4
export const ORIGIN_MAX = 12

/** 同一条原片的识别键：去掉首尾空白、# 片段与末尾斜杠；没有链接就没有键，不进这块。 */
export function originKey(template) {
  const raw = String(template?.sourceUrl || '').trim()
  if (!raw) return ''
  return raw.replace(/#.*$/, '').replace(/\/+$/, '')
}

/** 一组模板（同一条原片）→ 一块原片行：够认出是哪条原片、存成了哪条模板、有没有开成作品。 */
export function originRow(group = [], projects = []) {
  const sorted = [...group].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const latest = [...projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null
  const hasWork = (item) => projects.some((project) => project.templateId === item.id)
  // 有作品的模板优先当入口：点进去就是「用这条模板的作品」；没有就取最近存下、且有互动数据的那条
  const chosen = sorted.find(hasWork) || sorted.find((item) => originStats(item.stats)) || sorted[0] || {}
  const withStats = sorted.find((item) => originStats(item.stats))
  const stats = originStats(withStats?.stats)
  const project = latest ? { id: latest.id, title: latest.title, version: latest.version } : null
  return {
    templateId: chosen.id || '',
    title: chosen.title || '',
    platform: chosen.platform || '',
    platformLabel: ORIGIN_PLATFORM_LABEL[chosen.platform] || '',
    author: chosen.author || withStats?.author || '',
    // 互动数据只认正数，全 0 就是 null：原片没记数据，界面写「没记互动数据」而不是一排 0
    stats,
    official: Boolean(chosen.shared),
    savedAt: chosen.createdAt || '',
    // 同一条原片存成了几条模板（改编版也继承原链接）
    templates: group.length,
    // 这条原片开出了几条作品：一条作品多版只算一条
    project,
    works: projects.length,
    // 这一行的下一步（v0.9.39）：已经开过作品就进那条，没开就照这条模板开一条，没解析就指向解析。
    // 与卡片上的第二格、POST /api/projects 的 400 同一个口径（server/origin-entry.mjs）。
    entry: originEntry({ template: chosen, templateId: chosen.id, project, title: chosen.title, official: Boolean(chosen.shared) }),
  }
}

/**
 * 发现页要的四样：总共有几条原片、其中几条已经开成作品、几条是官方示例、最近一条是什么时候，
 * 和先列出来的那几条。templates / projects 都只放看得见的（调用方按登录态取）。
 */
export function takenOrigins(templates = [], projects = [], { limit = ORIGIN_LIMIT } = {}) {
  const byTemplate = new Map()
  for (const project of projects) {
    if (!project?.templateId) continue
    const list = byTemplate.get(project.templateId) || []
    list.push(project)
    byTemplate.set(project.templateId, list)
  }
  const groups = new Map()
  for (const item of templates) {
    if (!item || !item.id || item.deletedAt) continue
    const key = originKey(item)
    if (!key) continue
    const list = groups.get(key) || []
    list.push(item)
    groups.set(key, list)
  }
  const rows = []
  for (const group of groups.values()) {
    // 作品按 id 去重：同一条原片的两条模板被同一条作品用着时只算一条作品
    const seen = new Map()
    for (const item of group) {
      for (const project of byTemplate.get(item.id) || []) {
        if (!seen.has(project.id)) seen.set(project.id, project)
      }
    }
    rows.push(originRow(group, [...seen.values()]))
  }
  // 已经开成作品的排前面：这块要回答的第一句是「哪条已经在做了」，不是「最近收了什么」。
  // 组内仍按收进来的先后倒序；最近一条单独取全量的最大时间，别被这个排序带偏。
  rows.sort((a, b) => {
    const workDiff = (b.works > 0 ? 1 : 0) - (a.works > 0 ? 1 : 0)
    return workDiff !== 0 ? workDiff : String(b.savedAt).localeCompare(String(a.savedAt))
  })
  const max = Math.max(1, Math.min(ORIGIN_MAX, Number(limit) || ORIGIN_LIMIT))
  return {
    total: rows.length,
    withProject: rows.filter((row) => row.project).length,
    // 还没开成作品的有几条：按全部原片算（不是只算列出来的 4 行），界面上那句「还有 N 条」才是真的
    pending: originPending(rows),
    works: rows.reduce((sum, row) => sum + row.works, 0),
    official: rows.filter((row) => row.official).length,
    lastAt: rows.reduce((latest, row) => (row.savedAt > latest ? row.savedAt : latest), ''),
    items: rows.slice(0, max),
  }
}
