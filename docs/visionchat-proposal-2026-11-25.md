# VisionChat（Beta）方案

> 日期：2026-11-25 · 基线：v0.9.285（master，未提交工作区）· 状态：**方案待拍板，未动代码**
> 参考：用户仓库 dsh-chatroom（https://github.com/dingchenhui0618-arch/dsh-chatroom）、Pachat 公开文档（https://pachat.ai）
> 纪律：本文只写方案。没有改 `src/`、`server/`、`package.json`；没有调用任何真实上游；所有关于现有能力的描述都能在仓库里指出文件。

## 结论先行

1. **VisionChat 做「房间」，不做第二个 Pachat。** 平台侧是登录后的多智能体聊天室：一个房间里有 1 个人 + N 个智能体（后续可加人），智能体是成员而不是工具。Pachat 解决的是跨平台 agent 之间的异步通信（每只 agent 自己的 token、收件箱、长轮询唤醒），那套东西我们**不抄**，只借它「群聊 + 提及 + 幂等键」的产品直觉。
2. **入口放在「模板库」下面**，作为一级导航第 5 项，沿用 `src/nav.ts` 已有的 `chip: 'Beta'` 机制（工作流就是这么标的），不改工具区。
3. **智能体「操控 CLI」在平台侧先落成「白名单工具」**，不是服务器 shell。真正的本机命令执行已经存在（Electron 本地工作区：读目录/读文件免批准，写文件/改文件/执行命令逐次批准、命令 60 秒、路径锁在工作区内），平台版复用它验证过的**审批 + 副作用分级**模型，但不把 shell 搬到公网服务器上。
4. **连接方式选 SSE + 事件序号 + 服务端回合**，不用 WebSocket。放弃的是「广播级实时」和「在线状态」，换来的是与现有 `/api/chat/.../messages/stream`（已带 `X-Accel-Buffering: no`）、nginx 300 秒超时、2 核 1.8G 单进程部署相安无事。
5. **计费按「对话回合 1 次 + 每次工具调用各 1 次」**，全部走已有 `charge/refund`，先扣后调、失败全退、`ref` 可对账；权限先只读、写操作逐次审批，默认不给「完全授权」。

---

## 1. 定位与边界

**是什么**

| 项 | 定义 |
| --- | --- |
| 产品形态 | 平台内的多智能体聊天室（房间制），Beta |
| 成员 | 人（当前账号）+ 从 `agents.json` 拉进来的智能体；一期不开多人，二期开同工作区成员 |
| 消息 | 房间内按 `seq` 单调递增，支持提及、引用回复、分页翻历史 |
| 智能体 | 有名字与职责（进每次提示词）、各自独立会话、可被点名或按规则轮次发言 |
| 工具 | 平台白名单能力（读模板库 / 读工作流 / 网页读取 / 生图 / 生视频 / 视觉评审），带审批与计费 |

**不是什么**

| 不做 | 原因 |
| --- | --- |
| 不做 Pachat 式「agent 自带 token 从平台外接入」 | Pachat 的模型是平台外的 agent 用自己的 `pachat_` token 收发消息；我们是登录后的单一平台，账号体系已经存在（`vq_session` + `sessions` 表），再叠一层 agent 身份只会带来两套权限真源 |
| 不在服务器执行任意命令（shell） | 公网服务器 + 多租户 = 一个提示词注入就能拿到宿主；本机 CLI 留在桌面端 |
| 不做公网房间码/匿名加入 | 与「必须登录 + 积分」冲突；一期只做登录态房间，邀请走链接 token（三期） |
| 不做语音/视频通话、附件（一期） | 与当前聊天室的最小闭环无关 |

**和「快捷创作」里的对话有什么区别**（这一条最容易讲混，必须讲清）

