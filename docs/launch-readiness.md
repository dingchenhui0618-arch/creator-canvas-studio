# 上线差距清单（2026-11-09 实测）

> 读法：先看第一节的结论，再看第二节「哪些是真的、哪些是演示」的逐项判定，最后按第三节的顺序补。
> 所有判定都来自线上实测（`https://visionqa.wavisionai.cn`）与仓库源码，不按想象写。

## 一、结论先行

线上能用的核心链路只有两条半：**账号与会话**、**画布（含与工作台的数据打通）**、**运行记录**。
其余模块的代码是真的，但**缺凭证或缺数据**，对外表现就是演示态：

| 现在的线上状态 | 实测证据 |
| --- | --- |
| 视觉模型未配置 | `GET /api/health` → `{"redfox":false,"vision":false,"templates":0}` |
| 红狐检索未配置 | 同上 `redfox:false`；`/api/search` 永远返回 `mode:"mock"` + 示例条目 |
| 模板库为空 | `health.templates = 0`（本机 `data/templates.json` 有 4 条，服务器上一条也没有） |
| 只有一个账号 | `/api/auth/config` → `registrationEnabled:false`，库里只有 seed 的那条 |
| 画布可用 | 画布 iframe 与 `/api/bdc/canvases` 都通（Basic Auth 挡住的是外部访客，不是功能） |

**一句话**：现在是一个「能登录、能开画布、能看运行记录」的骨架，加两个「代码齐了但没有 Key」的模块（视觉评审、爆款雷达），
以及一个空模板库。离「客户能自己用起来并愿意付钱」还差：一份模型凭证、一份检索凭证、至少一次真实复刻入库、账号发放路径、备份与监控。

## 二、哪些是真的、哪些曾经是演示

### 2.1 真的（走服务端、可复查）

| 模块 | 实现 | 实测 |
| --- | --- | --- |
| 登录 / 注册 / 登出 / 记住我 | `server/auth.mjs`：SQLite + scrypt(N=16384) + 服务端会话（cookie 只放随机 token，库里存 sha256） | `scripts/test-auth.mjs` 16 项全过；未登录访问 `/api/templates` 恒 401 |
| 权限闸门 | `VQ_REQUIRE_AUTH=1` 时除 `/api/auth/*`、`/api/health`、`/api/version`、`/api/models` 外全部要求登录 | 线上 `/api/templates` → 401 |
| 画布 | 第三方 VisionQA Canvas（iframe）；工作台经服务端代理 `GET/POST /api/bdc/canvases`、`POST /api/bdc/canvases/note` 直接读写它的 JSON | 画布列表、存笔记、`revision` 冲突 409 都实测过 |
| 运行记录 | `GET /api/runs` 读 `data/runs.json`，逐节点状态/耗时/输出 | 页面与后台审计页都直读该接口 |
| 模板库 | `/api/templates` 读写 `data/templates.json` + `data/frames/` | 代码可用，线上 0 条 |
| 智能体（增删改查） | `/api/agents` 落 `data/agents.json` | 列表/新建/删除可用；**对话需要模型凭证** |
| 视觉评审（接口） | `POST /api/review` → `server/review.mjs` → 模型 | 接口在，**凭证缺失时必失败**（此前回退本地模型，现在线上两者都没有） |
| 版本与自检 | `/api/version` 读 `package.json` + 启动时间；顶栏画布状态是真实探测 | `v0.1.0` |
| 管理后台 | 模板治理、运行审计、系统状态都读真实接口 | 见 `docs/screenshot-admin*.png` |

### 2.2 这一轮已删除的演示残留

删掉的原因只有一条：**客户能点到、但背后没有真东西**。留着就是骗人。

