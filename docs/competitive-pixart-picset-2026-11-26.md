# 竞品核实：含糊的「PixArt」与 picsetai.com（Picset / Picell）

- 调研人：竞品研究员（只读；未注册、未登录、未付费、未调用任何生成接口）
- 抓取日期：**2026-11-26**（下文所有 URL 的抓取日期均为此日）
- 预算与如实收尾：本次共 **13 次 web_fetch + 5 次 web_search**（其中最后一次检索因搜索服务欠费失败，见 §4）。抓不到的条目一律写「抓不到，原因：…」，不猜。
- 出处分档：**A** = 官网/官方元信息/官方 sitemap 明说；**B** = 第三方目录/应用商店；**C** = 未核实或推断。

## 0. 先解决「PixArt」到底指哪个东西

- **结论**：本次检索命中的「PixArt」主要是**开源扩散 Transformer 图像模型论文系列（PixArt-α / PixArt-δ）**，**不是** pixai.art，也**不是** PixVerse。依据：检索结果中与「PixArt」直接对应的是 arXiv 2310.00426《PixArt-α: Fast Training of Diffusion Transformer for Photorealistic Text-to-Image Synthesis》与 arXiv 2401.05252《PixArt-δ: Fast and Controllable Image Generation with Latent Consistency Models》（均为 ar5iv 论文全文镜像）【B】。
- **必须排除的同名噪声**：Google Play「Pixart - AI Art Ideas」（包名 im.pixart.app）与 App Store「PixArt AI: AI Image Generator」（id6749236127）是两个与论文模型无关的同名手机 App【B，仅见于检索标题，未抓其页面】。
- **PixVerse 不是 PixArt**：结果中的 pixverse.ai/ja/ai-info-page 与 /vi/ai-info-page 属于另一家独立 AI 视频平台的「给 AI 助手看的信息页」【B】。
- **pixai.art：未核实**。多轮检索均未返回 pixai.art 域名；唯一一次针对「pixai.art」的定向检索因搜索服务返回 HTTP 402 而失败，**因此本报告不能证实 pixai.art 的站点内容、功能或收费**。任务给定的「用 pixai.art 作参照」属**推断关系**，标 C。
- **机构归属：C（未核实）**。抓到的只有论文标题与正文镜像页，摘要片段未出现「华为 / Noah 实验室」字样，故不把机构写实，只按「开源扩散 Transformer 模型系列」处理。

## 1. 出处表

| 编号 | 页面 | URL | 档位 |
| --- | --- | --- | --- |
| S1 | PixArt-α 论文全文（ar5iv 镜像） | https://ar5iv.labs.arxiv.org/html/2310.00426v3 | B |
| S2 | PixArt-δ 论文全文（ar5iv 镜像） | https://ar5iv.labs.arxiv.org/html/2401.05252v1 | B |
| S3 | HuggingChat papers-content 里的 PixArt-α 正文镜像 | https://huggingface.co/buckets/huggingchat/papers-content/tree/2310/2310.00426.md | B |
| S4 | Picset 英文站首页 | https://picsetai.com/ | A |
| S5 | Picset 英文站 /pricing | https://picsetai.com/pricing | A（仅外壳） |
| S6 | Picset 英文站 /features | https://picsetai.com/features | A（仅外壳） |
| S7 | Picset 英文站 /about | https://picsetai.com/about | A（仅外壳） |
| S8 | Picset 英文站 /docs | https://picsetai.com/docs | A（仅外壳） |
| S9 | Picset 中文站首页 | https://picsetai.cn/ | A |
| S10 | Picset 英文站 sitemap | https://picsetai.com/sitemap.xml | A |
| S11 | 品牌升级后的新站 | https://picell.ai/ | A |
| S12 | App Store 中国大陆《Picset AI-商品套图与主图设计》 | https://apps.apple.com/cn/app/id6817697455 | B |
| S13 | NovaTools 工具页「Picell AI」 | https://www.novatools.cn/tools/picset-ai | B |
| S14 | 观猹「Picset - 猹评详情」 | https://watcha.cn/reply/26725 | B（正文抓不到） |
| S15 | 中文站 /about、/support | https://picsetai.cn/about 、https://picsetai.cn/support | A（仅外壳） |

## 2. PixArt-α / PixArt-δ（开源模型，不是产品平台）

### 定位
- **事实**：两篇连续工作的图像生成模型论文（α → δ），标题分别落在「快速训练扩散 Transformer 做照片级文生图」与「用 Latent Consistency Models 做快速可控生成」【B，S1/S2】。
- **判断**：这是**模型/论文级开源资产**，没有账号体系、没有定价页、没有 SaaS 前端——拿它跟「产品平台」比定位本身是错位的。可对标的只有**能力**，不是商业模式。

