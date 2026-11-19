# Key 与联网搜索收到一处，搜索跟对话共用一把 Key（r258 / v0.9.241）

日期：2026-11-19。用户这一轮的原话是「联网搜索和 deepseek 官网的 key 共用，这里的相关都共用……key 和联网搜索相关的配置统一收在一处，别各写各的」。

## 一、之前是两处

| 要改的东西 | 以前在哪 | 问题 |
| --- | --- | --- |
| 模型 Key（增删改、能力声明、优先级） | 后台「模型 Key」页 | 与「模型与上游」并列，Key 与模型目录各在一页 |
| 统一路由、上游价格、上游余额 | 后台「模型与上游」页 | 与 Key 池分家，换 Key 要去另一页 |
| 联网搜索（服务商 + 单独一把搜索 Key） | 后台「系统」页最下面 | 与模型 Key 完全无关的一页；还要再买一把博查 / Tavily 的 Key |

于是「联网搜索」在生产上一直是**未接通**：`/var/lib/visionqa/search.json` 不存在，快捷创作里那个开关是灰的。这不是没做，是配置放在了没人会去找的地方、而且还要第二把 Key。

## 二、DeepSeek 把搜索开放成接口了（2026-11-13）

DeepSeek 随「全家桶应用 API」一起开放了两个接口，**用同一把 API Key、同一份余额**：

| 接口 | 地址 | 返回 |
| --- | --- | --- |
| 网页搜索 | `POST https://api.deepseek.com/v1/tools/search` | `results[]`：`title` / `url` / `snippet` / `summary` / `site_name` / `date` / `rerank_score` / `authority` |
| 网页抓取 | `POST https://api.deepseek.com/v1/tools/fetch` | `{ title, content(Markdown) }` |

（另有对话里的服务端工具 `deepseek_web_search` / `deepseek_read_url`，那是给 Chatbot 用的；r246 已经证明「上游不认这个工具就整条 400」，所以这次走**独立的搜索接口**，不碰对话请求。）

我们用的是搜索接口：结构化结果直接回来，来源卡片照旧，前 3 条正文仍走我们自己的 `link-read`（内网地址照样挡住）。

## 三、这一轮做了什么

### 1. 服务端：新增 `deepseek` 搜索通道，Key 从平台对话那把现取

- `server/web-search.mjs` 增加 `PLATFORM_PROVIDER = 'deepseek'`，默认通道；
- `platformSearchConfig()` 按「离对话最近」的顺序取 Key：Key 池里 `provider=deepseek` 的启用 Key → 地址落在 `api.deepseek.com` 的启用 Key → 环境变量那份对话凭证（且地址确实是 DeepSeek 官方）；
- `search.json` 里**不再存 Key**（`key: ''`），只有「用哪条通道 + 开没开」；
- 请求体 `{ query, count, need_content: false }`——正文我们自己读，不重复买一次；
- 结果归一：`summary`（600～800 字，给模型读）优先，界面只列标题 / 站点 / 地址；
- 错误说人话：401「这把 Key 不能用于搜索，去 Key 池核对」、402「DeepSeek 余额不足，搜索与对话共用同一份」、400「搜索请求被拒：<上游原话>」；
- 没有平台 Key 时**不许保存**，直接说「先在 Key 池加一把 DeepSeek Key」。

### 2. 后台：三页并成一页

`模型与上游` 现在从上到下是：平台卡 → **联网搜索** → 统一路由 → 模型目录 → **Key 池** → 路由决策 → 出图 / 出视频通道 → **当前生效的接入** → 上游余额 → 计价口径。

- 导航里删掉「模型 Key」；旧收藏的 `#/admin/keys` 由路由映射到 `models`（`parseAdminSection`），不落到总览、也不 404；
- 联网搜索卡片从「系统」页整块搬过来，系统页不再出现 `/api/admin/search`；
- 共用通道时卡片上**没有第二个 Key 输入框**，只有一行「用「Key 池」里那把 平台对话：sk-••••58（Key 池，https://api.deepseek.com/v1）」；换成博查 / Tavily / 自建接口时才出现地址与 Key 两栏——仍在**同一张卡**里。

