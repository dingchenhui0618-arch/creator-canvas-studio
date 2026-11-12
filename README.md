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
| 作品 | **一条内容一条记录**：`#/projects` 与 `#/projects/<id>`；只存「绑哪条模板 + 哪块画布 + 到哪一步」，脚本与分镜实时取自模板；作品页按「下一步」给一张主卡（开画布 / 送评审 / 继续改 / 交付）；改名、多版本对照、运行按作品归集、脚本 copy-on-write、**只读分享链接**都已上线；智能体草稿可**存为模板 / 送到画布** | 默认只存引用，脚本只在改过时复制一份；**没有作品级权限 / 协作 / 分享访问统计** |
| 导航 | 一级只留四个去处：**工作台 / 作品 / 发现 / 模板库**；智能体 / 画布 / 视觉评审 / 运行记录退到「工具」区；可用 Ctrl / ⌘ + K 快速跳转任意页面与动作 | 智能体编辑器仍归在「智能体」项下；路由保持原样（`#/radar` 等旧地址照旧可用） |
| 本地工作区（桌面端） | **loop、工具、会话记忆都在本机**：列目录 / 读文件 / 写文件 / 执行命令四个工具，写文件与执行命令必须逐次批准；会话落盘可续，上下文超预算先压成摘要；模型补全走账号会话（`/api/local-agent/complete`），密钥不下发 | 只在 Electron 外壳里出现，网页版打开 `#/local` 会如实说明不可用；**还没有安装包**（`npm run desktop` 起开发外壳，见第六十七节） |
| 发现（原爆款雷达） | 进页面**不自动检索**，点「检索」才发请求；卡片给播放 / 点赞 / 收藏 / 评论 / 转发与互动率；可「加入模板库」或「一键复刻」 | 抖音有播放量，小红书没有；取不到就隐藏，不做估算 |
| 一键复刻 | 视频解析 → ffprobe → FFmpeg 拆帧 → 逐帧视觉分析 → 入库，五步进度与实时日志 | 平台链接解析依赖红狐 Key；直链兜底可用 |
| 模板库 | **只存原链接 + 互动数据 + 解析出的脚本与分镜，不保存视频文件**；待解析 / 已解析两种状态，详情抽屉里可「去解析」；类型/关键词检索；送去评审 | 待解析条目没有帧图，封面走 /api/cover 代理 |
| 智能体 | 对话框式入口、参数行（智能体/输出/模型）、已自建智能体分类卡片、新建/编辑/删除；对话带**最近 8 条 / 6000 字**的会话记忆；脚本/分镜回复带**结构化草稿**，可存为模板、送到画布 | 记忆由服务端截断，超出部分不带；不落库；草稿只认回复里那段 ```draft JSON，模型没给就没有出口，不从正文表格反推 |
| 画布 | React Flow 节点编排（input/llm/kb/tool/condition/output）、检查器、连线校验、保存、逐节点运行；节点面板默认收起，双击画布或点「节点」唤出 | 运行是真执行，耗时真实；VisionQA Canvas 部署后画布交给它接管（见第六节） |
| 视觉评审 | 选画面 → visual-baseline 七维评审 → verdict + 像素锚点 + 有界修正建议 | 未启动 VisionQA 插件服务时由本地模型出一份同契约结果，provider 会写清 |
| 运行记录 | 读 data/runs.json，逐节点状态、耗时、输出 | 只有画布执行会产生记录 |

导航分两层：一级 4 项「工作台 / 作品 / 发现 / 模板库」，下面是「工具」区「智能体 / 画布 / 视觉评审 / 运行记录」，底部只留设置；桌面端在这之间多一组「本机 › 本地工作区」。左上角只写 VisionQA，不放图形标记；导航只有 `src/nav.ts` 一份真源（第六十六节）。

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

**模型切换的口子怎么用**：右上角模型下拉读 `GET /api/models`，目录来自服务器 `.env` 的 `VISION_MODELS`（逗号分隔，每项可写 `id|显示名`），没配就退回 `VISION_MODEL` + `VISION_FALLBACKS`；改完重启服务、刷新页面即可，**前端不用改一行**。公开匿名**拿不到**这份清单（`VQ_REQUIRE_AUTH=1` 时 401），只有登录后的界面能读；顶栏下拉只显示 VisionQA 产品名，真实模型 id 只用于请求。真正要发起调用时，把 `VISION_BASE_URL` / `VISION_API_KEY` 填进同一个 `.env`，`configured` 会变 true，下拉里的「凭证未配置」提示自动消失。

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


## 六十五、智能体结构化草稿与两个出口：存为模板 / 送到画布（v0.5.2）

智能体的回复现在带一份**机器可读版本**：正文照常讲思路，末尾附一个 ```draft JSON 块。
服务端只认这一段，把它整理成「段 + 镜」的草稿（标题 / 钩子 / 每段口播与屏幕字 / 每镜画面与字幕），
**正文气泡里不会出现那坨 JSON**。回复下面出现一张草稿卡：6 段脚本 · 6 个分镜 · 口播约 20.1 秒，
右边两个按钮——存为模板、送到画布。

