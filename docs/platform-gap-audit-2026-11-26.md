# VisionQA 平台缺口审计（0.9.289 · 2026-11-26）

审计对象：`D:\Projects\creator-canvas-studio` 当前工作区（package.json 0.9.289）。只读：未改 src/ server/ test/，未跑 npm test/build，未做任何 git 操作（分支与提交状态未读取），未调用任何生成、写入或上游接口。

线上实测（2026-11-26 11:57，仅两条允许的 GET）：

- `GET /api/version` → `{"ok":true,"version":"0.9.289","name":"VisionQA"}`
- `GET /api/health` → `{"ok":true,"redfox":true,"vision":true,"llm":true,"templates":27,"uptimeSec":2617}`（模板 27 条；服务刚重启 43 分钟）

证据写法：`文件:行号` 是当前工作区代码；`接口 + 返回` 是线上真实返回；没有证据的地方会写「未验证」。状态分三类：**【不存在】**、**【有壳没通】**、**【能跑但有已知缺口】**。

已知、不再展开（一行带过）：直连 BYOK 未做；平台智能体工具逐次批准未做；平台智能体工具与扣费本期进行中（聊天室 r315 已上线 `vqc_` 令牌与 MCP 端点）；短信运营商实名报备中；支付商户号未开。

---

## 结论先行

1. **注册到第一次生成，代码是通的，但入口是独木桥**：自助注册默认关闭（`VQ_REGISTRATION=0`），开号靠邀请码或管理员建号；手机号只能登录，不能注册、不能找回口令。首套资产免费，所以「第一次生成」本身不依赖 50 积分。
2. **复刻七步都有代码，两个真实上游是红狐与视觉模型**；缺的是音轨、ASR、BGM——分镜里的口播原文和 `audio` 字段是模型看着帧猜的，不是从原片转写的。这是全平台最「假」的一步：它看起来像拆解，交付出去的是二次创作。
3. **两块画布不是一回事**：工作流（#/canvas）是本仓库 9 种节点 + 真扣费 + 失败退款 + 断点续跑；无限画布（#/board）是外部 Source-Available 进程，本仓库只有 iframe、120 秒信任票据和排队位，能力与失败都无法从本仓库审计。
4. **评审→交付→回执这条链是闭合的**（zip + sha256 + 回执打开次数 + 版本对比），但「交付」不看评审结论，分享链接永久有效且无口令。
5. **账务最危险的不是支付没接，而是计费模式默认落在 auto**：任何登录账号 `POST /api/billing/orders` 就直接到账、订单标 paid，后台文案却还写着「下单返回 501」。这一条要么线上显式关了，要么现在就在白送积分。

---

## 一、按「最假的一步先修」排序

> 排序依据：这一步的输出会不会被用户当真拿去用 × 错了要赔多少（钱/信任）。每条给现象、证据、影响、最小修法（1–2 天可落地）。

### 1【P0】复刻的「口播原文」与「audio」不是从原片来的

- **现象**：模板 JSON 里每段有 `voiceover`（口播原文）、每镜有 `audio`（人声/音效/BGM），界面上是可复制的文案；实际模型只收到 18 张静音帧和切镜点，口播是按画面编的，`audio` 只能写「不确定」。
- **证据**：抽帧用 `-an` 丢掉音轨（`server/frames.mjs:58`）；提示词直接要求「即使原片没有人声和字幕，也要给出可执行的建议口播」（`server/vision.mjs:21`），并要求 `audio` 字段（`server/vision.mjs:17`）；只有 BGM 曲名允许写「不确定」（`server/vision.mjs:22`）。
- **影响**：用户拿「复刻」产出的脚本文案去拍，与原片口播是两套词；「拆结构」被理解成「拆文案」，评审与交付都建立在推测文案上。
- **最小修法**：`ffmpeg -vn` 抽一条 16k 单声道音轨，接一个 ASR 上游（火山/Whisper 任一）把转写结果填进 `voiceover`，并在 UI 标注「口播原文：转写 / 建议」；没有 ASR 就先把这两个字段在界面上标成「建议文案」，别让它们看起来像原文（改动在 `server/vision.mjs` 的 normalize 与模板详情渲染）。

