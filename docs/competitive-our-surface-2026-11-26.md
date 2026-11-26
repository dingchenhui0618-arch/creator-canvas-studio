# VisionQA 今天真实有什么（0.9.290 · 2026-11-26）

只读盘点，对象是当前工作区 `D:\Projects\creator-canvas-studio`。基线：`package.json` 版本 **0.9.290**；`test/` 下 269 个 `*.test.mjs`；`src/pages/` 下 25 个页面 + `src/pages/admin/` 25 个后台构件。最近一次有记录的全量单测是 2001/2001（`docs/r312-asset-refs-2026-11-25.md:45`）；线上最近可核对的版本是 0.9.289（`docs/platform-gap-audit-2026-11-26.md` 附录的原样返回）。

分类口径（三类，互斥）：
- **①端到端跑通**：有单测/端到端脚本，或有一次真实上游调用记录（文档里的实测数字、生产截图、线上返回）。
- **②代码在但从未真调**：接口、界面、单测都写完了，但没有任何一次真实调用记录；关键路径只有假上游或断言钉住。
- **③占位 stub**：只有壳、开关或文案，没有可执行实现。

证据里 `文件:行号` 指当前工作区；转引自文档的会在句内写明文档名。**本文件不写「计划中 / 应该有 / 即将」**。

## 一、侧栏页面与路由

- 一级 5 项：工作台 / 我的作品 / 爆款雷达 / 模板库 / 聊天室（Beta），`src/nav.ts:40-47`；「我的资产」紧跟工作台，`src/nav.ts:50-56`。
- 工具区 4 项：快捷创作 / 无限画布 / 视觉评审 / 积分记录，`src/nav.ts:59-64`；设置固定在底部 `:77-83`；本地工作区只在桌面外壳出现 `:86-92`。
- 工作流是 beta，默认只对管理员露出：`src/nav.ts:66-74` + `src/domain/features.ts:36-38` + `server/workflow-beta.mjs:27-30`（fail-closed）。
- 用户页面 14 个（`src/router.ts:69-85`）；另有对话预设编辑器、帮助、素材来源、条款、分享、回执、找回口令 7 类独立地址 `:51-65`。
- 整屏不进工作台外壳的路由：帮助 / 条款 / 来源 / 分享 / 回执 / 重置，`src/router.ts:107-117`。
- 地址唯一真源是 `location.hash`，对象级地址齐全：`#/projects/<id>/delivery/<deliveryId>`、`#/templates/<id>`、`#/review/<id>`、`#/board/<id>`、`#/canvas/<flowId>/run/<runId>`，`src/router.ts:176-236`。
- 老地址兼容：`#/canvas/project/<id>` 自动改写为 `#/board/<id>`，`src/router.ts:208-211`。
- 未保存离开的拦截在路由层一次拦全（侧栏、命令面板、页内链接、浏览器后退），`src/router.ts:392-401`。
- 后台 `#/admin/<section>` 共 11 个 section，`src/editions.ts:64-76`；非管理员一律回用户版 `:110-117`。
- 分类 **①**：全部页面可渲染，且有多轮真实渲染截图（`docs/r313-*`、`docs/r315-*`、`docs/r316-*`、`docs/r317-*`）。
- 与 README 不一致：`README.md` §一 仍写「工作台 / 作品 / 发现 / 模板库」四项一级导航，实际以 `src/nav.ts` 为准。

## 二、找爆款 / 发现

