// 帮助中心（r313）：公开可读的四篇产品说明，不登录也能打开。
// 地址：#/help 是目录，#/help/<slug> 是单篇（见 router.ts）；页面在 src/pages/HelpPage.tsx。
// 只写产品真的怎么做：快速上手、核心功能、积分与额度、协议与合规；
// 工作流是管理员 beta，不在这份用户帮助里占一节。
export type HelpSlug = 'quick-start' | 'features' | 'credits' | 'compliance'

/** 旧地址还留在按钮与历史书签里：认出来，映射到新文章，不让链接变成 404。 */
export type LegacyHelpSlug = 'replicate-failed' | 'copyright'

export type HelpStep = { title: string; text: string }

export type HelpLink = { label: string; href: string; text?: string }

export type HelpSection = {
  heading: string
  paragraphs?: readonly string[]
  bullets?: readonly string[]
  steps?: readonly HelpStep[]
  links?: readonly HelpLink[]
}

export type HelpArticle = {
  slug: HelpSlug
  title: string
  /** 目录页的一句话：这条回答的是哪个问题 */
  summary: string
  /** 眉标里的英文分类，和全站其它区块一致 */
  kicker: string
  updatedAt: string
  sections: readonly HelpSection[]
  /** 相关文章的 slug：读不懂这一篇时最该接着看的那几条 */
  related: readonly HelpSlug[]
}

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'quick-start',
    title: '六步跑通第一条内容',
    summary: '从注册、身份引导与第一套资产开始，到找爆款、拆模板、出片与评审。',
    kicker: '快速上手 / Quick start',
    updatedAt: '2026-11-25',
    sections: [
      {
        heading: '先按这六步走',
        steps: [
          { title: '注册并登录', text: '用邮箱或手机号登录；注册关闭时，需要管理员发的邀请码。新账号默认送 50 积分。' },
          { title: '完成身份引导', text: '第一次进工作台会要求选身份、类目与方向。身份是必填项，选完才会进入下一步。' },
          { title: '建第一套资产', text: '去「我的资产」建产品套图或数字人套图。至少留一张主图，出图时才能拿它当参考。' },
          { title: '在爆款雷达找一条', text: '按关键词检索抖音与小红书内容，看互动数据与结构，挑一条值得拆的加进模板库。' },
          { title: '在模板库拆结构', text: '点「去解析」后，平台会拆出脚本、分镜与每段台词的预计时长；只存链接与结构，不下载原片。' },
          { title: '开作品、出片、评审', text: '把模板开成作品，改脚本后逐镜出图或出视频；拿不准的画面送去视觉评审，按证据改。' },
        ],
      },
      {
        heading: '开始前准备什么',
        bullets: [
          '一套能代表商品或人物的清晰图片：正面、细节、常用场景各一张就够用。',
          '一个具体的关键词或选题方向，检索结果才不会太散。',
          '想清楚这条内容发在哪：竖版短视频、横版介绍或方形图，后面的比例按它选。',
        ],
      },
      {
        heading: '卡住时先看哪一篇',
        paragraphs: [
          '找不到入口就看「核心功能说明」；被扣了积分或想退款看「积分与额度」；素材授权与对外发布看「协议与合规」。三篇都解决不了，就在页面底部提交反馈。',
        ],
        links: [
          { label: '核心功能说明', href: '#/help/features' },
          { label: '积分与额度', href: '#/help/credits' },
          { label: '协议与合规', href: '#/help/compliance' },
        ],
      },
    ],
    related: ['features', 'credits'],
  },
  {
    slug: 'features',
    title: '核心功能都做什么',
    summary: '爆款雷达、模板库、我的作品、我的资产、快捷创作、无限画布与视觉评审。',
    kicker: '功能 / Features',
    updatedAt: '2026-11-25',
    sections: [
      {
        heading: '爆款雷达：先找值得拆的内容',
        paragraphs: [
          '按关键词检索公开的抖音与小红书内容，结果里会标出互动数据和库里是否已经有这一条。检索按次扣积分，不点就不会自己跑；示例数据不扣积分。',
        ],
      },
      {
        heading: '模板库：存的是结构，不是原片',
        paragraphs: [
          '把一条内容加进模板库后点「去解析」，平台会拆出脚本、分镜、镜头语言与台词时长。这里保存的是公开链接与解析结果，不保存来源平台的原始视频文件，也不提供原片下载。',
        ],
      },
      {
        heading: '我的作品：一条内容的主线',
        paragraphs: [
          '作品把脚本、分镜、逐镜画面与评审结论放在同一处。每镜可以单独出图或出视频，也可以选用自己的资产当参考；做到能拍、能发之后，再从这里交付。',
        ],
      },
      {
        heading: '我的资产：商品图与数字人',
        paragraphs: [
          '产品资产放商品主图、细节与场景；数字人资产放人物正面、侧面与定妆。建好之后，画布节点和作品逐镜出图都能直接选这套资产当参考，人物与商品换镜头时更稳定。',
        ],
      },
      {
        heading: '快捷创作：对话与单张生成',
        paragraphs: [
          '在对话里写需求，或直接开生图、生视频窗口。适合先试一个画面、一段镜头，不必先建整条作品；生成结果会进最近生成，也能再拿去作品里用。',
        ],
      },
      {
        heading: '无限画布：自由摆放与试排',
        paragraphs: [
          '把参考图、提示词与生成结果摆在一块无限画布上，边试边改。它适合找构图和镜头关系；真正要交付时，再把选中的画面放回作品里。',
        ],
      },
      {
        heading: '视觉评审：按证据给结论',
        paragraphs: [
          '评审会看画面并给出结论与问题，每条尽量指向具体位置。它可以评作品里的某一镜，也可以单独上传图片；评审按次扣积分，失败会退回。',
        ],
      },
      {
        heading: '这些入口在哪里',
        bullets: [
          '爆款雷达、模板库、我的作品与我的资产在左侧一级导航。',
          '快捷创作、无限画布、视觉评审与积分记录在「工具」区。',
          '头像、口令、积分余额与反馈在左下角「设置」。',
        ],
      },
    ],
    related: ['quick-start', 'credits'],
  },
  {
    slug: 'credits',
    title: '积分怎么扣，失败了会不会白扣',
    summary: '哪些动作扣积分、失败怎么退回、新手 50 积分、余额与充值入口。',
    kicker: '积分 / Credits',
    updatedAt: '2026-11-25',
    sections: [
      {
        heading: '哪些动作会消耗积分',
        bullets: [
          '检索一次：按服务端当前单价扣；示例数据不扣积分。',
          '一键复刻一次：解析、抽帧、逐帧分析与写入模板库算一次。',
          '视觉评审一次：一次请求里的画面加一次判断结论。',
          '对话一轮、快捷创作出图或出视频：按所选模型与服务端单价扣。',
        ],
        paragraphs: [
          '单价不写死在界面里，由服务端配置或模型卡下发；「设置 → 积分」和「积分记录」能看到当前价、余额与每一笔扣费。出图按张算，视频按时长与清晰度算，改价之后那两屏会跟着变。',
        ],
      },
      {
        heading: '失败与超时怎么退',
        paragraphs: [
          '不会白扣。检索、复刻、评审、对话与生成失败或超时，都会按账本原路退回；同一笔只退一次，重复触发不会退两遍。',
          '服务重启打断的那一次会被标成「已中断」，并按账本净额退回，而不是留在「运行中」把积分一直挂着。积分记录里的「已退回 N 积分」就是这件事的凭据。',
        ],
      },
      {
        heading: '新账号的 50 积分',
        paragraphs: [
          '新账号注册后默认到账 50 积分，入账会写进积分流水，不是只改一个余额数字。管理员开通的账号按后台设置发放；具体数额以注册页和积分记录为准。',
        ],
      },
      {
        heading: '余额、流水与充值入口',
        paragraphs: [
          '左下角「设置 → 积分」看余额、单价与本月消耗；左侧「积分记录」按笔看扣费、退款与充值。余额不够时，去「充值」页选一档；支付通道没接入时会明确写「内测直充」，不会扣真实款项。',
        ],
        links: [
          { label: '打开积分记录', href: '#/runs', text: '看每一笔扣在哪' },
          { label: '打开充值页', href: '#/recharge', text: '余额不够时选一档' },
        ],
      },
      {
        heading: '对不上账时',
        paragraphs: [
          '积分记录里每一笔都有时间、动作、增减和当时的余额。把你觉得对不上的两笔时间与金额抄进反馈里（最好带上记录的编号），管理员能按账本核对到具体某一次调用。',
        ],
      },
    ],
    related: ['quick-start', 'features'],
  },
  {
    slug: 'compliance',
    title: '协议、隐私与素材边界',
    summary: '服务条款、隐私说明、素材来源与下架入口，以及对外发布前要确认的授权与 AI 标识。',
    kicker: '协议 / Legal & rights',
    updatedAt: '2026-11-25',
    sections: [
      {
        heading: '先读这三份公开说明',
        paragraphs: [
          '使用平台前先看服务条款；涉及个人信息与数据保存看隐私说明；素材被误收录、需要下架或投诉，走素材来源与下架页。三份都公开可读，不需要登录。',
        ],
        links: [
          { label: '服务条款', href: '#/legal/terms', text: '账号、使用规则与责任边界' },
          { label: '隐私说明', href: '#/legal/privacy', text: '收集哪些数据、保存多久' },
          { label: '素材来源与下架', href: '#/sources', text: '来源说明、投诉与下架' },
        ],
      },
      {
        heading: '平台保存了什么',
        paragraphs: [
          '复刻时平台只保存公开链接、作者、互动数据，以及解析出来的脚本结构与分镜文本；不保存来源平台的原始视频文件，也不提供原片下载。',
        ],
      },
      {
        heading: '帧图去了哪儿',
        paragraphs: [
          '抽出来的帧图只用于视觉分析与模板预览，跟着模板走：删除模板时帧图一并删除。帧图不用于对外展示，也不会出现在分享页上。',
        ],
      },
      {
        heading: '对外交付带 AI 标识',
        paragraphs: [
          '从平台拿出去的每一份产物都带「AI 生成」标识：交付稿文首有说明，打印稿、现场页与评审对照纸的品牌行上也有，分享页顶部与底部同样标出。标识是事实标注，不代表平台做过人工审核；去掉或篡改标识再对外发布，责任由发布者承担。',
        ],
      },
      {
        heading: '照着别人的爆款拍之前',
        paragraphs: [
          '模板库里的公共模板带着第三方平台的封面与作者名，只用于看结构与镜头语言。素材、音乐与出镜授权要你自己确认：平台不替使用者取得授权，也不保证某条内容可以商用。',
        ],
      },
      {
        heading: '发现侵权内容',
        paragraphs: [
          '在反馈里贴链接说明情况，或从「素材来源与下架」提交；管理员会在后台处理这条举报（下架或保留），处理结果会记在后台。需要证据时请一并说明原作品地址。',
        ],
        links: [
          { label: '提交下架或投诉', href: '#/sources' },
        ],
      },
    ],
    related: ['features', 'credits'],
  },
]