| 删掉的 | 之前是什么 | 现在 |
| --- | --- | --- |
| 登录页「演示账号 · 填入」 | `/api/auth/config` 把 demo 邮箱和口令明文发给每个访客（等于公开后门） | 配置接口只下发 `registrationEnabled` / `minPasswordLength`；页面上不再有演示入口 |
| 「以访客身份进入」 | 纯前端会话，服务端 `VQ_REQUIRE_AUTH=1` 时所有接口 401，进去是一片空壳 | 删除；登录是唯一入口 |
| 资产库（整页） | 6 条硬编码假资产 + 顶部「24 / 18 / 75%」假统计，没有后端 | 删除页面、导航项与 `src/data/mock.ts` |
| 工作台「三件待办」 | 写死文案，meta 直接写「示例数据」「待接入」 | 换成画布 / 运行 / 模板三块真实数据 + 空状态 |
| 工作台「最近复刻」4 条 | 写死标题与「今天 11:13」，服务器上其实 0 条 | 删除；模板为空时显示空状态并给入口 |
| 工作台「待评审」3 条 | 写死评审结论 + 本地帧图，评审服务还没跑过 | 删除 |
| 设置页「运行适配器 · 演示模式」 | 卡片写着 `mode: mock · 未连接真实模型`、能力「待接入」 | 删除整张卡；设置页只留账号（真有接口的那块） |
| 设置页工作区偏好三行 | 开关只改 `useState`，刷新即失效 | 删除；不留假开关 |
| 侧栏「形态」分段控件 | 任何用户都能切到 admin / lab | 后台只从 `?edition=admin` 进，侧栏不再露出 |
| 内测测试版（整版） | 接口体检 / 样例对照 / 功能开关 / 诊断导出；里面全是「仅记录，尚未接线」的开关与示例数据对照 | 整块删除（`src/pages/lab/`、`lab.css`） |
| 顶栏搜索框（⌘K） | 输入什么都不搜，纯装饰 | 删除 |
| 顶栏通知铃铛 | 点击固定弹「没有新的评审提醒」 | 删除 |
| 智能体导航徽标 | 数字来自 `mock.ts` 的 3 条假智能体 | 删除徽标 |
| 版本弹窗「更新渠道 本地开发 · dev」 | 生产站点写自己是 dev | 改成当前域名；文案写清「重新拉取构建产物」 |
| 后台「账号与配额」页 | 一张「演示账号」表 + 禁用按钮 | 改成当前会话真实信息 + 「还缺哪三个接口」的说明 |
| 后台「危险操作」 | 三个永久禁用的占位按钮 | 删除 |
| 后台硬编码「红狐已禁用（3105）」 | 与 `health.redfox` 无关，永远显示 | 改成读 `health.redfox` 布尔值 |

同时补了两条真实能力（演示删掉后必须有路可走）：

- `npm run adduser -- --email x@y.com --password '...'`：注册关闭的部署里唯一能加账号的方式（`scripts/adduser.mjs`）。
- `node scripts/migrate-account.mjs`：把早期 seed 的 `kind='demo'` 账号改成普通账号，界面上不再出现「演示账号」。

### 2.3 还是演示的（代码在、数据假 / 缺凭证）

| 项 | 现在的表现 | 触发条件 |
| --- | --- | --- |
| 爆款雷达结果 | 12 条 fixtures 标题与互动数，横幅写「示例数据模式」，卡片上的「一键复刻」已禁用 | 未配置 `REDFOX_API_KEY` |
| 视觉评审结论 | 点「运行评审」直接报错 | 未配置 `VISION_API_KEY`（`/api/health` → `vision:false`） |
| 智能体对话 | 发送后报错 | 同上 |
| 模板库内容 | 空列表 | 一次真实复刻都没入库 |
| 登录页品牌区「VQ-0042 · 待确认」 | 营销用的静态样例，标了「评审记录示例」 | 不接任何数据，属于宣传物料，不是功能 |
| 后台「用户数」 | 显示 —，并写明没有用户列表接口 | 缺 `GET /api/admin/users` |

## 三、离正式上线还差什么（按先后）

### P0 —— 不补就是空壳

1. ~~**视觉模型凭证**（`VISION_API_KEY` / `VISION_BASE_URL` / `VISION_MODEL`）~~ —— **2026-11-09 17:20 已接上官方 DeepSeek**（`deepseek-flash` 自带图片输入），评审与智能体对话同时在真实数据上跑通，见三点六。
2. **检索凭证**（`REDFOX_API_KEY`）：雷达从「示例数据」变成真实检索。
3. **至少一次真实复刻入库**：模板库非空，工作台才有内容可看；现在 0 条。
4. **账号发放路径**：`npm run adduser` 已补，但还得定「谁能拿到账号、口令怎么给」。注册是关的。

### P1 —— 客户会立刻问

5. ~~**找回密码**~~：2026-11-10 第六批已补「本人修改口令」与「管理员重置口令」（一次性临时口令、旧会话注销）；邮件自助找回仍未做（当前没有邮件通道），登录页如实引导联系管理员。
6. **配额与计费**：没有按账号计量。真要对外收费，先定「按次还是按席位」，再加计数与闸门。
7. **备份**：`DATA_DIR`（`auth.db` + `templates.json` + `frames/`）没有定时备份，也没演练过恢复。
8. **监控**：只有 `/api/health`，没有外部拨测与告警；进程挂了没人知道（系统提示的「卡住」只能靠人发现）。
9. **画布的许可证边界**：VisionQA Canvas 是 Source-Available 第三方，只以 iframe 反代对外、源码不入公开仓库；对外销售前需要确认这条边界在合同里说得清。

### P2 —— 体验与工程

10. 智能体「数量」固定 1；三个只读工具（读模板库 / 读画布流程 / 导出 JSON）已真执行，图片生成与网页读取仍待接入。
11. 单机复刻无队列，4C8G 建议同时 ≤2。
12. 前端单包 594 KB（gzip 181 KB），可按页面拆包。
13. 管理后台已有真实用户列表、停用/角色调整与重置口令；审计日志仍只写进程日志，没有落库检索。