### 2【P0】充值默认 auto，会在没有任何支付回调的情况下直接到账

- **现象**：`VQ_BILLING_MODE` 不写、或写成 off 以外的任何值，都按 auto 处理；auto 下 `POST /api/billing/orders` 直接落一条 `status: 'paid'` 的订单并 `grant` 积分，没有支付回调、没有管理员工单确认。后台「计费」页却写着「下单接口会返回 501，不会有假订单」。
- **证据**：`server/config.mjs:237`（只有显式 `off` 才是 off）；`server/routes/billing.mjs:19` 与 `:88-89`（auto 文案 + paid 订单 + grant）；`src/pages/admin/BillingSection.tsx:286` 与 `server/readiness.mjs:32` 都还写着 501。
- **影响**：线上只要配了档位、env 又没显式 `VQ_BILLING_MODE=off`，任何账号点一下就能白拿积分并立刻消耗上游额度；账本、订单、就绪页三处口径互相矛盾。
- **最小修法**：把默认值翻到 off（`off` 为默认，`auto` 必须显式开），订单先落 `pending`，由后台「计费」页确认收款后再 `grant`；同时在 readiness 里把「模式」这一项暴露出来（1 天，改动集中在 config/billing/readiness）。

### 3【P0】新用户入口只有邀请码；手机号不能注册，也不能找回口令

- **现象**：登录页的短信入口只在后台配了短信通道时出现，且只给「已存在账号」发码（未注册号码不发、但仍回同一句话）；找回口令只走邮件，没配 SMTP 时页面如实写「找管理员」。
- **证据**：`server/config.mjs:345`（`VQ_REGISTRATION === '1'` 才允许自助注册）；`deploy/env.production.example:74`（生产样例就是 `VQ_REGISTRATION=0`）；`server/routes/auth.mjs:167`（邀请制始终可用）、`:172`（`passwordReset: await mailConfigured()`）、`:212-243`（发码前先查账号，查不到就跳过发送）、`:305`（注册只收邮箱）。
- **影响**：对外发布时第一个动作就是「请找我们要邀请码」；手机号用户在注册、找回两条路上都不是一等公民，客服成本全落在管理员手动建号/重置。
- **最小修法**：注册接口加 `phone + code` 分支（复用 `sms-login.mjs` 的签发/校验），找回口令加「短信验证码重置」；或先批量签一批邀请码放到登录页入口（半天）。两条都不需要改库结构。

### 4【P0】引导第二步承诺「决定模板推荐」，但没有任何推荐读取类目/方向

- **现象**：引导收身份（自媒体创作者/电商产品生产/品牌代运营）、类目、方向三件事，文案写「这一步决定资产类目与之后的模板推荐」。实际 `identity` 只用于引导状态与账号导出，`category` 只进资产提示词，`direction` 存进 JSON 后没有任何读取方；模板库按类型/平台/来源筛，没有类目维度。
- **证据**：`server/onboarding.mjs:16-31`（枚举）、`:105-108`（落库）、`:140-155`（view）；`server/asset-prompts.mjs:89-108`（类目只进资产提示词）；`src/pages/TemplateLibraryPage.tsx` 无 `category`（0 处）；`src/components/OnboardingGate.tsx:602`（那句承诺）。
- **影响**：用户认真选完，工作台仍是一屏通用内容；这是「第一步就假」——引导的唯一实际产出是资产默认类目。
- **最小修法**：二选一——要么按 `category` 给模板库加一个默认筛选（读 `onboardingOf`，模板补类目标签），要么把文案改成「用于生成时的风格与资产类目」，别再承诺推荐（0.5–1 天）。

### 5【P1】数字人资产只是定妆参考图，却按「数字人」命名