| 维度 | 快捷创作 · 对话（已上线） | VisionChat · 房间（新） |
| --- | --- | --- |
| 参与者 | 1 个账号 + 1 个平台模型 | 1 个账号 + N 个智能体，后续可加人 |
| 上下文 | 单条长会话，服务端按 token 预算截断 + 摘要 | 每个智能体各自的会话；房间消息是共享上下文 |
| 谁在说 | 模型 | 具名成员：每条消息标「谁说的」 |
| 触发 | 用户发一句，模型回一句 | 提及必回 / 全员轮次 / 主持人，可并行开关，但有预算闸门 |
| 工具 | 联网搜索、读链接、思考模式（模型侧） | 平台工具（模板、工作流、生图、评审），由服务端执行并计费 |
| 计费 | 每轮 `chat` 1 积分 | 每轮 `chat` + 每次工具调用各自的价目 |
| 数据 | `DATA_DIR/chat/<账号>/<会话>.json`，最多 30 会话 / 每条 200 消息 / 单条 32000 字 | 需要 `seq`、成员、未读、分页，文件形不够用（见第 6 节） |

---

## 2. 页面与信息架构

**入口**：`src/nav.ts` 的 `PRIMARY_NAV` 现在是工作台、我的作品、爆款雷达、模板库四项。新增第 5 项 `visionchat`，标签「聊天室」；工具栏标签用 `chip: 'Beta'`，与工作流同款。`src/domain/types.ts` 的 `Page` 联合类型与 `pageLabels` 各加一条；路由用现有 `#/<page>` 机制，不引入路由器。

桌面端布局（1440 宽）：三栏，左 240 / 中自适应 / 右 300；390 宽：单列，房间列表与成员改为抽屉。

| 区域 | 内容 | 空状态 | 数据来源 |
| --- | --- | --- | --- |
| 左栏 · 房间列表 | 房间名、最后一句预览、未读数、相对时间；顶部「新建房间」 | 一句话说明房间是什么 + 两个入口（新建房间 / 加一个智能体） | 新表 `rooms` |
| 中栏 · 消息流 | 成员头像与署名、时间线、提及高亮、工具调用卡、失败占位与「重试」、滚到底、加载更早 | 「还没有人说话」+ 输入建议 | 新表 `room_messages` |
| 右栏 · 成员 | 人 / 智能体分组；智能体显示职责、所用工具、状态；底部「本房间授权档位」 | 成员列整列收起，不占空列 | 新表 `room_members` + `agents.json` |
| 底部 · 输入区 | 多行输入、@ 提及候选、本轮发言规则开关（提及必回 / 全员一轮）、预算提示（本轮最多引出 N 个回合）、发送 | 发送键禁用并说明原因（未选智能体 / 无积分） | 前端状态 |
| 消息内 · 工具调用卡 | 工具名、参数摘要、状态（待批准 / 执行中 / 成功 / 失败 / 已退款）、产物缩略图、积分消耗、「查看记录」 | —— | 新表 `room_tool_calls` |

界面约束（与宿主一致，不另起一套）：只用 `src/styles/tokens.css` 的变量；间距 4/8 栅格（4/8/12/16/24/32）；图标用 lucide 线性图标，不新增 emoji；中文字体全局已指定，不另设；不画盒子套盒子，选中的房间用 11% 填充而不是描边。

### 2.1 交互细节（一期就要定死，避免边做边猜）

| 场景 | 行为 | 备注 |
| --- | --- | --- |
| 输入 @ | 打 `@` 弹成员候选，只列智能体；键盘上下选择、回车插入 | 提及写进 `mentions_json`，不靠正则事后猜 |
| 发送 | 回车发送、Shift+回车换行；输入法组合态回车不发送 | 对话输入框已有（`src/components/QuickChat.tsx` 的 `isComposing` 守卫），房间输入沿用 |
| 智能体发言中 | 消息流尾部一行「某某正在说…」，可点「停止本轮」 | 停止用世代号作废旧回合 |
| 失败 | 占位消息留在原位，灰色，带原因；底部「只重试它」 | 重试不动其他成员、不换会话 |
| 未读 | 左栏房间行显示未读数；滚到底即清零；不在前台不代清 | 与「谁看过」无关，只算自己的游标 |
| 翻历史 | 顶部「加载更早」，一页 100 条；翻着历史时新消息不把人拽下去 | 底部浮「回到最新 · N 条新的」 |
| 空房间 | 一句说明 + 两个动作（加智能体 / 发第一句示例） | 不留白屏 |
| 390 宽 | 单列；房间列表与成员改抽屉；输入区贴底，键盘弹起时不遮输入 | 不横向滚动 |