## 三点五、这一轮的发布结果（2026-11-09 16:49 已上线）

**线上已经换成本轮的构建，演示口令的泄露口子关掉了。**

| 项目 | 结果 |
| --- | --- |
| 线上 bundle | `index-DnLlNR--.js`（此前是 `index-B2pvXvsh.js`） |
| `GET /api/auth/config` | `{"registrationEnabled":false,"minPasswordLength":8}` —— 不再下发 `demoAccount` |
| `GET /api/health` | `redfox:true vision:true llm:true visionModel:deepseek-v4-flash-vision-exp llmModel:deepseek-flash` |
| 账号 | 已跑 `npm run migrate-account`，库里只剩 1 个 `kind='account'` 的账号（原来的 `kind='demo'` 已改） |
| 服务 | `visionqa` active，重启后 `/api/health` 与首页都 200 |

**发布方式变了**：这台服务器其实开着 22 端口，用 `~/.ssh/taskwatch_relay_ed25519` 能直接
`ssh root@139.196.123.28`（免密）。本轮就是 `scp` 打好的 `vq-deploy.tgz` +
`bash /tmp/vq-deploy2.sh`（备份 dist → 解包 → 重启 → 验 health）。以后不要再跟控制台的
「命令助手 / 画布转存」较劲：那两条路一条区域配额满、一条要手点 UI。

~~上一轮给的模型地址解析到内网 10.0.51.120，链路不通~~ —— 这条已在三点六解决。

## 三点六、模型接入换成官方 DeepSeek（2026-11-09 17:20 已上线）

**结论：模型这条链路通了，智能体对话与视觉评审都能在真实数据上跑出结果。**

| 项目 | 结果 |
| --- | --- |
| 接口 | `VISION_BASE_URL=https://api.deepseek.com/v1`（文本与视觉共用） |
| 模型 | `deepseek-flash` 同时承担对话与抽帧；自报 `input_modalities=["text","image"]`、`context_window 1048576` |
| 文本降级 | `LLM_FALLBACKS=deepseek-v4-pro`（该模型只吃文本，只能当文本兜底） |
| 线上 bundle | `index-sR4ooPeo.js` |
| `/api/config` | `baseUrl=https://api.deepseek.com/v1` · `apiKeyMasked=****9709 · 35 位` · `vision.models=["deepseek-flash"]` |
| 连通性自检（`POST /api/config/probe`） | `{"ok":true,"status":200,"count":2,"models":["deepseek-flash","deepseek-v4-pro"]}` |
| 智能体对话 | `POST /api/agents/agt_ads01/chat` → 200 · 6.0 秒 · 真实文案（模型写 `deepseek-flash`） |
| 视觉评审 | `POST /api/review` → 200 · 16.6 秒 · verdict + 带像素锚点的 observations（provider `local-model:deepseek-flash`） |
| 抽帧分析 | 生产函数 `analyzeFrames()` 在服务器上跑 3 帧 → 合法分镜 JSON（15 秒） |

**顺手修掉的四个真实问题**（都是「换个模型才暴露」的）：

1. **`max_tokens` 被推理 token 吃满**：`deepseek-flash` 先产 `reasoning_content`，
   18 帧的逐帧 JSON 实测 4800 token 上下，原来给 4000 会被截断成半截 JSON，
   每次复刻都白白多跑一次「修复指令」重试。现在 8000，并按 `finish_reason=length` 判可重试。
2. **正文被 markdown 代码块包裹**：改走 `response_format={"type":"json_object"}` 直接拿纯 JSON；
   网关不认这个字段时（400）自动退回不带它的请求，不让整条链路判死。
3. **前端还写着 4 个不存在的模型名**（`gpt-6.1-sol` 之类）：检查器的模型候选与 llm 节点默认值
   都改成读 `/api/models`，前端不再硬编码任何模型名；库里旧智能体存的假模型名在读取时折成当前模型，
   否则每次对话都要先打一次不存在的模型再降级。
4. **两个调用点各写一份 fetch**：抽成 `server/chatcall.mjs`，文本与多模态共用同一套
   「json 模式 / 截断判定 / 400 兼容回退」。

**这一轮之后仍然挡在上线前面的**：模板库 0 条（「一键复刻」还没跑过一条真实视频，
跑通它才算整条链路闭环）、没有队列与配额、没有找回密码与用户列表接口。

红狐这条是真的通了：`/api/search` 返回 `mode:"live"`，封面经 `/api/cover` 代理加载（小红书封面
是 http 且只认 https + 站点 Referer，代理里已做协议升级与重试）。

## 三点七、2026-11-10：雷达计费、模板库契约、会话记忆、字体与充值占位（已上线）