- **现象**：数字人资产产出的是几张定妆参考图，用来当出图/出视频的参考；不做唇形驱动，不直接出说话视频。产品自己在引导里写明了这一点，但入口、命名、资产卡都叫「数字人」。
- **证据**：`src/components/OnboardingGate.tsx:725`（「这一版只是定妆参考图，不做唇形驱动，也不会直接出说话视频」）；`server/assets.mjs:1-10`（定位：复刻链路的参考源）；`server/flow-image.mjs:111-113`（参考图走 `/images/edits`）。
- **影响**：电商/自媒体对「数字人」的预期是能出镜口播，实际拿到的是参考图；第一次用会觉得被骗，而不是「能力有限」。
- **最小修法**：资产页与选择器统一改叫「人像参考」，卡片上写清「用于出图/出视频的参考」；真要口播视频需要 TTS + 对口型，不在 1–2 天内，先别用「数字人」承载预期（文案层改动，1 天）。

### 6【P1】逐镜出图默认不带商品参考图

- **现象**：工作流按分镜建出图节点时 `assetRef` 跟着作品的 `assetRef` 走，而新建作品时该字段默认空串；只有用户在作品页手动选了「参考资产」，出图才走带参考图的上游通道。
- **证据**：`server/projects.mjs:740`（`assetRef: ''` 默认）；`server/script-draft.mjs:73` 与 `:97`（节点带 `assetRef`）；`server/flows.mjs:82-83`（空 = 纯文生图）、`:967`/`:990`（读参考资产）；`server/flow-image.mjs:128`（结果里标注用了哪套）。
- **影响**：复刻出来的每一镜是「像原片」，不是「像我的商品」；这恰好是产品主线承诺的差异点。
- **最小修法**：开作品/开工作流时若账号有 `product` 资产则默认带第一个（作品页仍可改），并在运行前顶栏写明「本次带参考资产：xxx」（1 天）。

### 7【P1】交付不看评审结论

- **现象**：交付包（zip + 交付稿 + 回执链接）可以直接生成，不检查这一版是否评过、结论是否通过；交付稿里只是把评审结论抄成一段文字。
- **证据**：`server/projects.mjs:2386-2405`（生成包 + 回执 token，无 verdict/decision 判断）；`server/project-deliverable.mjs:103-108`（把状态与人工复核写进正文）、`:214`（没送评审时写「这一版还没送评审」，仍可出稿）。
- **影响**：未过审的稿子也能交出去，且回执、台账、访问计数一应俱全，看起来比过审的还正规；评审这道门在交付环节等于不存在。
- **最小修法**：交付动作前查 `decisionFor`/最近 verdict，`fail` 或无评审时给二次确认并写进交付记录（`delivery.gate`），后台台账可筛（1 天）。

### 8【P1】分享链接永久有效、无口令

- **现象**：作品/模板分享靠一枚随机 token 当唯一凭证，公开视图不需要登录；能撤销（删除 token），但没有有效期、没有访问口令、没有次数限制。分镜帧图也走同一枚 token。
- **证据**：`server/project-share.mjs`（token 即凭证，白名单视图）；`server/projects.mjs:1560`（签发）、`:1596-1598`（删 token 即撤销）；`server/routes/project-share.mjs:3-5`、`:285-308`（帧图与访问计数同一 token）；模板同理 `server/templates.mjs:732`、`:756`。
- **影响**：链接被转发/进群后长期可见，含客户商品图与分镜；出问题只能整条撤销，已发出去的回执链接一起失效。
- **最小修法**：加可选 `expiresAt` 与 4–6 位访问口令（哈希存，分享页输一次记 cookie），撤销时只失效分享不动回执（1–2 天，改动在 projects/project-share/routes）。

### 9【P1】无限画布不在本仓库，只有壳

