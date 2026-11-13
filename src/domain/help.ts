// 帮助中心（v0.9.61）：三篇最常被问到的说明，公开可读（不登录也能看）。
// 只写产品真的怎么做：积分与退回、复刻/画布失败停在哪一步、素材与帧图去了哪儿。
// 地址：#/help 是目录，#/help/<slug> 是单篇（见 router.ts）；页面在 src/pages/HelpPage.tsx。
export type HelpSlug = 'credits' | 'replicate-failed' | 'copyright'

export type HelpStep = { title: string; text: string }

export type HelpSection = {
  heading: string
  paragraphs?: readonly string[]
  bullets?: readonly string[]
  steps?: readonly HelpStep[]
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
    slug: 'credits',
    title: '积分怎么用，失败了会不会白扣',
    summary: '哪些动作扣积分、失败怎么退回、余额不够找谁，以及去哪里对账。',
    kicker: '积分 / Credits',
    updatedAt: '2026-11-13',
    sections: [
      {
        heading: '哪些动作会消耗积分',
        bullets: [
          '检索一次：按服务端配置的单价扣；示例数据不扣积分。',
          '一键复刻一次：解析、抽帧、逐帧分析与写入模板库算一次。',
          '视觉评审一次：一次请求里的画面加一次判断结论。',
          '智能体对话一轮，或画布整条流程跑一次。',
        ],
        paragraphs: [
          '单价不是写死在界面里的数字，由服务端配置下发；「设置 → 积分」里能看到当前单价、余额，以及每一笔增减。改价之后那一屏会跟着变，帮助页不单独抄一份。',
        ],
      },
      {
        heading: '失败会不会白扣',
        paragraphs: [
          '不会。检索、复刻、评审、对话与画布运行失败，都会按账本原路退回；同一笔只退一次，重复触发不会退两遍。',
          '画布是先写运行记录再扣费：服务重启打断的那一次会被标成「已中断」，并按账本净额退回，而不是留在「运行中」把积分一直挂着。运行记录里的「已退回 N 积分」就是这件事的凭据。',
        ],
      },
      {
        heading: '余额不够怎么办',
        paragraphs: [
          '在「设置 → 积分」里提交积分申请，管理员会在后台看到并发放。充值通道还没开通，目前没有自助购买：积分是站内额度，不是货币，不能提现，也不能转赠。',
        ],
      },
      {
        heading: '对不上账时',
        paragraphs: [
          '流水里每一笔都有时间、动作、增减和当时的余额。把你觉得对不上的两笔时间与金额抄进反馈里（最好带上「设置 → 帮助与反馈」里那条记录的编号），管理员能按账本核对到具体某一次调用。',
        ],
      },
    ],
    related: ['replicate-failed', 'copyright'],
  },
  {
    slug: 'replicate-failed',
    title: '复刻、画布与出图失败了怎么办',
    summary: '先看停在哪一步：链接解析、视频信息、抽帧、视觉模型，还是上游出图服务。',
    kicker: '排障 / Troubleshooting',
    updatedAt: '2026-11-13',
    sections: [
      {
        heading: '一键复刻停在哪一步',
        steps: [
          { title: '获取视频与抽帧', text: '走远端算力服务或本地 FFmpeg。平台链接解析不了时，失败通常停在第一步。' },
          { title: '读取视频信息', text: '读时长、分辨率与切镜点。文件损坏、不是视频、或链接返回的不是视频流，会停在这里。' },
          { title: '抽帧与逐帧分析', text: '视觉模型不可用或返回内容不合法时暂停；这时积分会原路退回。' },
          { title: '写入模板库', text: '最后一步才是落库；这一步失败说明文件写不进去，找管理员看磁盘。' },
        ],
      },
      {
        heading: '平台链接解析不了',
        paragraphs: [
          '解析服务没接入时，弹窗里会直接说明，这时只能粘贴 mp4 直链先跑通拆帧与模板流程。换了直链仍然失败，多半是链接需要登录、已经过期，或者返回的是网页而不是视频文件。',
        ],
      },
      {
        heading: '画布出图 / 出视频失败',
        paragraphs: [
          '画布里的出图与出视频是把提示词转给上游生成服务，决定成败的是上游（额度、模型是否可用、参数是否被拒）。失败时节点上会显示上游返回的那段说明，平台不替它下结论。把提示原文贴进反馈，管理员能按请求编号查到上游那一刻返回了什么。',
        ],
      },
      {
        heading: '积分够不够',
        paragraphs: [
          '余额低于本次单价时按钮会直接变灰，并写明还差多少。积分规则见「积分怎么用」那一篇。',
        ],
      },
      {
        heading: '磁盘满了（素材到上限）',
        paragraphs: [
          '服务器上的帧图按模板归属算在创建人名下。管理员设了素材上限时，到顶之后一键复刻会在扣费前被拒绝（429，不扣积分）：删掉不用的模板、并在回收站里彻底删除，占用就降下来了；确实需要更多空间可以让管理员给账号单独放宽。',
        ],
      },
      {
        heading: '还是不行',
        paragraphs: [
          '把失败时间、运行或复刻的编号（界面上等宽字体那一串）和提示原文一起写进反馈。没有编号只能靠时间猜，有编号能直接定位到那一次调用。',
        ],
      },
    ],
    related: ['credits', 'copyright'],
  },
  {
    slug: 'copyright',
    title: '素材、帧图与对外交付的边界',
    summary: '平台保存什么、帧图什么时候删、交付稿上的 AI 标识，以及照着别人的爆款拍之前要确认什么。',
    kicker: '素材 / Source & Rights',
    updatedAt: '2026-11-13',
    sections: [
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
          '在反馈里贴链接说明情况，管理员会在后台处理这条举报（下架或保留），处理结果会记在后台。需要证据时请一并说明原作品地址。',
        ],
      },
    ],
    related: ['credits', 'replicate-failed'],
  },
]

export const HELP_SLUGS: readonly HelpSlug[] = HELP_ARTICLES.map((article) => article.slug)

export function isHelpSlug(value: string | null | undefined): value is HelpSlug {
  return Boolean(value) && (HELP_SLUGS as readonly string[]).includes(String(value))
}

/** 认不出的 slug 一律当目录页：坏链接不该把用户挡在「找不到页面」上。 */
export function findHelpArticle(value: string | null | undefined): HelpArticle | null {
  if (!isHelpSlug(value)) return null
  return HELP_ARTICLES.find((article) => article.slug === value) ?? null
}

export function relatedArticles(article: HelpArticle): HelpArticle[] {
  return article.related
    .map((slug) => HELP_ARTICLES.find((item) => item.slug === slug))
    .filter((item): item is HelpArticle => Boolean(item))
}