这一轮按用户提的五条改，逐条给实测结论：

| 需求 | 做法 | 实测（线上） |
| --- | --- | --- |
| 不要在切到爆款雷达时自动检索 | 去掉挂载时的 `runSearch()`，改为 `searched` 状态 + 空状态引导；平台/时间/排序变更也不再触发请求 | 进页面 `performance` 里 `/api/search` 请求数 0；点「检索」后返回 74 条真实小红书数据 |
| 补点赞 / 收藏 / 转发等重要信息 | `normalizeDouyin/Xhs` 加 `plays`；卡片展示 播放 / 赞 / 藏 / 评 / 转 + 互动率，排序加「按播放 / 按转发」 | 小红书没有播放量 → 该项直接不渲染（不留 0）；抖音有 `playCount` 才显示 |
| 雷达可加入模板库，模板库不存原视频 | 新增 `POST /api/templates/from-radar`：只落 url、作者、互动数据；`kind:'saved'` 与 `kind:'replica'` 两态；复刻同一条时按 sourceId 升级，不重复占格 | 线上点「加入模板库」→ `/api/templates` 返回 `saved:1`；详情显示「待解析 / 去解析这条」；测试条目已删除，现回到 0 条 |
| 智能体输入框与发送按钮布局 | 合成一张卡片：textarea 在上，参数胶囊 + 「Ctrl + Enter」+ 发送键收进底部同一行；删掉「数量 1」与「真实调用本地模型」等内部文案 | 卡片高度 209 → 156px，发送键 36×36 与胶囊同排；无 `agx-capsule--static` |
| 会话记忆 | 前端把最近 8 条对话随请求发出；服务端 `normalizeMemory` 按 8 条 / 6000 字截断后插入 system 之后 | `POST /api/agents/:id/chat` 带 history 实测 1.4s 返回，响应 `memory:{turns:1,messages:2}`，模型能接住上文 |
| 字体模糊 | 去掉两处 `fonts.googleapis.com` @import；Geist / Geist Mono 拉丁子集自托管（52KB，`font/woff2`）；中文改用系统黑体；10px 微标签统一 11px；删掉 App.css 里那套会覆盖 tokens 的旧 `:root`（`--ink-faint:#9d978b` 只有 2.9:1） | `document.fonts` 只剩 Geist / Geist Mono 两套；首屏不再有外部字体请求 |
| 充值接口与按钮 | `GET /api/billing/overview`（enabled:false）、`GET /api/billing/orders`（空列表）、`POST /api/billing/orders`（501 BILLING_NOT_CONFIGURED）；设置页新增「充值」卡片与按钮 | overview 200 / 下单 501；按钮 disabled + 文案「充值通道未开通，按钮暂不可用」；**没有任何价格、余额、订单是编的** |

**顺手修掉的线上漏洞**：登录门（`needsLogin`）原来排在功能路由之后，`VQ_REQUIRE_AUTH=1` 时
`/api/agents`、`/api/flows` 匿名就能 200（智能体系统提示词、画布流程全暴露）。现在门前置，
匿名一律 401，`/api/auth/*`、`/api/health`、`/api/models` 仍公开。已实测四个端点。

**这一轮之后仍然挡在上线前面的**：模板库 0 条（「一键复刻」仍未跑过一条真实视频，跑通才算闭环）、
没有队列与配额、没有找回密码与用户列表接口、充值只有空壳接口。

## 三点八、2026-11-10 追加：页头/运行记录溢出/入口缓存，以及上线前审计与六处加固（已上线）

### 界面三处

| 反馈 | 原因 | 改法 |
| --- | --- | --- |
| 智能体页顶部红圈 | 顶栏已有「个人工作区 › 智能体」，页内又写了一遍虚构层级「创作能力 / 智能体」；「自建库 · N 次运行」和「已自建智能体」说的是同一件事；右上角还有第二个「新建」 | 删页内眉标（编辑页同改）；列表头收成「已自建智能体 + N 个 · 累计 M 次运行」；新建只留页头一个 |
| 参数胶囊下拉 | 原生 `<select>` 弹出层盖住输入框底部，样式与发丝线不搭 | 自绘下拉：点外部 / Esc 关闭，选中项加粗，展开时箭头翻转 |
| 运行记录明显溢出 | `.runs-page` 漏写页面内边距，内容贴到侧栏与窗口边缘 | 与工作台统一 32px 内边距 + 1280 居中 |
| 工作台页头字体 | 整行等宽 + 中文混排，被 0.04em 字距拉散；「2026 年 11 月 10 日」又多占了 8 个字 | 「工作台 · 用户 · 2026-11-10 周二」，只有日期用等宽等宽数字；标题数字 tabular-nums、分隔点降为 1px 灰 |

截图见 README「2026-11-10 追加」小节那四张。

### 发版后仍看到旧界面（真事故）