- 页面 `src/pages/RadarPage.tsx`（882 行）；侧栏名「爆款雷达」，`src/nav.ts:43`。
- 服务端 `GET /api/search`，`server/index.mjs:722`；按次扣积分（`beginPaid(..., 'search', ...)` `:735`），上游失败全额退 `:757`。
- 真实上游是红狐；抖音有播放量、小红书没有，取不到就空着不做估算，`src/domain/radar.ts:16-17`。
- 三条降级路径都写明「这是示例数据」：未接 Key `server/index.mjs:730-733`；凭证不可用 3105 `:761-770`；额度不足 `:771-781`。
- 检索历史只存条件与结果条数，不存结果本身（结果会过期），`src/domain/radar.ts:321-331`。
- 卡片「加入模板库」只落链接 + 互动数据，不下载视频、不抽帧，`server/index.mjs:922-929`。
- 分类 **①**：有真实数据记录（`README.md` §二 两张实拍 + 2026-11-09 线上；`/api/health` 的 `redfox:true` 见 `docs/platform-gap-audit-2026-11-26.md` 附录）。
- 边界：红狐额度与凭证是可变的；一旦失效走上面三条降级，界面明说、且不扣费。

## 三、复刻七步（谁在跑、真实上游、产出、哪一步是编的）

- 七步都在服务端 `server/jobs.mjs` 里跑，前端只轮询 `GET /api/jobs/:id`（`server/index.mjs:836-841`）；进度点 `server/jobs.mjs:302 / 314 / 319 / 324 / 334 / 340 / 352`。
- 1 解析：`acquireVideo` 取可播直链，`server/jobs.mjs:303`；真实上游 = 红狐。
- 2 下载：本机 fetch 落盘，200MB / 90s 上限、无断点续传（`docs/platform-gap-audit-2026-11-26.md` §三，代码在 `server/media-fetch.mjs`）。
- 3 ffprobe：`probeVideo` 读时长 / 分辨率 / 帧率，`server/frames.mjs:12-25`。
- 4 切镜：ffmpeg 场景检测 `scene>0.3`，`server/frames.mjs:28-36`；阈值写死，快剪与转场会漏。
- 5 抽帧：一次解码出全部帧、`-an` 丢音轨、480 宽、最多 18 帧，`server/frames.mjs:53-63`、`:58`、`:59`、`:76`。
- 6 视觉出 JSON：多模态模型、8000 token、输出整套模板 JSON，`server/vision.mjs:35-45`、`:7-23`；真实上游 = 配置里的 OpenAI 兼容视觉模型。
- 7 落模板：`createTemplate` + 帧图拷贝，`server/jobs.mjs:340-352`。
- 产出形态：title / contentType / tags / hook / hookType / structure / storyboard / analysis / frames / platform / source / durationSec，`src/domain/radar.ts:161-225`。
- **模型编的那一步**：`voiceover`（口播原文）与每镜 `audio`。音轨在抽帧时就被 `-an` 丢掉（`server/frames.mjs:58`），提示词却明确要求「即使原片没有人声和字幕，也要给出可执行的建议口播」，只允许 BGM 曲名写「不确定」，`server/vision.mjs:21-22`。
- 音轨 / ASR / 字幕转写 / BGM 识别：**不存在**（全链路没有音频分支）。
- 远端算力：配了 `REPLICATE_REMOTE_URL` 时前四步交给外部 worker（`server/remote.mjs`，`README.md` §二）；本机是否启用未验证。
- 分类 **①**：端到端跑通（`README.md` §二 远端算力实拍：5 帧 640×360）；但第 6 步的文案是二次创作，不是原文。

## 四、模板库

- 五种来路：saved（只存链接）/ replica（跑过复刻）/ adapted（改编）/ flow（画布另存）/ agent（对话草稿），`src/domain/radar.ts:164-165`。
- 六个来源胶囊：radar / project / agent / canvas / adapted / shared，`src/domain/radar.ts:351`。
- `GET /api/templates` 支持 q / type / source；来源写错直接 400，不静默退化成「全部」，`server/index.mjs:972-980`。
- 「复用」真建一张工作流：工作流模板按 blueprint 原样建回节点与连线，普通模板建「输入 + 复刻脚本」两节点，`server/index.mjs:845-919`。
- 「改编」把一条模板改成自己的一版并存成新模板，`server/index.mjs:952-970`。
- 线上条数：`templates:27`（`docs/platform-gap-audit-2026-11-26.md` 附录）。
- 分类 **①**（生产 27 条；`test/templates.test.mjs`、`test/template-source.test.mjs`、`test/template-lineage.test.mjs`）。
- 缺：没有质量分，只有数量 / 来源 / 复用点击 / 「几条作品在用」（`docs/platform-gap-audit-2026-11-26.md` §一.10）；上架只校验来源 URL。