- **现象**：#/board 是一个 iframe，指向另一套 Source-Available 的无限画布进程（本机 6677/5312/5313）。本仓库只做三件事：探活、签发 120 秒信任票据换它会话、代转它画布里的图/视频并校验归属。它的节点能力、失败归类、计费、并发都不在本仓库。
- **证据**：`server/bdc.mjs:4-15`（源码不随本仓库分发）、`:26-43`（探活）、`:45-58`（本机 HMAC 调用）；`server/canvas-session.mjs:15-27`（票据 120 秒、未配密钥即关闭）；`src/pages/BoardPage.tsx:179-207`、`:504`（iframe + postMessage 票据）；`src/domain/board-canvas.ts`。
- **影响**：作品流、评审落笔记、交付都依赖这个外部进程；许可证禁止再分发源码，客户现场部署要另装一套；它的失败只能显示「画布没有返回」，没有归类。
- **最小修法**：把 `bdcStatus` 的三个探活结果并进 `/api/health`（现在只有 redfox/vision/llm 三个布尔），未部署时画布页给明确降级说明而不是空白 iframe；把它的失败文案统一走 `public-error`（1 天）。

### 10【P2】模板没有质量分

- **现象**：模板只有数量、平台分布、来源分布、复用点击计数，以及「现在有几条作品在用它」；没有「这个模板好不好用」的分数，也没有按结果排序。
- **证据**：`server/templates.mjs:677-693`（`templateStats` 只统计）；`server/template-usage.mjs:1-6`（在用作品数现算）；`server/templates.mjs:131-145`。
- **影响**：模板库只能按时间/平台排，好模板沉底；运营也没法用「交付率/过审率」判断哪条值得推。
- **最小修法**：用已有数据算一个展示分：用过它的作品里 `delivered` 与 verdict=pass 的比例（数据都在 projects.json，1 天），先只展示不排序。

### 11【P2】视觉模型默认指向本机代理，漏配要到复刻 70% 才炸

- **现象**：`VISION_BASE_URL` 默认 `http://127.0.0.1:10100/v1`（开发机代理），生产漏配时不会在启动/提交时拦，而是在抽帧、切镜都跑完、进入「逐帧分析」时才失败。失败会退款，但 ffmpeg 与等待都白花。
- **证据**：`server/config.mjs:55-58`（默认本机，只有本机才读本地 token）、`:89-95`；`deploy/env.production.example:102-103`（生产必须显式给值）；`server/jobs.mjs:334`（vision 步骤在 70%）；退款在 `server/jobs.mjs:176-188`。
- **影响**：新环境部署最常见的一次失败；用户等 1–3 分钟拿到「模型未配置」，复刻这条主线的第一印象就毁了。
- **最小修法**：`POST /api/replicate` 前先查 `visionEnabled()`（已有函数），未就绪直接 400 并给「去哪里配」；`/api/health` 把 vision 的 baseUrl 来源（env/vault/本机）带出来（0.5 天）。

### 12【P2】余额阈值只展示、不告警；复刻失败无重试

- **现象**：上游余额页能设阈值并显示「低」，但不会触发告警；告警通道只有 webhook（飞书/钉钉/Slack/自建），没有短信/邮件兜底。复刻任务失败后没有「重试」入口，只能重新提交一次（重新扣费，失败已退）。
- **证据**：`server/upstream-balance.mjs:275-277`（阈值只存）、`:150-164`（只算 state）；`server/alert-channel.mjs:1`、`:93-101`（只有 webhook + 签名）；`server/jobs.mjs` 无 retry 分支（0 处）。
- **影响**：上游欠费/见底时先坏的是用户请求，后知后觉；复刻偶发失败时用户要重走一遍解析。
- **最小修法**：`balanceState` 变 low 时 `recordAlert`（已有），webhook 挂上即可；给失败任务加「用同一地址重试」按钮（复用 `startReplicate`，1 天）。

### 13【P2】窄屏的真实边界是「能看能评，不能连线」

- **现象**：产品自己在手机提示里写明：手机也能检索、挑素材、送评审；画布连线与逐帧评审建议在电脑上做。响应式做了（App.css 20 处断点、canvas.css 12 处、board.css 4 处），但工作流节点拖拽、无限画布 iframe 的触控体验没有真机证据。
- **证据**：`src/App.tsx:1236`（那句提示）；`src/domain/mobile-note.ts:1-5`（一次即隐）；`src/styles/canvas.css`、`src/styles/board.css` 的 `@media`。
- **影响**：不是缺陷，是承诺边界；风险在于对外宣传「手机可用」时被理解成全部可用。
- **最小修法**：登录页/落地页把这句话前置成一句能力说明；工作流页在 ≤760px 直接给只读运行视图（数据已有），别让用户点进拖不动的画布（1 天）。