nginx 直接托管 `/opt/visionqa/dist`，`index.html` 没有 `Cache-Control`，浏览器按 ETag 启发式缓存，
发版后继续用旧 HTML 里的旧 bundle——用户看到的就是上一版界面。nginx 里补：

```nginx
location = /index.html { add_header Cache-Control "no-store, no-cache, must-revalidate" always; expires off; }
location /assets/      { add_header Cache-Control "public, max-age=31536000, immutable" always; }
```

实测：`curl -I /` 现在带 `no-store`，`/assets/index-*.css` 带 `immutable`。
另外发版后 `dist/assets` 会堆 6 个历史 bundle（已清理到只剩当前两个），下次发版顺手 prune。

### 审计后当场修掉的六处

| 问题 | 证据 | 改法 | 实测 |
| --- | --- | --- | --- |
| 登录暴破限流可绕（P0） | nginx `X-Forwarded-For $proxy_add_x_forwarded_for` + `auth.mjs:204` 取第一段 → 客户端自带 XFF 排最前 | nginx 改 `$remote_addr`；`clientIp` 优先 X-Real-IP、XFF 取最后一段 | 轮换 XFF 连打 12 次：改前 12×401 永不 429；改后 8×401 → 4×429 |
| 模板库并发写丢条目（P1） | `templates.mjs` 整文件读改写、共用 `.tmp`、无写队列 | 抽出 `enqueueWrite` 串行化（对齐 flows.mjs），tmp 文件名带 pid + 随机串 | 30 并发「加入模板库」：改后 30/30 成功（201），条目数 1 → 31 |
| 失败任务临时目录永久残留（P1） | `jobs.mjs` 只在成功分支 `rm jobDir` | 改 `.finally()`，成功失败都清 | 代码路径统一，失败不再留 ≤160MB 源视频 |
| 模板帧图送评审必失败（P1） | `routes/review.mjs` 写死 `process.cwd()/data`，生产 `DATA_DIR=/var/lib/visionqa` | 改用 `config.dataDir`（同 flows.mjs） | 生产数据目录与代码路径一致 |
| 安全响应头缺失（P2） | 线上只有 `Server: nginx/1.30.2` | 补 HSTS / nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy，`server_tokens off` | `curl -I` 六项头齐全，`Server: nginx` |
| 数据零备份（P1） | 全仓无备份脚本，`/var/lib/visionqa` 只有在线文件 | 新增 `deploy/production/backup.sh` + `visionqa-backup.timer`（每天 04:10，留 7 份，整目录打包含 WAL） | 已装并跑过：`/var/backups/visionqa/data-20261110-114423.tar.gz`，`tar -tzf` 列出 5 个数据文件；timer `enabled/active` |

### 审计里**没有**动、但上线前必须做的（按优先级）

1. **P0 配额与并发闸门**：`/api/search` 按次计费、`/api/replicate` 每次 = 付费解析 + ffmpeg + 18 帧视觉模型、
   `/api/agents/:id/chat` 无限刷 token，三者现在都没有按用户配额/并发上限；`billing.mjs` 的 PLANS 还是空数组。
2. **P0 多用户归属**：templates / agents / flows / runs 全是全局数据，改删无 ownerId 校验。
   现在只有一个管理员账号，还不流血；**发第二个账号之前必须先并 ownerId 补丁**。
3. **P1 SSRF 与无超时下载**：`media.mjs` 的直链下载没有私网/回环校验、没有 `AbortSignal` 超时、整段读进内存。
4. **P1 全局异常兜底与访问日志**：没有 `unhandledRejection` / `uncaughtException`，也没有每请求一行日志。
5. **P1 健康检查只报「配了没配」**：key 过期、余额为 0、上游 DNS 挂了，`/api/health` 仍是 `ok:true`。
6. **P1 前端无 ErrorBoundary、无路由**：任一页渲染抛错整树白屏；在模板库按 F5 会回工作台。
7. **P2 注册开关默认 fail-open**：`VQ_REGISTRATION !== '0'` 才是关，换机重装漏一行就静默开放注册。
8. **P2 密码策略 / 找回 / 备案与协议**：8 位即可、无找回接口、页脚无备案号与隐私政策。
9. **P2 首屏 604KB 单 chunk、移动端表格宽度 720–880px 不可用**。

## 四、怎么复验

```bash
# 1. 依赖是否配置（两个布尔必须都是 true 才算功能可用）
curl -s https://visionqa.wavisionai.cn/api/health

# 2. 未登录必须被挡住
curl -s -o /dev/null -w '%{http_code}\n' https://visionqa.wavisionai.cn/api/templates   # 401

# 3. 版本与启动时间
curl -s https://visionqa.wavisionai.cn/api/version

# 4. 配置接口不再下发任何口令
curl -s https://visionqa.wavisionai.cn/api/auth/config   # 只有 registrationEnabled / minPasswordLength
```