## 五、作品与交付回执

- 作品：建 / 改 / 版本归档 / 逐镜画面槽 / 脚本 copy-on-write，`server/projects.mjs:720`、`:755`、`:1410`、`:846`、`:1375`。
- 交付包封存：`saveDeliveryPackage` 写 sha256 与包内清单（上限 60 条），`server/delivery-packages.mjs:51`；包不好不挡「标记交付」`:10`。
- 回执链是闭的：签发 token `server/projects.mjs:1140`；按 token 查 `:1181`；收包人贴收据 `:1254`；只说「收到了」`:1284`；催办 `:986`；重发链接 `:1015`；换新链接 `:1105`（最多 2 次 `:397`）；等不到关闭 `:1047`；改收件人 `:1316`；回复 `:1346`。
- 覆盖面：`test/delivery-*.test.mjs` 24 个（重放 / 重发 / 换链接 / ack / 收件人 / 等待 / 回复 / 催办）。
- 交付记录里存了交时评审快照（`server/projects.mjs:290-295`），但**不作准入**：没评过、评不过都能生成 zip 与回执链接。
- 分享 token 即凭证、公开可读，可撤销但没有有效期与访问口令（`docs/platform-gap-audit-2026-11-26.md` §一.8）。
- 封存包有独立巡检：`/api/health` 会 stat 每份包并报「丢 / 大小变」，`server/health.mjs:48-87`。
- 分类 **①**：生产有真实交付包与回执记录。

## 六、工作流画布（节点类型）

- 9 种节点：input / llm / kb / tool / condition / image / video / review / output，`src/canvas/catalog.ts:31-151`。
- 工具节点只有 3 个：模板库统计、模板检索、当前时间，`src/canvas/catalog.ts:192-196`。
- 评审节点 4 个角度：品牌一致性 / 构图与主体 / 文案与卖点 / 可读性与无障碍，`src/canvas/catalog.ts:185-190`。
- 出图 / 出视频的比例、时长、清晰度选项与服务端 `server/media-models.mjs` 一一对应，前端不许自加，`src/canvas/catalog.ts:160-182`。
- 准入：beta，默认只给管理员，`server/workflow-beta.mjs:27-30`；直连 `#/canvas` 的普通账号落到 Beta 说明页（`src/domain/features.ts:37-38`）。
- 计费：整条运行 + 出图/出视频按模型价，先扣后跑、失败全额退（`docs/platform-gap-audit-2026-11-26.md` §四）。
- 运行可靠性：断点续跑、停止按已跑结算、失败有中文归类（同上 §四）。
- 分类 **①**：`test/flow-run-{stop,resume,queue,recovery}.test.mjs` 4 个，加上 `test/flow-image-node`、`test/flow-video-node`、`test/queue-cancel`、`test/run-graph-snapshot`。
- 缺：没有内置流程模板——`src/canvas/catalog.ts` 只有节点元数据、没有预设图。

## 七、无限画布（仓库里到底有什么）

- 仓库里**没有**无限画布本体：`#/board` 是 iframe，指向另一套 Source-Available 进程，`server/bdc.mjs:4-15`。
- 宿主只做四件事：三路探活（6677 / 5313 / 5312）并给 `deployed`（`server/bdc.mjs:26-43`）；按账号列画布（`server/index.mjs:431-435`）；认领一块 `:438-458`；往画布里落一条评审笔记 `:472-484`。
- 归属：先到先得但不许抢别人的，老画布只给管理员，`server/canvas-owner.mjs`（`test/canvas-owner.test.mjs`）。
- 前端用 iframe + postMessage 换 120 秒一次性信任票据（`src/pages/BoardPage.tsx`、`server/canvas-session.mjs:15-27`，据 `docs/platform-gap-audit-2026-11-26.md` §一.9）。
- 不可审计的部分：它的节点能力、失败归类、计费、并发都在外部进程里。
- 分类：宿主壳 **①**（`test/board-canvas.test.mjs`、`test/canvas-isolation-r296.test.mjs`、`test/canvas-owner.test.mjs`）；画布本体按外部依赖记，不属于本仓库三类中的任何一类。