---

## 3. 与现有能力的接线

| 现有能力 | 真源（文件） | 接入方式 | 需要新增/改动 |
| --- | --- | --- | --- |
| 账号 | `server/config.mjs` 的 `cookieName: 'vq_session'`；`server/auth.mjs` 的 `currentUser()`、`sessions` 表、`isAdmin()` | 所有房间接口先 `currentUser`，无登录 401，与 `/api/chat` 一致 | 房间成员表里存 `user_id`；不新建账号体系 |
| 积分 | `server/credits.mjs`：`charge(userId, kind, {ref, amount, meta})`、`refund`、`outstandingCharge`、`credit_ledger(id, user_id, delta, balance_after, kind, ref, meta, created_at)` | 发消息扣 `chat`；工具调用按 `image_gen` / `video_gen` / `review` 扣；失败 `refund` | 新增 kind：`room_turn`、`room_tool`（或在 `ref` 前缀里区分房间），价格集中在 `config.credits.prices` |
| 月度额度 | `server/quota.mjs`（`checkQuota` 在 `charge` 里先拦） | 复用，不另写 | 无 |
| 智能体 | `DATA_DIR/agents.json`（`server/agents.mjs`：`id/name/role/category/systemPrompt/temperature/knowledge/tools/model`） | 房间成员引用 `agentId`，不复制定义；改智能体定义房间里的下一次发言即生效 | 成员表加 `agent_id`；智能体被删时的降级文案 |
| 智能体对话 | `server/agentChat.mjs`：`chatWithAgent({agent, message, outputType, model, history, user, log})`，内部 2 次重试 + 候选降级链，错误分内部/外部两套文案 | 后台回合直接调用；每个成员维护自己的 `history` | 需要「多人共享上下文」的拼接层（见第 5 节） |
| 工具（现有） | `server/agents.mjs` 的 `AGENT_TOOLS`：`templates-read` / `canvas-read` / `export-json` / `web-read` 为 ready，`image-gen` 只是 planned | 复用为房间工具的前 4 个；`image-gen` 接 `server/routes/media-gen.mjs` 才第一次真的可用 | 由「对话前一次性注入」升级为「可被调用的工具」，见第 4 节 |
| 生图 / 生视频 | `server/routes/media-gen.mjs`：`/api/media/generate`、`/api/media/tasks`、`/api/media/models`；失败全额退回 | 房间工具卡直接下单，产物落地后回填消息 | 房间内产物引用（素材 id） |
| 模板库 | `server/templates.mjs` 的 `listTemplates({q, contentType, platform, kind, source}, user)`，条目含 `title/contentType/tags` 与所有者 | 房间工具「读取模板库」给它最近 6 条标题与类型，与 `agentChat` 现在的口径一致 | 无 |
| 视觉评审 | `server/routes/review.mjs`：`/api/review`，扣 `review` 5 积分，失败退 | 房间工具「请评审这张图」；限流已有 10 次/分钟 | 需要把产物 id 传给评审 |
| 资产 | `server/assets.mjs`、`/api/assets` | 房间工具「读我的资产」二期再加 | 二期 |

计费口径要写死一处：**用户在房间里发一句 = 1 次 `chat` 扣费（无论引出几个智能体回合）**；每个智能体实际调用仍然消耗上游 token，但不再逐条扣，否则一条消息会被扣成好几次，与已上线的对话价目打架。这是 `server/routes/local-agent.mjs` 已经用过的取舍（「一轮只在该轮第一次调用时扣一次」）。工具调用则逐次扣，因为它对应真实上游成本。

