/**
 * 平台效果示例（r314）：工作台上「平台能做出什么」那一墙。
 *
 * 这五张是真实产出的作品画面（用户在飞书文档里公开的），不是账号数据、也不是占位图：
 * 图片来自作品原图，视频取的是成片里的关键帧。任何一张都不在这里写「生成中」这类假状态。
 *
 * 放在 public/works/ 下随构建产物一起发，路径不带 hash——换图时保持文件名不变，
 * 省得每换一张图就多一份旧缓存。
 */
export type ShowcaseKind = '图片' | '视频'

export type ShowcaseItem = {
  key: string
  src: string
  alt: string
  title: string
  /** 一行说明这条作品用到了流程里的哪几步，不写形容词。 */
  meta: string
  kind: ShowcaseKind
  /** 画面里的内容说明，给 title 属性用：鼠标停一下能看到「这是什么」。 */
  note: string
}

export const SHOWCASE: ShowcaseItem[] = [
  {
    key: 'ip-sheet',
    src: '/works/ip-sheet.jpg',
    alt: 'IP 形象设定图：橙猫角色的主视觉、三视图、四种表情与周边延展',
    title: 'Orange Kitty · IP 形象设定',
    meta: '主视觉 · 三视图 · 表情 · 周边',
    kind: '图片',
    note: '一张设定图里同时给出正面 / 侧面 / 背面、四种表情与八个周边，形象前后一致。',
  },
  {
    key: 'burger-poster',
    src: '/works/burger-poster.jpg',
    alt: '汉堡品牌海报：四款汉堡沿铁轨排布，标题 FRESH BURGER COMING YOUR WAY',
    title: 'TrackSide Burger · 电商主视觉',
    meta: '产品海报 · 版式与文案 · 9:16',
    kind: '图片',
    note: '把四款产品排成一条动线，标题、卖点与角标都在一张竖版海报里。',
  },
  {
    key: 'kitty-motion',
    src: '/works/kitty-motion.jpg',
    alt: '15 秒动效成片的关键帧：橙猫角色圆形徽章，带 ORANGE KITTY 立体字',
    title: 'Orange Kitty · 15 秒动效',
    meta: '图生视频 · 徽章动效 · 720×1280',
    kind: '视频',
    note: '用同一套 IP 形象延展成 15 秒竖屏动效，可直接发短视频平台。',
  },
  {
    key: 'burger-film',
    src: '/works/burger-film.jpg',
    alt: '15 秒产品片的关键帧：四款汉堡沿铁轨排布的全景',
    title: 'TrackSide Burger · 15 秒产品片',
    meta: '分镜出片 · 运镜 · 720×1280',
    kind: '视频',
    note: '海报里的静态版式拆成分镜，做成有运镜的 15 秒产品片。',
  },
  {
    key: 'nuts-film',
    src: '/works/nuts-film.jpg',
    alt: '15 秒产品片的关键帧：坚果拼成的冬不拉立在沙丘上',
    title: '每日坚果 · 产品氛围片',
    meta: '产品氛围 · 材质合成 · 720×1280',
    kind: '视频',
    note: '把产品本身当材料拼成一把乐器，在沙丘里立起来，适合做开场钩子。',
  },
]