## 八、视觉评审

- 接口：`POST /api/review`、`GET /api/review/health`，`server/routes/review.mjs:221`。
- 两种 provider 按顺序试：先 VisionQA 插件服务（默认 `127.0.0.1:6300`），连不上或失败退本地视觉模型，结果里写清 provider，`server/review.mjs:137-219`。
- **插件服务那条分支是死路**：请求里硬编码 `provider: 'mock'`，`server/review.mjs:150`；返回的 note 自己写着「fixture provider 时只证明链路可用，不代表模型准确率」`:166`。
- 本地模型那条是真跑的：visual-baseline 七维、每条结论必须带 bbox 锚点、修正建议有界，`server/review.mjs:13-31`；实测 72.9s 出结论（`README.md` §五，provider 写的是 local-model）。
- 模型读图能力本身验过：`deepseek-flash` 读 1024×1024 PNG，1154ms / HTTP 200（`docs/models-live-check-2026-11-19.md:12`）。
- 判断层（Jev）可选：没配 Key 就 `status=disabled`，评审照常出结论，`server/judge.mjs:13`。
- 评审对象是**一张图**，不是整条视频；逐帧要人一张张送（`docs/platform-gap-audit-2026-11-26.md` §五）。
- 分类：本地模型路径 **①**；插件服务分支 **②**（契约在、从未以真 provider 调过）。

## 九、快捷创作（出图 / 出视频 / 参考素材 / 最近生成 / 扣费）

- 页面 `src/pages/AgentsPage.tsx`（3008 行）；侧栏名「快捷创作」，`src/nav.ts:60`；对话预设与生图/生视频共用一条生成表单 `:1716-1717`。
- 契约：`POST /api/media/generate`、`GET /api/media/tasks`、`GET /api/media/models`、`POST /api/media/assets`（原始字节，不走 base64），`src/api/media-gen.ts:131-207`。
- 最近生成：按任务号往回翻；5 秒轮询只读元数据、不打上游、不扣积分，`src/api/media-gen.ts:158-163`；翻过页只插新行、旧行不动，`src/domain/media-recent.ts:11-19`。
- 扣费：服务端扣、失败全额退，前端只拿任务状态与鉴权下载地址，`src/api/media-gen.ts:1-2`；余额刷新走 `vq:credits` 一个事件 `:124-129`。
- 真实调过的只有两条通道：`gpt-image-2` 文生图、`seedance-2.0` 视频（4s/8s、480p/720p），`server/media-models.mjs:146`、`:149`。
- 参考图能力全部未验：五条通道的 `referenceVerified` 全是 false，`server/media-models.mjs:144-149`；`/images/edits` 从上线至今没有一次真实调用（`docs/models-live-check-2026-11-19.md:14`、`docs/r312-asset-refs-2026-11-25.md:60`）。
- 视频通道 2026-11-19 实测是坏的：上游出片成功但取不回（证书错 + 418），`docs/models-live-check-2026-11-19.md:15-16`；11-18 那批下载成功过，属上游回归。
- 分类：文生图 / 文生视频 **①**；参考图出图、参考素材生视频 **②**（multipart 与 `asset://` 只有单测钉住）。

## 十、聊天室（1a / 1b / 1c）