---

## 4. 「智能体可操控 CLI」怎么落地

先对齐词：用户说的「CLI/工具」，在平台侧应当理解为**可执行的白名单工具**。已有两套事实：

- **桌面端真 CLI**：`electron/agent/tools.mjs` 的工具集是 `list_dir` / `read_file` / `search_text`（无副作用、免批准）、`write_file` / `edit_file` / `run_command`（`needsApproval: true`，逐次批准）；命令 60 秒超时、输出截断 8000 字、路径锁在工作区根内（`resolveInside`）；`loop.mjs` 每轮最多 8 步，批准由宿主注入，拒绝即 `fail closed`；密钥只留在服务端（`/api/local-agent` 用平台 Key 换一次补全）。
- **平台侧工具**：`AGENT_TOOLS` 里只有「对话前读一次模板/工作流/网页」和「把回复里的 JSON 抽出来」，没有模型发起的工具调用循环，`image-gen` 至今是 planned —— 也就是说，「智能体自己决定调用工具」这件事**当前并未实现**。

**推荐模型（一期只落一颗钉子：只读 + 一个写操作）**

| 层 | 设计 | 与现有代码的关系 |
| --- | --- | --- |
| 工具注册表 | 服务端一张表：`id / label / scope(只读/读写) / needsApproval / creditKind / 参数 schema / 执行函数` | 扩展 `AGENT_TOOLS`，不另起第二份能力清单 |
| 只读工具 | 读模板库、读工作流、网页读取（仅公开 http/https，沿用 `webread.mjs` 的字节与字数上限）、导出 JSON（把回复里的 JSON 块整理成可下载文件） | 自动执行，结果注入下一步上下文；不扣积分 |
| 写操作（一期只开一个） | **生成一张图**：参数只收「提示词 + 尺寸 + 参考资产 id」，走 `/api/media/generate` 同一套上游与限流 | 该工具已有服务端实现，只差房间侧调用与审批 |
| 审批 | 房间级档位：`只读`（默认）/ `写操作需批准` / `完全授权（仅房主可开，二期）`；批准人 = 房间成员，二期扩到「房主可代批」 | 抄 `dsh-chatroom` 的三档与 `fail closed`：不点、超时 90 秒、服务重启或档位被改成只读，一律按拒绝收尾 |
| 越权 | 智能体只能调用「房间为它勾选的工具 ∩ 平台已 ready 的工具」；参数在服务端按 schema 校验，模型给的多余字段丢弃 | 不信任模型输出，与 `electron/agent/tools.mjs` 把路径限制在工作区是同一个思路 |
| 计费 | 每次工具调用一条 `charge`，`ref = room:<roomId>:call:<callId>`；失败 `refund` 同 `ref`；工具卡显示这笔账 | `outstandingCharge` 已能保证「同一 ref 不会多退」 |
| 失败 | 上游失败、参数不合法、超时 → 工具卡标失败并全退；不写进消息正文冒充结果 | 与 `media-gen` 现有退款口径一致 |

**明确不做**：服务器上的 shell、任意 URL 抓取（只允许公开页面且过 SSRF 校验）、写文件、改数据库、调用管理接口。若用户要的是「真的在我机器上跑命令」，答案在桌面端本地工作区，不在 VisionChat。

---

## 5. 连接方式对比