---

## 二、新用户从注册到第一次做成东西

| 步骤 | 状态 | 证据 | 会卡在哪 |
| --- | --- | --- | --- |
| 邮箱注册 | 【能跑但有已知缺口】默认关闭，邀请码可自助开号 | `server/config.mjs:345`；`server/routes/auth.mjs:167`、`:305-320`；`server/invites.mjs` | 没有邀请码就没有入口；邀请码由后台签发 |
| 短信验证码登录 | 【能跑但有已知缺口】只服务已有账号 | `server/routes/auth.mjs:212-243`（未注册号码不发码）、`:256-292` | 不能注册；未配短信通道时入口不显示（`deploy` 样例 + 报备中，已知） |
| 找回口令 | 【能跑但有已知缺口】只走邮件 | `server/routes/auth.mjs:172`；`server/password-reset.mjs`；`server/readiness.mjs:48-54` | SMTP 未配时只能找管理员 |
| 身份引导 | 【能跑但有已知缺口】三步、身份必填 | `src/components/OnboardingGate.tsx:449-504`、`:741`；`server/onboarding.mjs:94-127` | 只在 `kind==='account'` 弹；完成必须至少见到一张图 |
| 建产品/数字人资产 | 【能跑但有已知缺口】真生成，首套免费 | `server/assets.mjs:1-10`、`:33-35`（产品 6 套 / 数字人 3 套）、`:182-189`；`server/routes/assets.mjs:41-92` | 生成要 1 组图，失败有 `partial`；来源图是必填（`:308`） |
| 赠送 50 积分 | 【能跑但有已知缺口】写账本 | `server/config.mjs:164`；`server/routes/auth.mjs:286-289`；历史账号补发 `server/credits.mjs:179-183` | 无 |
| 第一次生成 | 【能跑但有已知缺口】首套资产免费，之后按模型价逐张扣（默认模型约 3 积分/张） | `server/assets.mjs:44-48`（与出图同一价）、`:315-320`（首套 0 元）；`server/media-pricing.mjs:1-9`（成本 × 1.1 × 每元积分）；复刻 10 见 `server/config.mjs:182` | 生成前不校验模型是否就绪（见第 11 条） |

结论：这条链在代码层面是完整闭环，**唯一真正会拦住陌生人的是入口**（邀请制 + 手机号不能注册）。引导本身不产生「第一件作品」，只产生「第一套资产」；从资产到作品还要用户自己点模板/复刻。

---

## 三、复刻七步

| 步 | 实现 | 上游 | 证据 | 缺口 |
| --- | --- | --- | --- | --- |
| 1 解析 | 分享页 URL → 可播直链 | 红狐（按次计费） | `server/redfox.mjs:296-300`（download 端点）、`:248-262`（检索） | 依赖平台与红狐可用性；无缓存直链 |
| 2 下载 | 本机 fetch 落盘，200MB/90s 上限 | 无（直连 CDN） | `server/media-fetch.mjs:9-11` | 无断点续传 |
| 3 ffprobe | ffprobe-static 读时长/分辨率/帧率 | 无 | `server/frames.mjs:6-10`、`:22`；`server/jobs.mjs:314` | 无 |
| 4 切镜 | ffmpeg 场景检测（scene>0.3） | 无 | `server/frames.mjs:30`；`server/jobs.mjs:319-321` | 硬切阈值写死，快剪/转场会漏 |
| 5 抽帧 | 480 宽、最多 18 帧 | 无 | `server/frames.mjs:59`、`:74-90`；`server/config.mjs:130` | 帧少，长视频靠 18 帧代表 |
| 6 视觉出 JSON | OpenAI 兼容多模态，8000 token，2 次重试 + 模型降级 | 视觉模型（按配置的 baseUrl） | `server/vision.mjs:35-84`、`:7-23`；`server/config.mjs:55-95` | 不接音轨；`audio`/口播是推测；无 ASR/字幕识别 |
| 7 落模板 | 模板入库 + 帧图拷贝 + 公共模板 | 无 | `server/jobs.mjs:340-352`；`server/templates.mjs:226-263`、`:245` | 无质量分/无审核（上架只校验来源 URL：`server/templates.mjs:163`） |