| 之前 | 现在 |
| --- | --- |
| 智能体只产出自由文本，想留下得自己复制去模板 / 画布 | 回复带结构化草稿，两个按钮直接落库 |
| 存模板要重新填标题、段数、时长 | 存为模板：落成 `kind: agent` 的新模板，段落、分镜、时长一起带过来，存完在模板库能搜到、能套用 |
| 送到画布要自己搭 input + llm 节点、自己写提示词 | 送到画布：建一张两节点画布（原始素材 → 复刻脚本），提示词就是这份脚本，带每段「这句要念几秒」 |
| 开了「导出 JSON」的智能体会把草稿块当成「没有 JSON」 | 导出工具认内容不认标签，草稿照样导出 `agent-output.json` |

实现要点：

- **草稿块只认 fenced 代码块**（```draft / ```json），解析失败或形状不合格就当没有草稿；
  不从 Markdown 表格反推、不截断成坏 JSON——宁可不给出口，也不存一条假结构。
- **时长不采信模型写的秒数**：统一用 `server/speech.mjs` 按口播字数估（与模板、作品同一口径），
  分镜里没字幕也没声音的镜头给 2 秒默认值；草稿卡与模板详情显示的是同一个数。
- 上限：段落 12 段、分镜 24 镜；标题 60 字、单段口播 600 字。
- 两个出口都**不扣积分**（没有模型调用）；草稿由服务端重新整理，不信任客户端回传的形状。
- 模板库里 `kind: agent` 单独标「智能体」、**不显示原片互动数据**（它不是某条爆款的复刻），
  详情写「来自智能体 X · N 段 · M 镜」；没有分镜的草稿不显示「改编这条」（改编要求分镜在场）。
- 送画布复用已有的复刻草稿生成器（`server/script-draft.mjs`），和作品页开画布走同一套节点与提示词前缀。

![智能体回复 + 结构化草稿卡：6 段 / 6 镜 / 口播约 20.1 秒，两个出口都在](docs/screenshot-agent-draft-2026-11-12.png)

![两个出口都点过：已存为模板、已送到画布，各带一个「打开」；草稿与正文都还在](docs/screenshot-agent-draft-exits-2026-11-12.png)

![送到画布：原始素材 → 复刻脚本，2 节点 1 连线，提示词就是这份脚本](docs/screenshot-agent-draft-canvas-2026-11-12.png)

![存为模板：模板库第一条标「智能体」，类型是解析过的「脚本」，6 段 6 镜](docs/screenshot-agent-draft-library-2026-11-12.png)

![模板详情：来自智能体「口播脚本与分镜」，脚本段落带每段时长，分镜表写「分镜 20.1s」而不是「原片」](docs/screenshot-agent-draft-template-2026-11-12.png)

验收：生产 **v0.5.2**、`/api/health` ok（templates 26）、入口 `index-rKFBCLkL.js`；
用真实 DeepSeek 跑一轮「租房咖啡机」口播（输出类型「分镜」，36.1 秒），服务端取出 6 段 / 6 镜草稿；
点「存为模板」得到 `tpl_8cfe9e23`（`kind: agent`、6 段 / 6 镜、时长 20s、`timing.fit = ok`），
点「送到画布」得到 `flow_4edab7b8`（2 节点 1 连线，提示词里带每段「这句要念 X 秒」）；
运行记录里这一轮的工具是「读取画布流程 + 结构化草稿」，没有 skipped，扣 1 积分。
`npm test` **74/74**（新增 8 条：草稿块解析与去除、坏 JSON 不生成草稿、段镜上限、只有分镜的草稿、
画布提示词、存模板、空草稿不落库、导出 JSON 认内容不认标签）；oxlint 0 error / 8 warning（均为既有）。

这一片是边截图边修的：v0.5.0 的草稿指令写成「适合就输出」，模型因为正文已经写了口播和分镜表而整段省略；
改成强制格式后 v0.5.1 又暴露出「路由没把 draft 带回响应」和「导出 JSON 只认 ```json、不认 ```draft」两个问题，
v0.5.2 才把截图定稿。v0.5.0 / v0.5.1 那两次试跑存的模板与画布已删（模板进回收站），
保留的是最后一轮真实产物，可在生产打开。

## 六十六、P2 导航收敛：一级四去处 + 工具区 + 快速跳转（v0.6.0）

这一片改的是**信息架构**，不是加页面。侧栏原来 7 项平铺，智能体、画布、评审和「发现 / 模板库」看起来是同一类入口——
但前三个其实是「从作品的某一步被带进去的能力」。现在一级只留四个去处，其余收进工具区；
「爆款雷达」改名「发现」（地址仍是 `#/radar`，旧链接、收藏、分享都不失效）；补了 Ctrl / ⌘ + K 快速跳转，
键盘三步内能到任何页面或动作。