| 方案 | 延迟 | 服务端代价 | 与现部署的关系 | 断线恢复 | 实现成本 |
| --- | --- | --- | --- | --- | --- |
| 轮询（每 2–3 秒拉一次） | 2–3 秒 | 每客户端每 2 秒一次请求；2 核 1.8G 下 50 个房间 = 每秒 25 次查询，SQLite 读写会被放大 | 无特殊要求，nginx 无感 | 天然从 `seq` 续拉，不重不漏 | 最低 |
| **SSE（推荐）** | 亚秒级 | 每客户端一条长连接；单进程 Node 下几百条可承受，但每条都占一个 socket 与一段内存 | `/api/chat` 与 `/api/flows` 已在用，带 `X-Accel-Buffering: no`；nginx `proxy_read_timeout 300s`，心跳 15 秒即可安全穿过 | 用 `Last-Event-ID` / `?since=` 从 `seq` 续传 | 低（复用 `sseWrite` 那一套） |
| WebSocket | 亚秒级 | 需要 `http` 升级处理；反向代理要额外配置；Node 单进程下连接数与心跳管理更重 | 现在没有任何 WS 代码；nginx 与 Caddy 两套部署都要改 | 需要自定义重连与补洞协议 | 高 |

**推荐**：SSE + 服务端回合 + `seq` 续传，轮询作为降级（`EventSource` 连续失败 3 次 → 切 `/messages?since=` 每 3 秒轮询，界面顶部提示「实时连接断了，正在用轮询」）。放弃的是：不做「谁在线」的实时 presence（轮询下会闪），不做 <200ms 的多端同步；这些在 Beta 都不值当。

容量边界（写进验收）：单房间同时 1 个回合在跑（与 `dsh-chatroom` 的「一轮一人一次」同源）；全局并发复用 `config.credits.concurrency.chat = 2` 的闸门，超了返回 429 并说明「还有对话在跑」；SSE 单账号最多 2 条连接，服务端拒绝第 3 条并给原因。理由：2 核 1.8G 上真正贵的是模型调用，不是连接；把闸门放在模型入口最省钱。

回合调度（服务端，不依赖客户端在线）：

1. 人发一条消息 → 落库 `seq = n`，同步返回；
2. 调度器按房间规则选出本轮要发言的成员（提及必回 / 全员一轮），用「本轮预算」封顶（建议默认最多 2 个智能体回合、深度 1，比 dsh-chatroom 的 3/2 更保守，因为每次都是真扣费）；
3. 每个成员按顺序跑：拼上下文（房间最近 N 条 + 该成员自己的历史 + 工具上下文）→ 调模型 → 落库 `seq = n+1` → SSE 推送；
4. 45 秒无回应落一条失败占位（可只重试该成员）；「停止本轮」清空队列并作废旧回合（用世代号，抄 dsh-chatroom 的做法）；
5. 用户中途插话：排队到本轮结束再处理，不丢。

### 5.1 一期接口清单（不含实现，只定形状）

| 方法 · 路径 | 作用 | 鉴权 | 扣费 | 限流 |
| --- | --- | --- | --- | --- |
| `GET /api/rooms` | 我的房间列表（名称、最后一句、未读） | 登录 | 无 | 共享读限流 |
| `POST /api/rooms` | 新建房间（名称、规则、默认档位） | 登录 | 无 | 10 次/分钟 |
| `GET /api/rooms/:id` | 房间详情（成员、规则、权限） | 成员 | 无 | 共享读限流 |
| `PATCH /api/rooms/:id` | 改名、规则、档位（仅房主） | 房主 | 无 | 10 次/分钟 |
| `DELETE /api/rooms/:id` | 解散（墓碑，不物理删） | 房主 | 无 | 5 次/分钟 |
| `GET /api/rooms/:id/messages?since=&before=&limit=` | 历史与补洞 | 成员 | 无 | 共享读限流 |
| `POST /api/rooms/:id/messages` | 发一句话，触发回合 | 成员 | 1 次 `chat` | 20 次/分钟/账号 |
| `GET /api/rooms/:id/stream` | SSE：`seq`、发言开始/结束、工具卡、错误、心跳 | 成员 | 无 | 每账号 2 条连接 |
| `POST /api/rooms/:id/stop` | 停止本轮 | 成员 | 无 | 10 次/分钟 |
| `POST /api/rooms/:id/retry` | 只重试某成员某条 | 成员 | 1 次 `chat` | 10 次/分钟 |
| `POST /api/rooms/:id/members` | 加/删智能体成员（仅房主） | 房主 | 无 | 20 次/分钟 |
| `POST /api/rooms/:id/tools/:callId/approve` | 批准或拒绝一次工具调用（二期） | 成员 | 无 | 20 次/分钟 |

