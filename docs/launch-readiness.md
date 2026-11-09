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

5. **找回密码**：登录页「忘记密码？」现在只提示「联系管理员」。至少要有管理员重置口令的命令。
6. **配额与计费**：没有按账号计量。真要对外收费，先定「按次还是按席位」，再加计数与闸门。
7. **备份**：`DATA_DIR`（`auth.db` + `templates.json` + `frames/`）没有定时备份，也没演练过恢复。
8. **监控**：只有 `/api/health`，没有外部拨测与告警；进程挂了没人知道（系统提示的「卡住」只能靠人发现）。
9. **画布的许可证边界**：VisionQA Canvas 是 Source-Available 第三方，只以 iframe 反代对外、源码不入公开仓库；对外销售前需要确认这条边界在合同里说得清。

### P2 —— 体验与工程

10. 智能体「数量」固定 1；工具只声明不执行。
11. 单机复刻无队列，4C8G 建议同时 ≤2。
12. 前端单包 594 KB（gzip 181 KB），可按页面拆包。
13. 管理后台缺用户列表 / 重置口令 / 审计日志落库。

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