**产出形态**：一条模板 = `title / contentType / tags / hook / hookType / structure(≤12 段) / storyboard(≤24 镜) / analysis / frames[] / platform / source / 时长`；同时可按脚本生成一张工作流草稿（输入 + 复刻提示词 + 最多 12 个出图节点，`server/script-draft.mjs:14-16`）。

**远端算力**：配了 `REPLICATE_REMOTE_URL` 时，解析/下载/探测/抽帧交给外部 worker（`server/remote.mjs:5-7`），本机只收帧；本仓库带 `worker/video-worker.mjs`，但线上是否启用属未验证。

**音轨/ASR/文案字幕/BGM**：音轨【不存在】（`-an`）；ASR【不存在】；字幕只从画面里读（模型可能读到屏幕字）；BGM【不存在】，提示词只允许写「不确定」。

---

## 四、工作流画布与无限画布

| 维度 | 工作流 #/canvas | 无限画布 #/board |
| --- | --- | --- |
| 代码归属 | 本仓库 `src/canvas/*` + `server/flows.mjs` | 外部进程（源码不随仓库分发）`server/bdc.mjs:4-15` |
| 节点能力 | 9 种：输入 / 大模型 / 知识库 / 工具 / 条件 / 出图 / 出视频 / 评审 / 输出（`src/canvas/catalog.ts:31-151`）；工具只有 3 个：模板统计、模板检索、当前时间（`:192-196`；服务端同三件 `server/flows.mjs:28-31`，其中「当前时间」是验证链路用的）；评审 4 个角度（`:185-190`） | 自由摆放、就地出图出视频；评审结论只能作为文本节点写进去（`src/pages/BoardPage.tsx:449`） |
| 准入 | beta，仅管理员（`server/workflow-beta.mjs:27-29`、`server/routes/flows.mjs:166`） | 登录即可，走 120 秒信任票据换会话（`server/canvas-session.mjs:15-47`） |
| 计费 | 整条运行 2 积分（`server/config.mjs:186`）+ 出图/出视频按模型单价（`/api/flows/meta` 下发两张价格表：`server/flow-image.mjs:27`、`server/flow-video.mjs:37-53`），扣费在前、失败全额退（`server/flows.mjs:682-701`） | 由画布自己的服务扣费，宿主只下发积分口径（`server/bdc.mjs:39-41`） |
| 失败归类 | 有中文映射（余额不足/凭证/限流/截断，`server/public-error.mjs:25-45`），但只落成 `run.error` 字符串与节点 `status`，没有可筛的错误类型 | 只有「画布没有返回 / 读不到」，归类在外部服务 |
| 运行恢复 | 有断点续跑：只复用成功/不支持的节点（`server/flows.mjs:701`）、停止按已跑结算（`:1255-1280`） | 无运行概念，画布上直接发生 |
| 模板 | 没有内置工作流模板：`src/canvas/catalog.ts` 只有节点元数据、无流程预设，模板库里 `kind==='flow'` 的条目来自用户把工作流存成模板（`server/templates.mjs:315`）；空状态只列自己的作品与模板（`src/domain/canvas-start.ts:56-63`） | 不适用 |
| 生成能力对等 | 出图、出视频都有（`server/flow-image.mjs`、`flow-video.mjs`），另有评审节点 | 出图、出视频都有；没有评审节点，靠把结论推过来 |

线上 `templates:27` 是模板库总数（含复刻、改编、工作流模板），不是工作流模板数。

---

## 五、评审 / 作品 / 模板 / 交付包 / 分享

