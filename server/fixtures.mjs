// 示例数据：仅在未配置 REDFOX_API_KEY 时返回，界面会显式标注「示例数据」
// 这些数字与标题用于演示界面结构，不代表真实平台数据。
export const mockItems = [
  {
    id: 'mock-dy-1', platform: 'douyin', platformLabel: '抖音', mock: true,
    title: '春日通勤穿搭｜三套不踩雷的配色，微胖也能穿出高级感',
    author: '阿柚的衣橱', cover: '', url: '', publishedAt: '2026-10-28 19:42', durationSec: 48,
    stats: { likes: 128400, comments: 3421, shares: 8912, collects: 20411 },
  },
  {
    id: 'mock-dy-2', platform: 'douyin', platformLabel: '抖音', mock: true,
    title: '一百块的租房改造：把 9㎡ 阳台改成咖啡角，全网最省版本',
    author: '小满住出租屋', cover: '', url: '', publishedAt: '2026-10-26 12:05', durationSec: 63,
    stats: { likes: 96300, comments: 2108, shares: 15320, collects: 33120 },
  },
  {
    id: 'mock-xhs-1', platform: 'xiaohongshu', platformLabel: '小红书', mock: true,
    title: '陶瓷杯开箱｜这只手工釉的杯子，让我的早晨慢了下来',
    author: '一杯慢生活', cover: '', url: '', publishedAt: '2026-10-25 09:12', durationSec: 37,
    stats: { likes: 54200, comments: 1866, shares: 2401, collects: 18760 },
  },
  {
    id: 'mock-xhs-2', platform: 'xiaohongshu', platformLabel: '小红书', mock: true,
    title: '不踩雷的护肤台收纳：把台面清空之后，我每天多睡十分钟',
    author: '桌面收容所', cover: '', url: '', publishedAt: '2026-10-24 21:30', durationSec: 52,
    stats: { likes: 41800, comments: 977, shares: 1220, collects: 15400 },
  },
  {
    id: 'mock-dy-3', platform: 'douyin', platformLabel: '抖音', mock: true,
    title: '爆款咖啡店探店｜老板说自己每天只做 40 杯，我信了',
    author: '周末去哪喝', cover: '', url: '', publishedAt: '2026-10-23 16:48', durationSec: 71,
    stats: { likes: 73500, comments: 4090, shares: 6721, collects: 9800 },
  },
  {
    id: 'mock-xhs-3', platform: 'xiaohongshu', platformLabel: '小红书', mock: true,
    title: '三条视频讲清「春季上新」的卖点排序，运营新人直接抄',
    author: '内容操盘手记', cover: '', url: '', publishedAt: '2026-10-22 10:20', durationSec: 96,
    stats: { likes: 28700, comments: 1502, shares: 4310, collects: 22100 },
  },
  {
    id: 'mock-dy-4', platform: 'douyin', platformLabel: '抖音', mock: true,
    title: '把包装盒做成二次利用的收纳盒，客户说这才是我们想买的',
    author: '包装设计日记', cover: '', url: '', publishedAt: '2026-10-21 14:02', durationSec: 44,
    stats: { likes: 58200, comments: 1310, shares: 5140, collects: 12900 },
  },
  {
    id: 'mock-xhs-4', platform: 'xiaohongshu', platformLabel: '小红书', mock: true,
    title: '早八人早餐 | 五分钟做完的三种搭配，拍照也好看',
    author: '早上八点的厨房', cover: '', url: '', publishedAt: '2026-10-20 07:55', durationSec: 58,
    stats: { likes: 66200, comments: 2740, shares: 3820, collects: 26400 },
  },
]

export function searchFixtures(keyword) {
  const q = (keyword || '').trim()
  const list = q ? mockItems.filter((item) => (item.title + item.author).includes(q)) : mockItems
  return list.map((item) => ({ ...item }))
}