## 三点九、2026-11-10 晚间：上表 1–9 条落地情况

用户按上一节的优先级清单逐条点名，本轮按「积分制 + 归属隔离」为主线一起做完了。
结论：**上面第 1–9 条全部关闭**，只剩「充值定价」与「模板库第一条真实闭环」两件要用户拍板。

| 上一节条目 | 状态 | 落地方式与证据 |
| --- | --- | --- |
| 1 P0 配额与并发闸门 | 关闭 | 积分账本（users.credits + credit_ledger，同事务、先扣后退）；单账号并发闸门（检索 1 / 复刻 2 / 评审 1 / 对话 2）。实测 3 并发检索 200/429/429；余额 1 分时检索 402 且不扣费。billing 仍是占位（按用户要求不动） |
| 2 P0 多用户归属 | 关闭 | templates / agents / flows / runs / jobs 全部带 ownerId；列表过滤、读改删校验；跨账号 404，管理员可见全部；启动时把历史数据认领给管理员（线上 agents:4 flows:4）。实测 A 存 1 条 B 看 0 条、B 读 A 的 404、B 调管理接口 403 |
| 3 P1 SSRF 与无超时下载 | 关闭 | media.mjs 新增 assertPublicHttpUrl（协议白名单、禁带凭据、DNS 解析后拒私网/保留段）、fetchPublic（最多 3 跳逐跳校验 + AbortSignal 超时）、下载改流式写盘；/api/cover 与 review 的图片地址同样过校验。实测封面代理内网 404、评审内网图片 500 并退款 |
| 4 P1 全局兜底与访问日志 | 关闭 | server/log.mjs：每请求一行 JSON（含 X-Request-Id 响应头），5xx 附堆栈并把 traceId 返回；unhandledRejection 记录，uncaughtException 记完 exit(1) 交给 systemd |
| 5 P1 健康检查 | 关闭 | 新增 GET /api/system/health（登录可见，缓存 10 秒）：真连数据库、数据目录（写入探测 + 剩余空间）、模板库、模型接口 /models、红狐接口；设置页底部「系统状态」逐条展示。生产实测 6 项全 ok |
| 6 P1 ErrorBoundary / 路由 | 关闭 | hash 路由（含 #/agents/<id>、#/admin/<section>）+ ErrorBoundary（切页复位）+ 5 个页面懒加载；主包 604.09 → 315.54 kB（gz 183.91 → 97.28），画布 222 kB 独立 chunk |
| 7 P2 注册开关 | 关闭 | VQ_REGISTRATION 改为「只有等于 1 才开」，默认关闭；前端首屏也默认不显示注册入口 |
| 8 P2 密码策略 | 部分关闭 | 口令要求 8 位且同时含字母与数字（服务端校验 + /api/auth/config 下发 policy，注册页提示）。找回密码、邮箱验证、备案号与隐私政策仍未做：备案号按用户要求不设置 |
| 9 P2 分包与移动端表格 | 关闭 | 分包见第 6 条；nav.css 在 ≤720px 让运行记录/智能体/模板库的表格在容器内横滚并隐藏低优先级列，实测 390×844 无横向溢出 |

### 页头排版（用户第 9 条）

爆款雷达标题原来是旧 App.css 的 clamp(26px,3vw,38px) / 800 / -0.045em，1440 宽下约 33px、明显过重。现在收敛成一套 token（tokens.css）与一个组件（components/PageHead.tsx）：

| 元素 | 规格 |
| --- | --- |
| 页标题 | 26px / 500 / -0.01em / line-height 1.25 / tabular-nums |
| 眉标 kicker | 11.5px / 500 / 0.06em / --faint |
| 描述 | 12.5px / 1.7 / --muted，最宽 64ch |
| 页头区 | 下边线 1px --line，与内容间距 24px，760px 转纵向 |

已同步的页面：工作台、爆款雷达、模板库、智能体列表、智能体编辑、画布、视觉评审、运行记录、设置、后台管理版。计算样式实测 26px / 500 / -0.26px / 32.5px。

### 本轮之后仍然存在的差距

