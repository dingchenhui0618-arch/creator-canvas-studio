import type { RunProjectRef } from '../api/flows'

/**
 * 运行记录里「这条运行属于哪条作品的哪一版」的写法，全站一处。
 * 运行记录页的第二行、详情页头、工作台的最近运行都读它——分开写迟早一处写「v2」、
 * 一处写「第2版」，归档版还会有一处忘了标「已归档」。
 */
export function runVersionLabel(project: RunProjectRef): string {
  if (!project.version) return '还没分版'
  return '第 ' + project.version + ' 版' + (project.archived ? '（归档）' : '')
}

/**
 * 列表里的那一行：画布通常按作品名自动命名（「毛衣折叠收纳法」、新版画布是「… v2」），
 * 再抄一遍标题就是同一行重复两遍，所以画布名里已经带着标题时只写版次；
 * 画布被改过名才补上作品名。空白画布直接跑的运行如实写「没挂在作品上」。
 */
export function runWorkLine(run: { flowName: string; project?: RunProjectRef | null }): string {
  const project = run.project
  if (!project) return '没挂在作品上'
  const title = project.title && !String(run.flowName || '').includes(project.title) ? project.title + ' · ' : ''
  return '作品 · ' + title + runVersionLabel(project)
}
