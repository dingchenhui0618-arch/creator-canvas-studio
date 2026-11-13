// 换页之后内容区停在哪儿：这一页唯一的一处判断（v0.9.43）。
//
// 为什么需要它：外壳是 `height: 100vh + overflow: hidden`，真正滚动的是 `.vq-content`
// （`flex: 1; overflow: auto`）。换页时没人重置它的 scrollTop，浏览器只是按新页面的
// 内容高度把旧值夹一下——于是同一件事有两种结果：
//   · 从滚到底的作品页点「工作台」→ 停在轮播最下面，页头与主卡都在上面看不到；
//   · 从「发现」点「运行记录」→ 新页面更短，正好回到顶部。
// 用户看到的是「有时正常、有时跳到中间」，这就是「跳转混乱」。
//
// 规则只有一条主干：**换一个页面，就从页头开始**。另外两处保持不动，因为它们不是换页：
//   · 模板库打开/关闭单条模板：抽屉是盖在列表上的遮罩，背景列表不该跟着挪；
//   · 画布页换流程：画布自己管视口与缩放，外壳不插手。
// 作品列表 ↔ 作品详情、评审台 ↔ 单条评审都属于「换了个界面」，仍然从页头开始。
//
// 这文件不 import 任何东西：它只做判断，动手的是 App（`useLayoutEffect` + `scrollTop = 0`），
// 所以 Node 里可以直接 import 这个 .ts 跑真断言（见 test/scroll.test.mjs）。
export interface ScrollRoute {
  kind: string
  page?: string
}

/** top = 回到内容区最上面；keep = 保持当前滚动位置。 */
export type ScrollPlan = 'top' | 'keep'

export function planScroll(previous: ScrollRoute | null, next: ScrollRoute): ScrollPlan {
  // 首次渲染没有「上一页」，内容区本来就是 0。
  if (!previous) return 'top'
  // 后台 / 合规页 / 只读分享 / 智能体编辑器各自整屏：一律从上面开始。
  if (previous.kind !== 'page' || next.kind !== 'page') return 'top'
  if (previous.page !== next.page) return 'top'
  if (next.page === 'templates' || next.page === 'canvas') return 'keep'
  return 'top'
}