- 1a 房间骨架：四张表 + SSE；匿名 `GET /api/rooms` 与 `/stream` 都 401；已上生产 0.9.288，`docs/deploy-r315-2026-11-25.md:33-38`。
- 1b 接入：配对码换 `vqc_` 令牌；两张表 `pair_codes` / `agent_tokens`，令牌只存 sha256 与前缀，`docs/visionchat-1b-2026-11-26.md:13-19`。
- 1b 接口：`/api/agent/{pair,me,token,inbox,room,messages,read}` + `POST /mcp` + `GET /visionchat.md`，`docs/visionchat-1b-2026-11-26.md:31-43`；令牌不是登录态（打 `/api/rooms` 得 401）`:49`。
- 1c 回话：房间只有一个平台智能体时人每说一句它接，多个只接被 @ 的；一轮 1 积分、先扣后调、失败全额退回，`docs/r317-room-agent-2026-11-26.md:19-23`。
- 1c 工具：登记 7 个、只开 `templates.list`（只读、不花积分），其余 6 个「调了只回还没开」，`docs/r317-room-agent-2026-11-26.md:30-40`。
- 1c 工具协议：模型输出一行 JSON（tool / args），最多 2 轮，不依赖上游 function calling，`docs/r317-room-agent-2026-11-26.md:24`。
- 1c 未做：没有逐次批准、写操作工具一个没接、不做流式、智能体之间不互相接话（maxDepth=1），`docs/r317-room-agent-2026-11-26.md:82-86`。
- 1c 的验证用本地假 `/v1` 代替模型；真模型下的语气与长度没验过，`docs/r317-room-agent-2026-11-26.md:57`、`:86`。
- 分类：1a / 1b **①**（1b 有 `scripts/visionchat-e2e.mjs` 跑通「人说话 → 连接器 → 本地命令 → 房间回话」，`docs/visionchat-1b-2026-11-26.md:79-89`）；1c 链路 **①**（`test/room-agent.test.mjs` 15 条），1c 真模型 **②**。
- 上线状态：只有 1a 在生产；1b 与 1c 停在 master（`docs/visionchat-1b-2026-11-26.md:105`、`docs/r317-room-agent-2026-11-26.md:92`）。

## 十一、数字人与素材资产

- 两类资产：产品（1–3 张来源图 → 白底 / 场景 / 细节 / 平铺 4 张）与数字人（1 张正脸 → 定妆 / 半身 / 侧脸 / 场景 4 张），`docs/r311-asset-onboarding.md:27-33`。
- 上限与价：产品 6 套 / 数字人 3 套，`server/assets.mjs:32-42`；单价与快捷创作出图同价 `:44-48`；首套 4 张免费、失败作废不算用掉 `:10-11`。
- 归属：目录第一层就是账号 id，别人的资产一律 404；生成只能拿自己上传的素材做参考，`server/assets.mjs:6-11`。
- 资产引用已接四处（工作流出图 / 出视频 / 作品逐镜 / 快捷创作），解析只有 `server/asset-ref.mjs` 一个入口，`docs/r312-asset-refs-2026-11-25.md:14-23`。
- 三条硬规矩：先读资产再扣钱、不许静默降级成纯文生图、只碰自己的 `n_shot_*` 节点，`docs/r312-asset-refs-2026-11-25.md:27-33`。
- **「数字人」只是定妆参考图**：不做唇形驱动、不直接出说话视频（`src/components/OnboardingGate.tsx:725`、`docs/r311-asset-onboarding.md:99`）。
- 分类：建资产 / 上传 / 归属 / 列表 / 删除 **①**（`test/assets.test.mjs` 11 条、`scripts/assets-smoke.mjs` 22 项）；**真出图 ②**——T1/T2 两组真调都没跑（`docs/r311-asset-onboarding.md:90-95`、`docs/r312-asset-refs-2026-11-25.md:60-61`）。

## 十二、积分与计费

