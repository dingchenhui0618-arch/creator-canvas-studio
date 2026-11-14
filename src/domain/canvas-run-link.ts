// 画布地址里「点名一条运行」的那一段（v0.9.104）：
//   #/canvas/<flowId>/resume/<runId>
//
// 解析和拼装放在同一个纯函数里，是因为这两件事一旦分开写就会漂移：
// 页面按一种格式拼、路由按另一种格式拆，最后表现为「刷新一下续跑入口就没了」。
// flowId / runId 由服务端签发（flow_xxx / run_xxx），这里仍然编码，坏字符不拼进地址栏。
export type CanvasRunLink = { flowId: string; resumeRunId: string }

/** 拼成规范 hash。调用方拿到的就是最终地址，不再二次拼接。 */
export function canvasRunLinkHash(flowId: string, runId: string): string {
  return '#/canvas/' + encodeURIComponent(flowId) + '/resume/' + encodeURIComponent(runId)
}

/**
 * 从路由已经拆好、解码过的路径段里认这条地址。
 * 不是画布 / 缺 flowId / 缺 runId / 多一段，都返回 null，交给调用方走普通画布地址；
 * 坏链接不抛错，画布本身仍然打得开。
 */
export function canvasRunLinkFromSegments(segments: readonly string[]): CanvasRunLink | null {
  if (segments[0] !== 'canvas') return null
  if (segments[2] !== 'resume') return null
  if (!segments[1] || !segments[3]) return null
  if (segments.length !== 4) return null
  return { flowId: segments[1], resumeRunId: segments[3] }
}
