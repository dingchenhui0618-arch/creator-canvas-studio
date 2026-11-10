# VisionQA Workbench

VisionQA 是给画面做**有证据的视觉评审**的工具：结论只有「通过 / 需人工确认 / 不通过」三种，每条判断都必须指向画面里的具体区域（像素锚点），定位不到证据的一律写进「无法判断」，不给模糊结论。

这个仓库是 VisionQA 的**创作与检索工作台**：把「找一条爆款 → 拆它的结构 → 换个产品复刻 → 评审产出画面 → 沉淀成可复用模板」串成一条能跑通的链路，评审语言与 VisionQA 插件共用同一套 visual-baseline 契约。

> 诚实边界（2026-11-09 17:20 线上实测）：模型链路换成**官方 DeepSeek**（`https://api.deepseek.com/v1`）后真正通了。`deepseek-flash` 自报的 `input_modalities` 是 `["text","image"]`，所以智能体对话和抽帧评审共用同一个模型，不再需要假想一个「视觉专用模型」。实测：后台「连通性自检」`可用 · 上游 2 个模型`；智能体对话 6.0 秒出成品文案；`/api/review` 本地模型路径 16.6 秒给出 verdict + 像素锚点；`analyzeFrames` 在服务器上用生产代码跑 3 帧得到合法分镜 JSON。**仍然缺**：模板库 0 条（「一键复刻」还没跑过一条真实视频）、没有队列/配额/找回密码/用户列表接口。

![工作台](docs/screenshot-workbench-2026-11-09.png)

![智能体 · deepseek-flash 真实回复](docs/screenshot-agents-live-2026-11-09.png)

![爆款雷达（红狐真实数据）](docs/screenshot-radar-live-2026-11-09.png)

![后台 · 模型与密钥（连通性自检通过）](docs/screenshot-admin-keys-2026-11-09.png)

登录是**真实的服务端账号**：密码用 scrypt 存哈希，账号落在 `data/auth.db`（SQLite），会话是服务端随机 token + HttpOnly cookie，浏览器里读不到 token 也读不到密码。支持注册、登录、记住我；登录失败统一提示「邮箱或密码不正确」，不泄露邮箱是否注册过。登录状态收在**侧栏左下角**，点开可切换账号或退出。

![登录](docs/screenshot-login.png)

![注册](docs/screenshot-signup.png)

左下角是账号与版本：点账号行可设置 / 切换账号 / 退出；点版本行打开「版本与在线更新」——只读服务端 /api/version 的真实版本号，接口没接入时如实显示「未接入」，不伪造下载进度。

![版本与在线更新](docs/screenshot-update-panel.png)

## 一、这一版做了什么

| 模块 | 真实能力 | 事实边界 |
| --- | --- | --- |
| 登录 | 注册 / 登录 / 登出 / 记住我 / 会话持久化，密码 scrypt 存哈希，会话服务端校验 | **没有找回密码、邮箱验证与角色权限**；注册默认关闭，加账号用 `npm run adduser`，见 [docs/accounts.md](docs/accounts.md) |
| 爆款雷达 | 进页面**不自动检索**，点「检索」才发请求；卡片给播放 / 点赞 / 收藏 / 评论 / 转发与互动率；可「加入模板库」或「一键复刻」 | 抖音有播放量，小红书没有；取不到就隐藏，不做估算 |
| 一键复刻 | 视频解析 → ffprobe → FFmpeg 拆帧 → 逐帧视觉分析 → 入库，五步进度与实时日志 | 平台链接解析依赖红狐 Key；直链兜底可用 |
| 模板库 | **只存原链接 + 互动数据 + 解析出的脚本与分镜，不保存视频文件**；待解析 / 已解析两种状态，详情抽屉里可「去解析」；类型/关键词检索；送去评审 | 待解析条目没有帧图，封面走 /api/cover 代理 |
| 智能体 | 对话框式入口、参数行（智能体/输出/模型）、已自建智能体分类卡片、新建/编辑/删除；对话带**最近 8 条 / 6000 字**的会话记忆 | 记忆由服务端截断，超出部分不带；不落库 |
| 画布 | React Flow 节点编排（input/llm/kb/tool/condition/output）、检查器、连线校验、保存、逐节点运行；节点面板默认收起，双击画布或点「节点」唤出 | 运行是真执行，耗时真实；VisionQA Canvas 部署后画布交给它接管（见第六节） |
| 视觉评审 | 选画面 → visual-baseline 七维评审 → verdict + 像素锚点 + 有界修正建议 | 未启动 VisionQA 插件服务时由本地模型出一份同契约结果，provider 会写清 |
| 运行记录 | 读 data/runs.json，逐节点状态、耗时、输出 | 只有画布执行会产生记录 |

导航分两层：主层 6 项「工作台 / 爆款雷达 / 模板库 / 智能体 / 画布 / 视觉评审」，横线下面是设置层「运行记录 / 设置」，字号更小、颜色更淡。左上角只写 VisionQA，不放图形标记。

> 2026-11-09 上线体检后，整块删掉了「资产库」（6 条假资产 + 假统计，没有后端）、内测测试版、登录页演示账号与访客入口、工作台的示例待办/最近复刻/待评审。逐项清单与「哪些是真的」判定见 [docs/launch-readiness.md](docs/launch-readiness.md)。

### 2026-11-10 这一轮（已上线）

