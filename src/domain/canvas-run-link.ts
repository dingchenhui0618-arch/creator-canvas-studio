// 画布地址里「点名一条运行」的两种入口（v0.9.106）：
//   #/canvas/<flowId>/run/<runId>       只读查看这次运行，画布不改
//   #/canvas/<flowId>/resume/<runId>    从这次运行继续跑，复用已跑完的节点
//
// 解析和拼装放在同一个纯函数里，是因为这两件事一旦分开写就会漂移：
// 页面按一种格式拼、路由按另一种格式拆，最后表现为「刷新一下入口就没了」。
// flowId / runId 由服务端签发（flow_xxx / run_xxx），这里仍然编码，坏字符不拼进地址栏。
export type CanvasResumeRunLink = { flowId: string; resumeRunId: string }
export type CanvasViewRunLink = { flowId: string; viewRunId: string }
export type CanvasRunLink = CanvasResumeRunLink | CanvasViewRunLink

/** 拼成续跑地址。调用方拿到的就是最终地址，不再二次拼接。 */
export function canvasRunLinkHash(flowId: string, runId: string): string {
  return '#/canvas/' + encodeURIComponent(flowId) + '/resume/' + encodeURIComponent(runId)
}

/** 拼成只读查看地址。查看和续跑是两个地址，不能靠页面状态偷偷切换。 */
export function canvasRunViewLinkHash(flowId: string, runId: string): string {
  return '#/canvas/' + encodeURIComponent(flowId) + '/run/' + encodeURIComponent(runId)
}

/**
 * 从路由已经拆好、解码过的路径段里认这条地址。
 * 不是画布 / 缺 flowId / 缺 runId / 多一段 / 认不出的模式，都返回 null，
 * 交给调用方走普通画布地址；坏链接不抛错，画布本身仍然打得开。
 */
export function canvasRunLinkFromSegments(segments: readonly string[]): CanvasRunLink | null {
  if (segments[0] !== 'canvas') return null
  if (!segments[1] || !segments[3]) return null
  if (segments.length !== 4) return null
  if (segments[2] === 'resume') return { flowId: segments[1], resumeRunId: segments[3] }
  if (segments[2] === 'run') return { flowId: segments[1], viewRunId: segments[3] }
  return null
}