---

## 6. 存储与数据形状

现有 `chat-store.mjs` 是「一个账号一个目录、一条会话一个文件」，并明确写了「两者的数据形状不一样，硬塞进一个文件只会让两边都难改」。房间需要 `seq` 连续、成员外键、未读游标、工具调用与积分对账，文件形做不到原子追加与分页查询，因此**新建 SQLite 表**（数据库已经是 `node:sqlite` 的 `DatabaseSync`，见 `server/auth.mjs`；建表沿用 `CREATE TABLE IF NOT EXISTS` 的做法）：

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `rooms` | `id, name, owner_id, rules_json, approval_mode, created_at, dissolved_at` | `rules_json` 存「提及必回 / 全员一轮 / 预算」；解散不删，置 `dissolved_at`（墓碑） |
| `room_members` | `id, room_id, kind, user_id, agent_id, name, role, joined_at, removed_at`（kind 取 human / agent） | 智能体成员引用 `agents.json` 的 `id`，不复制 `systemPrompt` |
| `room_messages` | `id, room_id, seq, sender_member_id, body, mentions_json, reply_to, state, created_at`（state 取 ok / failed / tool） | `UNIQUE(room_id, seq)`；一张表同时存人的话、智能体的回复、系统通知 |
| `room_tool_calls` | `id, room_id, message_id, tool, args_json, status, credit_cost, ledger_ref, artifact_id, created_at` | `ledger_ref` 与 `credit_ledger.ref` 对上，积分可对账 |
| `room_reads` | `room_id, member_id, last_seq` | 未读数 = 最新 `seq` − `last_seq`；不做已读回执给对方看 |

保留口径：每房间最多 4000 条（超出滚动归档），投影给前端最近 200 条、分页每页 100 条 —— 与 dsh-chatroom 的 `200/4000/100` 相同，理由同样是不让一次打开房间把全历史读进内存。

### 6.1 与现有 chat-store 的关系

- **不迁移、不改写**：`DATA_DIR/chat/` 是「快捷创作」的一对一会话，VisionChat 另建表；两边互不读对方数据。
- **命名不撞**：房间接口全部挂 `/api/rooms`，不复用 `/api/chat` 前缀，避免将来两套消息语义混在一个路由里。
- **备份口径一致**：房间表落在现有 SQLite 文件里，跟着已有的备份脚本走；不新增第二个数据库文件，减少运维面。
- **回滚**：表是新增的，回滚先把入口从导航摘掉（`src/nav.ts` 一处），接口与表留着不碍事；`Page` 类型与 `pageLabels` 的条目可以留一版再删，避免同一次提交里改动面过大。这一点要求一期不写任何「房间消息 → 作品/模板」的单向搬迁，二期再加。

---

## 7. 安全

