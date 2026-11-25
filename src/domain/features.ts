// 能力开关的真源（r313）：工作流改成 beta，只对管理员开放。
//
// 为什么用一个模块级 store 而不是层层传 prop：
//   - 侧栏、命令面板、作品页、模板库、评审页、快捷创作、工作台都要判「能不能露工作流」，
//     一路把 session 传下去会改十几个组件签名，而且每一层都可能传漏；
//   - 判定只有一处（App 拿到 session 之后 set 一次），页面里读到的永远是同一份。
// 默认 false：没 set 过就是不露——新加的页面忘了接线时，宁可少露一个入口，也不要漏出去。
import { useSyncExternalStore } from 'react'

type Listener = () => void

let workflowEnabled = false
const listeners = new Set<Listener>()

export function setWorkflowEnabled(value: boolean) {
  const next = Boolean(value)
  if (next === workflowEnabled) return
  workflowEnabled = next
  for (const listener of listeners) listener()
}

export function isWorkflowEnabled() {
  return workflowEnabled
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 组件里读：工作流这个能力现在露不露。 */
export function useWorkflowEnabled() {
  return useSyncExternalStore(subscribe, isWorkflowEnabled, () => false)
}

/** 工作流 beta 的对外说法：入口隐藏 + 直连地址落到这里时用同一句。 */
export const WORKFLOW_BETA_TITLE = '工作流还在 Beta'
export const WORKFLOW_BETA_NOTE = '这个能力现在只对管理员开放，正在重做。下面这些地方可以先做完：'
