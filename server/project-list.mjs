// 作品列表的找法：关键字 + 状态。
//
// 为什么放在服务端：谁能看这条作品由 listProjects 决定，这里只决定「搜出来的列表里还剩哪几条」。
// 分面计数与筛选用同一个函数算，界面上的数字才不会和真正点出来的人数对不上——
// 与评审历史（v0.9.18）同一套：计数按关键字算、不按当前状态算。
//
// 关键字只搜卡片上看得见的两行：作品标题 + 模板标题。搜不到的东西不假装能搜到。
import { deliveredCurrent } from './project-status.mjs'

/** 三种筛法：全部 / 在做 / 已交付。只分「交没交出去」，不把评审结论再切成筛选项。 */
export const PROJECT_STATES = ['all', 'active', 'delivered']

// 一个关键字最多 5 个词、一个词最多 40 字：够用，也挡住整段文案被贴进来当搜索词
const MAX_TOKENS = 5
const MAX_TOKEN = 40

/** 关键字切成词：空格分隔（全角空格也认）、统一小写。 */
export function projectSearchTokens(q) {
  return String(q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN))
}

/** 搜索范围：作品标题 + 模板标题。 */
export function projectSearchText(item) {
  return [item?.title, item?.template?.title]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

/**
 * 分桶只回答「这一版交没交出去」：交付了 v2 又开 v3 的，当前这一版还没交，算在做。
 * 口径来自 project-status.deliveredCurrent，与状态胶囊、待办、分享页同一处。
 */
export function projectBucket(item) {
  return deliveredCurrent(item) ? 'delivered' : 'active'
}

/**
 * 列表搜索 + 状态筛选。
 * - 关键字多个词是「都要命中」（AND），不是任一命中；
 * - 分面计数按关键字算、忽略当前状态，换一个状态另一排数字仍然是真的；
 * - 认不出的状态退回全部，不报错、不空列表。
 */
export function projectListQuery(items, { q = '', state = 'all' } = {}) {
  const list = Array.isArray(items) ? items : []
  const tokens = projectSearchTokens(q)
  const keywordList = tokens.length
    ? list.filter((item) => {
        const text = projectSearchText(item)
        return tokens.every((token) => text.includes(token))
      })
    : list
  const facets = { all: keywordList.length, active: 0, delivered: 0 }
  for (const item of keywordList) facets[projectBucket(item)] += 1
  const wanted = PROJECT_STATES.includes(state) ? state : 'all'
  const matched = wanted === 'all' ? keywordList : keywordList.filter((item) => projectBucket(item) === wanted)
  return {
    items: matched,
    // 账号下看得见的作品总数（不受筛选影响）：界面写「筛出 3 / 共 12」用得上
    total: list.length,
    shown: matched.length,
    facets,
    // 归一后的关键字回给界面：输入框里还是原始输入，计数与空状态按这一份判断
    query: tokens.join(' '),
    state: wanted,
  }
}