| 环节 | 状态 | 证据 | 缺什么 |
| --- | --- | --- | --- |
| 视觉评审 | 【能跑但有已知缺口】单张图评审，5 积分，失败退款 | `server/routes/review.mjs:304`、`:389`/`:399`；`src/api/review.ts:157`（media/imageUrl/projectId） | 评审对象是一张图，不是整条视频；逐帧要人一张张送 |
| 人工拍板 | 【能跑但有已知缺口】通过/不通过，按评审时间绑定 | `server/review-decisions.mjs:83-104`；`server/project-status.mjs:9-12`、`:38-45` | 新评审自动让旧拍板失效（有意）；没有审批人角色 |
| 作品版本 | 【能跑但有已知缺口】版本、脚本 copy-on-write、逐镜画面、对比 | `server/project-script.mjs:1-6`；`server/project-shots.mjs`；`server/version-diff.mjs` | 无 |
| 模板 | 【能跑但有已知缺口】从复刻/工作流/改编入库，可分享 | `server/templates.mjs:163`、`:315`、`:362-393` | 无质量分（见第 10 条）；上架只校验来源 URL |
| 交付包 | 【能跑但有已知缺口】zip + sha256 + 校验页 + 回执 + 打开次数 | `server/delivery-packages.mjs:46-67`、`:152-166`；`server/routes/deliveries.mjs` | 不看评审结论（见第 7 条） |
| 回执/催办/回复 | 【能跑但有已知缺口】回执链接、重发、改收件人、等待关闭、回复、确认 | `server/projects.mjs:994-1132`（reminder/resend/relink/recipient/wait-close）、`:169-171` 与 `:1872`（`/api/receipts/:id/ack`） | 回执确认只有 ack，不回流到作品状态 |
| 分享 | 【能跑但有已知缺口】作品/模板/离线包/打印对照纸，访问计数 | `server/routes/project-share.mjs:3-9`、`:119-308`；`server/share-visits.mjs` | 无有效期/口令（见第 8 条） |
| 版本对比 | 【能跑但有已知缺口】作品版本字段差异 + 运行输出对比 | `server/version-diff.mjs`；`src/components/VersionCompareModal.tsx`；`src/domain/run-diff.ts` | 无 |

---

## 六、账务与运营

| 项 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- |
| 积分账本 | 【能跑但有已知缺口】流水有 delta/balance_after/kind/ref，余额与流水同事务改 | `server/credits.mjs:39`（写入列）、`:274`（查询）、`:100`（退款幂等按 ref 求和）；kind 字典在 `:195-209` | 口径清楚，能对账 |
| 充值/支付 | 【有壳没通】订单 + 档位 + 后台定价，但无支付渠道；auto 模式直接到账 | `server/routes/billing.mjs:88-89`；`server/plans.mjs:1-4` | 见第 2 条；商户号未开是已知 |
| 订单核对 | 【不存在】后台没有订单页，`/api/billing/orders` 只回自己的 | `server/routes/billing.mjs:52-60`；`src/pages/admin/BillingSection.tsx`（只有档位，无订单） | 充值到账后管理员看不到订单流水 |
| 配额 | 【能跑但有已知缺口】月度上限，默认 0 = 不限 | `server/quota.mjs:8-12`、`:63` | 对外收费前必须显式设一个 |
| 上游余额 | 【能跑但有已知缺口】一个渠道自动读（New API），另一个只能手工登记 | `server/upstream-balance.mjs:28-39`、`:174-212` | 阈值不告警（见第 12 条） |
| 告警 | 【能跑但有已知缺口】webhook（飞书/钉钉/Slack/自建）+ 签名 + 失败重投 | `server/alert-channel.mjs:1`、`:93-101`；`server/alerts.mjs`（outbox） | 无短信/邮件告警；无余额联动 |
| 备份 | 【能跑但有已知缺口】独立 systemd 进程，加密 + sha256 + 校验 + 保留份数 | `server/backup-status.mjs:1-40`；`deploy/backup.sh`、`visionqa-backup.timer` | 本机是否装了 timer 属未验证 |
| 短信通道 | 【能跑但有已知缺口】后台配通道，逐条记录发送结果 | `server/sms-config.mjs`、`sms-send.mjs`、`sms-usage.mjs`；后台「用量」页 `src/pages/admin/UsageSection.tsx` | 实名报备中（已知） |
| 邮件通道 | 【能跑但有已知缺口】后台配 SMTP，找回口令/告警可用 | `server/mail-config.mjs`、`mailer.mjs`；`server/readiness.mjs:48-54` | 未配即降级为「找管理员」 |
| 后台管理 | 【能跑但有已知缺口】账号/邀请/额度/计费/模型/Key/路由/网关/上游余额/用量/成本/水线/存储/告警/邮件/短信/审计/反馈/举报/画布/模板/站点/就绪 | `server/routes/admin.mjs`（61 个 pathname 分支）；`src/pages/admin/*` | 缺订单页（上）；缺模板上架审核流 |