| 之前 | 现在 |
| --- | --- |
| 侧栏 7 项平铺：工作台 / 作品 / 爆款雷达 / 模板库 / 智能体 / 画布 / 视觉评审 | 一级 4 项 + 「工具」区 4 项 + 底部「设置」；工具区有独立分组标签 |
| 智能体、画布、评审和「发现 / 模板库」并列，看不出主次 | 工具页的面包屑多一段「工具」：个人工作区 › 工具 › 画布 |
| 收起侧栏后 9 个图标挤在一起，分不出主线与工具 | 收起或窄屏时，分组标签变成一道发丝线，主线与工具仍然分得开 |
| 名字叫「爆款雷达」，实际做的是发现与拆解 | 页面名「发现」，页头 kicker 写「内容发现」；路由不变 |
| 页面一多，到「运行记录」要穿过三层 | 顶栏「跳转到…」或 Ctrl / ⌘ + K：输入几个字母就筛到目标，↑↓ 选择、Enter 打开、Esc 关闭 |

实现要点：

- **导航只有一份真源**：`src/nav.ts` 导出 `PRIMARY_NAV / TOOL_NAV / SETTINGS_NAV` 与 `isNavActive / isToolPage`，
  侧栏与命令面板都从它生成，不再各抄一份页面清单；改导航只改这一处。
- **命令面板是纯函数 + 薄组件**：匹配规则在 `src/domain/commands.ts`（多词全中、大小写不敏感），
  组件只管渲染与键盘。清单 = 9 个导航目标 + 3 个真动作（新建空白画布 / 使用引导 / 收起侧栏）。
- **键盘与焦点**：打开时焦点进输入框并锁住背景滚动；Esc / 点遮罩关闭，焦点还给打开它的控件；
  在输入框里按 Ctrl+K 不抢键（编辑器里的同名快捷键仍属于编辑器）；只在没有上手引导 / 版本弹窗时响应。
- **窄屏不漏可访问名**：900px 以下侧栏固定 68px、文字由 CSS 隐藏，按钮仍带 `aria-label` 与图标态 tooltip；
  分组标签在收起态与窄屏下是同一个元素（1px 发丝线），不多渲染一个节点。
- 顺带修掉侧栏旧「运行记录」在底部设置层的错位：它属于工具，不属于设置。

![导航收敛：一级四项，工具区单独成组，顶栏多一个快速跳转入口](docs/screenshot-nav-2026-11-12.png)

![快速跳转：页面 / 工具 / 设置 / 动作四组，一屏装得下 12 条](docs/screenshot-nav-palette-2026-11-12.png)

![输入「画布」剩下三条：画布、运行记录（提示里含画布）、新建空白画布](docs/screenshot-nav-palette-filter-2026-11-12.png)

![发现（原爆款雷达）：页头与面包屑同步改名，高亮在「发现」](docs/screenshot-nav-discovery-2026-11-12.png)

![工具页：面包屑「个人工作区 › 工具 › 运行记录」，高亮在工具区](docs/screenshot-nav-tool-2026-11-12.png)

![收起侧栏：只剩图标，主线与工具之间是一道发丝线](docs/screenshot-nav-collapsed-2026-11-12.png)

**桌面端形态定下来了**：先做「桌面优先的网页外壳」（固定左侧栏 + 顶栏 + 内容区），
Electron 之后只负责把同一外壳套进本地窗口、多一个「本地工作区」，导航层级不再改。
这样 P2 不必等 Electron，也不会把导航做两遍；本地 agent loop 与压缩协议按原计划接在这套外壳后面。

验收：生产 **v0.6.0**、`/api/version` 0.6.0、`/api/health` ok（templates 26）、入口 `index-DYSi_9wT.js`。
CDP 在生产页面实测：侧栏 3 段（一级 4 / 工具 4 / 底部 1）、面板分组「页面·工具·设置·动作」、
过滤「画布」剩 3 条、Enter 跳转后地址与高亮一致、Esc 后焦点回到入口且背景滚动恢复、
在发现页搜索框里按 Ctrl+K 不弹面板；900px 窄屏侧栏 68px、9 个图标都有可访问名；全程 0 条页面异常。
`npm test` **74/74**、oxlint 0 error / 8 warning（均为既有）、`npm run build` 通过。


## 六十七、桌面外壳与本地工作区：agent loop 跑在本机（v0.7.0）

上一片把桌面形态定成「网页外壳 + Electron 只套壳」，这一片把「多出来的那一块」做成了真能干活的东西：
桌面端多一个**本地工作区**——循环、工具、审批、会话记忆都在这台机器上跑，模型补全仍然走 VisionQA 账号。

| 之前 | 现在 |
| --- | --- |
| 网页里点按钮，服务端做事 | 桌面端里点发送：列目录、读文件、执行命令都在这台机器上，服务端只负责「用平台 Key 换一次补全」 |
| 智能体只有对话，没有工具 | 四个本地工具，**写文件与执行命令必须先批准**，路径锁在工作区内 |
| 刷新页面就等于从零开始 | 会话存在本机，重启还在；上下文超过预算先压成摘要再继续 |
| 网页版没有本地能力 | 网页版打开 `#/local` 会如实说「只在桌面端可用」，不给一个假界面 |
| 要让客户端能跑模型，就得把密钥发下去 | 密钥不下发：桌面端用账号会话调 `/api/local-agent/complete`，一轮只扣一次积分 |