| 面 | 措施 | 失败时 |
| --- | --- | --- |
| 房间成员鉴权 | 每个房间接口先查 `room_members` 且 `removed_at IS NULL`；不是成员 403，不返回房间是否存在 | 403 + 一句中文原因 |
| 消息归属 | 发送者由服务端从 `currentUser` 决定，**请求体里的 sender 一律忽略**；智能体消息只能由调度器写入 | 客户端伪造无效 |
| 工具越权 | 工具白名单 ∩ 房间勾选 ∩ 账号可用；参数按 schema 校验；只读工具不碰写路径；写工具必须过审批 | 拒绝并落一条 `denied` 工具卡，不产生扣费 |
| 提示词注入 | 工具结果、网页正文、他人消息都按「不可信数据」处理，进上下文时明确标注来源与边界，不让模型把消息内容当指令；服务器侧没有任何「消息里出现某指令就执行」的路径 | 最坏是回复被带偏，不会执行动作 |
| 审批伪造 | 审批记录写服务端（谁、哪条调用、什么时候、允不允许）；审批只能由有权限的成员发起，客户端不能自称已批准 | fail closed，超时 90 秒按拒绝 |
| 限流 | 新接口单独开桶：房间发送 20 次/分钟/账号、工具调用 6 次/分钟/账号（与 `ratelimit.mjs` 的 60 秒滑动窗口同机制；IP 桶作为第二道，防换号） | 429 + 重试秒数 |
| 审计 | `room_tool_calls` 即审计：谁、在哪个房间、调了什么工具、花了多少积分、结果如何；管理员在后台可查，普通成员只能看自己房间 | 不可删除，只追加 |
| 邀请（三期） | 一次性 `invite token`，绑定房间与席位，有效期 7 天；不做房间码（房间码适合无账号的 LAN，我们有账号） | 过期/用掉即失效 |
| 隐私 | 房间消息不进入公开分享页；分享作品时只带产物，不带对话正文 | —— |

---

## 8. 分期与验收

**一期：能开会话的房间（约 1 个迭代）**

范围：导航入口 + 房间 CRUD + 成员（人 + 智能体）+ 消息流 + `@` 必回 / 全员一轮（默认只开第一个）+ 服务端回合 + SSE 推送 + `chat` 计费 + 只读工具 4 个 + 失败占位与「重试该成员」+ 未读与历史分页。
不做：他人加入、写操作工具、附件、悬浮窗、移动端独立布局。

验收（全部可测）：

- 两个智能体同房，@ 谁谁回；一条消息最多引出 2 个回合，超出不再发言；
- 一轮之内同一成员只说一次；插话排队不丢；停止本轮后旧回合迟到的事件被丢弃；
- 断线 30 秒重连，消息按 `seq` 不重不漏；`EventSource` 失败 3 次后切轮询且有提示；
- 每轮扣 1 积分、失败退 1；`credit_ledger` 里能找到 `room` 的 `ref`，余额 = 流水求和；
- 非成员访问房间返回 403/404；另一个账号读不到该房间的任何消息；
- 390 宽不横向溢出，间距只出现 4/8/12/16/24/32，无 emoji 图标。

**二期：工具调用与审批**

范围：工具注册表、工具调用卡、审批三档（默认只读）、生图（一个写操作）、生视频与视觉评审、产物回填与「引用到作品」、管理员审计页。
验收：发起生图 → 卡在「待批准」→ 拒绝则 0 扣 0 执行；批准 → 扣 5 积分 → 成功出图并回填 `artifact_id` → 失败全退；审批超时 90 秒按拒绝；模型消息里写「调用 run_command」不产生任何执行；单账号工具调用超 6 次/分钟返回 429。

**三期：多人、邀请与运营**

范围：同工作区成员加入、邀请链接、只读访客、房间模板（把一条作品/模板变成房间的初始任务）、房间回收站。
验收：邀请令牌一次有效；被邀请者 7 天内加入且席位唯一；访客只能读与 @ 自己的智能体；解散后历史保留、输入锁住；管理员可导出某房间的审计 CSV。

### 8.1 风险与观测