---

## 七、权限与安全

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 登录态 | 服务端会话，cookie `HttpOnly` + `SameSite=Lax`，`Secure` 需显式开 | `server/auth.mjs:430-444`；`server/config.mjs:335-340` |
| CSRF | 写请求校验同源 Origin | `server/routes/auth.mjs:144-154`、`:205-208` |
| 后台隔离 | `/api/admin/*` 统一 403（`NOT_ADMIN`） | `server/routes/admin.mjs:59`、`:133` |
| 下载归属 | 画布文件先验归属再代理；上传/分镜图按 ownerId 校验 | `server/routes/works.mjs:52-55`；`server/project-shots.mjs:22-45` |
| `vqc_` 令牌 | 只存哈希、可吊销；但**没有有效期、没有 scope**，拿到即以该成员身份收发消息 | `server/agent-access.mjs:58-73`、`:201-205`、`:304-320`；`server/routes/agent.mjs:121-169` |
| 画布互信 | 120 秒一次性票据，未配共享密钥即关闭（fail-closed） | `server/canvas-session.mjs:15-27` |
| 分享/回执 | token 即凭证、公开可读；分镜帧图同一 token | `server/routes/project-share.mjs:3-9` |
| 限流 | 滑动窗口按 IP + 桶，短信有冷却与次数上限 | `server/ratelimit.mjs`；`server/sms-login.mjs` |

`vqc_` 令牌无过期是本期新入口（r315）最该补的一处：现在只有手动吊销（`agent_tokens.revoked_at`），泄露后长期有效。

---

## 八、移动端 / 窄屏

- 能做：检索、挑素材、送评审、看作品与模板、快捷创作（对话/生图/生视频）、设置与账号。响应式断点齐全（`src/App.css` 20 处、`canvas.css` 12 处、`board.css` 4 处）。
- 不建议：工作流连线与拖拽、逐帧评审、无限画布 iframe（产品自己在 `src/App.tsx:1236` 写了「画布连线与逐帧评审建议在电脑上做」）。
- 未验证：真机 375/390 宽下的资产生成弹窗、评审对照纸、引导三步的可用性（只有 CSS 与代码证据，无真机截图）。

---

## 九、未验证（不要当成结论）

- 生产 `/etc/visionqa/env` 实际值：读不到，所以「充值是 off 还是 auto」「SMTP/短信是否已配」「是否启用了远端算力」都只能按代码默认值推断。
- 线上 `/api/auth/config` 不在本次允许的接口清单内，没有调用；因此短信入口在线上到底露不露，未验证。
- 无限画布内部（节点、失败、计费）源码不在本仓库，只审计了宿主侧的壳。
- 备份 timer、systemd 服务状态只在仓库里有 unit 文件，主机上是否安装未验证。
- 真机窄屏、iOS Safari 的 iframe 票据行为未验证。

---

## 附：线上返回原文

```
GET /api/version
{"ok":true,"version":"0.9.289","name":"VisionQA"}

GET /api/health
{"ok":true,"redfox":true,"vision":true,"llm":true,"templates":27,"uptimeSec":2617}
```

`uptimeSec: 2617` 说明这次审计时服务是刚重启的实例；`health` 只回答三个上游布尔与模板数，不回答「复刻七步各自能不能跑」，这也是第 11 条想补的那一项。