分层（也是为什么它能被测试）：

```
渲染进程（React / src/pages/LocalWorkspacePage.tsx）
        ⇅ IPC（preload 只暴露 8 个方法）
主进程（electron/main.cjs：窗口、菜单、Cookie、会话落盘）
        ⇅ 直接调用
agent（electron/agent/*.mjs：协议解析 / 工具 / 审批 / 压缩 / 存储，不 import electron）
        ⇅ POST /api/local-agent/complete
服务端（平台 Key + 模型降级链，扣积分只在这里）
```

实现要点：

- **一步一个 JSON**，不依赖供应商 function calling：`{"type":"tool",...}` 继续查、`{"type":"final",...}` 收尾；
  一轮最多 8 步，用完就直说「到上限了，没做的还没做」。
- **审批是真的会等**：`write_file` / `run_command` 把请求推到界面，用户点允许才执行；拒绝就把这条写回上下文，
  让模型不要原样重试。窗口在后台时会闪任务栏。
- **边界不止一道**：所有路径先过 `resolveInside()`，工作区外的读写直接报错——审批不是唯一防线。
- **压缩**：64k 预算、到 75% 触发、保留最近 ≤6 条、摘要 ≤1200 字；摘要生成失败就**不动历史**，下一轮再试。
- **会话落盘**：`userData/local-agent/threads/*.json`，临时文件 + rename，强杀不会留半个 JSON。
- **桌面壳**：单实例、窗口位置记忆、外链交系统浏览器、中文菜单、`will-navigate` 只放行同源；
  页面刷新时主动中止挂起的审批（否则那一轮会永远等人点按钮）。

三处是**实测踩到才补的**（不是设计时想到的）：

1. 模型会在工具调用后面自己编一段「`<system>工具执行成功…`」——第一版把这段原文写进历史，下一轮它把自己编的内容当证据，
   于是一边读真实文件、一边报「文件里写的是《夜班》」。现在历史里只写**规范化后的调用**，伪造段落不进上下文。
2. 模型会漏转义引号、在 JSON 字符串里直接写换行——先做控制字符转义再解析；仍不合法就判定为格式错误。
3. 格式确实不对时，**只要求它重发一次**（界面上会留一行「已要求模型重发」），第二次还不对就停，不让它空转。

![本地工作区：写文件前停下来等批准，参数按「路径 / 内容」摊开，不用读 JSON](docs/screenshot-desktop-local-2026-11-12.png)

![批准之后：工具卡给出真实执行结果，审批收成一行「已允许执行」，下面是最终回答](docs/screenshot-desktop-local-done-2026-11-12.png)