### 功能
- **事实**：能力范围＝文生图 + 可控/加速生成（LCM 蒸馏路线）【B，S1/S2】。
- **抓不到**：参数量、训练成本、显存要求、许可证是否允许商用——本次未抓 HuggingFace 模型卡与 LICENSE，**标 C，不写数字**。

### 收费
- **事实**：作为论文/开源权重，**没有官网定价页可抓**（不存在订阅制入口），因此「定价」一项对它无意义。
- **未核实（C）**：权重是否可商用、是否要求署名。

### 平台化
- **结论：几乎没有**。它交付的是「能跑出图的模型」，不含工作流、素材库、计费、账号、评审、交付任何一层。被产品化的方式是被绘图社区（如 pixai.art 一类，C）或自建服务包进去。

### 与我们的差距
- **完全没有**：自研/微调的扩散 Transformer 底座与蒸馏加速能力（我方图像能力全部来自上游模型）。
- **更弱**：单看「照片级写实」的模型级上限，我方受上游约束。
- **我们更强**：**产品层**——模板库、复刻七步、视觉评审、交付回执（zip + sha256 + 打开次数）、版本对比、工作流真扣费与失败退款。两边不重叠：它有模型没有产品，我们有产品没有模型。

## 3. Picset（picsetai.com，已改名 Picell AI → picell.ai）

### 定位
- **事实**：英文站标题「Picset - Professional AI E-commerce Design & Visual Style Cloning」；描述「Scale Amazon & Shopify sales with Picset. Transform photos into high-converting assets using automated product suites and pro style replication in seconds.」【A，S4】
- **事实**：中文站标题「Picset - 极致的AI电商详情图生成与风格复刻工具」，描述列出「AI 商品图生成、AI 商拍、电商主图制作、图片精修和 AI 视频创作」【A，S9】
- **事实**：首页关键词直接写 Amazon A+ content tool、Shopify visual optimization、product image generator、AI style transfer for e-commerce【A，S4】
- **给谁用（B 档）**：独立卖家、品牌方、跨境电商团队；覆盖 Amazon、Shopify、Shopee、TikTok Shop【B，S13】
- **判断**：**电商视觉垂直工具**，不是通用绘图社区。它卖的不是「一张图」，而是「能直接上架的详情页/主图套图」。

### 功能
- **A 档能确认的**：商品图生成、AI 商拍、主图制作、图片精修、AI 视频创作、风格复刻（官网自述范围，S4/S9）。
- **B 档（NovaTools 列 6 项核心功能）**：① 一键生成主图与详情页（自动规划详情页结构、支持自定义尺寸与风格）；② **爆款风格精准复刻**（上传参考图 + 产品图，克隆设计语言/配色/排版）；③ 服装系列图（模特试穿、白底图、人台图、细节卖点图）；④ 主体完整性 + 物理级光影（锁定产品结构/颜色/Logo）；⑤ 批量产品精修；⑥ 100% 商业版权保障（上传内容不公开、不用于训练）【B，S13】
- **B 档补充**：万能画布、电商视频、图片翻译/多语言广告图、最高 4K 导出、平台预设比例【B，S13】
- **抓不到**：模型型号、单次生成耗时、是否有对外 API、是否有 MCP/Agent 入口——官网正文抓不到，第三方目录也未提。

### 收费
- **B 档**：NovaTools 标「**$5/月起**」，并标「网页版」「中文、English 等 11 种语言」【B，S13】
- **抓不到，原因**：https://picsetai.com/pricing 返回 **HTTP 200，但只是一份 React SPA 的 head 骨架**（正文由 JS 渲染，抓取器拿到的是同一份 index.html），因此**档位名称、计费单位（订阅/积分/按张）、免费额度全部未核实（C）**。同一现象见 /features、/about、/docs、picsetai.cn/about、picsetai.cn/support（S5–S8、S15）。

### 平台化
- **事实（是 SaaS，不是服务商/外包）**：纯网页版 SaaS + 移动端 App——App Store 中国大陆有《Picset AI-商品套图与主图设计》（id6817697455），发行商「**跳帧工场(杭州)科技有限公司**」【B，S12】；中文站挂百度统计与简体中文包，英文站挂 GA，双站双品牌【A，S4/S9】。
- **事实（多语言铺开）**：sitemap 声明 **13 个 hreflang**（en、zh-CN、zh-TW、ja、ko、id、ms、th、vi、de、fr、it + x-default），lastmod 2026-05-23、changefreq daily【A，S10】→ 主攻**跨境出海**，不只做国内。
- **事实（品牌迁移，关键情报）**：picsetai.com 首页内联脚本写明：生产域（仅 picsetai.com）对**登录与未登录用户都弹不可关闭的「品牌升级」弹窗**，点击跳 https://picell.ai（登录用户带 token 过去）；.cn / picell / test / 本地环境**完全不触发**【A，S4】。picell.ai 首页 title 与 description 与 Picset **逐字相同**、只把品牌名换成 Picell【A，S11】；NovaTools 的 FAQ 亦确认「原 Picset AI 现已正式全面升级为 Picell AI」【B，S13】。
- **判断**：**picsetai.com 正在退役**。长期竞品跟踪对象应改为 picell.ai；本仓库若要做竞品截图或录入，别固化成 Picset 旧名。

