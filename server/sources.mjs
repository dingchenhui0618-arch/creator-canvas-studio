// 「素材来源与下架通道」那一页的数字（v0.9.82）。
//
// 为什么要一个接口：这一页讲的是「公共模板里存了什么、有多少条、从哪些平台来」，
// 写在文案里一定会漂（今天 25 条，下个月就不是了）。数字现算，页面自己跟着走。
//
// 边界：只回计数与分布，不回标题 / 作者 / 链接。公共模板的正文要登录进模板库看，
// 那里每条都能直接「举报侵权」；匿名访客拿不到可批量抓取的清单。
import { publicSourceStats } from './templates.mjs'
import { reportCounts } from './reports.mjs'

export async function sourcesSummary() {
  const [stats, counts] = await Promise.all([publicSourceStats(), reportCounts()])
  return {
    ok: true,
    at: new Date().toISOString(),
    public: stats,
    // 已处理的下架条数：证明这条通道真的有人走完过，不是摆设（0 也照实回 0）
    takedown: { handled: counts.takedown },
  }
}