- 账本：`credit_ledger` 带 delta / balance_after / kind / ref，退款按 ref 净额算、重复收尾不多退（`server/credits.mjs`；`test/credits-ledger.test.mjs`、`test/usage-meter.test.mjs`）。
- 价格口径只有一处：扣费 = 上游成本 ×（1+10%）× 每元积分（默认 1 元 = 10 积分），向上取整，`server/media-pricing.mjs:1-9`、`:58-62`。
- 图片按张、视频按「秒 × 清晰度」报价，价表由服务端算好下发，`server/media-pricing.mjs:64-84`。
- 充值：档位 + 订单 + 后台定价都在，没有支付通道（商户号未下来）。
- **计费模式默认落在 auto**：`VQ_BILLING_MODE` 不写或写错都按 auto，`server/config.mjs:237`；auto 下下单即 `paid` 并 grant 积分（`docs/platform-gap-audit-2026-11-26.md` §一.2）。
- 后台文案还写着「下单接口会返回 501，不会有假订单」，`src/pages/admin/BillingSection.tsx:286`——与上一条直接矛盾。
- 分类：账本 / 扣费 / 退款 **①**；支付通道 **③**（未实现）；「充值到账」是内测直充，不扣真实款项。

## 十三、后台管理

- 11 个 section：总览 / 账号 / 无限画布 / 模型与上游 / 模板治理 / 成本 / 计费 / 举报处理 / 反馈 / 运行审计 / 系统，`src/editions.ts:64-76`。
- `/api/admin/*` 共 61 个 pathname 分支（`server/routes/admin.mjs` 内逐条 `pathname === '/api/admin…'`），统一 `isAdmin` 403。
- 入口只有 `?edition=admin`；非管理员即使带这个参数也会被剔掉，`src/editions.ts:110-117`、`:164-173`。
- 已有面：账号 / 邀请 / 额度 / 计费档位 / 模型目录 / Key 池与路由 / 网关 / 上游余额 / 用量 / 水线 / 存储 / 告警 / 邮件 / 短信 / 审计 / 反馈 / 举报 / 画布 / 模板 / 站点 / 就绪。
- 缺：没有订单页——充值到账后管理员看不到订单流水（`docs/platform-gap-audit-2026-11-26.md` §六）；没有模板上架审核流。
- 分类 **①**：`test/admin-access`、`test/admin-one-place`、`test/admin-kind`、`test/admin-identity` 等 + 后台多屏截图（`docs/r313-admin-sidebar-1440.png`）。

## 十四、短信 / 邮件 / 告警

- 短信：阿里云通道；真发过一条（650ms 受理、约 ¥0.045），并用这枚码真换到 `vq_session`，`docs/sms-login-live-2026-11-18.md:30-35`。
- 短信只服务**已有账号**：未注册号码不发码但仍回同一句话（`docs/platform-gap-audit-2026-11-26.md` §一.3）；用的是赠送签名，移动报备中、联通/电信待验证，自申请签名审核未通过，`docs/sms-login-live-2026-11-18.md:60`。
- 短信用量逐条落库，后台「用量」页可看（`server/sms-send.mjs`、`server/sms-usage.mjs`；`test/sms-usage.test.mjs`）。
- 邮件：后台配 SMTP，找回口令走邮件（`test/mail-smtp.test.mjs`、`test/password-reset.test.mjs`；2026-11-17 有 e2e 记录 `docs/mail-reset-e2e-2026-11-17.md`）。
- 告警：只有 webhook（飞书 / 钉钉 / Slack / 自建）+ 签名 + 失败重投，`server/alert-channel.mjs:1`、`:93-101`，outbox 在 `server/alerts.mjs`（据 `docs/platform-gap-audit-2026-11-26.md` §六）。
- 没有短信告警、没有邮件告警兜底；上游余额阈值只展示不告警（`docs/platform-gap-audit-2026-11-26.md` §一.12）。
- 分类：短信登录 **①**、邮件重置 **①**、webhook 告警 **①**（`docs/alert-webhook-e2e-2026-11-17.md`）；短信/邮件告警通道 **③**（未实现）。

## 十五、账号与权限