### 与我们的差距
**A. 我们完全没有**
1. **平台专属预设**：Amazon A+ / Shopify / TikTok Shop 的尺寸、比例、规范与 4K 导出（我方无电商平台规格层）。
2. **图片级「爆款风格复刻」**：参考图 + 产品图直接克隆配色/排版/设计语言（我方复刻是**视频拆解**七步，不产出可上架的详情页版式）。
3. **服装系列图**：模特试穿、人台、白底、细节卖点图一键批量。
4. **主体完整性锁定**（结构/颜色/Logo 不失真）+ 3D 摄影棚级光影重建的对外承诺。
5. **批量精修**：抠图、打光、瑕疵修复、色彩校正、背景优化批处理。
6. **多语言图片翻译 / 广告图出海**：一键多语种出图（我方无翻译链路）。
7. **移动端 App**：App Store 已上架；我方只有 Web。
8. **对外价格语言**：对方能写「$5/月起」；我方 server/plans.mjs 只定义「多少钱换多少积分」，付款通道未接，且缺口审计指出 VQ_BILLING_MODE 默认 auto 会在无支付回调下直接到账。

**B. 有但明显更弱**
1. **商品图生成**：我方有上游图像模型与九节点工作流，但没有「电商详情页」这层成品形态（无套图排版、无平台规范模板）。
2. **风格一致性**：对方把「主体完整性」做成卖点算法；我方靠提示词约束，无对外承诺。
3. **国际化**：对方 13 语言站点 + 11 语言界面；我方以中文为主，无 hreflang 体系。
4. **入口**：对方 App + Web 双入口、自助注册；我方 VQ_REGISTRATION=0，开号靠邀请码或管理员。

**C. 我们更强**
1. **「复刻 → 评审 → 交付 → 回执 → 版本对比」是闭环的**：zip + sha256 + 回执打开次数 + 项目版本 diff；对方官网与第三方目录均未见同等交付物（第三方只讲出图，不讲交付与验收）。
2. **视觉评审是真能力**（service / local-model 双 provider + 证据锚点 + 评审队列）；对方只有出图，没有质量门。
3. **失败退款与断点续跑**已实现（工作流真扣费、失败全额退回、run resume）；对方未见任何失败退款规则，B 档目录也未提。
4. **平台/画布/智能体形态**：工作流画布、无限画布、房间智能体 + vqc_ 令牌 + MCP 端点；对方是**单点工具 SaaS**，本次未抓到任何 API / Agent / 插件入口。
5. **爆款检索（红狐）+ 来源足迹**：对方靠「你上传参考图」，我方有可检索的爆款库与来源记录。

## 4. 抓不到 / 未核实（如实收尾）

| 项 | 结论 | 原因 |
| --- | --- | --- |
| pixai.art 站点内容 | 未核实 | 多轮检索未命中该域名；定向检索时搜索服务返回 **HTTP 402 Insufficient Balance**（搜索端点欠费），此后无法再检索 |
| PixArt-α 机构归属 | C | 抓到的是论文正文镜像与标题，片段未出现机构名；未抓 arXiv 官方页 |
| PixArt 许可证 / 商用条款 | C | 未抓 HuggingFace 模型卡与 LICENSE |
| Picset 档位、计费单位、免费额度 | 未核实 | /pricing 返回 HTTP 200，但只是 SPA 的 head 骨架，无正文 |
| Picset 是否开放 API / 是否有 MCP | 未核实 | 官网正文抓不到，第三方目录未提 |
| 观猹「猹评详情」正文 | 未核实 | https://watcha.cn/reply/26725 返回 200，正文为前端渲染，抓取器只拿到样式表 |
| Picset 现名与 picell.ai 的产品范围 | 部分确认 | picell.ai 首页 title/description 与 Picset 逐字相同【A】，功能列表只能引第三方【B】 |

**给下一手的提醒**：① 追踪对象改 picell.ai；② 要拿 Picset 价格必须用真实浏览器打开 /pricing（SPA 渲染），静态抓取永远拿不到；③ 搜索服务当前欠费（402），需要联网检索的复核任务请先确认额度。
