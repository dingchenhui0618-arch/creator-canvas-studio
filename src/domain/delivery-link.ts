// 交付深链：#/projects/<作品 id>/delivery/<交付记录 id>（v0.9.140）。
//
// 工作台「交出去的」点一行，落在作品页的那一版档案上，收据已经摊开——
// 这样清单顶上那句「点那几行进去，看差在哪一项」才真的一步走得到。
// 单独一个模块（和画布运行链接同一套做法）：路由与测试都只认这一段纯逻辑。
//
// 约定：
//   - 认交付记录的 id，不认版次：同一版重新封过包会换一条记录，旧链接找不到就直说找不到，
//     不能按「最接近的版次」猜一个落下去。
//   - 缺任何一段都不算深链，退回作品页本身：坏链接照样能把作品打开。

export type DeliveryLink = {
  projectId: string
  deliveryId: string
}

/** 从路径分段里认交付深链；不是这个形状就返回 null（调用方退回作品页）。 */
export function deliveryLinkFromSegments(segments: readonly string[]): DeliveryLink | null {
  if (!Array.isArray(segments) || segments.length < 4) return null
  const [head, projectId, kind, deliveryId] = segments
  if (head !== 'projects' || kind !== 'delivery') return null
  const project = String(projectId || '').trim()
  const delivery = String(deliveryId || '').trim()
  if (!project || !delivery) return null
  return { projectId: project, deliveryId: delivery }
}

/** 拼回地址：两段 id 都编码，中文与斜杠都不会把路径切错。 */
export function deliveryLinkHash(projectId: string, deliveryId: string): string {
  return '#/projects/' + encodeURIComponent(projectId) + '/delivery/' + encodeURIComponent(deliveryId)
}