- 口令 scrypt + 每用户随机盐；会话 32 字节随机 token、库里只存 sha256、cookie `HttpOnly; SameSite=Lax`（`README.md` §七）。
- 注册默认关闭，开号靠邀请码或管理员建号（`server/config.mjs:345`，据 `docs/platform-gap-audit-2026-11-26.md` §一.3）；手机号只能登录，不能注册、不能找回。
- 登录门排在功能路由之前：`PUBLIC_API` 白名单之外一律要登录，`server/index.mjs:359-361`、`:164-185`。
- 配置接口收紧到管理员：`/api/config`、`/api/config/probe` 非管理员 403，`server/index.mjs:493-495`。
- 归属校验覆盖画布文件、上传、分镜图、资产、模板、作品（`server/owner.mjs`、`server/canvas-owner.mjs`）。
- `vqc_` 令牌只存哈希、可吊销，但**没有有效期、没有 scope**，拿到即以该成员身份收发（`docs/platform-gap-audit-2026-11-26.md` §七）；生产未上线。
- 画布互信是 120 秒一次性票据，没配共享密钥即关闭（fail-closed），`server/canvas-session.mjs:15-27`。
- 分类：账号 / 会话 / 归属 **①**；令牌策略 **②**（能跑，但缺过期与 scope）。

## 十六、对外接口（MCP、/visionchat.md）

- `POST /mcp`：无状态 Streamable HTTP，实现 `initialize` / `ping` / `tools/list` / `tools/call` / `notifications/*`，`server/routes/agent.mjs:174-243`。
- 三个工具：`visionchat_inbox`（长轮询 ≤25s）、`visionchat_send`（纯文本 ≤8000 字、带幂等键）、`visionchat_room`（房间 + 成员 + 最近消息），`server/routes/agent.mjs:108-141`。
- 鉴权只认 `Authorization: Bearer vqc_…`：没有令牌 401 + `WWW-Authenticate: Bearer`，`server/routes/agent.mjs:180-184`。
- `GET /visionchat.md`：由代码拼出的接入说明（换令牌 / MCP 一行接入 / HTTP 轮询 / 连接器 / 边界），按 Host 生成 base URL，`server/routes/agent.mjs:245-331`。
- 限流：`/mcp` 120 次/分/IP（`server/ratelimit.mjs:21`）；配对 20 次/分/IP、令牌发消息 30 次/分、一个令牌最多 2 条长轮询（`docs/visionchat-1b-2026-11-26.md:57`）。
- 分类 **①**：`scripts/visionchat-e2e.mjs` 实测列出三个工具、`/visionchat.md` 1438 字符且不含令牌、撤销令牌后连接器 401 退出（`docs/visionchat-1b-2026-11-26.md:86-88`）。
- 边界：只在 master、未发布生产（`docs/visionchat-1b-2026-11-26.md:105`）；工具层必须零命中 `/api/admin/*`（`:104`）。

## 十七、一句话收口

- **① 真跑通的骨架**：登录会话、爆款检索、七步复刻（第 6 步文案是编的）、模板库 27 条、作品版本与交付回执、工作流 9 节点与断点续跑、快捷创作文生图/文生视频、评审（本地模型）、账本与扣退、后台 61 个接口、短信登录、邮件重置、webhook 告警、MCP 与 /visionchat.md（未发布）。
- **② 代码在但从没真调**：参考图出图 `/images/edits`、数字人定妆成片、评审的插件服务分支（硬编码 `provider: 'mock'`）、聊天室 1c 的真模型回话、`vqc_` 令牌的过期与 scope。
- **③ 占位**：支付通道、短信/邮件告警通道、模板质量分与上架审核、工作流内置流程模板。
- **最短的谎在三处**：复刻里的「口播原文」（模型编的）、「数字人」这个名字（只有定妆图）、后台「下单返回 501」的文案（实际会直接到账）。
- 本文件以代码为准；`README.md` §一 的导航与页面命名已落后于 `src/nav.ts`。