| 改动 | 之前 | 现在 |
| --- | --- | --- |
| 雷达检索时机 | 切到爆款雷达就自动检索一次（按次计费） | 进页面只读健康状态；输入关键词点「检索」才请求，未检索时给明确的空状态 |
| 卡片数据 | 点赞 / 收藏 / 评论 / 转发 | 再加播放量与互动率（(赞+藏+评+转)/播放），排序支持按播放、按转发 |
| 雷达 → 模板库 | 只有「一键复刻」入库 | 新增「加入模板库」：只存原链接、作者、互动数据，不下载视频、不抽帧 |
| 模板库 | 每条都带本地帧图 | 待解析 / 已解析两态；详情里可「去解析这条」，复刻完成后同一条目升级，不重复占格 |
| 智能体对话框 | 输入框 + 参数行 + 提示行 + 独立发送键，改一次要滚 | 一块卡片：输入区在上，参数与「Ctrl + Enter + 发送」收在底部同一行；去掉「数量 1」与「真实调用本地模型」这类给我们自己看的文案 |
| 会话记忆 | 每轮只发当前一句 | 带最近 8 条 / 6000 字上下文（服务端截断），实测追问能接住上文 |
| 字体 | 从 fonts.googleapis.com 拉 Geist + Noto Sans SC 四套字重；中文用无 hinting 的网页字体，12px 发虚 | 去掉外部字体请求，Geist 拉丁子集自托管、中文用系统黑体；10px 微标签统一抬到 11px |
| 充值 | 无 | 新增 /api/billing/*（overview / orders）与设置页「充值」按钮；通道未开通时明确显示未开通、按钮不可用，不编价格 |

![爆款雷达 · 未检索时的空状态](docs/screenshot-radar-idle-2026-11-10.png)

![爆款雷达 · 真实检索结果与五项互动数据](docs/screenshot-radar-live-results-2026-11-10.png)

![模板库 · 只存链接的待解析条目](docs/screenshot-templates-2026-11-10.png)

![模板详情 · 待解析状态与互动数据](docs/screenshot-template-detail-2026-11-10.png)

![智能体 · 收成一块的输入框与发送键](docs/screenshot-agents-composer-2026-11-10.png)

### 2026-11-10 追加：页头、运行记录溢出、入口 HTML 缓存

| 问题 | 原因 | 改法 |
| --- | --- | --- |
| 智能体页顶部「创作能力 / 智能体」 | 顶栏已经有「个人工作区 › 智能体」，页内又写了一遍虚构的上一层 | 删掉页内这行眉标（编辑页同改），全站只留顶栏一处面包屑 |
| 「已自建智能体」上方 | 「自建库 · N 次运行」和下面的标题说的是同一件事，右上角还有第二个「新建」 | 收成一行：标题 + 「N 个 · 累计 M 次运行」；新建只留页头那一个 |
| 参数胶囊的下拉 | 原生 `<select>` 弹出层会盖住输入框底部，样式也和发丝线不搭 | 换成自绘下拉：点击外部或 Esc 关闭、选中项加粗、展开时箭头翻转 |
| 运行记录页明显溢出 | `.runs-page` 漏写页面内边距，内容顶到侧栏和窗口边缘，左侧字看起来像被切掉 | 与工作台同一套 32px 内边距 + 1280 居中 |
| 工作台页头字体发虚 | 「工作台 · 用户 · 2026 年 11 月 10 日 · 星期二」整行等宽字体 + 中文混排，被 0.04em 字距拉散 | 拆成「工作台 · 用户 · 日期」，中文走界面字体、只有日期用等宽等宽数字；标题数字改 tabular-nums、分隔点降为 1px 灰 |
| 发版后仍看到旧界面 | nginx 直接托管 dist，`index.html` 没有 `Cache-Control`，浏览器按 ETag 启发式缓存旧 HTML，发版后继续加载旧 bundle | nginx 里 `location = /index.html` 写 `no-store, no-cache, must-revalidate`，`/assets/` 写 `immutable` 长缓存 |

![智能体 · 去掉重复面包屑，列表头收成一行](docs/screenshot-agents-header-2026-11-10.png)

![智能体 · 自绘参数下拉，不再盖住输入框](docs/screenshot-agents-menu-2026-11-10.png)

![运行记录 · 补上页面内边距后不再贴边](docs/screenshot-runs-2026-11-10.png)

![工作台 · 页头字体与数字对齐](docs/screenshot-home-typography-2026-11-10.png)

同一轮还按上线前审计修了六处**会真出事故**的地方（登录暴破绕过、模板库并发写丢条目、失败任务残留临时目录、
模板帧图送评审路径错、安全响应头、数据零备份）：
`deploy/production/backup.sh` + `visionqa-backup.timer` 每天 04:10 把 `/var/lib/visionqa` 整目录打包到
`/var/backups/visionqa` 留 7 份（含 WAL，恢复时 SQLite 自己重放），已装并跑过第一次。
审计清单、未修的 P0/P1（配额闸门、多用户 ownerId、SSRF 超时、健康检查探上游……）逐条记在
[docs/launch-readiness.md](docs/launch-readiness.md) 的「三点八」。

### 视觉基线（去 AI 味）

界面按六条硬规则约束，细则与 token 表见 [docs/design-baseline.md](docs/design-baseline.md)：

1. **间距只走 4/8pt 栅格**——`--space-1..16`（4/8/12/16/24/32/48/64），组件里不出现 13/26/29 这类随手值；
2. **禁大面积渐变**——底板是纯色（`#f4f4f4` / `#fbfbfb` / `#ffffff`），彩色只留在「通过 / 待确认 / 问题」三个语义位；
3. **图标不用 emoji**——全部 lucide 线性图标，统一 1.5px 描边；
4. **字体显式指定**——Geist 拉丁子集自托管（52KB）+ 中文走系统黑体（苹方 / 微软雅黑），不再 @import fonts.googleapis.com；标题 500、正文 14、等宽元数据 11–12；
5. **文案给信息不给寒暄**——工作台页头是「3 项待办 · 3 条待评审 · 4 条今日入库」，不是「下午好」；
6. **颜色先 token 后动手**——六件套 `--canvas / --surface / --surface-raised / --ink / --muted / --line`，组件里不现调色。

这一轮把 8 张样式表里 449 处 off-grid 间距、495 处 `font-size` 收敛到栅格与字阶，标题字重统一降到 500，并把模板库「搜索框 + 9 个类型 chip 挤一行换行」重排成搜索一行、类型一行（下划线式 tab，横向不换行）：

![模板库 · 工具条重排](docs/screenshot-templates.png)

![设置 · 会话与运行适配器](docs/screenshot-settings.png)

### 两个形态

对外只有一个形态：**用户生产版**。后台管理版不给普通用户看到，地址栏加 `?edition=admin` 才进得去，进去后侧栏有一条「返回生产版」。

| 形态 | 给谁 | 导航 |
| --- | --- | --- |
| 用户生产版 PRODUCTION | 内容团队日常用 | 工作台 / 爆款雷达 / 模板库 / 智能体 / 画布 / 视觉评审 +（横线下）运行记录 / 设置 |
| 后台管理版 ADMIN | 运维自己（`?edition=admin`） | 总览 / 账号 / 模型 Key / 模板治理 / 运行审计 / 系统 |

原来的「内测测试版 LAB」整块删除：接口体检、样例对照、功能开关、诊断导出四页里，开关全是「仅记录，尚未接线」，对照页的作用是把 `src/data/mock.ts` 的假数据摆在真实接口旁边——上线版不该带这种页面。
后台版每个数字都标「真实接口 / 本地会话」，没有接口的地方就写没有，见 [docs/editions.md](docs/editions.md)。

![后台管理版 · 总览](docs/screenshot-admin.png)

![后台管理版 · 模板治理](docs/screenshot-admin-templates.png)

![后台管理版 · 运行审计](docs/screenshot-admin-audit.png)

## 二、检索 → 复刻 → 模板库

爆款雷达按平台（抖音 / 小红书）、关键词、时间范围检索，卡片直接给点赞 / 收藏 / 评论 / 分享与时长；鼠标移到封面出「一键复刻」。

![爆款雷达](docs/screenshot-radar.png)

红狐账号不可用时（Key 禁用 / 积分不足 / 限流），界面明确说清并给后台链接：

![接口异常状态](docs/screenshot-radar-quota.png)

一键复刻跑五个可观测步骤：解析视频地址 → 读视频信息（ffprobe + 场景切镜）→ FFmpeg 抽帧 → 逐帧分析脚本与分镜 → 写入模板库。进度、每步状态、实时日志都在弹窗里。

![一键复刻](docs/screenshot-replicate.png)

![模板库](docs/screenshot-templates.png)

模板详情里有脚本结构（钩子 + beats + 口播 + 屏幕字）、分镜表（画面 / 机位 / 字幕 / 声音 / 叙事作用 + 对应帧图）、爆款分析、可复用规则、原视频链接，以及「送去评审」——把这条模板的首帧直接交给视觉评审。

![模板详情](docs/screenshot-template-detail.png)

### 抽帧可以交给远端算力

「解析 → 下载 → 探测 → 抽帧」这四步默认在本机跑 FFmpeg。填一个 `REPLICATE_REMOTE_URL` 就整体挪到外部服务上，工作台只收帧、调视觉模型、入库，**服务器上不再需要跑 FFmpeg**。契约与参考实现见 [docs/remote-compute.md](docs/remote-compute.md)，仓库自带 `worker/video-worker.mjs`。

弹窗里会写明这次走的是哪条路——下图是远端算力实际跑通的一帧：`来源：远端算力 … · 5 帧 · 640×360`，前三个步骤（获取 / 探测 / 抽帧）由对方完成：

![一键复刻 · 远端算力](docs/screenshot-replicate-remote.png)

顺带把本机那两条 FFmpeg 命令也压了一轮：场景切点只解关键帧、18 次 spawn 合成一条命令，整条链路 **6.1s → 0.99s**（10 秒 640×360 实测）。

## 三、智能体：对话框入口 + 已自建智能体

进入「智能体」先看到的是一个 composer：描述你要它做的事，同一行选智能体、输出类型、模型、数量，Ctrl+Enter 发送。发送后进入对话，用户消息靠右、智能体消息靠左，运行中有计时，失败显示模型名 + 状态码 + 原因并可重试。

![智能体入口](docs/screenshot-agents.png)

底部不是「精选作品」，而是**已自建智能体**：分类标签（全部 / 内容复刻 / 视觉评审 / 脚本分镜 / 投放素材）+ 卡片（名称、职责、模型、最近运行、使用次数），可编辑、可删除、可新建。

![智能体对话](docs/screenshot-agent-chat.png)

![智能体编辑](docs/screenshot-agent-editor.png)

真实链路：POST /api/agents/:id/chat 把智能体的 systemPrompt、知识条目、本次输出类型和用户消息拼成 messages，调用本机模型（gpt-6.1-sol，失败按降级链换模型），返回真实回复并把 runCount 加一。实测一次口播分镜回复 44–52 秒，主模型过载时会降级到 grok-4.6 并在界面上标出实际用的模型。

## 四、画布：节点编排与真实执行

画布用 @xyflow/react 12 实现：中间画布 + 右侧检查器，**节点面板默认不显示**——双击画布空白处或点工具栏「节点」才唤出（Esc 收起），避免一进来就被一列按钮占掉焦点。连线校验（不允许自环、输入只接一根），节点可删，Ctrl+Z 撤销，画布状态存 data/flows.json。节点类型只有六类：输入 / 大模型 / 知识库 / 工具 / 条件 / 输出——**评审不进画布**，评审是独立页面（第五节）。

![画布](docs/screenshot-canvas.png)

点「运行流程」由服务端按拓扑序执行：llm 节点调本地模型、kb 节点读模板库做上下文、condition 按表达式分支、output 汇总；每个节点返回 status / ms / output，节点在画布上逐个点亮，右侧抽屉同步显示每节点输出。

![画布运行](docs/screenshot-canvas-run.png)

实测一条 6 节点流程（input → kb → llm → condition → tool → output）跑完 72.8 秒，llm 节点 72.8 秒（含模型调用），GET /api/runs 能查到逐节点结果。

![运行记录](docs/screenshot-runs.png)

画布的参考来源与许可证（Langflow / Flowise / n8n / Dify / React Flow，未复制任何源码）写在 [docs/canvas-source-attribution.md](docs/canvas-source-attribution.md)。

## 五、视觉评审：VisionQA 的视觉能力怎么放进工作台

VisionQA 的定位不是「帮你想文案」，而是「给已经产出的画面下判断」。放进工作台后它有三个落点：

1. **独立页面**：选一张画面（模板首帧或图片地址）→ 出 verdict、逐条 observation（维度 / 严重度 / 像素锚点 / 置信度）、有界修正建议、无法判断清单。
2. **模板库出口**：模板详情里「送去评审」，把首帧直接带进评审页。
3. **画布不掺和**：评审不是流程节点，画布只做编排与执行——判断留在评审页，画布保持干净。

![视觉评审](docs/screenshot-review.png)

评审按 visual-baseline 七维（层级 / 对比 / 间距 / 字体 / 色彩 / 构图 / 可识别性）出结论，**每条判断必须给 bbox 锚点**，给不出锚点的降级为 info 或进「无法判断」。服务端实现见 server/review.mjs：优先调 VisionQA 插件服务（127.0.0.1:6300 的 /api/visual-review，同一套 v0.1 契约），服务没起来就退到本地模型的同口径评审，并把实际 provider 写进结果（截图里是 local-model:gpt-6.1-sol · 72.9s）。

契约映射、证据锚点格式与降级行为见 [docs/review-integration.md](docs/review-integration.md)。

## 六、VisionQA Canvas 接入（上游 BD Canvas 源码，Source-Available，不入仓）

画布这一块跑的是 **VisionQA Canvas**：源码来自 **BD Canvas**（Source-Available License v1.0，不是开源协议）的授权副本，本产品对外统一叫 VisionQA Canvas。上游条款禁止把源码或修改版以任何形式分发，也禁止把软件本身当产品卖，所以本仓库：

- **不 vendor、不提交** BD Canvas 的任何源码或构建产物（公开仓库提交就等于分发）；
- VisionQA Canvas 单独部署在本机，跑它自己的 5312（后端）/ 5313（后台管理）/ 6677（网页入口）；
- 工作台只做探活与内嵌：GET /api/bdc/status 探测这三个地址，画布页拿到 `deployed=true` 就**默认直接进 VisionQA Canvas 本体**；没有部署时仍是本仓库那套节点编排。
- 画布页是**沉浸模式**：第三方画布自带完整的顶栏与工具条，所以这一层不再叠标题和说明，只留一条 42px 状态条（署名 BD CANVAS / 连接状态 / 当前地址 / 新窗口 / 回到内置编排），画布铺满内容区、不套卡片不套圆角。画布页的主角是画布，壳让位。

部署记录、三个必踩的坑（Python 不在 PATH、requirements 少两个包、根 .env 没有代码读）与验收清单见 [docs/visionqa-canvas-integration.md](docs/visionqa-canvas-integration.md)，自检用 node scripts/check-bdc.mjs，重启用 `scripts/start-bdc.ps1`。

**当前状态（2026-11-05 实测）**：已解压到 `D:\Projects\bd-canvas`，5312 / 5313 / 6677 三端口都返回 200，`/api/bdc/status` 的 `deployed` 为 true，画布页由 VisionQA Canvas 接管，浅色纸面主题已覆盖；后台 `bdadmin` 初始密码已改。**还差模型 Key**——后台「Key 管理」为空，出图链路没通。

### 改名与顶栏对齐（2026-11-06）

产品名统一成 **VisionQA Canvas**，只改**用户看得见**的地方：网页 `<title>`、顶栏品牌、管理员登录页、新手教程页、桌面端画布标题、设置面板里的应用名、AI 人设前缀、`document.title` 动态标题。上游的版权声明（`copyrightBanner.ts` 归属串）、各文件头部的 `Source-Available License v1.0` 与 `LICENSE` 原文**一个字符都没动**——那是 §4.3 / §5.1 要求保留的署名。

顶栏几何也并进 `deploy/bd-canvas/vq-theme.css` 第 9 节，口径直接抄宿主 42px 状态条（`.cv-bdc-strip`）：**42px 高、底色 `#f4f4f4` 与宿主状态条连成一条、底边 `1px rgba(17,17,17,.10)`、页签 26px / 6px 圆角 / 12px 字、「后端未检测」做成 20px 等宽微标签**。于是「宿主状态条 + 画布顶栏」读起来是一条，而不是两层壳。

### 把它收进我们这套白纸墨线的语言

上游默认是 `#101113` + 蓝 `#6f9cff` + 青 `#22d3ee` 的深色霓虹调性，直接嵌进浅色工作台会读成「里面装了个别家的 App」。所以做了一层**只改配色与顶栏几何、不改组件结构**的主题覆盖：

- `deploy/bd-canvas/vq-theme.css`：它真正的色板在 `src/ui/styles/` 里分三层——`palette.css` → `themes.css`（`--ui-*` 语义层）→ `legacyAliases.css`（把旧 `--bg-*` / `--text-*` / `--border-*` 全部桥接上去）。所以只重定义**上游两层**（`--palette-*` 与 `--ui-*`）就能一次收口，并且是**往我们自己的浅色画布上靠**，不是另起一套深色皮肤：画布 `#f4f4f4`、卡片 `#ffffff`、次级 `#f0f0f0`、三级发丝线 `rgba(17,17,17,.06/.10/.20)`、文字 `#111 / #3f3f3f / #5d5d5d / #9a9a9a`、强调近黑、发光全 `transparent` 只留墨投影、点阵 `rgba(17,17,17,.10)`、语义色直接用我们 tokens.css 的 `#176b43 / #8a5b08 / #a33838`。
- `scripts/apply-bdc-theme.mjs`：幂等地把 css 复制进 `bd-canvas/public/`，并在 `index.html` 的 `</head>` 前插入/校正一行 `<link id="vq-bdc-theme" rel="stylesheet" href="/vq-theme.css">`（371121 → 371187 字节，去掉这一行可完整还原）。上游升级后重跑一次即可；`--check` 只校验不改。

**许可证边界**：LICENSE §3.2 允许为自用修改源码，§4.3 / §5.1 禁止删除、隐藏、篡改版权声明、水印与归属标识。所以：`src/features/license/copyrightBanner.ts` 的归属串、各文件头部的 `Source-Available License v1.0` 声明、`LICENSE` 原文**全部原样保留**；改动只限于**可见产品名**（标题、顶栏品牌、登录页、教程页、桌面端标题、AI 人设、`document.title`）与配色/顶栏几何（`deploy/bd-canvas/vq-theme.css`）。`vq-theme.css` 与脚本是我们自己写的、进本仓库，**上游源码一个字节都没进仓库**。

改色前（蓝青霓虹）：

![VisionQA Canvas 改色前](docs/screenshot-canvas-bdc-before.png)

改色后（白纸 + 墨线 + 发丝节点卡，节点选中是 1.5px 近黑环）：

![VisionQA Canvas 改色后 · 节点与参数面板](docs/screenshot-canvas-bdc-nodes.png)

同一个画布按沉浸模式内嵌进工作台——两边现在是一套语言，不再像「里面装了个别家的 App」：

![VisionQA Canvas 内嵌在工作台](docs/screenshot-canvas-bdc.png)

## 七、账号与会话（真实服务端）

登录不再是前端 mock。后端 `server/auth.mjs` + `server/routes/auth.mjs` 提供五个端点：`GET /api/auth/config`、`POST /api/auth/{register,login,logout}`、`GET /api/auth/me`。要点：

- **口令**：scrypt(N=16384, r=8, p=1) + 每用户随机盐，格式 `scrypt$N$r$p$salt$key`；库里没有明文密码。
- **会话**：32 字节随机 token，库里只存 `sha256(token)`；cookie 是 `HttpOnly; SameSite=Lax`，生产加 `Secure`。
- **不泄露账号存在性**：邮箱不存在时也跑一次 scrypt，登录失败统一 `field:'form'` + 「邮箱或密码不正确」。
- **限流**：同 IP + 邮箱 10 分钟失败 8 次锁；写请求校验 `Origin` 与 `Host` 一致，挡最省事的 CSRF。
- **受保护接口**：`VQ_REQUIRE_AUTH=1` 时除 `/api/auth/*`、`/api/health`、`/api/version` 外全部要登录，未登录返回 `{error:'未登录', loginRequired:true}`，前端收到就在 `src/api/client.ts` 派发 `vq:auth-required` 统一切回登录页。

**四个开关的默认值都在「不安全」一侧**（这是为了让本机演示不受影响），生产必须显式写：`VQ_REQUIRE_AUTH=1`、`VQ_SECURE_COOKIES=1`、`VQ_DEMO_ACCOUNT=0`、`VQ_REGISTRATION=0`（按需）。演示账号由后端 seed，密码通过 `/api/auth/config` 下发给登录页，**前端源码里没有任何密码**；关掉演示账号后登录页那块入口整体消失。

验收：`node scripts/test-auth.mjs` 起临时实例跑 16 项端到端断言（含「库里查不到明文 token / 明文密码」），全过；界面侧另做过一次真实点击：注册新账号 → 直接进工作台 → 退出 → 回登录页 → 错误密码给出统一提示 → 演示账号登录 → 进工作台。

没做的部分（别当成已经有了）：找回密码、邮箱验证、角色权限、多工作区、第三方登录。细节与接口契约见 [docs/accounts.md](docs/accounts.md)。

![登录失败：统一提示，不区分邮箱与密码](docs/screenshot-login-error.png)

## 八、服务器配置

内测起步一台 **4C 8G / 100G ESSD / 5M 带宽**、视觉模型继续走 API、VisionQA Canvas 同机部署即可；**不需要 GPU**——评审 60–85s、智能体 20–50s 都是接口延迟。逐档配置、存储/带宽估算、以及上线前必须做的三件事（Windows 脚本换 systemd、JSON 换 SQLite、视频转对象存储）见 [docs/server-sizing.md](docs/server-sizing.md)。

**要真正对外上线**时看 [docs/deploy-production.md](docs/deploy-production.md)：域名与 DNS、Caddy 自动 HTTPS（`deploy/Caddyfile`）或 Nginx（`deploy/nginx.conf`）、systemd 守护（`deploy/vq.service`）、环境变量清单（`deploy/env.production.example`）、健康检查、备份恢复与日志轮转，都有可直接复制的命令和验收步骤。三条硬结论：node 只监听 127.0.0.1、公网只走反代；四个 `VQ_` 开关不写就等于裸奔；单机同时复刻不超过 2 路。

### 线上环境（已上线，2026-11-06）

| 项 | 值 |
| --- | --- |
| 站点 | https://visionqa.wavisionai.cn （80 端口 301 跳 https） |
| 机器 | 阿里云轻量应用服务器 2 vCPU / 2 GiB / 40 GB，华东2（上海） |
| 应用目录 | /opt/visionqa，git 部署，systemd `visionqa.service` |
| 数据目录 | /var/lib/visionqa（SQLite，含 auth.db） |
| 后端端口 | 127.0.0.1:8799（8787 被既有站点占用，所以换端口） |
| 反向代理 | nginx `/etc/nginx/conf.d/visionqa.wavisionai.cn.conf`：80 只做 ACME 挑战 + 跳转，443 终止 TLS 并反代 /api 与 /media |
| 证书 | Let's Encrypt（certbot webroot `/www/wwwroot/wavisionai.cn/acme`），到期 2027-02-04，续期不影响 443 |
| 登录账号 | 由服务器 `/opt/visionqa/.env` 的 `VQ_DEMO_EMAIL` / `VQ_DEMO_PASSWORD` 决定，改完 `systemctl restart visionqa` 生效 |

当前是**无模型 Key** 的形态：`/api/health` 里 `vision=false`，界面照常可用，模型下拉照实写「凭证未配置：选中模型也不会真正发起调用」，不假装有推理。

部署脚本（root）：

```bash
DOMAIN=visionqa.wavisionai.cn API_PORT=8799 SECURE_COOKIES=0 bash deploy/production/install.sh   # 装依赖 → 拉代码 → 构建 → systemd → nginx(80)
DOMAIN=visionqa.wavisionai.cn bash deploy/production/enable-https.sh                            # 签证书 → 换成 80 跳转 + 443 → 打开 Secure Cookie
```

![线上工作台（无模型 Key）](docs/deploy-no-key.png)

![模型切换入口：留好的口子](docs/deploy-model-switch.png)

**模型切换的口子怎么用**：右上角模型下拉读 `GET /api/models`，目录来自服务器 `.env` 的 `VISION_MODELS`（逗号分隔，每项可写 `id|显示名`），没配就退回 `VISION_MODEL` + `VISION_FALLBACKS`；改完重启服务、刷新页面即可，**前端不用改一行**。真正要发起调用时，把 `VISION_BASE_URL` / `VISION_API_KEY` 填进同一个 `.env`，`configured` 会变 true，下拉里的「凭证未配置」提示自动消失。

### VisionQA Canvas 同机部署（2026-11-06）

线上「画布」页里嵌的就是 BD Canvas 本体（真源码那套），不再是内置编排的替身。

| 项 | 值 |
| --- | --- |
| 站点 | https://canvas.wavisionai.cn （独立子域，80 跳 https） |
| 目录 | /opt/bdcanvas（git clone 私有仓库快照，venv 在 .venv，node_modules 走 npmmirror） |
| 服务 | systemd `bdc-web.service`（Vite 6677，只监听 127.0.0.1）、`bdc-api.service`（Flask 5312）、`bdc-enterprise.service`（Flask 5313） |
| 反向代理 | nginx `/etc/nginx/conf.d/canvas.wavisionai.cn.conf` → 127.0.0.1:6677；`/admin`、`/api/admin`、`/enterprise/admin` 只放行 127.0.0.1 |
| 证书 | Let's Encrypt（同一 ACME webroot），与主站互不影响 |
| 接线 | `/opt/visionqa/.env` 的 `BDC_WEB_URL=https://canvas.wavisionai.cn`，重启 visionqa 后 `/api/bdc/status` 变 `deployed: true`，画布页直接从「未发布」切成 iframe |

两个坑（都踩过）：

1. BD Canvas 的正式构建（`npm run build`）在当前源码里是坏的——`vite:esbuild-transpile` 在 `VideoFaceBlurEditor` 分块上拿到 `[object Object]` 就中断，去掉三个自定义 bridge 插件也一样。所以服务端跑的是它自己启动时用的那套 Vite dev server（6677），不是静态 dist。
2. `vite.config.ts` 默认把非 loopback Host 当「公网访客」，会 403 掉所有写接口。子域部署要把它加进 `TRUSTED_PUBLIC_HOSTS`（已改），同时加进 `server.allowedHosts`，否则整页 403。

**画布已加 Basic Auth**（2026-11-06 追加）：`canvas.wavisionai.cn` 默认 401，用户 `canvas`；iframe 走一次性入口 `/__auth?k=<token>` —— nginx 种 30 天 cookie 后所有资源请求免登录，所以嵌在 VisionQA 里不会弹登录框。`/admin`、`/api/admin`、`/enterprise/admin` 仍然只放行 127.0.0.1。VisionQA 侧新增两个环境变量：`BDC_EMBED_URL`（iframe 用，带 token）与 `BDC_WEB_PROBE_URL`（探活用本机 6677，避免 401 把 `deployed` 误判成 false）。

**外壳对齐（2026-11-06）**：主题只在 `deploy/bd-canvas/vq-theme.css`（部署方自用，不改它的组件结构），发布时拷成 `<canvas>/public/vq-theme.css`、在 `index.html` 里以 `#vq-bdc-theme` 引入。十节内容：

1. 第 1–8 节把它的 `--ui-*` 变量用 `:root:root` + `!important` 映射到 VisionQA 的 `tokens.css`——字体栈、6/10px 圆角、4/8pt 间距、`#f4f4f4` 画布 + 发丝线、单层轻阴影、等宽微标签。
2. 第 9 节管顶栏几何：`height: 42px !important`（只写 `min-height` 会被它自己的 48px 规则压住）、页签 26px/6px/12px、状态胶囊等宽 10px。
3. 第 10 节管左侧组件面板与右键菜单：面板 288px 白底 10px 圆角、44px 表头、分组标题等宽 10px/0.12em、行高 36px、图标方块 24px；右键菜单与节点创建菜单 208px 宽、行高 34px、快捷键右对齐（补了 `display:flex` + `margin-left:auto`，它原本是 `display:block`，标签和快捷键会挤在一起）。

![线上实拍：42px 状态条与画布顶栏同高同色，品牌已统一为 VisionQA Canvas](docs/bdc-aligned.png)

**第三轮：外壳细节（2026-11-09）** 主题层第 11 节把剩下的界面统一成一套 4pt 栅格：

- 左侧功能轨：8px 内边距、32px 方形 8px 圆角按钮（原来是灰底圆形），悬浮 5% 墨色；
- 底部控制条：46 → **40px** 高（它的 `min-height: 44px` 要一起压，只写 `height` 不生效）、按钮 32px、缩放数字等宽 10px；
- 节点卡：标题 12/500、正文 13px/1.6、页脚等宽 10px、选中转单层墨色描边；
- 悬浮工具条 28px、参数面板 12px 圆角 + 等宽分组标签、输入框 6px 圆角聚焦转墨色、滚动条细化到 8px。

**顶栏状态改报真实结果（2026-11-09）**：品牌旁那颗探的是 `/api/health`（5312），5s 超时、30s 一轮，title 带状态码与耗时；右侧连接胶囊原本归管理服务状态管，未登录时恒为 `unknown` 所以永远显示「后端未检测」——现在宿主把真实探测结果写进 `setConnectionProbe()`，未登录也报真话（后端正常 / 后端断连）。

![线上实拍：左轨方形按钮、节点卡与底部 40px 控制条](docs/bdc-chrome-after.png)

**细节第一轮：节点卡尺寸与空状态（2026-11-09）**

- **文本节点按「一页纸」定尺寸**：它自己会写 `_width/_height`（默认 360×220），但旧逻辑最后落到 `aspectRatio` 的 **1:1 方卡**上——评审结论三行就出滚动条。现在 `getNodeBaseSize()` 为 `text` 单独开一条分支按存储尺寸取值，写笔记用 420×300 + `_cardScale: 1`，五条结论一屏读完、不用滚动。
- **空白画布有了引导**：`#v2-canvas:not(:has(.v2-node))::after` 画一块虚线提示卡（13px / 白 70% / 10px 圆角 / 虚线发丝线）：「空白画布 · 左侧 + 新建节点，或把素材拖进来（Ctrl+V 粘贴）」。有节点后自动消失，纯 CSS，不动上游 DOM。

![线上实拍：420×300 的评审笔记卡，五条结论一屏读完](docs/bdc-note-card.png)

![线上实拍：空白画布的引导卡](docs/bdc-empty-state.png)

**细节第二轮：文本卡的内联样式控件（2026-11-09）** 文本节点没有模型参数面板（上游把它当「原地编辑」节点），所以样式控件直接做在卡片页脚，右对齐四颗 18px 小按钮：

- `A-` / `A+`：字号 10–22px，每次 1px；
- `LH`：行高在 1.4 / 1.6 / 1.8 之间循环；
- `M`：等宽字族开关（Geist Mono）。

样式写进 `node.params._vqText`，渲染时翻译成三支 CSS 变量（`--vq-text-size/-leading/-font`）由主题层消费；点按钮不整卡重渲染（文本框要保光标），直接把变量写到现有 textarea 上。线上实测：`13px → 16px` 时行高跟着到 `25.6px`，`M` 切到 `Geist Mono`。

![线上实拍：评审笔记卡页脚的四颗样式按钮](docs/bdc-text-style.png)

**画布与工作台数据打通（2026-11-06）**：工作台不再只是「嵌一个 iframe」，它和后端共用同一批画布。

| 工作台接口 | 干什么 | 打到的画布接口 |
| --- | --- | --- |
| `GET /api/bdc/canvases` | 列画布（名称、节点数、版本、更新时间） | `GET /api/canvas/list` |
| `POST /api/bdc/canvases` | 建一块空画布（id 形如 `vq-*`） | `POST /api/canvas/save` |
| `POST /api/bdc/canvases/note` | 把评审结论落成画布里的一个文本节点 | `GET /api/canvas/load/:id` + `POST /api/canvas/save`（带 `expected_revision` 乐观锁，别人同时改了返回冲突而不是覆盖） |

界面就在 42px 状态条里：`画布项目` 下拉（选中即用 `&loadCanvas=<id>` 深链换画布，选中项记在 `localStorage`，刷新后仍然绑着同一块）、`新建`（建完自动绑定）、`写笔记`（写完 iframe 自动重挂载，立刻能看到那条文本节点）。

![工作台里写评审笔记：状态条多了画布项目、新建与写笔记](docs/bdc-bridge-note.png)

![写完自动重载、刷新也还记得：评审结论成了画布左上角的文本节点，节点数同步成 1](docs/bdc-bridge-bound.png)

打通时踩到的三个硬点（都是上游行为，记住能省一天）：

1. **公网访客模式只读浏览器**：`isPublicWebClient()` 把任何非内网 Host 当公网访客，画布数据存 localStorage，服务端的画布永远加载不出来（深链报 `Load failed`）。改成把 `canvas.wavisionai.cn` 当「本机安装」（`runtimeMode.ts` 里加 `VITE_TRUSTED_HOSTS` 白名单），数据才落到服务端 workspace。
2. **一次性入口会吃掉查询串**：`/__auth?k=…&loadCanvas=<id>` 原本一律 `return 302 /`，深链参数直接丢。nginx 里补 `if ($arg_loadCanvas) { return 302 /?loadCanvas=$arg_loadCanvas; }`。
3. **文本节点的正文在 `prompt` 不在 `params.text`**：照它自己的 `createTextNode` 写——`{ type:'text', prompt: 正文, model:'text', params:{ _width:360, _height:220, _agentTextNode:true } }`，写进 `params.text` 的会显示成「0 字」。


## 九、怎么跑

依赖安装后起两个服务：后端 8787（同时托管 dist），前端开发 5191。守护脚本 keep-services.ps1 是单实例，掉了自动拉起，日志在 data/keeper.log。

| 命令 | 作用 |
| --- | --- |
| npm install | 装依赖 |
| node server/index.mjs | 后端 8787 |
| npm run dev -- --port 5191 --strictPort | 前端开发服务器 |
| powershell -ExecutionPolicy Bypass -File scripts/keep-services.ps1 | 常驻守护 |

环境变量放 .env（已 gitignore，模板见 .env.example）：

| 变量 | 用途 |
| --- | --- |
| REDFOX_API_KEY | 红狐检索 / 视频解析 Key（当前账号积分不足且 Key 被禁用） |
| API_PORT | 后端端口，默认 8787（监听地址写死 127.0.0.1，公网只走反向代理） |
| VISION_BASE_URL / VISION_API_KEY / VISION_MODEL | 模型通道，线上是 https://api.deepseek.com/v1 + deepseek-flash（文本与看图同一个模型） |
| VISIONQA_SERVICE_URL | VisionQA 插件服务地址，默认 http://127.0.0.1:6300 |
| VQ_REGISTRATION | 注册开关，**默认关闭**，只有显式写 1 才开放（以前是「不等于 0 就开」，漏配即公开注册） |
| VQ_ADMIN_EMAILS | 管理员邮箱（逗号分隔），可看全部数据、发放积分；库里 kind='admin' 等价 |
| VQ_CREDIT_WELCOME / VQ_CREDIT_SEARCH / VQ_CREDIT_REPLICATE / VQ_CREDIT_REVIEW / VQ_CREDIT_CHAT / VQ_CREDIT_FLOW_RUN | 初始积分与各动作单价，默认 100 / 2 / 10 / 5 / 1 / 2（画布整条流程跑一次） |
| VQ_CONCURRENCY_SEARCH / _REPLICATE / _REVIEW / _CHAT / _FLOW_RUN | 单账号并发上限，默认 1 / 2 / 1 / 2 / 1 |

## 十、接口

| 接口 | 说明 |
| --- | --- |
| GET /api/health | 服务与三个外部依赖的可用性（红狐 / 模型 / 模板数） |
| GET /api/auth/config, POST /api/auth/{register,login,logout}, GET /api/auth/me | 账号与会话（scrypt + HttpOnly cookie），契约见 [docs/accounts.md](docs/accounts.md) |
| GET /api/search | 红狐检索；不可用时返回 mode:'mock' + quota.code + 充值链接 |
| POST /api/replicate, GET /api/jobs/:id | 一键复刻流水线（五步进度） |
| GET /api/templates（含 ?kind=saved|replica）, GET /api/templates/:id, POST /api/templates/:id/reuse, DELETE /api/templates/:id | 模板库 |
| POST /api/templates/from-radar | 雷达卡片「加入模板库」：只落链接 + 互动数据，不下载视频（同一 sourceId 不会重复入库） |
| GET /api/billing/overview, GET/POST /api/billing/orders | 充值通道占位：未接入时返回 enabled:false、下单 501 BILLING_NOT_CONFIGURED，不伪造价格与订单 |
| GET/POST /api/agents, GET/PATCH/DELETE /api/agents/:id, POST /api/agents/:id/chat | 智能体与真实对话 |
| GET/POST /api/flows, PATCH/DELETE /api/flows/:id, POST /api/flows/:id/run, GET /api/runs | 画布与运行记录 |
| POST /api/review, GET /api/review/health | 视觉评审（service / local-model 两种 provider） |
| GET /media/frames/:id/:file | 抽帧静态文件 |
| GET /api/credits | 当前账号积分余额、单价、近期流水（检索 2 / 复刻 10 / 评审 5 / 对话 1，可用 VQ_CREDIT_* 改） |
| GET /api/system/health | 深度健康检查：真连数据库、数据目录、模板库、模型接口、红狐接口（结果缓存 10 秒） |
| GET /api/admin/users, POST /api/admin/users/:id/credits | 管理员：真实账号列表（含余额）、发放/扣减积分 |

## 十一、目录

前端在 src/：App.tsx 是外壳（侧栏、顶栏、登录门、vq:navigate 事件）；auth/ 是会话状态（服务端真实校验，含 RequireSession 与 useSession）；brand/ 是 VisionQA 标记；styles/tokens.css 是设计 token；api/ 是各模块轻客户端；pages/ 下是 10 个页面（登录、工作台、雷达、模板库、智能体、编辑器、画布、视觉评审、资产库、运行记录、设置）。

后端在 server/：index.mjs 做路由分发与静态托管；routes/ 下 agents、flows、review 三个路由模块；llm.mjs 统一模型调用（重试 + 降级链）；review.mjs 是评审适配；redfox.mjs 是红狐客户端（限流、缓存、单飞、错误映射）；media.mjs 与 frames.mjs 负责视频解析与抽帧；templates.mjs、agents.mjs、flows.mjs 是 JSON 原子写存储。

文档在 docs/：design-direction-v2.md（视觉方向与去 AI 味清单）、review-integration.md（评审契约）、replication-pipeline.md（复刻链路与红狐实测）、canvas-source-attribution.md（画布开源调研）。

## 十二、已知限制

- 红狐账号积分不足且 Key 被禁用：雷达只能给示例数据；重新充值并换 Key 后无需改代码。
- 视觉评审在插件服务未启动时走本地模型，结论可信度取决于模型；界面始终标出 provider，不冒充插件结果。
- 视觉评审与智能体对话需要 `VISION_API_KEY`，爆款雷达需要 `REDFOX_API_KEY`：没配就是「接口在、结果出不来」，界面按实际状态标注，不假装成功。
- 智能体「数量」固定 1；工具只声明不自动执行；会话记忆只在一次对话里生效，刷新后靠本地「最近对话」找回，不落服务端。
- 充值只有接口和按钮：价格、档位、支付通道都没接，设置页显示「未开通」，下单接口回 501，没有任何扣费。
- 模板库现在以「链接 + 解析内容」为主；解析过的模板仍保留抽帧图作为分镜缩略图，视频文件本身不进库（复刻结束即删临时目录）。
- 完整的上线差距清单（真实 / 演示逐项判定、P0–P2 补课顺序）见 [docs/launch-readiness.md](docs/launch-readiness.md)。
- 账号是真的（SQLite + scrypt + 服务端会话），但没有找回密码、邮箱验证、角色权限与多租户；后台管理版的用户列表页因此只展示当前会话。
- 单机部署：复刻任务没有队列（`startReplicate` 直接起 ffmpeg），多人同时复刻会叠加 CPU；4C8G 单机建议同时复刻 ≤2。

## 十三、验证记录

- npx tsc -p tsconfig.app.json --noEmit 通过；npx oxlint src 0 error / 0 warning（59 个文件）。
- 账号体系端到端 16 项全过（`node scripts/test-auth.mjs`）：未登录受保护接口 401、注册即登录、重复注册 409、弱密码 400、登出后旧 cookie 失效、库中无明文 token 与明文密码。
- 智能体对话实测 44.2s（gpt-6.1-sol）、52.7s（降级链生效）、123.6s（grok-4.6）。
- 画布 7 节点流程实测 99.0s / 115.5s，/api/runs 可回放逐节点输出。
- 视觉评审实测 72.9s（gpt-6.1-sol）、84.2s（gpt-6-luna），5–7 条 observation，锚点渲染与图片对齐。
- 复刻压测：5 并发 5/5 完成（163s 墙钟）、25 并发复用无丢失更新、40 并发检索 40/40 HTTP 200（p50 3.7s）。
- 2026-11-10 实测：进爆款雷达 0 次 /api/search 请求（改前是一次）；点检索后线上返回 74 条真实小红书数据；「加入模板库」后 /api/templates 返回 saved:1，详情看到「待解析」与互动数据；智能体带 history 追问 1.4s 返回且 memory.turns=1；/api/billing/overview 200 enabled:false、POST /api/billing/orders 501；/fonts/geist.woff2 200 font/woff2，document.fonts 只剩 Geist / Geist Mono 两套。
- 同轮修掉一个线上漏洞：VQ_REQUIRE_AUTH=1 时 /api/agents、/api/flows、/api/billing 曾匿名返回 200（登录门排在功能路由之后），现已前置，匿名请求一律 401。
## 十四、2026-11-10 追加二：积分制、多用户隔离、健壮性与页头统一

这一轮按你的九条落地，线上已经是新版本（bundle index-CdQxwXyC.js）。

### 十四.1 九条与结果

| # | 你要的 | 现在是什么 |
| --- | --- | --- |
| 1 | 积分制，每次检索扣积分 | 检索 2 / 一键复刻 10 / 视觉评审 5 / 智能体对话 1；余额在 users.credits、流水在 credit_ledger，同一事务里改；**先扣后调、失败原路退回**；示例数据不扣费。单账号并发上限（检索 1 / 复刻 2 / 评审 1 / 对话 2），余额不足返回 402 且不扣钱 |
| 2 | 多用户归属 | 模板、智能体、画布流程、运行记录、复刻任务都带 ownerId；列表与读取按账号过滤，改删前先校验，跨账号一律 404（不泄露存在性），管理员可见全部 |
| 3 | 修 P1 | 见下面十四.3：SSRF、超时、流式下载、全局兜底、请求日志、深度健康检查 |
| 4 | 兜底日志 | 每请求一行 JSON（方法、路径、状态、耗时、账号、IP、X-Request-Id）；5xx 另打堆栈并把同一个 id 回给前端；unhandledRejection 记录，uncaughtException 记完退出交给 systemd 重启 |
| 5 | 健康检查放到底部设置 | 设置页最下方「系统状态 / Health」，6 项逐条真探（进程、账号库、数据目录、模板库、模型接口、红狐接口），带「重新检测」与 10 秒缓存 |
| 6 | ErrorBoundary + 路由 | hash 路由 #/radar、#/agents/<id>、#/admin/users 等，刷新停留、前进后退可用、首屏不多压历史；内容区包 ErrorBoundary（切页自动复位）；5 个重页面懒加载 |
| 7 | 收尾内容（备案号不做） | 注册默认关闭（fail-closed）、口令必须字母+数字、分包、小屏表格；备案号按你说的不设置 |
| 8 | 充值先别动 | 设置页充值卡仍是「未开通」占位，/api/billing/* 一字未改，不产生任何扣费 |
| 9 | 页头字体降重并统一 | 「爆款雷达」原来 33px/800/-0.045em，现在全站页头一套 token：26px / 500 / -0.01em / line-height 1.25，kicker 11.5px，desc 12.5px；工作台、爆款雷达、模板库、智能体、画布、视觉评审、运行记录、设置、智能体编辑全部换成同一个 PageHead |

### 十四.2 真实截图（线上渲染）

![爆款雷达：页头降重，右上角显示积分余额与每次消耗](docs/screenshot-radar-credits-2026-11-10.png)

![设置页：积分余额、单价、流水；最下方是系统状态健康检查](docs/screenshot-settings-credits-health-2026-11-10.png)

![后台管理版：真实账号与积分发放](docs/screenshot-admin-accounts-2026-11-10.png)

![页头统一后的工作台（26px / 500，数字等宽）](docs/screenshot-head-typography-2026-11-10.png)

![小屏 390×844 的运行记录：页面不再横向溢出](docs/screenshot-mobile-runs-2026-11-10.png)

### 十四.3 实测数字

- 积分端到端 23 项全过（node scripts/test-credits.mjs，配 scripts/mock-redfox.mjs）：注册得 100 → 检索扣 2（100→98）→ 上游 3105 退款（98→98）→ 余额压到 1 分再检索得 402 且不扣费 → 管理员发放 → 3 并发检索 200/429/429 → 封面代理拒内网 404 → 评审拒内网图片 500 并退款 → 深度健康 6 项。
- 多用户隔离：A 存 1 条模板、B 看到 0 条；B 读 A 的单条 404；B 访问 /api/admin/users 403。
- 启动迁移：线上 agents:4 flows:4 templates:0 认领给管理员；老账号一次性补 100 初始积分（日志 welcome-credits accounts:1）。
- 分包：主包 604.09 kB → 315.54 kB（gzip 183.91 → 97.28 kB，−47%），画布 222 kB 等按页懒加载。
- 路由：17 组 parseRoute/toHash 用例通过；无 hash 首屏只 replace 一次（history 1 条）。
- 生产探针：/api/health ok；/api/credits、/api/admin/users、/api/system/health、/api/templates 匿名均 401；/api/auth/config → registrationEnabled:false、passwordPolicy「至少 8 位，且同时包含字母和数字」；HSTS / X-Frame-Options / 入口 HTML no-store 保持。
- 页头计算样式实测：26px / 500 / -0.26px / 32.5px，页头下边线 1px，与内容 24px。

### 十四.4 还没做的

- 充值仍是占位：金额、档位、支付方式等你定价，接口契约没动。
- 模板库真实条目还是 0：「一键复刻」没有对真实视频跑过，第一条闭环等你点头（会消耗真实红狐额度与积分）。
- 账号仍没有找回密码、邮箱验证、停用开关；多租户仍是单工作区。
- 画布流程执行没有接积分（只受并发与超时保护），要不要按次计费等你定。

完整差距清单见 [docs/launch-readiness.md](docs/launch-readiness.md) 的「三点九」。

## 十五、2026-11-10 追加三：画布图标、后端状态下线、全站口径统一

### 十五.1 三项改动

| 项 | 之前 | 现在 |
| --- | --- | --- |
| 画布图标 | 上游 BD Canvas 的紫色渐变「B」标（569×569），同时当 favicon | 换成 VisionQA 标记（V + 检视框：深墨底、奶油字、紫环），512×512、四角透明，favicon 同步；源文件 [deploy/bd-canvas/bd-canvas-app-icon.svg](deploy/bd-canvas/bd-canvas-app-icon.svg) |
| 画布顶栏「主后端正常」 | 品牌旁一颗 10px 胶囊，探 `/api/health` 后显示「主后端正常 / 断开 / 检测中」 | 主题层 `display:none`，画布里不再报后端状态；进程、数据目录、模型与检索的探活统一放「设置 → 系统状态」 |
| 画布顶栏账号/额度挂件 | 右侧「个人模式 + 后端正常 + 额度条」 | 整颗隐藏：账号、余额、积分都在 VisionQA 自己的顶栏与设置页，画布只留品牌、画布页签与工具 |
| 全站口径 | 雷达、设置、复刻、后台写着「红狐」「deepseek-flash」 | 一律以 VisionQA 为主语：检索服务 / 模型服务 / VisionQA 通用·视觉·对话模型；后台「模型与密钥」默认只露产品口径，真实模型 ID、上游地址、环境变量值收进右上角「显示技术详情」 |

### 十五.2 真实截图（线上渲染，1440 宽）

![画布：VisionQA 图标，后端状态与账号挂件都不再显示](docs/screenshot-canvas-branding-2026-11-10.png)

![爆款雷达：状态改成「检索服务已连接」](docs/screenshot-radar-visionqa-2026-11-10.png)

![设置：健康检查只报通断与耗时，不再带模型名和上游域名](docs/screenshot-settings-health-clean-2026-11-10.png)

![后台模型与密钥：默认产品口径，「显示技术详情」才展开真实配置](docs/screenshot-admin-keys-toggle-2026-11-10.png)

### 十五.3 验收口径（实测）

- 用无头 Chrome 带真实会话登录线上，逐页读 `document.body.innerText` 扫 `红狐|REDFOX|redfox|deepseek`：13 条路由（工作台、爆款雷达、模板库、智能体、视觉评审、运行记录、设置、后台六个分页）**全部 0 命中**。
- `/api/models` 的 label 已是「VisionQA 通用模型 / 视觉模型 / 对话模型」，id 仍只用于请求；画布检查器的模型下拉同步改成只显示名称。
## 十六、2026-11-10 追加四：生产/内部两套口径 + 待接 API 开工

### 十六.1 环境分离

同一份构建跑两套环境，差异只来自服务端 `VQ_UI_MODE`：

## 十七、2026-11-10 追加五：待接 API 第一批（积分可见性、模板套用、评审历史、账号管理）

### 十七.1 这一批做了什么

| 页面 | 之前 | 现在 |
| --- | --- | --- |
| 一键复刻 | 弹窗只有「开始复刻」，402 混在普通报错里 | 弹窗显示「本次消耗 10 积分 · 当前余额」；余额不足直接禁用并提示找管理员；完成后显示扣了多少 |
| 智能体对话 | 每次扣 1 积分，界面上看不到余额 | 输入框上方常驻「余额 / 每次对话」；402 显示差额与发放方式 |
| 视觉评审 | 每次扣 5 积分，页头只有模型状态 | 页头多一枚「每次 5 积分 · 余额」；结论落库到 `data/reviews.json`，左侧「最近评审」可回看 |
| 模板库 | 「复用此模板」只是 reuseCount +1 | 改成「套用到画布」：生成一张带输入节点 + 复刻脚本节点的流程，并直接跳转画布 |
| 后台账号 | 状态只读 | 可停用/启用、设/撤管理员；服务端拦住「把自己降级或停用」 |
| 后台总览 | 用户数写死「—」 | 取 `GET /api/admin/users` 的 total |
| 后台模板 | 只有删除 | 服务端已支持 `PATCH /api/templates/:id`（标题/类型/标签/原链接），编辑表单下一批补 |

新增接口：`POST /api/templates/:id/apply`、`GET /api/reviews`、`GET /api/reviews/:id`、`PATCH /api/admin/users/:id`。

![智能体：输入框上方常驻余额与单价](docs/screenshot-agents-credits-2026-11-10.png)

![视觉评审：页头显示每次积分与余额](docs/screenshot-review-credits-2026-11-10.png)

![内部测试：评审历史可回看（记录为 QA 测试数据）](docs/screenshot-review-history-internal-2026-11-10.png)

![后台账号：停用/启用与角色调整](docs/screenshot-admin-users-access-2026-11-10.png)

### 十七.2 实测

- 内部环境（与生产同代码、独立数据库）：`POST /api/templates/from-radar` → 201；`POST /api/templates/:id/apply` → 201，返回流程含 2 个节点（input / llm）与 1 条连线；`GET /api/reviews` → 200；对自己的管理员账号 PATCH 停用 → 400 `SELF_LOCKOUT`，守卫生效。
- 生产 bundle `index-B7leFJhm.js`，`/api/health` ok，两个服务均 active。
- 评审历史页用一条内部测试记录验证了列表、回看与像素锚点渲染；这条记录标记为「测试」，不属于真实业务数据。

### 十七.3 当前阻塞（不是代码问题）

上游模型账号返回 `Insufficient Balance`：`deepseek-flash` 的 `/models` 正常，但真实 `chat/completions` 与视觉评审都 402。也就是说**智能体对话和视觉评审在补余额前不可用**（错误会如实显示，扣掉的积分会退回）；检索服务仍正常。需要你给上游账号充值，或换一把有余额的 key。

### 十七.4 下一批

运行记录分页/筛选、画布流程按 ID 打开、画布「另存为模板」落模板库、流程执行计积分、智能体历史接口、后台模板编辑表单。

## 十八、2026-11-10 追加六：待接 API 第二批（运行记录、画布计费、流程模板、按 ID 打开）

### 十八.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 运行记录 | 只拉默认 20 条，没有筛选 | 服务端分页 + 按流程 / 状态 / 关键词筛选，显示「当前区间 x–y / 总数」 |
| 运行记录详情 | 只有节点输出 | 头行显示本次消耗或退回的积分，可一键「在画布打开」对应流程 |
| 画布运行 | 点了就跑，不扣积分 | 按次扣 2 积分（`VQ_CREDIT_FLOW_RUN` 可改）；跑之前显示「运行 2 积分 · 余额」，余额不足直接禁用；有节点失败整单退回，运行结果里显示「已退回 2 积分」 |
| 画布地址 | 永远打开列表第一条 | `#/canvas/<flowId>`，刷新、复制链接、从运行记录/模板库跳转都落到同一张画布 |
| 画布「另存为模板」 | 其实是复制一张新流程，模板库找不到 | 真的写进模板库的「工作流」条目（带 blueprint），在模板库里能筛「工作流」、能看到节点清单、点「在画布打开」原样开回一张新画布 |
| 后台运行审计 | 只有列表 | 可按成功/失败筛选，一键导出当前筛选结果 CSV（带 BOM，Excel 直接可读） |
| 运行报错文案 | 上游原始报文原样透出（带模型名与余额细节） | 统一走 `server/public-error.mjs`：生产只给「模型服务额度不足，本次不计费」这类产品语言；模型名/上游状态只在内部环境与日志里 |

新增/变更接口：`POST /api/templates`（`{from:"flow", flowId}`）、`GET /api/runs?flowId=&status=&q=&limit=&offset=`、`POST /api/flows/:id/run` 计费与退款。

![运行记录：分页、流程/状态筛选与积分](docs/screenshot-runs-filters-2026-11-10.png)

![画布：运行前显示本次积分与余额](docs/screenshot-canvas-run-credits-2026-11-10.png)

![模板库：画布另存的工作流模板](docs/screenshot-templates-flow-2026-11-10.png)

![模板库：工作流详情与节点清单](docs/screenshot-template-flow-detail-2026-11-10.png)

![后台运行审计：状态筛选与导出 CSV](docs/screenshot-admin-audit-filter-2026-11-10.png)

### 十八.2 实测（内部环境同代码、独立数据；生产同 bundle）

- 计费：跑一条 input→output 流程 → 200，`credits.cost=2`、余额 100→98；`GET /api/runs?status=success` 能查到，`offset` 翻页正确。
- 余额不足：把余额扣到 1 再跑 → 402 `CREDIT_INSUFFICIENT`（需要 2 / 余额 1），余额不变。
- 失败退款：llm 节点因上游 402 失败 → 运行记录 `status=error`、`credits.refunded=true`，余额回到运行前；界面上的报错是「模型服务额度不足，本次不计费」。
- 工作流模板：`POST /api/templates {from:"flow"}` → 201，blueprint 带 2 节点 1 连线；`apply` → 201，新流程节点与连线一致；测试模板与流程已删除。
- 生产：用现有流程跑了一次真实运行（2 积分），截图里的运行记录与模板卡片就是这次验收产生的；bundle `index-BufeDKIP.js`，两个服务 active、`/api/health` ok。

### 十八.3 下一批

智能体历史接口（`GET/POST /api/agents/:id/history`）、智能体编辑页真实运行次数、工具节点真正执行、后台模板编辑表单、设置页积分流水加载更多、后台按账号筛选运行记录。

## 十九、2026-11-10 追加七：待接 API 第三批（智能体运行历史、工具真执行、模板编辑）

### 十九.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 智能体历史 | 只有一个本机浏览器 `localStorage` 对话列表，换设备或清缓存就没了；运行只累加一个数字 | 「历史」弹层分两栏：「本机对话」照旧可恢复上下文；「运行记录」读服务端 `GET /api/agents/:id/history`，成功与失败都留档，含输入、回复、模型口径、耗时、扣退积分、工具读取结果；支持分页、展开、复制、清空（两次确认） |
| 智能体编辑页 | 右侧预览写死「最近运行 未运行 / 使用次数 0 次」 | 读服务端真实的最近运行、累计次数与最近模型；工具按「已接入 / 待接入」分开显示 |
| 智能体工具 | 五个工具都只写在 system 里，界面小字承认「不自动执行」 | 三个真执行：「读取模板库」「读取画布流程」在对话前读当前账号的模板与流程摘要带进上下文；「导出 JSON」把回复里的 JSON 块整理成可下载文件。响应与运行记录都回报读了什么，没读到就写「为空 / 读取失败」。图片生成、网页读取仍是待接入，界面不假装 |
| 后台模板治理 | 接口支持 PATCH，但管理页只有删除 | 就地编辑标题 / 类型 / 标签 / 原链接，保存走 `PATCH /api/templates/:id`，成功后重新请求列表；失败与成功都有明确提示 |
| 生产口径 | 智能体编辑页还露着 `data/agents.json`、`PATCH /api/agents/…`、`VISION_MODEL`、`system 消息` | 生产只讲产品语言（「保存后回到列表即可直接对话」「由平台统一配置」）；文件、接口路径、环境变量名只在 `VQ_UI_MODE=internal` 的内部环境出现 |

新增接口：`GET /api/agents/:id/history?limit=&offset=`、`DELETE /api/agents/:id/history`；`POST /api/agents/:id/chat` 响应增加 `tools`（读了什么、生成了什么文件）与 `run`（本次运行的扣费记录），并接收 `conversationId` 把同一轮对话串起来。

![智能体运行记录：成功与失败都留档，展开可看原因与扣退积分](docs/screenshot-agent-history-2026-11-10.png)

![智能体编辑器：工具已接入/待接入分开，运行次数来自服务端](docs/screenshot-agent-editor-tools-2026-11-10.png)

![后台模板治理：就地编辑标题 / 类型 / 标签 / 原链接](docs/screenshot-admin-template-edit-2026-11-10.png)

### 十九.2 实测

- 本地集成（同一份服务端代码 + 本地 mock 模型，真实 HTTP 与真实鉴权）：新建带三个工具的智能体 → 对话 200；`tools.used` 报「读取模板库 1 条 / 读取画布流程 1 张」（先建了一条工作流模板和一张流程，确认它真的读到），`tools.artifacts[0]` 是 156 字节的 `agent-output.json`；`GET history` → total 1、status success、`credits.cost=1`、回复 254 字、`runCount=1`、`lastModel` 有值。
- 失败路径（内部环境真实上游）：对话 502 → 运行记录 `status=error`、`credits {cost:1, balance:97, refunded:true}`、错误文案「模型服务额度不足，本次不计费」；余额保持运行前的 100；`DELETE history` 移除 1 条；未知智能体 404、匿名 401。
- 工具 id 迁移：老 `agents.json` 里的 `assets-read` / `canvas-write` 在读取时折成 `templates-read` / `canvas-read`，再次保存落盘的也是新 id（单测通过）。
- 生产：bundle `index-C7ILN4e4.js`，两个服务 active、`/api/health` ok。截图里的失败记录是上游未充值时的一次真实调用；模板编辑用的 QA 条目与流程已删除（模板库回到 0 条），积分 98 未变（扣 1 已退回）。

### 十九.3 下一批

设置页积分流水「加载更多」、后台运行记录按账号 / 流程筛选、后台系统磁盘占用、全局模型偏好、更新检查与下载、找回密码；智能体的「图片生成 / 网页读取」要等图像与网页读取通道。上游模型账号余额仍需充值，智能体成功路径与视觉评审在补余额前只能在内部环境用 mock 验证。

## 二十、2026-11-10 追加八：待接 API 第四批（生产文案收敛、积分流水分页、运行审计按账号筛选）

### 二十.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 生产文案 | 登录页、工作台、设置页、画布、运行抽屉、节点检查器、复刻弹窗、顶栏与更新弹窗仍会露出「服务端」「/api/version」「data/flows.json」「VISION_MODEL」这类实现细节 | 生产环境统一产品语言（「登录状态会安全保存」「数据保存在你的账号下」「平台统一维护」）；文件路径、接口地址、环境变量名只在 `VQ_UI_MODE=internal` 的内部环境保留 |
| 设置页积分流水 | 固定只取最近 12 条，多了就看不到 | `GET /api/credits?limit=&offset=` 服务端分页，返回 `ledgerTotal / ledgerOffset / ledgerLimit`；页面显示「共 N 条，已显示 M 条」并按 12 条「加载更多」，不做前端假分页 |
| 新账号初始额度 | 账号创建时直接写余额 100，账本里没有对应流水，用户看到「有余额、无来源」 | `createUser` 在同一事务里补一条 `welcome` 流水（「新账号初始额度」），余额与流水从第一条开始就对得上 |
| 后台运行审计 | 只能按状态筛选，账号一列也没有 | 账号 / 流程 / 状态三个筛选（`GET /api/runs?ownerId=&flowId=&status=`），表格新增账号列并显示邮箱提示，CSV 同步导出账号；`ownerId=__none__` 专查积分制之前没有归属的历史运行 |

新接口参数：`GET /api/runs` 增加 `ownerId`（支持 `__none__`），`GET /api/credits` 增加 `offset` 并在响应里带上总数与分页回显。

![生产设置页：简单产品语言、积分余额与流水，底部显示「共 6 条，已显示 6 条」](docs/screenshot-settings-ledger-2026-11-10.png)

![内部环境设置页：保留服务端 / cookie / token 等技术说明，流水超过 12 条时出现「加载更多」](docs/screenshot-settings-internal-ledger-2026-11-10.png)

![生产运行审计：账号 / 流程 / 状态三个筛选与账号列](docs/screenshot-admin-audit-filter-2026-11-10.png)

![生产登录页：不再出现「会话由服务端校验」「HttpOnly cookie」等实现细节](docs/screenshot-login-prod-copy-2026-11-10.png)

### 二十.2 实测

- 隔离环境（独立 `DATA_DIR` + 临时端口，真实 HTTP 与真实鉴权）：种子管理员登录后账本 1 条 `welcome`（+100）；再发放 20 次 → `ledgerTotal=21`，第一页 12 条、第二页 9 条、两页 id 无重复、按时间倒序；`offset=40` 返回空页；`limit=9999&offset=-5` 被夹到 200 / 0；匿名 401。
- 运行审计：建一条 input→output 流程并真实执行 → 200 success、扣 2 积分；`ownerId=<账号>` 命中 1 条且 `ownerId` 正确，`ownerId=__none__` 在写入一条无归属运行并重启后命中 2 条，未知账号 0 条，`flowId+status=success` 1 条、`flowId+status=error` 0 条。
- 生产：bundle `index-B5ffs6O4.js`，`visionqa` 与 `visionqa-internal` 均 active、`/api/health` ok；当前余额 98、流水 6 条、运行 1 条、账号 1 个、流程 4 张；截图为真实线上渲染。
- 内部环境：流水 14 条、余额 100，设置页显示「共 14 条，已显示 12 条」与「加载更多」，与生产同一份代码、只是 `VQ_UI_MODE` 不同。

### 二十.3 下一批

后台系统磁盘占用、全局模型偏好、更新检查与下载、找回密码；后台页面（总览 / 账号 / 模型 Key / 模板治理 / 系统）还留着接口路径和「真实接口」标记，下一步按同一口径收敛。上游模型账号余额仍需充值，智能体成功路径与视觉评审在补余额前只能在内部环境用 mock 验证。

## 二十一、2026-11-10 追加九：后台生产口径与数据占用

### 二十一.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 后台全站 | 「真实接口 / 本地会话」标记、`GET /api/...` 路径和接口错误前缀在生产环境也显示 | `SourceTag` 只在内部环境渲染；加载提示生产写「正在加载…」；错误横幅在生产自动去掉 `GET /api/...：` 前缀，只说哪块数据没取到 |
| 后台总览 / 账号 / 模型 Key / 模板治理 | 描述里写 `data/auth.db`、`GET /api/templates`、`npm run adduser`、凭证末四位 | 生产改产品语言（账号体系、模板库真实条目、平台统一维护），凭证只显示「已配置」；文件路径、接口、命令、末四位只在 `VQ_UI_MODE=internal` 出现 |
| 后台系统 | 数据目录只写「接口没有返回磁盘用量」，地址与服务名原样展示 | 新增 `GET /api/admin/storage`：真实统计 data 目录的文件数 / 字节数 / 逐条目占用，并用 `statfs` 给出磁盘余量；生产把回环地址写成「内网地址」、服务名写「VisionQA 工作台」，目录路径与 `deployed = true` 只在内部环境显示 |

新接口：`GET /api/admin/storage`（仅管理员）→ `{dataDir, bytes, files, items[{name,bytes,files}], disk{totalBytes,freeBytes}, checkedAt}`；遍历中单条失败会跳过，不让整页报错。

![生产后台系统：真实占用、磁盘余量与内网地址收敛](docs/screenshot-admin-system-storage-2026-11-10.png)

![内部后台系统：保留数据目录、真实接口标记与 deployed 字段](docs/screenshot-admin-system-internal-2026-11-10.png)

![生产后台总览：去掉接口路径与「真实接口」标记](docs/screenshot-admin-overview-prod-2026-11-10.png)

![生产模型 Key：凭证只写「已配置」，地址与模型标识不露出](docs/screenshot-admin-keys-prod-2026-11-10.png)

### 二十一.2 实测

- 隔离环境（临时 `DATA_DIR` + 临时端口）：管理员 `GET /api/admin/storage` → 200，`files=4`、`bytes=153228`，items 含 `auth.db` / `auth.db-wal` / `agents.json`，disk 返回总量与可用；匿名 401；新建普通账号访问 storage 与 users 均 403 `NOT_ADMIN`。
- 生产：`/api/admin/storage` → 200，`bytes=352718`、`files=8`，disk 39 GB 总量 / 12 GB 可用；bundle `index-BK7y7DVf.js`，两个服务 active、`/api/health` ok；截图为线上真实渲染。
- 内部环境：同一接口返回 498 KB / 10 个文件，数据目录 `/var/lib/visionqa-internal`，页面保留「真实接口」标记与 `deployed` 字段，与生产只差 `VQ_UI_MODE`。

### 二十一.3 下一批

全局模型偏好（顶栏切换目前只写 localStorage，没有任何调用方）、更新检查与下载、找回密码 / 管理员重置口令；后台账号页的删除账号仍未做。上游模型账号余额仍需充值，智能体成功路径与视觉评审在补余额前只能在内部环境用 mock 验证。
## 二十二、2026-11-10 追加十：全局模型偏好与口令管理

### 二十二.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 顶栏模型切换 | 选择只写浏览器 `localStorage`，全站没有任何调用方，换浏览器就丢 | 选择保存到服务端 `GET/PUT /api/preferences`（按账号），刷新、换浏览器仍是同一选择；保存失败会恢复原选择并说明原因，不假装切换成功 |
| 全局偏好生效 | 智能体对话只认请求或智能体绑定的模型，画布 llm 节点没选模型时直接吃平台默认 | 请求显式模型 > 账号偏好 > 智能体/节点自己的模型；智能体默认模型、新建智能体、画布 llm 节点都读同一份偏好，测试用本地 mock 证明上游实际收到偏好模型 |
| 设置页修改口令 | 没有入口，口令只能由管理员在服务器上改 | 「设置 → 修改口令」：当前口令 + 新口令 + 二次确认；成功后其它设备上的会话注销、当前设备保持登录，并显示注销了几个会话 |
| 后台账号 | 只能停用/启用与改角色 | 每行新增「重置口令」：由服务端生成一次性临时口令（含字母与数字），只在这次响应里返回，可复制；该账号所有旧会话立即失效，重置自己会被拦下并指向设置页 |
| 登录页忘记密码 | 弹「密码重置还没接入」，还建议用访客身份 | 生产明确写「联系工作区管理员重置，平台不通过邮件找回，也不会索要当前口令」；内部环境额外说明管理员在后台重置、临时口令只显示一次 |

新增接口：`GET/PUT /api/preferences`（`{model}`，校验模型必须在 `/api/models` 清单里）、`POST /api/auth/password`（`{currentPassword,newPassword}`）、`POST /api/admin/users/:id/password`（可选 `{password}`，不传则生成临时口令）。

![顶栏模型偏好：保存到账号，换浏览器仍是同一选择](docs/screenshot-model-preference-2026-11-10.png)

![设置页修改口令：当前口令 + 新口令 + 二次确认](docs/screenshot-settings-password-2026-11-10.png)

![后台账号：新增「重置口令」，一次性临时口令只在这一次返回](docs/screenshot-admin-users-reset-2026-11-10.png)

![登录页忘记密码：如实引导联系管理员，不暗示访客入口](docs/screenshot-login-forgot-2026-11-10.png)

### 二十二.2 实测

- 隔离环境（独立 `DATA_DIR` + 临时端口 + 本地 mock 模型，真实 HTTP 与真实鉴权）：26 项全部通过。偏好匿名 401、空值读取、非法模型 400 `MODEL_NOT_AVAILABLE`、保存/再读一致、落盘 `preferences.json`；智能体对话与画布流程都把 `model-b` 传给上游，响应记录 `model=model-b`。
- 口令：普通账号调用管理员重置接口 403；管理员重置返回 12 位临时口令、目标账号旧会话 401、临时口令可登录；重置自己 400 `SELF_RESET`；本人改口令当前密码错/太弱都是 400，成功后当前会话 200、另一会话 401、旧口令 401、新口令 200。
- 生产：`PUT /api/preferences` 保存 `deepseek-flash` → 再读一致，清空后回到 `""`；`/api/preferences` 匿名 401。生产当前只配了一个可用模型（`VisionQA 通用模型`），所以截图里只有一个选项；多模型时会按同一接口列出并保存。
- 生产 bundle `index-CCBK1hvU.js`，`visionqa` 与 `visionqa-internal` 均 active、`/api/health` ok；截图为线上真实渲染，未改动充值占位。

### 二十二.3 下一批

在线更新检查与下载/应用、后台删除账号、邮件自助找回（需要邮件通道）；智能体的图片生成 / 网页读取仍等通道。上游模型账号余额仍需充值，真实智能体成功路径与视觉评审在补余额前只能靠本地 mock 验证。

## 二十三、2026-11-10 追加十一：删除账号与工作台画布入口

### 二十三.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 后台账号 | 只能停用/启用、改角色、重置口令，账号建错了没有出口 | 每行新增「删除」：展开确认条，必须手动输入该账号邮箱才能提交；删除会清掉登录、会话、积分流水与账号级模型偏好，该账号创建过的模板、画布与运行记录保留；不能删除当前登录账号 |
| 工作台画布卡片 | 点哪块都只跳到画布页，打开的是上次的画布或默认流程 | 按画布项目 id 打开：`#/canvas/project/<canvasId>`，刷新、复制链接、从别的页面点回来都落到同一块；画布服务连不上时给出明确说明和返回工作台的入口，不白屏 |
| 新建 → 资产画布 | 只跳到画布页，没有真的建画布 | 直接调画布服务建一块「新画布 11/10」并打开它；服务不可用时退回画布页并如实提示失败原因 |

新增接口与地址：`DELETE /api/admin/users/:id`（管理员，自我保护 400 `SELF_DELETE`，不存在 404）、`#/canvas/project/<canvasId>`（路由解析、规范化与去重都覆盖）、`POST /api/bdc/canvases`（工作台新建入口复用已有接口）。

![后台删除账号：输入邮箱确认，明确写出会删什么、保留什么](docs/screenshot-admin-delete-2026-11-10.png)

![工作台：画布卡片按项目打开，不再只是切页](docs/screenshot-overview-canvas-2026-11-10.png)

![线上画布：地址带项目 id 打开「默认画布」，顶栏同步选中该画布](docs/screenshot-canvas-project-2026-11-10.png)

### 二十三.2 实测

- 隔离环境（独立 `DATA_DIR` + 临时端口，真实 HTTP 与真实鉴权）17 项全部通过：匿名删除 401、普通账号删除管理员 403、删除自己 400 `SELF_DELETE`、删除未知账号 404、管理员删除普通账号 200；被删账号旧会话立即 401、无法再登录、列表回到 1 个、`preferences.json` 里没有残留、`users` / `credit_ledger` / `sessions` 三张表计数都是 0；管理员自己的会话不受影响。
- 生产真实 UI：用后台「删除」按钮删掉一条 QA 账号（输入邮箱 → 确认删除），页面提示「已删除账号 …。该账号创建过的模板、画布与运行记录仍保留。」，列表从 2 回到 1；服务端复查三张表计数都是 0，该邮箱登录 401；删除自己 400 `SELF_DELETE`，匿名 401。
- 生产画布入口：从工作台画布卡片进入 `#/canvas/project/20261109-nmeom5h`，顶栏「画布项目」选中「默认画布 · 0 节点」，iframe 地址带 `loadCanvas=20261109-nmeom5h`；内部环境用「新建 → 资产画布」实测生成新画布（`#/canvas/project/vq-mwahph6y`，下拉里 3 个画布），建完直接打开。
- 生产 bundle `index-CNud9XQ1.js`，`visionqa` 与 `visionqa-internal` 均 active、`/api/health` ok；截图为线上真实渲染，未改动充值占位。

### 二十三.3 下一批

在线更新检查与下载/应用、邮件自助找回（需要邮件通道）、爆款雷达「加载更多」与跨页排序口径、模板库「送去评审」的按钮口径（当前是带到评审页并预填，不会自动扣积分发起）。上游模型账号余额仍需充值，真实智能体成功路径与视觉评审在补余额前只能靠本地 mock 验证。

## 二十四、2026-11-10 追加十二：雷达翻页与跨页排序、模板「去评审」口径

### 二十四.1 这一批做了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 爆款雷达 | 只有第一页；排序只重排这一页，翻不到后面的内容 | 底部「加载更多」按页往后翻（每页和检索一样按次计费，按钮上直接写单价），结果按 id 去重后追加；排序作用于「已加载的全部条数」，页脚写明已加载多少、总共多少 |
| 爆款雷达排序 | 排序字段只在本页内生效，服务端固定按点赞返回 | 服务端 sort 参数按白名单校验（点赞/收藏/评论/转发/播放/互动量），未知值回落点赞；回传实际排序字段、页码与 hasMore，翻页时排序规则保持一致 |
| 爆款雷达数据口径 | 选了「按播放」但上游没回播放量时，界面静默不动 | 页脚直接写「当前结果缺少按播放所需的数据，顺序不会变化」，不假装排过 |
| 模板库详情 | 按钮写「送去评审」，实际只是带着首帧跳到评审页并预填，不会发起评审 | 改成「去评审」，悬停说明打开评审页并预填，点「开始评审」才扣积分，不再让人以为已经送出去了 |

新增/变更接口：GET /api/search 支持 page（从 1 开始）与 sort（likes / collects / comments / shares / plays / interactions，未知值回落 likes），响应新增 page、hasMore、sort 三个字段；示例数据模式固定返回 page:1、hasMore:false。

![爆款雷达：加载更多按页追加，页脚写清已加载 64 条 / 共 889 条与每次 2 积分](docs/screenshot-radar-more-2026-11-10.png)

![爆款雷达：按收藏排序作用于已加载的 64 条，收藏数从 3 万递减](docs/screenshot-radar-sort-2026-11-10.png)

![模板库：按钮改为「去评审」，明确是去评审页发起](docs/screenshot-template-review-2026-11-10.png)

### 二十四.2 实测

- 隔离环境（独立 DATA_DIR + 临时端口 + 本地假检索服务，真实 HTTP 与真实鉴权）19 项全部通过：匿名检索 401；第一页 24 条按播放降序、回传 page:1 / sort:plays / hasMore:true 且扣 2 积分；第二页 24 条与第一页零重复、仍按播放降序；按点赞排序生效且与按播放顺序不同；未知排序回落 likes；全部平台一页 48 条且 id 不重复、合并后仍降序；第 21 页 hasMore:false；余额压到 1 分后翻页返回 402 CREDIT_INSUFFICIENT 且不扣费。
- 回归：假检索服务自带 7 项全过（限流、并发、缓存、重试、3105 短路、3210）；积分端到端 23 项全过（检索扣费、退款、402、并发 429、模板归属隔离、管理员发放、SSRF 拦截、深度健康检查）；npm run build 通过，npm run lint 0 错误 3 条既有警告。
- 生产真实 UI：检索「春季通勤」→「加载更多」后 64 条（共 889 条）；这一次两页扣 4 积分，余额 90 → 86，截图里显示的就是 86。切到「按收藏」后第一屏收藏数依次 3 万 / 7345 / 4297 递减，证明排序作用于已加载范围。本轮连同接口核对与模板取材共 7 次真实检索，余额 98 → 84。
- 生产模板库：从真实小红书条目写入一条待解析模板，详情页按钮显示「去评审」；截图后已删除，模板库回到 0 条。
- 生产 bundle index-DeG_IBD9.js，visionqa 与 visionqa-internal 均 active、/api/health ok；截图为线上真实渲染，未改动充值占位。

### 二十四.3 下一批

后台模型 Key 托管与在线更新下载/应用继续按安全口径保持只读 + 部署文档说明（不在控制台写密钥、不做无签名自更新）；邮件自助找回仍等邮件通道；多工作区、智能体图片生成 / 网页读取仍等外部条件或数据模型改造。上游模型账号余额仍需充值，真实智能体成功路径与视觉评审在补余额前只能靠本地 mock 验证。

## 二十五、2026-11-10 追加十三：管理员操作审计与内部环境排查信息（已上线）

结论：后台多了两件**我们自己排障用**的真东西——管理动作落库可查、内部环境能直接看最近请求与错误。
生产环境仍然只讲产品语言：排查接口在生产直接返回 404，操作日志也只显示 IP，不露请求 ID。

### 二十五.1 改了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 后台「运行审计」 | 只有运行记录；停用账号、重置口令、发积分只在 journald 留一行 | 新增「操作日志」页签：动作、操作人、对象、详情、来源与请求 ID；按动作与关键词筛选，服务端分页，记录写进 SQLite，重启后还在 |
| 管理动作 | 只写进程日志，查一次要 SSH 翻 journald | 账号权限、删除账号、重置口令、发放积分四处动作落 `admin_audit` 表；审计写失败只记一条日志，不影响管理动作本身 |
| 后台「系统与版本」 | 版本、画布三端口、数据占用 | 内部环境新增「排查信息」：进程 / 运行时长 / 内存、模型与检索凭证是否就绪、最近错误、最近请求（状态与耗时）；生产环境没有这块，接口 404 |
| 请求日志 | 只 `console.log` 到 journald | 进程内存环形缓冲（最近 400 条请求 / 60 条错误），路由自己 catch 的 5xx 也按状态码补记；重启清空，完整日志仍在 journald |

### 二十五.2 新增接口

- `GET /api/admin/audit?action=&actorId=&q=&limit=&offset=`（仅管理员）
  返回 `{ items, total, limit, offset, actions }`；每条带操作人、动作中文名、对象、详情 JSON、IP、请求 ID。动作白名单由服务端下发，前端不另写一份中文。
- `GET /api/admin/diagnostics`（仅管理员 + `VQ_UI_MODE=internal`）
  返回当前进程、配置是否就绪（只返回布尔与模型名，**不含任何密钥明文**）、最近请求与错误。生产环境此路径恒 404。

### 二十五.3 实测

- 隔离环境（独立 DATA_DIR + 两个临时端口 + 真实 HTTP 鉴权）**29 项全部通过**：审计初始为空；匿名 401、普通账号 403；停用/发放/重置/删除四类动作全部落库；操作人、对象、IP、请求 ID、金额详情正确；按动作筛选、按对象关键词筛选、limit/offset 分页正确；内部环境诊断 200 且返回最近请求；响应里搜不到注入的测试密钥；配置就绪状态真实；内网图片触发评审 500 后进入「最近错误」；生产环境诊断 404，但操作日志仍可用。
- 回归：账号体系 16 项、检索服务 7 项全过；`npm run build` 通过；`npm run lint` 0 错误、3 条既有警告。
- 生产真实操作：给管理员发放 1 积分再扣回 1 积分（净 0，余额仍是 84），操作日志出现两条真实记录；第二次发版重启后记录仍在，证明是落库不是内存。生产截图里「来源」只显示 IP，不带请求 ID。
- 内部环境真实验收：用内网图片地址触发一次评审 500（积分已退回，余额仍 100），「排查信息」显示 1 条错误与 10 条请求，500 那一行状态标红；模型名与上游地址只在内部环境出现。
- 线上 bundle `index-Dv6syFKy.js`；`visionqa` 与 `visionqa-internal` 均 active、`/api/health` ok；充值（billing）保持占位未动。

![生产后台：操作日志按时间倒序显示真实的发放与扣回记录（生产只显示 IP，不显示请求 ID）](docs/screenshot-admin-audit-2026-11-10.png)

![内部环境：系统与版本底部的「排查信息」，含进程、配置就绪状态、最近错误与最近请求](docs/screenshot-internal-diagnostics-2026-11-10.png)

### 二十五.4 下一批

后台模型 Key 托管与在线更新下载/应用继续按安全口径保持「只读 + 部署文档说明」；邮件自助找回仍等邮件通道；多工作区、智能体图片生成 / 网页读取仍等外部条件或数据模型改造。上游模型账号余额未充，智能体成功路径与视觉评审仍无法在真实数据上验收；模板库第一条真实复刻仍等一次真实视频的确认。

## 二十六、2026-11-10 追加十四：智能体「网页读取」真实接入（已上线）

结论：智能体工具里的「网页读取」从「待接入」变成真执行——对话里贴一个公开网页链接，服务端把标题与正文抓进本次上下文；
抓取失败、链接不是公开地址、消息里没有链接，都会在界面上如实说明，不假装读过。模型调用失败时，运行历史仍保留
「工具已执行」的证据与退款记录，排障时能分清是网页抓不到还是模型答不上来。

### 二十六.1 改了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 智能体工具 | 「网页读取」只作能力声明（state=planned） | 真执行：取消息里第一个 http/https 链接，标题 + 正文进上下文；正文最多读 6000 字，本次上下文截到 4000 字 |
| 智能体编辑页 | 3 已接入 · 2 待接入 | 4 已接入 · 1 待接入；说明补上「对话里链接的公开网页」 |
| 智能体运行历史 | 模型失败时整次运行只有错误，工具记录丢失 | 失败也保留已执行工具（如「网页读取 · example.com · 171 字」）与退款，成功与失败口径一致 |
| 内部环境「排查信息」 | 进程、模型、最近请求与错误 | 多两行：网页读取最近一次结果（主机 / 字数 / 成功失败 / 时间）与智能体工具清单；新增单独自检接口，不经过模型 |
| 生产环境 | — | 同一工具照常可用；自检接口与诊断接口在生产恒 404，不暴露内部排障入口 |

安全边界（这是唯一由用户输入决定目标地址的服务端请求，所以逐条写死）：

- 只允许 `http / https`，禁止 URL 里的账号口令，只允许默认端口 80 / 443；
- 禁止 `localhost`、`.local / .internal / .lan / .home / .arpa` 与单段主机名；
- IP 字面量与 DNS 解析结果都判私网（回环、内网、链路本地、组播、IPv4 映射的 IPv6 一律拒绝），
  域名解析到 127.0.0.1 也拦得住；
- 重定向最多 3 跳，每一跳重新校验；超时 8 秒、正文最多读 400KB，只接受文字类 Content-Type；
- 诊断摘要只记主机名，不记完整地址（避免查询串里的令牌落进日志）。

### 二十六.2 接口变化

- `POST /api/admin/tools/web-read`（仅管理员 + `VQ_UI_MODE=internal`，生产 404）
  body `{ url }`，返回 `{ ok, url, title, chars, bytes, truncated, contentType, elapsedMs, excerpt }`；
  失败返回 400/502/504 与稳定错误码（`WEB_READ_BLOCKED`、`WEB_READ_UNAVAILABLE`、`WEB_READ_TIMEOUT` 等）。
- `GET /api/admin/diagnostics` 增加 `tools.list`（每个工具的 id / 名称 / 状态）与 `tools.webRead.last`（最近一次读取摘要）。
- `POST /api/agents/:id/chat`：网页读取在模型调用前执行，属于同一次对话的一部分，不额外扣积分；
  失败响应之后的运行历史会带上 `tools.used` / `tools.skipped`。
- 可调参数：`WEB_READ_TIMEOUT_MS`（默认 8000）、`WEB_READ_MAX_BYTES`（默认 409600）、`WEB_READ_MAX_CHARS`（默认 6000）。

### 二十六.3 实测

- 工具单测 **24/24**：链接提取（中文标点、括号收尾）、无链接、15 类内网/非法地址拦截（含 `169.254.169.254`、
  IPv6、`localtest.me` 解析到 127.0.0.1）、公网页面真实读取、正文长度上限与截断标记。
- 隔离环境（两个独立 DATA_DIR + 两个临时端口 + 真实 HTTP 鉴权 + 本地假模型）**33/33 全部通过**：
  带链接对话 200 且模型上下文里真有页面标题、正文与来源；无链接如实跳过；内网链接被拦且正文没进上下文；
  模型失败时工具证据仍在运行历史、积分全额退回；内部自检 200 / 内网 400 / 缺链接 400 / 匿名 401 / 普通账号 403；
  生产环境自检与诊断 404；生产对话响应不含测试密钥与上游路径。
- 回归：第九批 29 项、账号体系 16 项、检索 7 项全过；`npm run build` 通过；`npm run lint` 0 错误、3 条既有警告。
- 生产真实链路：创建一个临时智能体开启网页读取，对话里贴 `https://example.com/` 后模型仍返回
  「模型服务额度不足」，但运行历史明确记录「网页读取 · example.com · 171 字」、本次 1 积分已退回（余额回到 84）；
  临时智能体随后删除，模板库仍为 0 条。
- 内部环境真实验收：自检接口读取 `https://example.com/` 返回 200、标题 Example Domain、171 字、773ms；
  `169.254.169.254` 返回 400 `WEB_READ_BLOCKED`；「排查信息」显示最近一次成功与工具清单。
- 线上 bundle `index-DcczDgzT.js`；`visionqa` 与 `visionqa-internal` 均 active、`/api/health` ok；充值（billing）保持占位未动。

![生产智能体编辑器：工具区显示 4 已接入 · 1 待接入，「网页读取 · 已接入」并写明读取对话里的公开网页](docs/screenshot-agent-tools-2026-11-10.png)

![内部环境「排查信息」：网页读取最近一次成功（example.com · 171 字）与智能体工具清单，自检请求 200](docs/screenshot-internal-webread-2026-11-10.png)

### 二十六.4 下一批

图片生成仍需要真正的图像通道与计费口径，继续标「待接入」；后台模型 Key 托管与在线更新下载/应用保持
「只读 + 部署文档说明」；邮件自助找回仍等邮件通道；多工作区仍等数据模型。上游模型账号余额未充，
智能体成功路径与视觉评审仍无法在真实数据上验收；模板库第一条真实复刻仍等一次真实视频的确认。

## 二十七、2026-11-10 追加十六：生产界面口径第二轮（15 页真实扫描，已上线）

结论：用无头浏览器按真实登录态走完生产 15 个页面，扫出 6 处仍带技术词或内部地址的文案，已全部改掉；
健康检查接口也按环境分口径——生产只回答「能不能用」，内部保留 Node 版本、数据目录、上游状态码。
改完复扫 15 页：内部词 0 命中、脚本异常 0、失败请求 0、横向溢出 0、破图 0。

### 二十七.1 怎么扫的

- Chrome headless + 生产真实会话，1440×1200，逐页读 `document.body.innerText`，匹配 40 个内部词
  （厂商名、上游、环境变量、`127.0.0.1`、数据目录、PID、HTTP 状态码、待接入、示例数据等），
  同时记录脚本异常、4xx/5xx 响应、横向溢出与破图。
- 首轮命中 6 页：工作台与爆款雷达（示例数据 / 上游）、智能体编辑（待接入）、视觉评审（`127.0.0.1:6300`、provider）、
  设置（上游、Node 版本、数据目录、HTTP 200）、后台总览（示例数据）。

### 二十七.2 改了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 设置 · 健康检查 | 生产显示 Node 版本、内存、`/var/lib/...`、上游模型数、HTTP 状态码 | 六项产品状态：服务运行 / 账号与积分 / 数据存储 / 模板库 / 模型服务 / 检索服务，详情写「运行正常」「可读写 · 剩余 13GB」「2 个模型可用」「已连通」；生产失败只写「暂时不可用」，不返回原始报错 |
| 视觉评审 | 生产写「插件服务未启动（127.0.0.1:6300）」「provider」「visual-baseline」 | 生产写「本地评审插件未启动，本次由平台视觉模型按同一套评审规则完成」；技术细节只在内部环境出现 |
| 智能体编辑器 | 生产显示「4 已接入 · 1 待接入」「图片生成 · 待接入」 | 生产显示「4 项可用 · 1 项即将开放」；「已接入 / 待接入」只留在内部环境 |
| 爆款雷达 / 工作台 / 后台总览 | 「上游失败会原路退回」「不放示例数据」 | 改为「检索失败会原路退回」「示例结果」「没有数据时写清空状态」；后台说明改为「雷达会明确标注结果来源」 |
| 公开 `GET /api/health` | 匿名也能看到 `deepseek-flash` 与 `llmModel` | 生产只返回 `ok / vision / redfox / templates`；模型标识只在内部环境返回，探针脚本仍只看 `ok` |

内部环境不回退：进程、运行时长、内存、数据目录、上游模型数、HTTP 状态码、工具清单与网页读取最近一次结果都保留。

### 二十七.3 验收

- 新增隔离测试 **18/18**：三套服务（内部 / 生产 / 依赖故障的生产）各自登录后比对健康检查；
  生产标签与详情不含路径、Node 版本、HTTP 状态码、上游字样与密钥；内部保留全部细节；
  依赖故障时生产只写「模型服务暂时不可用 / 检索服务暂时不可用」，不泄露域名与错误码；
  公开探针生产不带模型标识、内部带模型标识且仍回答能不能干活。
- 生产 15 页复扫：**全部 0 命中**，0 脚本异常、0 失败请求、0 横向溢出、0 破图。
- 回归：第十批 33 项、第九批 29 项、网页读取单测 24 项、账号 16 项、检索 7 项全过；`npm run build` 通过；`npm run lint` 0 错误、3 条既有警告。
- 线上真实接口：生产 `/api/system/health` 六项分别是「运行正常 / 账号与积分数据可读 / 可读写 · 剩余 13GB /
  共 0 条模板 / 2 个模型可用 / 已连通」；内部同一接口显示 Node v22.12.0、`/var/lib/visionqa-internal`、
  上游 2 个模型可用、可达（HTTP 200）；公开 `/api/health` 已不返回模型标识。
- 线上 bundle `index-BC5Rp4Tu.js`；`visionqa` 与 `visionqa-internal` 均 active；充值（billing）保持占位未动。

![生产设置页健康检查：六项产品语言状态，不出现路径、版本号、上游与状态码](docs/screenshot-settings-health-2026-11-10.png)

![生产智能体编辑器：工具显示「4 项可用 · 1 项即将开放」，不再出现「已接入 / 待接入」](docs/screenshot-agent-tools-prod-2026-11-10.png)

### 二十七.4 下一批

图片生成仍需要真正的图像通道与计费口径；后台模型 Key 托管与在线更新下载/应用保持「只读 + 部署文档说明」；
多工作区切换、邮件自助找回仍等数据模型或邮件通道。上游模型账号余额未充，智能体成功路径与视觉评审仍无法在
真实数据上验收；模板库第一条真实复刻仍等一次真实视频的确认。

---

## 二十八、第十二批（2026-11-10 晚间）：模型服务「真能出结果」才算可用

### 二十八.1 问题

健康检查此前只探 `/models`：上游余额为 0 时它也返回 200，于是设置页写着「2 个模型可用」，
用户一点对话就 502。更别扭的是每次失败都先扣 1 积分再退回，账本里堆一串「对话 / 对话退款」；
视觉评审也一样。判断标准错了：**接口能连通不等于账号出得了结果**。

### 二十八.2 改了什么

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| 服务端状态 | 没有 | `server/service-state.mjs` 记住最近一次真实调用的结果：只认「额度不足 / 凭证失效」两类账号级故障，超时、限流、单模型 404 仍按可重试处理；5 分钟自动失效 |
| 健康检查「模型服务」 | 只看 `/models` 探活 | 有真实失败时直接判不可用：生产只写「暂时不可用」；内部写「上游额度不足（Insufficient Balance / 402）· 最近一次 … · 连续 1 次 · 模型 deepseek-flash」 |
| 对话 / 评审 | 先扣积分再调上游 | 已知不可用时在扣费前返回 503 `MODEL_UNAVAILABLE`（带 `retryAfterSec`），积分账本不新增扣退流水 |
| 恢复方式 | 只能等服务重启或状态过期 | 任一次真实调用成功即清零；页面「重新检测」走 `POST /api/system/service/recheck`，放行一次真实请求，成功就恢复 |
| 生产失败文案 | 失败卡片小字显示 `UPSTREAM` 等内部码 | 内部码只在内部环境显示，生产只保留「本次未扣积分，管理员正在处理」这类产品说明 |
| 新接口 | 无 | `GET /api/system/service`（登录可见）：生产 `{ available, message, retryAfterSec }`；内部另带 `code / detail / upstream / since / count / lastModel` |

界面接线：智能体对话的输入卡片顶部、视觉评审页头下方各有一条提示条，写明「本次未扣积分」并带「重新检测」；
确认不可用时发送键与「开始评审」置灰，避免白点一次。

### 二十八.3 验收

- 新增隔离测试 **25/25**（假上游可切换「额度不足 / 凭证失效 / 正常」）：失败后状态被记住；生产状态接口只有产品说明、
  不含 `detail / upstream / code`；第二次请求在扣费前被拦下且余额与流水都不变；生产健康检查「模型服务」为
  「暂时不可用」且全文不含上游报文与模型名；内部环境保留原始报文、模型名与失败时间；重新检测后放行；
  上游恢复后对话成功且状态自动清零；凭证失效同样记为「接入异常」；评审同样被拦下；状态接口要求登录；公开探针口径不变。
- 回归：第十一批 18 项、第十批 33 项、第九批 29 项、网页读取单测 24 项、账号 16 项、检索 7 项全过；
  `npm run build` 通过；`npm run lint` 0 错误、3 条既有警告。
- 线上真实接口（生产）：余额 84，真实失败一次返回 502「模型服务额度不足，本次不计费」，扣 1 退 1（流水 17 → 19）；
  紧接着的第二次请求返回 503、余额与流水均不变；`/api/system/health` 的「模型服务」变为「异常 · 暂时不可用」，
  生产页面不出现上游报文。内部环境同一时刻显示 `Insufficient Balance / 402`、模型名与失败时间。
- 线上 bundle `index-D-z8A3x2.js`；`visionqa` 与 `visionqa-internal` 均 active；充值（billing）保持占位未动。

![生产智能体：模型服务不可用时在输入卡片上方说明，不扣积分，可重新检测](docs/screenshot-agents-model-down-2026-11-10.png)

![生产视觉评审：页头状态与提示条同时标出「暂时不可用」](docs/screenshot-review-model-down-2026-11-10.png)

![生产设置页健康检查：模型服务显示异常与「暂时不可用」，不出现上游报文](docs/screenshot-settings-model-down-2026-11-10.png)

![内部测试环境的同一条健康检查：保留上游报文、模型名与失败时间，用于排障](docs/screenshot-settings-model-down-internal-2026-11-10.png)

### 二十八.4 下一批

图片生成仍需要真正的图像通道与计费口径；后台模型 Key 托管与在线更新下载/应用保持「只读 + 部署文档说明」；
多工作区切换、邮件自助找回仍等数据模型或邮件通道。上游模型账号余额仍未充：现在系统会如实显示「模型服务不可用」
并在扣费前拦下，但智能体成功路径与视觉评审仍无法在真实数据上验收；模板库第一条真实复刻仍等一次真实视频的确认。
