// 「这条原片/这条模板，下一步往哪走」：已经开过作品就打开那条作品，还没开就照它开一条。
//
// 两个地方共用这一句，界面不另写一份判断：
//   - 发现页「库里的原片」每一行的出口（没有作品的行以前只写着「还没开成作品」，没有下一步可点）；
//   - 发现页检索卡片在库里命中时的第二格（以前只有「打开模板」，做起来还得绕回模板库）。
//
// 两条硬规则与 POST /api/projects 共用一处（canStartProject），不各写一遍：
//   1) 只有「已经解析出脚本或分镜」的模板能开作品：雷达里「加入模板库」先存的是只有链接的
//      kind: 'saved' 条目，这种要先去解析，拿它开作品会 400；
//   2) 已经有作品的，下一步是那条作品，不是再开一条——重复开作品不是「向前走」。

/** 这条模板能不能开成作品：与 POST /api/projects 的 400 是同一个判断。 */
export function canStartProject(template) {
  if (!template || !template.id) return false
  // 只存了原链接的条目（雷达「加入模板库」下来的）还没有脚本与分镜，得先解析
  if (template.kind === 'saved') return false
  const beats = Array.isArray(template.structure) ? template.structure.length : 0
  const shots = Array.isArray(template.storyboard) ? template.storyboard.length : 0
  return beats > 0 || shots > 0
}

/** 作品的进法：版本 0 是「照模板开了作品、还没开画布」，不写「第 0 版」。 */
function workLabel(project) {
  const version = Number(project?.version) || 0
  return version > 0 ? '作品 · 第 ' + version + ' 版' : '作品 · 还没开画布'
}

function workHint(project) {
  const version = Number(project?.version) || 0
  const name = String(project?.title || '').trim() || '未命名作品'
  return version > 0
    ? '打开作品《' + name + '》第 ' + version + ' 版，接着做这一条'
    : '《' + name + '》是照这条模板开的，还没开画布：打开作品接着开'
}

/**
 * 一条原片/模板的下一个动作。
 * 返回值：{ kind, label, hint, projectId }，kind 三种——
 *   open-work   已经开过作品，点一下进那条作品
 *   create-work 还没开过，点一下照这条模板开一条（脚本与分镜跟着走）
 *   blocked     还没解析出脚本与分镜，先去解析（按钮点不动，理由写在 hint 里）
 * 没有模板 id（不该发生）时返回 null：不给一个指向不存在东西的按钮。
 */
export function originEntry({ template = null, templateId = '', project = null, title = '', official = false } = {}) {
  const id = String(templateId || template?.id || '')
  if (!id) return null
  if (project && project.id) {
    return {
      kind: 'open-work',
      label: workLabel(project),
      hint: workHint(project),
      projectId: String(project.id),
    }
  }
  if (!canStartProject(template)) {
    return {
      kind: 'blocked',
      label: '还没解析',
      hint: '这条只存了原链接，还没解析出脚本与分镜：打开模板点「去解析这条」，解析完就能开成作品',
      projectId: '',
    }
  }
  const name = String(template?.title || title || '').trim()
  return {
    kind: 'create-work',
    label: '开成作品',
    hint: official
      ? '照这条官方示例开一条你自己的作品：脚本与分镜跟着走，官方那条不动' +
        (name ? '（《' + name + '》）' : '')
      : '照这条模板开一条作品：脚本与分镜跟着走' + (name ? '（《' + name + '》）' : ''),
    projectId: '',
  }
}

/** 还没开成作品的有几条：开场的这句话按全部原片算，不是按列出来的那几行。 */
export function originPending(rows = []) {
  return (rows || []).filter((row) => row && row.templateId && !row.project).length
}
