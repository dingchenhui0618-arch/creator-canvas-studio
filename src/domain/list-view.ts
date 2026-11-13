// 作品列表的筛选条件记在哪儿（v0.9.43）。
//
// 起因：作品列表点进一条作品再回来，搜索词与「在做 / 已交付」这一档会被清空——
// 页面是重新挂载的，useState 回到初始值。条目一多，筛完点开一条、回来再筛一遍，
// 这是实打实的重复劳动。所以把这两项塞进 sessionStorage：同一个标签页里回来还在，
// 关掉标签页就忘掉（不跨会话，避免下次打开看到一份不知从哪儿来的筛选）。
//
// 存进去的东西是不可信的：读的时候逐字段校验，坏了就退回「全部、无关键词」。
// 这里不 import 任何 React / DOM 类型，Node 里可以直接跑（test/list-view.test.mjs）。
export interface ProjectsView {
  keyword: string
  bucket: 'all' | 'active' | 'delivered'
}

export const EMPTY_PROJECTS_VIEW: ProjectsView = { keyword: '', bucket: 'all' }

/** 只需要 Storage 的这三件事，测试里给个假的即可。 */
export interface ViewStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function projectsViewKey(): string {
  return 'vq_projects_view:v1'
}

export function readProjectsView(storage: ViewStorage): ProjectsView {
  try {
    const raw = storage.getItem(projectsViewKey())
    if (!raw) return { ...EMPTY_PROJECTS_VIEW }
    const parsed = JSON.parse(raw) as Partial<ProjectsView> | null
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY_PROJECTS_VIEW }
    const keyword = typeof parsed.keyword === 'string' ? parsed.keyword.slice(0, 80) : ''
    const bucket: ProjectsView['bucket'] =
      parsed.bucket === 'active' || parsed.bucket === 'delivered' ? parsed.bucket : 'all'
    return { keyword, bucket }
  } catch {
    // 读不出来、解析失败都当没筛过：筛选条件不值得让列表打不开。
    return { ...EMPTY_PROJECTS_VIEW }
  }
}

/** 没有筛选就把键删掉：下次读到的「没有记录」和「全部」是一回事，不留一条空记录。 */
export function writeProjectsView(storage: ViewStorage, view: ProjectsView): void {
  try {
    if (!view.keyword.trim() && view.bucket === 'all') {
      storage.removeItem(projectsViewKey())
      return
    }
    storage.setItem(projectsViewKey(), JSON.stringify({ keyword: view.keyword, bucket: view.bucket }))
  } catch {
    // 隐私模式/配额满写不进去：这一屏照常能用，只是回来要重筛一次。
  }
}