### 3. 生产上的状态

部署后生产 Key 池里那把 `deepseek`（`https://api.deepseek.com/v1`，文本 / 视觉 / 判断，启用）就是搜索要用的那把。开通只写一条 `search.json`（`provider=deepseek`），**不产生任何上游调用**；第一次「试搜一次」由用户在用户端点，会真发一次搜索（DeepSeek 按次计费，同一份余额）。

## 四、验收

| 项 | 结果 |
| --- | --- |
| `test/web-search.test.mjs` | 12/12：新增「没平台 Key 不许开通 / 开了也不另存一份」「请求打到 `/v1/tools/search`、Bearer 用平台那把、结构化结果归一」「401/402/400 说人话」 |
| `test/admin-one-place.test.mjs` | 4/4：模型与上游装下 Key 池 / 搜索 / 路由 / 通道；导航没有第二个 Key 入口；`#/admin/keys` 落到同一页；系统页不再有搜索卡片 |
| `test/admin-access.test.mjs` | 后台导航 11 项，且 `section: 'keys'` 为 0 |
| 全量 | 1709/1709 |
| lint / tsc / build | 0 error / 26 warning、tsc 干净、build 通过 |
| 临时实例（假 Key、假上游） | `/#/admin/models` 1440×1000 与 390×844 都渲染出「联网搜索 已接通 / DeepSeek 搜索（跟平台对话共用一把 Key）/ Key sk-••••58 / 用「Key 池」里那把 平台对话（样例）」；390 无横向溢出（scrollWidth 390 = innerWidth 390）；`#/admin/keys` 落到同一页 |

截图（临时实例、样例 Key，不代表真实上游）：

- `docs/admin-models-search-1440.png`
- `docs/admin-models-search-390.png`
- `docs/admin-search-card-390.png`

## 五、边界

- 本次**没有**真实调用 DeepSeek 搜索接口：按约定，花钱的调用由用户在用户端点。第一次「试搜一次」如果回 401/402，按卡片上的话术处理即可（换 Key / 充值）。
- 博查 / Tavily / 通用接口的逻辑没动，只是搬了家；它们的 Key 仍然单独存在 `search.json`。
- 搜索只读前 3 条网页、合计 12000 字，跟 r246 一致；不做图片搜索、不做 `/tools/fetch` 的兜底抓取（`link-read` 已经够用，且更可控）。

## 六、生产上线（2026-11-19 13:44）

| 项 | 值 |
| --- | --- |
| 版本 | `0.9.241`，入口 `index-DlXzwBQ-.js` |
| 发布标签 | `20261119-1345-r258search` |
| health | ok，templates 26 |
| `/var/lib/visionqa/search.json` | 已写入（0600、visionqa:visionqa，165 B）：`provider=deepseek`，无 Key |
| `GET /api/chat/search`（真实账号会话） | `configured:true`，`providerLabel:"DeepSeek 搜索（跟平台对话共用一把 Key）"` |
| 快捷创作里的「联网搜索」开关 | `disabled:false`、`aria-pressed:false`、title 为「平台自己搜一遍最新信息，再把前几条网页读成文字」 |
| 后台「模型与上游」 | 「联网搜索 已接通 / 通道 DeepSeek 搜索（跟平台对话共用一把 Key）/ Key sk-••••09 / 用「Key 池」里那把 DeepSeek 官方（原环境变量）」 |

上线用的临时管理员会话与验收用的普通账号会话**都已从 sessions 撤销**（deleted=1 / deleted=1，回到 21 条），临时文件已删。

生产截图：`docs/prod-admin-search-1440.png`、`docs/prod-quick-search-toggle-1440.png`。

开通这一步本身**没有任何上游调用**；第一次真实搜索（点「试搜一次」，或在对话里打开「联网搜索」发一句）由用户发起。