![网页版打开 #/local：侧栏里根本没有这一项，页面如实说明本地能力只在桌面端](docs/screenshot-web-local-2026-11-12.png)

验收：生产 **v0.7.0**、入口 `index-XB_UdIu2.js`、release `20261112-122641-0.7.0.tar.gz`、`/api/health` ok（templates 26）、
`/api/local-agent/meta` 匿名 **401**（登录才可见）。生产 Electron 窗口里真实走了一遍：
登录 → 本地工作区（工作区 `D:\Projects\visionqa-local-demo`）→ `list_dir` → `read_file brief.md`（读到的就是磁盘上的 10 行）
→ `write_file INDEX.md` **等待批准** → 允许 → 写入 320 字节；中途模型一次格式不对，被自动要求重发后继续。
本地实测：重启后会话与工具卡原样恢复；拒绝审批时文件不会出现；页面刷新会中止那一轮。
`npm test` **86/86**（74 + 本地循环 12 条）、oxlint 0 error / 8 warning（均为既有）、`npm run build` 通过。

更多本地工具与跨会话长期记忆已在 v0.8.0 补上（见下一节）；桌面端安装包与 v0.9.0 见再下一节。

## 六十八、本地工作区的长期记忆：跨会话记住，改文件走补丁（v0.8.0）

结论：本地工作区以前每开一个新会话都是白纸——压缩只解决「这一轮说了什么」，跨会话仍然没有连续性。
这一片补上**按工作区存的长期记忆**，再顺手把两个最常用的工具补齐：**按关键词找内容**（只读）与**补丁式改文件**（要批准）。
记一条不花积分：用户发「记住：…」由主进程直接写盘，不调模型。

| 之前 | 现在 |
| --- | --- |
| 新会话从零开始，上次说定的路径、命名、口径都要重讲 | 每个工作区一份长期记忆，新会话说「老规矩」它就懂；不同目录是不同的一份 |
| 记忆只活在上下文里，压缩一次就可能丢 | 落盘在 `userData/local-agent/memory/<工作区哈希>.json`，重启、换会话都在 |
| 只能整份读、整份写 | 新增 `search_text` 按关键词定位（给出「文件:行号: 那一行」）、`edit_file` 只换唯一一段原文 |
| 记忆怎么来的不透明 | 面板里一条条看得见：原文、被召回几次、最近一次什么时候，能单条删、能清空 |

记忆的四个决定：

- **跟着工作区走**：文件名是工作区路径的哈希，换个目录就是另一份；路径大小写、斜杠写法不同也算同一个目录。
- **两个入口**：智能体在你说出长期有效的约定时自己调 `remember` 记一条；你也可以直接发「记住：…」——这条不调模型、不扣积分。
- **召回不是全塞**：按当前这句话和每条记忆的词语重合度排序，最多 8 条 / 1600 字，被用到的计一次「召回」。
  满 40 条后先淘汰「最少召回、最久没用」的那条。
- **记忆是提示，不是事实**：系统提示里写明「这是以前记的，和用户现在说的冲突以现在为准，不确定就重新读文件核对」。

两个新工具：

- `search_text`：只读，走关键词（按字面匹配，不把它当正则），跳过 `node_modules` / `.git` / 产物目录与二进制文件，
  最多 400 个文件 / 60 处命中，到上限会直说「可能还有」。
- `edit_file`：**必须批准**。原文必须在文件里**只出现一次**，否则拒绝并让你多带两行上下文；
  替换后回报行数与字节数，模型不需要重写整份文件。

实测踩到的三件事：

1. **`EPERM: rename`**：新建会话后立刻再存一次，Windows 上偶发 `rename` 被占用（杀毒/索引器正在读新文件），
   那一轮直接失败。现在所有落盘走 `writeFileAtomic()`：写 .tmp → rename，遇到 `EPERM/EACCES/EBUSY` 退避重试 6 次，
   仍失败才删 .tmp 并抛错，**原文件保持不动**（这条有单测）。
2. **模型不轻信记忆**：生产里我故意记了一条「发布前跑 npm test、用 ops/deploy.sh 打包」，它在那个没有 `package.json` 的演示工作区里
   先 `search_text` 核实，发现对不上，明确说「这条记忆不适用于此工作区，别照做」，还自己写回一条更正。
   这正是「以现在为准」那行提示在起作用——记忆没有让它闭眼照做。
3. **会话栏在长一轮里一直写着「新的本地会话 / 0 条」**：改名与条数以前只在本轮结束后才刷新。现在主进程补发 `title` 事件、
   `user` 事件带上条数，发送后立刻变成第一句话。

![记忆面板：这个工作区的长期记忆，一条条看得见，被召回几次也写得明明白白](docs/screenshot-desktop-memory-2026-11-12.png)

![新会话里问「成片多少秒、几镜」，它直接用长期记忆回答，状态栏写着「本轮用到 2 条记忆」](docs/screenshot-desktop-memory-recall-2026-11-12.png)

![补丁式改文件：只换唯一一段原文，批准卡把原内容与新内容并排摊开](docs/screenshot-desktop-edit-2026-11-12.png)

验收：生产 **v0.8.0**、入口 `index-C6sOIVZZ.js`、release `20261112-124816-0.8.0.tar.gz`、`/api/version` 0.8.0、
`/api/health` ok（templates 26）、`/api/local-agent/meta` 匿名 **401**。
生产 Electron 窗口里真实走了一遍：记忆面板 2 条 → 新会话问「成片多少秒、几镜」→ 状态栏「本轮用到 2 条记忆」→
回答 30 秒 / 8 镜且注明「来自本工作区的长期记忆，不是这次重新读文件确认的」；
`edit_file` 改 `patch-demo.md` 的 `版本：v2 → v3` 走完**待批准 → 允许 → 替换 1 处**，文件 44 字节、其余未动；
重启应用后两条记忆与 5 条会话都还在，召回次数继续累加（当时 9 / 4）。
`npm test` **92/92**（74 + 本地循环 18 条）、oxlint 0 error / 8 warning（均为既有）、`npm run build` 通过。

还没做：**安装包**（electron-builder、签名、自动更新）——签名证书与更新源要你先定；
跨会话记忆目前是「模型主动记 + 用户命令记」，还没有后台批量提炼与语义召回（现在是关键词重合度），
这两件等安装包落地后再排。


## 六十九、桌面端有了安装包：装完双击就用，卸载不丢数据（v0.9.0）

结论：以前桌面端只能 `git clone` + `npm i` + `npx electron .` 才跑得起来，等于只有开发机自己能用。
这一片把它做成两个能直接发出去的文件：**NSIS 安装包**（开始菜单、桌面快捷方式、卸载程序）和**免安装单文件**。
签名与自动更新**没有接**——这两件要你先定证书和更新源；它们缺席时用户会遇到什么，下面如实写，不粉饰。

| 之前 | 现在 |
| --- | --- |
| 只能从源码起 `npx electron .` | 双击 `VisionQA-Setup-0.9.0.exe` 装好，开始菜单与桌面都有入口 |
| 没有应用图标与版本信息 | 品牌 mark 做成 7 档 ICO（16–256）；exe 属性里 `VisionQA 0.9.0` |
| 数据目录跟着包名落在 `creator-canvas-studio` | 落在 `%APPDATA%\VisionQA Desktop`；首次启动把旧目录整个搬一次（会话、长期记忆、登录态都在） |
| 装的是哪一版，界面里看不出来 | 本地工作区状态栏右侧直接写「桌面端 0.9.0」，版本取自主进程，不是网页版号 |
| 装与卸没在真机上走过 | 走完了：安装向导三页、装好后截图、静默卸载（目录 / 注册表 / 快捷方式清干净、数据保留）、重装后 5 条会话与记忆都在 |

两个包（都放在本机 `release-desktop/`，产物不入库）：

- `VisionQA-Setup-0.9.0.exe`（103.1 MB）：NSIS 向导，默认「仅为我安装」到 `%LOCALAPPDATA%\Programs\VisionQA`，
  可改目录，建开始菜单与桌面快捷方式，带卸载程序。
- `VisionQA-Portable-0.9.0.exe`（94.9 MB）：免安装，双击自解压到临时目录运行，同样能登录、能用本地工作区。

安装包本身的三件事，先说清楚：

- **未签名**：Authenticode 状态是 `NotSigned`。从浏览器下载后首次运行，Windows 会先拦一次「Windows 已保护你的电脑」，
  要点「更多信息 → 仍要运行」。要消掉这一步只能买代码签名证书。
  （本机这份是直接构建的，没有下载标记，所以这次安装没有弹——分发给别人时会在。）
- **没有自动更新**：构建产物里有 `latest.yml` 与 blockmap，但应用里没接更新源、也没有更新提示；
  换版本靠重新下载安装包覆盖安装（数据在 `%APPDATA%\VisionQA Desktop`，覆盖安装不动它）。
- **装出来 330 MB**，主要是 Electron 运行时；卸载默认保留用户数据，重装后会话与记忆还在。

![安装向导：选定安装位置，默认只装给当前用户，不弹 UAC](docs/screenshot-desktop-setup-2026-11-12.png)

![安装完成：勾选「运行 VisionQA」直接起应用](docs/screenshot-desktop-setup-finish-2026-11-12.png)

![装好的应用：状态栏右侧「桌面端 0.9.0」，会话与长期记忆都在](docs/screenshot-desktop-installed-2026-11-12.png)

验收（本机 Windows 实装，不是模拟）：安装目录 `%LOCALAPPDATA%\Programs\VisionQA` 内 `VisionQA.exe` 的文件版本
**0.9.0**、产品名 **VisionQA**；卸载项 `VisionQA 0.9.0` 带 `/currentuser` 卸载命令；开始菜单与桌面各 1 个快捷方式；
静默卸载后安装目录、卸载项、两个快捷方式全部为 0，`%APPDATA%\VisionQA Desktop` 保留；静默重装后 5 条会话、
2 条记忆都还在，应用能正常起并加载生产站点。免安装版也真起过一次，同样加载生产站点、页面一致。
生产同时升到 **v0.9.0**：入口 `index-BvtX7MhE.js`、release `20261112-131339-0.9.0.tar.gz`、
`/api/version` 0.9.0、`/api/health` ok（templates 26）。
`npm test` **92/92**、oxlint **0 error / 8 warning**、`npm run build` 通过。

校验值与构建参数记在 `docs/desktop-installer-2026-11-12.md`（安装包不入库，重编后哈希会变，文档里写明了这一点）。

还没做：**代码签名**（要证书）与**自动更新**（要更新源）——这两件你定了之后各接一小片；
长期记忆的后台批量提炼与语义召回仍排在它们之后。

## 七十、长期记忆会自己提炼，也听得懂近义说法（v0.9.1）

结论：v0.8.0 的记忆要么等智能体主动记、要么人发「记住：…」，而且召回只认字面重合——问「上线」找不到记着「发布」的那条。
这一片补两件事：**每轮结束后台提炼最多 3 句长期约定**（不调模型、不扣积分），**召回按同义组 + 稀有词权重排序**，
一条词都不沾边的记忆不再塞进上下文。

| 之前 | 现在 |
| --- | --- |
| 只有智能体主动记 / 用户发「记住：…」 | 每轮结束后台扫最近 20 条用户消息，挑长期约定自动记；来源标「后台提炼」 |
| 记忆从哪来的分不清 | 面板每条带来源：你让记的 / 智能体记的 / 后台提炼 |
| 后台干了什么看不见 | 面板写「后台提炼：看过 N 句，记下 M 条（K 条重复）」，状态栏写「自动记下 N 条」 |
| 召回只认字面词 | 同义组（上线↔发布↔部署、打包↔构建、图标↔icon…）+ 稀有词权重（IDF） |
| 无关记忆也会被塞进提示 | 一条词都没重合就不注入；判重还会挡住「换个说法」的重复 |

提炼的边界（不夸大）：

- 只从**用户自己说的话**里挑；工具结果、系统提示、批准备注都不算。问句、「帮我改一下…」这种一次性任务不算，
  「记住：…」已经直接写盘，不重复记。
- 规则是句式 + 关键词（以后 / 下次 / 每次 / 默认 / 统一 / 口径 / 规范 / 不要 / 必须…），**不是模型总结**：
  多调一次模型就多扣一次积分，这个决定要你点头，所以现在这套不花钱。宁可少记，也不把一次性任务记成长期约定。
- 每轮最多 3 条；写入前先按「完全一样」和「短句有一大半词重合」判重；满 40 条仍按原规则淘汰最少召回的。
- 提炼失败不拖垮这一轮（catch 后只写日志）。

召回怎么算：

- 分词（英文按词、中文按二元组）→ 同义组扩展 → 用这个工作区的条目集合算 IDF（越少见的词权重越高）→
  命中词权重求和排序 → 同分看最近用过。
- 例：记着「以后发布前先跑 npm test，再用 ops/deploy.sh 部署」，问「上线前要做什么检查？」也能召回到（上线 / 发布 / 部署同组）。

实测（生产装好的 0.9.1）：

- 发一句「以后发布前先跑 npm test，再用 ops/deploy.sh 部署；成片统一按 30 秒、8 镜算。」→ 这一轮结束后面板变成 4 条，
  两条来源「后台提炼」，面板写「看过 2 句，记下 2 条」，状态栏「自动记下 2 条」。
- 新会话只问「上线前要做什么检查？」→ 状态栏「本轮用到 1 条记忆」，模型准确指出「我记忆里那条部署约定属于另一个工程工作区，
  在当前目录不适用」——召回到了，但它没有把记忆当事实硬套。
- 旧桌面端兼容：新网页的 `memory:list` 返回结构变了，渲染侧对「数组」和「{entries, stats}」两种都认，
  避免网页先发、客户端没更新时记忆面板崩掉。

![后台提炼：每轮结束后台看过 2 句、记下 2 条，来源逐条标出来](docs/screenshot-desktop-distill-2026-11-12.png)

![换一种问法也能召回：问「上线前」，记的是「发布前」，模型自己说明这条约定不属于当前工作区](docs/screenshot-desktop-recall-alias-2026-11-12.png)

验收：生产 **v0.9.1**、入口 `index-DNXxL_Ir.js`、release `20261112-132859-0.9.1.tar.gz`、`/api/health` ok（templates 26）；
安装包同步重打为 `VisionQA-Setup-0.9.1.exe`（103,057,739 B）与 `VisionQA-Portable-0.9.1.exe`（94,862,438 B），
覆盖安装后 5 条会话与旧记忆都在，卸载项显示 `VisionQA 0.9.1`。
`npm test` **97/97**（74 + 本地循环 23 条；新增语义召回、提炼规则、判重、账目 5 条）、
oxlint **0 error / 7 warning**、`npm run build` 通过。

还没做：**代码签名**与**自动更新**要你先定证书和更新源（同上节）；记忆提炼目前是本地规则，
模型驱动的归纳要额外一次补全与积分，等你点头再做。

## 七十一、作品交付稿：一条内容能拿出工作台了（v0.9.2）

结论：作品页以前只能「标记交付」，标记完手上什么也没有。这一片补上最后一公里——
**一键把这条作品压成一份 Markdown 交付稿**，脚本、分镜、评审的问题与修正建议、版本对照、
运行记录（含失败原因）全在里面，发给剪辑、贴进文档、打印都行。

| 之前 | 现在 |
| --- | --- |
| 只有「标记交付」，改的是作品状态 | 页头「导出交付稿」：点一下落盘一个 `.md` |
| 脚本与评审结论只在屏幕上可看 | 8 个章节的完整稿，含每条修正建议与每次运行的失败原因 |
| 想拿走只能开只读分享（要联网、谁都能看） | 交付稿是文件，不用给任何人开权限 |
| 时间、口径各处不一 | 按导出人时区写；脚本用作品自己的版本，版本 0 的历史记录折进 v1 |

稿子的三条边界（这一片最花时间的部分）：**不写分享 token**（它等于钥匙，而稿子会被转发）；
**只写发生过的事**（这一版没送评审就写没送，不拿上一版结论凑数）；**口径与页面同源**
（详情组装提成 `projectDetailView()`，作品页与导出读同一个函数）。

```markdown
## 评审

最新一次（v2）：需人工确认 · 2026-11-12 18:03
模型 visual-baseline（local-model:deepseek-flash） · 38 秒

> 首帧里人和毛衣都在，但标题红色文字压住折叠起点，双手张开没捏住衣角，下摆出画，折叠动作读不出来。

### 修正建议（3）

1. 把标题移出折叠区：把「毛衣折叠」从 y0.47–0.55 下移到 y0.82–0.90 的桌面空区…
```

生产实测（作品「毛衣折叠收纳法」，v2）：

- 点导出 → `GET /api/projects/prj_f38d68c6/deliverable?tz=480` **200**、`text/markdown`，落盘 **9,245 B**，
  文件名 `VisionQA-毛衣折叠收纳法-20261112.md`（中文名走 RFC 5987，老浏览器退回 ASCII 名）。
- 稿子 174 行：8 段脚本、8 个镜头、5 个问题 + 3 条修正建议、v1/v2 版本对照、6 次运行（4 次失败，原因逐条在稿里）。
- 控制台 **0 异常**，按钮没有卡在「正在整理…」。

![作品页页头：导出交付稿排在分享左边，1440 宽下一行放得下](docs/screenshot-project-export-2026-11-12.png)

![导出后：右下角如实报出文件名，文件已经落盘](docs/screenshot-project-exported-2026-11-12.png)

![780 宽：五个动作换到自己一行，标题不再被压成三行](docs/screenshot-project-export-780-2026-11-12.png)

顺手修的两个问题：**页头挤标题**（第五个按钮让 780 宽下的标题断成三行，页头改成放不下时动作整行下移，
1440 宽逐像素不变，全站页头共用）；**「按快速估」读不通**（模板详情、分享页、模板导出、交付稿四处统一成「按语速档「快」估」）。

验收：生产 **v0.9.2**、入口 `index-LpbTI6B9.js`、release `20261112-134609-20261112-214608-0.9.2.tar.gz`、
`/api/health` ok（templates 26）；`npm test` **107/107**（新增交付稿 10 条）、oxlint **0 error / 7 warning**、构建通过。
桌面端不用重装：外壳加载的就是这套网页（这一轮没有改外壳代码，安装包仍是 0.9.1）。
细节见 [作品交付稿](./docs/project-deliverable-2026-11-12.md)。

## 七十二、交付稿的打样版：一键出 A4，打印或存 PDF（v0.9.3）

结论：上一节给的是 `.md`，但编导要摊在桌上用笔改、制片要在群里发一张纸。这一片给交付稿加**第二个出口**——
作品页点「打印稿」，新标签里是一张排好版的 A4，按一下「打印 / 存为 PDF」，纸张已经写死 A4，只剩选「另存为」。

| 之前 | 现在 |
| --- | --- |
| 只有 `.md`，要纸得自己排版 | 服务端直接出 A4：抬头事实表、小节自动编号、镜头不跨页 |
| 打印前得装个 Markdown 编辑器 | 浏览器打印（Ctrl+P），不新增依赖，中文断行交给浏览器 |
| 纸上的内容和稿子可能两套口径 | 打印版由**同一份 Markdown** 渲染，两份永远同文 |

为什么从 Markdown 再渲染一次（而不是照作品详情再拼一遍版）：一份内容只有一个来源；
渲染器只认我们自己生成的七种记号，遇到不认识的行按段落输出，**宁可难看也不吞内容**；
打印走浏览器自己的 PDF 引擎，服务器不用装 Chromium。

生产实测（作品「毛衣折叠收纳法」v2）：

- 页头点「打印稿」→ **真鼠标点击**开出新标签 `/print/projects/prj_f38d68c6/deliverable?tz=480`（标签 165 → 166）。
- 页面 **19,168 B**、`text/html`、`no-store`、`noindex`；**7 个小节 / 3 张表 / 8 个镜头**；控制台 **0 异常**。
- 服务端真出一份 PDF：**5 页 / 444,140 B**，已存进仓库 [样张 PDF](./docs/sample-deliverable-2026-11-12.pdf)。
- 没登录是 `401` + 一张「登录已过期」的纸（带「去登录」）；作品被删是 `404` + 「作品不在了」——
  新标签里不吐 JSON。

![打印页：顶栏写着 A4 与「打印 / 存为 PDF」，纸上是标题、事实表与自动编号的小节](docs/screenshot-project-print-2026-11-12.png)

![把窗口收到 820 宽：纸按 210mm 展开，第一页从抬头到脚本表](docs/screenshot-project-print-a4-2026-11-12.png)

![780 宽：六个动作整行下移，标题不再被挤](docs/screenshot-project-print-780-2026-11-12.png)

这一轮最容易漏的一处是 **nginx**：生产 `location / { try_files … /index.html }` 是静态托管，
`/print/...` 不加一条反代就会返回 SPA 首页——**看着 200，打开是应用壳**，等于没上线。
已加 `location ^~ /print/`（带五个安全头，nginx 里 location 写了 add_header 就不继承 server 级的），
`nginx -t` 通过后 reload，备份在服务器 `/root/visionqa.wavisionai.cn.conf.bak-20261112-print`；
仓库 `deploy/nginx.conf` 同步补上，重装机器不会漏。

顺手修了两处：**评审元信息粘行**（纸上「18:03 模型 …」连成一句，元信息行前补「· 」）；
**抬头没有冒号**（「建立 / 导出时间」在事实表里落不到标签列，统一成「标签：值」，`最后更新` 独立一行）。

验收：生产 **v0.9.3**、入口 `index-CarVCfDG.js`、release `20261112-135857-0.9.3.tar.gz`、
`/api/health` ok（templates 26）；`npm test` **114/114**（新增打印版 7 条）、
oxlint **0 error / 7 warning**、构建通过。桌面端不用重装（外壳加载的就是这套网页，仍为 0.9.1）。
细节见 [交付稿的 A4 打印版](./docs/project-deliverable-a4-2026-11-12.md)。