export const HELP_SLUGS: readonly HelpSlug[] = HELP_ARTICLES.map((article) => article.slug)

const LEGACY_SLUGS: Record<LegacyHelpSlug, HelpSlug> = {
  'replicate-failed': 'features',
  copyright: 'compliance',
}

export function isHelpSlug(value: string | null | undefined): value is HelpSlug {
  const slug = String(value || '')
  return (HELP_SLUGS as readonly string[]).includes(slug) || Object.prototype.hasOwnProperty.call(LEGACY_SLUGS, slug)
}

/** 认不出的 slug 一律当目录页；旧地址映射到新文章，坏链接不该把用户挡在「找不到页面」上。 */
export function findHelpArticle(value: string | null | undefined): HelpArticle | null {
  if (!isHelpSlug(value)) return null
  const raw = String(value)
  const slug = Object.prototype.hasOwnProperty.call(LEGACY_SLUGS, raw) ? LEGACY_SLUGS[raw as LegacyHelpSlug] : raw
  return HELP_ARTICLES.find((article) => article.slug === slug) ?? null
}

export function relatedArticles(article: HelpArticle): HelpArticle[] {
  return article.related
    .map((slug) => HELP_ARTICLES.find((item) => item.slug === slug))
    .filter((item): item is HelpArticle => Boolean(item))
}