1. **充值定价（等用户）**：金额、档位、支付方式未定；/api/billing/* 保持未开通占位，积分只能由管理员发放。
2. **模板库第一条真实闭环（等用户点头）**：/api/replicate 会真实消耗红狐额度与 10 积分，本轮没有对真实视频跑过；模板库线上仍是 0 条。
3. **账号补课**：邮件自助找回与邮箱验证还没有（无邮件通道）；停用/启用、改角色、重置口令、删除账号已完成；多工作区仍未做。
4. **画布流程计费**：已接积分（第二批），每次运行扣 2 积分、节点失败整单退回。
5. **备案与协议**：备案号按用户要求不设置；隐私政策/用户协议仍未起草。

### 三点十、待接 API 清单（2026-11-10 全站代码扫描）

口径：只统计界面上已经出现、背后没有真接口或只走占位/本地状态的地方；充值卡按用户要求单列且不改。

| 页面 | 现在点下去会怎样 | 需要接什么 | 类别 |
| --- | --- | --- | --- |
| 工作台总览 | ✅ 已补（2026-11-10 第七批）：点画布卡片按 id 打开那一块，地址可刷新/复制；连不上画布服务时说明并给返回入口 | `#/canvas/project/<canvasId>` + GET /api/bdc/canvases | 已完成 |
| 工作台总览 | ✅ 已补（2026-11-10 第七批）：「新建 → 资产画布」真调画布服务建一块并直接打开，失败如实提示并退回画布页 | POST /api/bdc/canvases | 已完成 |
| 爆款雷达 | ✅ 已补（2026-11-10 第八批）：服务端按 sort 白名单排序并回传 hasMore，底部「加载更多」按页追加与去重，页脚写清已加载/总数与每次单价；缺播放量时明说顺序不会变 | GET /api/search?...&page=&sort= | 已完成 |
| 一键复刻 | ✅ 已补（2026-11-10）：弹窗显示单价/余额，余额不足禁用开始，402 给出「找管理员发放」 | GET /api/credits | 已完成 |
| 模板库 | ✅ 已补（2026-11-10）：「套用到画布」生成带输入/复刻节点的流程并跳转画布 | POST /api/templates/:id/apply | 已完成 |
| 模板库 | ✅ 已补（2026-11-10 第八批）：按钮改为「去评审」，悬停说明打开评审页并预填，点「开始评审」才扣积分 | 文案口径 | 已完成 |
| 智能体列表 | ✅ 已补（2026-11-10 第三批）：历史弹层分「本机对话 / 运行记录」，运行记录读服务端并按账号隔离，成功与失败都留档、可清空 | GET /api/agents/:id/history、DELETE 同路径 | 已完成 |
| 智能体编辑 | ✅ 已补（2026-11-10 第三批）：最近运行 / 使用次数 / 最近模型读真实数据 | GET /api/agents 的 runCount/lastRunAt/lastModel | 已完成 |
| 智能体编辑 | ✅ 已补（2026-11-10 第三批）：读取模板库、读取画布流程在对话前真实执行，导出 JSON 产出可下载文件；图片生成 / 网页读取仍标待接入 | POST /api/agents/:id/chat 内调度只读工具 | 已完成（余两个待通道工具） |
| 智能体对话 | ✅ 已补（2026-11-10）：输入框上方常驻余额/单价，402 显示差额并提示管理员发放 | GET /api/credits | 已完成 |
| 画布 | ✅ 已补（2026-11-10 第二批）：「另存为模板」写进模板库的「工作流」条目，可筛可套用回画布 | POST /api/templates {from: flow, flowId} | 已完成 |
| 画布 | ✅ 已补（2026-11-10 第二批）：「运行流程」按次扣 2 积分，余额不足 402 拦截，节点失败整单退回 | POST /api/flows/:id/run 内接 charge/refund | 已完成 |
| 画布 | ✅ 已补（2026-11-10 第二批）：地址带 flowId，刷新/复制链接/从运行记录跳转都能打开同一张画布 | `#/canvas/<flowId>` + GET /api/flows/:id | 已完成 |
| 画布 | 默认视图是 VisionQA Canvas 的 iframe，本机地址只能给提示卡 | 独立子域 + BDC_WEB_URL（外部部署） | 外部依赖 |
| 视觉评审 | ✅ 已补（2026-11-10）：评审落库到 data/reviews.json，页面「最近评审」可回看详情 | GET /api/reviews、GET /api/reviews/:id | 已完成 |
| 视觉评审 | ✅ 已补（2026-11-10）：页头显示每次积分与余额，402 走统一错误提示 | GET /api/credits | 已完成 |
| 视觉评审 | 「插件服务」状态取自本机 127.0.0.1:6300 | 外部插件服务，前端解决不了 | 外部依赖 |
| 运行记录 | ✅ 已补（2026-11-10 第二批）：服务端分页 + 按流程/状态/关键词筛选，详情可跳回画布 | GET /api/runs?flowId=&status=&q=&limit=&offset= | 已完成 |
| 设置 | ✅ 已补（2026-11-10 第四批）：流水按 12 条分页，显示总数并「加载更多」；新账号初始额度也记一条 welcome 流水 | GET /api/credits?limit=&offset= | 已完成 |
| 设置 | ✅ 已补（2026-11-10 第六批）：本人可用「当前口令 + 新口令」修改，成功后其它设备会话注销、当前会话保留 | POST /api/auth/password | 已完成 |
| 设置 | 「工作区」单值展示，多工作区切换没有后端 | GET/POST /api/workspaces | 占位 |
| 后台总览 | ✅ 已补（2026-11-10）：用户数取 GET /api/admin/users 的 total | GET /api/admin/users | 已完成 |
| 后台账号 | ✅ 已补（2026-11-10，第六批加重置口令、第七批加删除账号）：可停用/启用、设/撤管理员、重置口令（一次性临时口令，旧会话全部注销）、删除账号（输入邮箱确认；删登录/会话/积分流水/模型偏好，保留其创建的内容）；不允许把自己降级、停用或删除 | PATCH /api/admin/users/:id、POST /api/admin/users/:id/password、DELETE /api/admin/users/:id | 已完成 |
| 后台模型 Key | 只能看末四位，改要登服务器改 .env | PUT /api/admin/config（密钥托管有风险，不建议） | 半成品 |
| 后台模板治理 | ✅ 已补（2026-11-10 第三批）：就地编辑标题 / 类型 / 标签 / 原链接，成功后重拉列表 | PATCH /api/templates/:id | 已完成 |
| 后台运行审计 | ✅ 已补（2026-11-10 第四批）：账号 / 流程 / 状态三个筛选、账号列、CSV 带账号；可单独筛「未归属」历史运行 | GET /api/runs?ownerId=&flowId=&status= | 已完成 |
| 后台系统 | ✅ 已补（2026-11-10 第五批）：`GET /api/admin/storage` 真实统计文件数 / 占用 / 磁盘余量与逐条目明细 | GET /api/admin/storage | 已完成 |
| 全局 | ✅ 已补（2026-11-10 第六批）：顶栏选择保存到服务端并按账号生效；智能体对话与画布 llm 节点在未单独指定模型时使用它，换浏览器仍是同一选择 | GET/PUT /api/preferences | 已完成 |
| 全局 | 「在线更新」只比对版本号，没有下载/应用 | GET /api/update/check + POST /api/update/apply | 半成品 |
| 登录页 | ✅ 已补（2026-11-10 第六批）：不再提示「访客身份」，明确引导联系管理员重置；自助邮件找回仍需邮件通道，未做 | 管理员重置 + POST /api/auth/password | 已完成（无邮件通道） |
| 充值 | 未开通占位（按你的要求不动） | 等金额/档位/支付方式 | 冻结 |

静态统计（2026-11-10 第八批补齐后）：已完成 25 条、余半成品 2 条（后台模型 Key、在线更新下载/应用）、占位 1 条、外部依赖 2 条、冻结 1 条。

第一批已落地（提交见 README 十七）：复刻/评审/对话三处积分可见与 402 提示、模板套用到画布、评审历史落库与回看、后台用户数、账号停用与角色调整、模板 PATCH 接口。

第二批已落地（提交见 README 十八）：运行记录分页/筛选、画布按 flowId 打开、画布「另存为模板」落模板库、流程执行计积分与失败退款、后台运行审计状态筛选与 CSV 导出、用户可见报错统一为产品语言（不再透出模型名与上游余额报文）。

第三批已落地（提交见 README 十九）：智能体运行历史落库（成功/失败都留档，含扣退积分与工具证据）、编辑页真实运行统计、三个只读工具真执行与 JSON 导出、后台模板就地编辑、智能体编辑页生产/内部两种文案口径。

第四批已落地（提交见 README 二十）：登录/工作台/设置/画布/运行抽屉/检查器/复刻弹窗/顶栏与更新弹窗的生产文案收敛（技术细节只留在内部环境）、积分流水服务端分页与「加载更多」、新账号初始额度补 welcome 流水、后台运行审计按账号/流程/状态筛选与账号列。

第五批已落地（提交见 README 二十一）：后台「真实接口」标记与接口路径只在内部环境显示、后台各页生产文案收敛、模型 Key 凭证只写「已配置」、数据占用接口与系统页真实占用 / 磁盘余量。

第六批已落地（提交见 README 二十二）：全局模型偏好改为服务端按账号保存并真正接入智能体对话与画布 llm 节点、设置页本人修改口令、后台管理员重置口令（一次性临时口令 + 旧会话注销）、登录页忘记密码文案与自助找回边界。

第七批已落地（提交见 README 二十三）：后台删除账号（输入邮箱确认、会话/流水/偏好一并清理、自我保护）、工作台画布卡片按画布项目 id 打开（`#/canvas/project/<id>`）、「新建 → 资产画布」真实创建并打开。

第八批已落地（提交见 README 二十四）：爆款雷达服务端排序参数与页码、加载更多按页追加去重、页脚写清已加载/总数与每次单价、缺排序字段数据时明说顺序不变；模板库「送去评审」改为「去评审」并说明在评审页才扣积分。

**当前阻塞（非代码）**：上游模型账号返回 `Insufficient Balance`（deepseek-flash 文本对话与视觉评审都会 402），智能体与评审在补余额前不可用；检索服务仍正常。

