// 全局提示条（toast）该停多久、收尾等多久（r324）。
//
// 原来固定 2.4 秒：一条「已保存」够用，但报错往往更长——「复制失败：浏览器没给剪贴板权限」
// 这种还没读完就没了，用户只能再点一次碰运气。现在停留时间跟着字数走：
// 2.4 秒打底，每个字多给 60ms，最多 6 秒（再长就该写成页面里的常驻说明，不该让提示条一直挂着）。
//
// 这里只放纯函数：真正计时的在 App.tsx，真渲染的数字见 scripts/shot-r324.mjs。

/** 最短停留：一眼就能扫完的那几个字（「已保存」「已复制」）也要看得见。 */
export const TOAST_BASE_MS = 2400
/** 每个字多给的时间：一行中文按 60ms 算，读得慢的人也有余地。 */
export const TOAST_PER_CHAR_MS = 60
/** 上限：超过这个长度，问题不在「停留够不够」，而在这句话本身太长了。 */
export const TOAST_MAX_MS = 6000
/** 收尾动效的时长：与 CSS 里的 --dur-2（180ms）同一档，改一处要改两处。 */
export const TOAST_EXIT_MS = 180

/** 这条提示该停留多久（毫秒）。空文案按打底时长——不能因为 0 字就变成 0 秒。 */
export function toastDuration(message: string): number {
  const text = typeof message === 'string' ? message.trim() : ''
  return Math.min(TOAST_MAX_MS, TOAST_BASE_MS + text.length * TOAST_PER_CHAR_MS)
}

/**
 * 收尾要等多久才把这条卸载。
 * 系统开了「减弱动态效果」时过渡只有 1ms，没有淡出可看，就别让它多挂 180ms。
 */
export function toastExitDelay(reducedMotion: boolean): number {
  return reducedMotion ? 0 : TOAST_EXIT_MS
}