| 风险 | 触发条件 | 缓解 | 观测指标 |
| --- | --- | --- | --- |
| 多智能体回合烧钱 | 全员一轮 + 长消息 + 生图工具 | 本轮预算默认 2 个回合、深度 1；工具逐次扣费并需审批 | 每房间每轮的积分消耗分布；单账号日消耗上限告警 |
| 提示词注入 | 网页正文、他人消息、模板标题里夹带指令 | 工具结果标注为不可信数据；服务器只认白名单工具，不做「文本即命令」 | 工具调用拒绝率；异常参数校验失败数 |
| SSE 连接堆积 | 多标签页 + 移动端切换后台 | 单账号 2 条连接；心跳 15 秒；服务端 5 分钟空闲断开 | 当前连接数 / 进程内存（2 核 1.8G 的余量） |
| SQLite 写竞争 | 房间多、写频繁，与账号/积分共用同一个库 | 一期只有单进程；写操作短事务；`seq` 由房间内单点分配 | 写等待耗时 p95；`SQLITE_BUSY` 次数 |
| 免费额度被刷 | 新账号 50 积分 + 多房间 | 沿用限流桶；房间发送 20 次/分钟；不新增免费通道 | 单 IP 新账号创建房间数 |
| 数据不一致 | 扣费成功但回合失败 | 先扣后调、失败全退（复用 `outstandingCharge` 防重复退） | 退款流水与失败回合数对账，差异必须为 0 |

---

## 9. 需要拍板的问题（6 条）

1. **「CLI」到底指什么**：平台白名单工具（推荐），还是必须能在你的服务器上跑真命令？后者要单独的安全方案，我不建议放进 VisionChat。
2. **入口位置**：按用户原话放「模板库」下面（推荐，Beta 标签）；还是并进工具区（与快捷创作、无限画布并列）？
3. **一期开不开多人**：只做「1 个人 + N 个智能体」（推荐，一期风险最小），还是直接做同工作区多人？
4. **工具分期**：一期只上 4 个只读工具、生图放二期（推荐）；还是把生图压进一期？生视频与视觉评审每次 15 / 5 积分，建议更靠后。
5. **计费口径**：一条消息扣 1 次 `chat`（推荐，与桌面端「一轮一次」一致），还是按每个智能体回合各扣 1 次？
6. **默认授权档位**：房间默认「只读」、写操作逐次批准（推荐）；要不要给房主一个「完全授权」开关，开了之后不再逐次问？

---

## 附：本文事实来源

- 导航与页面：`src/nav.ts`、`src/domain/types.ts` 的 `Page` / `pageLabels`。
- 账号：`server/config.mjs`（`vq_session`）、`server/auth.mjs`（`sessions` 表、`currentUser`、`isAdmin`）。
- 积分：`server/credits.mjs`（`charge/refund/outstandingCharge` 与 `credit_ledger` 列）、`server/config.mjs` 的 `credits.prices` 与 `concurrency`、`server/quota.mjs`。
- 智能体：`DATA_DIR/agents.json` + `server/agents.mjs`（`AGENT_TOOLS`）、`server/agentChat.mjs`、`server/routes/agents.mjs`（先扣后调、失败退款、`recordAgentRun`）。
- 工具：`server/routes/media-gen.mjs`、`server/routes/review.mjs`、`server/templates.mjs`（`listTemplates`）、`server/assets.mjs`。
- 连接：`server/routes/chat.mjs` 的 SSE 头（`text/event-stream`、`X-Accel-Buffering: no`）、`server/routes/flows.mjs`、`deploy/nginx.conf`（`proxy_read_timeout 300s`）、`server/ratelimit.mjs`。
- 存储：`server/chat-store.mjs`（文件形与上限）、`server/auth.mjs`（`node:sqlite`）。
- 桌面 CLI：`electron/agent/tools.mjs`、`electron/agent/loop.mjs`、`server/routes/local-agent.mjs`。
- 参考产品（外部，未经我们验证其内部实现）：dsh-chatroom 的 README 与目录（三条发言规则、预算 `maxSpeakers`/`maxDepth`、45 秒失败占位、200/4000/100 分页、三档授权、`fail closed` 90 秒、LAN 房间码与明文 HTTP 的威胁模型）；Pachat 公开文档（https://pachat.ai/install.md 与站点帮助：每只 agent 自己的 `pachat_` token、收件箱、`wait=25` 长轮询、提及与 `replyTo`、`opKey` 幂等、2 分钟内撤回、check-in 与唤醒、公开/链接可见群）。**没有**把两者当作我们的架构，也没有引用任何未被公开的数字。
