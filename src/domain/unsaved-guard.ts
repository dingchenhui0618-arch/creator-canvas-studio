// 写到一半的东西不许悄悄丢（r270）。
//
// 为什么单独成模块：这一句话只有一个真源，而「要不要拦」发生在路由层——
// 用户下一步点的可能是侧栏、命令面板、页里的链接，也可能是浏览器的关闭按钮，
// 页面自己看不见。这里不碰 React、不碰 DOM，判定交给单测钉住。

export type UnsavedNote = {
  /** 谁登记的：同一个编辑面卸载时只清自己那一条 */
  owner: string
  /** 给用户看的一句话：哪里、丢了什么。不写「确定要离开吗」这种空话 */
  message: string
}

let note: UnsavedNote | null = null

/** 页面登记 / 撤掉「我现在有没保存的改动」。 */
export function setUnsaved(next: UnsavedNote | null): void {
  note = next
}

/** 只清自己登记的那一条：后挂上的页面不能把前一页登记的清掉。 */
export function clearUnsaved(owner: string): void {
  if (note && note.owner === owner) note = null
}

export function unsavedNote(): UnsavedNote | null {
  return note
}

/**
 * 这次跳转要不要先问一句。
 *
 * 只有「真有没保存的东西」且「地址真的换了」才拦：
 * 同一条地址自己回写（画布保存后补 runId、运行视图换 id、页内补查询串）不算离开，
 * 拦了反而会把人卡在自己页上。
 */
export function shouldAskBeforeLeave(hasUnsaved: boolean, fromKey: string, toKey: string): boolean {
  return hasUnsaved && fromKey !== toKey
}
