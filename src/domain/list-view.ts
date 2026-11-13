// 列表筛选条件记在哪儿（v0.9.43 作品列表 → v0.9.44 模板库与运行记录）。
//
// 起因：列表点进一条再回来，搜索词与筛选档会被清空——页面是重新挂载的，useState 回到初始值。
// 条目一多，筛完点开一条、回来再筛一遍，这是实打实的重复劳动。所以把这些条件塞进
// sessionStorage：同一个标签页里回来还在，关掉标签页就忘掉（不跨会话，避免下次打开
// 看到一份不知从哪儿来的筛选）。读出来的东西一律当不可信，逐字段校验，坏了退回默认。
//
// 三份列表各存各的键，互不影响：
//   vq_projects_view:v1   作品列表：搜索词 + 在做 / 已交付
//   vq_templates_view:v1  模板库：搜索词 + 类型 + 来源
//   vq_runs_view:v1       运行记录：搜索词 + 流程 + 状态
//
// 工作台「评审等你看的」故意不记：那是一张待办清单，留着昨天的筛选会把等你改的作品藏起来
// （v0.9.25 已经保证筛空时写出「全部还有 N 条」，但仍然不如每次从「全部」开始）。
//
// 这里不 import 任何 React / DOM 类型，Node 里可以直接跑（test/list-view.test.mjs）。
export interface ProjectsView {
  keyword: string
  bucket: 'all' | 'active' | 'delivered'
}

export const EMPTY_PROJECTS_VIEW: ProjectsView = { keyword: '', bucket: 'all' }

export interface TemplatesView {
  /** 搜索标题、钩子、标签或可复用规则 */
  keyword: string
  /** 类型：服务端给的分类名，「全部」表示不筛 */
  type: string
  /** 来源：discovery / project / agent / canvas / adapted / shared，空串表示不筛 */
  source: string
}

export const EMPTY_TEMPLATES_VIEW: TemplatesView = { keyword: '', type: '全部', source: '' }

export interface RunsView {
  keyword: string
  /** 只看某块画布；空串表示全部流程 */
  flowId: string
  status: '' | 'success' | 'error'
}

export const EMPTY_RUNS_VIEW: RunsView = { keyword: '', flowId: '', status: '' }

/** 只需要 Storage 的这三件事，测试里给个假的即可。 */
export interface ViewStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEYWORD_MAX = 80
const LABEL_MAX = 80

export function projectsViewKey(): string {
  return 'vq_projects_view:v1'
}

export function templatesViewKey(): string {
  return 'vq_templates_view:v1'
}

export function runsViewKey(): string {
  return 'vq_runs_view:v1'
}

/** 读成一份普通对象：不是对象、解析失败、读不出来都当「没存过」。 */
function readObject(storage: ViewStorage, key: string): Record<string, unknown> | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    // 坏数据不值得让列表打不开：当作没筛过。
    return null
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** 没有筛选就把键删掉：下次读到的「没有记录」和「全部」是一回事，不留一条空记录。 */
function writeObject(storage: ViewStorage, key: string, view: Record<string, unknown>, empty: boolean): void {
  try {
    if (empty) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify(view))
  } catch {
    // 隐私模式 / 配额满写不进去：这一屏照常能用，只是回来要重筛一次。
  }
}

export function readProjectsView(storage: ViewStorage): ProjectsView {
  const parsed = readObject(storage, projectsViewKey())
  if (!parsed) return { ...EMPTY_PROJECTS_VIEW }
  return {
    keyword: text(parsed.keyword, KEYWORD_MAX),
    bucket: oneOf<ProjectsView['bucket']>(parsed.bucket, ['all', 'active', 'delivered'], 'all'),
  }
}

export function writeProjectsView(storage: ViewStorage, view: ProjectsView): void {
  writeObject(
    storage,
    projectsViewKey(),
    { keyword: view.keyword, bucket: view.bucket },
    !view.keyword.trim() && view.bucket === 'all',
  )
}

export function readTemplatesView(storage: ViewStorage): TemplatesView {
  const parsed = readObject(storage, templatesViewKey())
  if (!parsed) return { ...EMPTY_TEMPLATES_VIEW }
  const type = text(parsed.type, LABEL_MAX)
  return {
    keyword: text(parsed.keyword, KEYWORD_MAX),
    // 「全部」与空串都表示不筛；认不出的类型也退回「全部」——分类被后台改名后不会卡在一份空列表上
    type: type || '全部',
    source: text(parsed.source, LABEL_MAX),
  }
}

export function writeTemplatesView(storage: ViewStorage, view: TemplatesView): void {
  const type = view.type || '全部'
  writeObject(
    storage,
    templatesViewKey(),
    { keyword: view.keyword, type, source: view.source },
    !view.keyword.trim() && (type === '全部' || type === '') && !view.source,
  )
}

export function readRunsView(storage: ViewStorage): RunsView {
  const parsed = readObject(storage, runsViewKey())
  if (!parsed) return { ...EMPTY_RUNS_VIEW }
  return {
    keyword: text(parsed.keyword, KEYWORD_MAX),
    flowId: text(parsed.flowId, LABEL_MAX),
    status: oneOf<RunsView['status']>(parsed.status, ['', 'success', 'error'], ''),
  }
}

/**
 * 记下来的「只看这块画布」还算不算数：流程清单读成功、里面却没有这块画布（删了、或换了账号），
 * 就按「全部流程」算，别让人停在一份永远空的列表上；清单还没读到（或读失败）时先信记下来的那个，
 * 不为一次网络抖动把好筛选抹掉。
 */
export function resolveFlowFilter(flowId: string, flowIds: readonly string[], listLoaded: boolean): string {
  if (!flowId) return ''
  if (!listLoaded) return flowId
  return flowIds.includes(flowId) ? flowId : ''
}

export function writeRunsView(storage: ViewStorage, view: RunsView): void {
  writeObject(
    storage,
    runsViewKey(),
    { keyword: view.keyword, flowId: view.flowId, status: view.status },
    !view.keyword.trim() && !view.flowId && !view.status,
  )
}
