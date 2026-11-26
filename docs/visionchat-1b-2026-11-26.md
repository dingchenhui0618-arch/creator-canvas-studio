# 1b 落地记录：配对码 + vqc_ 令牌 + 收件箱 + MCP + 连接器（2026-11-26）

方案见 `docs/visionchat-proposal-v2-2026-11-25.md` 3.3 / 3.4 / 8。这一份只记「实际做成了什么、
契约长什么样、边界在哪、怎么验的」。

## 一、这一版解决的问题

1a 的房间里只有人在说话。1b 要回答的是：**用户自己的智能体（codex / Claude / workbuddy）怎么进来，
并且进来的人只能说话、不能替主人花钱。** 结论：配对码换令牌，令牌只认一个房间、一个成员。

## 二、数据与契约

新增两张表（都在已有的 `auth.db`，不新增数据库文件，`server/agent-access.mjs` 懒建）：

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `pair_codes` | `code`（主键，8 位归一化）、`room_id`、`user_id`、`expires_at`、`used_count`、`revoked_at` | 24 小时；最多 10 次；同房间一次一换 |
| `agent_tokens` | `id`、`room_id`、`member_id`、`user_id`、`token_hash`（sha256，唯一）、`prefix`、`provider`、`last_seen_at`、`revoked_at` | 原文不落库；`prefix` 只用于界面显示 `vqc_ab12cd…` |

`room_members` 沿用 1a 的列：`kind='agent'` + `provider`（`platform` / `codex` / `claude` …）；
连接器成员没有 `agent_id`，与平台智能体区分得开。

### 接口（session 侧，房主）

| 接口 | 作用 |
| --- | --- |
| `POST /api/rooms/:id/pair-code` | 生成新码（旧码立刻失效） |
| `GET /api/rooms/:id/pair-code` | 拿当前有效码（刷新页面不丢）；没有就回 `code: null` |
| `DELETE /api/rooms/:id/pair-code` | 作废（已接入的令牌不受影响） |

### 接口（令牌侧，`/api/agent/*`，只认 `Authorization: Bearer vqc_…`）

| 接口 | 说明 |
| --- | --- |
| `POST /api/agent/pair` | `{code,name,provider,reclaim?}` → `{token}`（只回一次） |
| `GET /api/agent/me` | 令牌归属：成员、房间、`lastSeq`、上限 |
| `DELETE /api/agent/token` | 自撤 |
| `GET /api/agent/inbox?since=&wait=` | 长轮询（≤25 秒）；不带 `since` = 第一次来只回游标 |
| `GET /api/agent/room?limit=` | 房间 + 成员 + 最近消息 |
| `POST /api/agent/messages` | 说话（`clientId` 幂等；30 次/分钟） |
| `POST /api/agent/read` | 未读游标 |
| `POST /mcp` | MCP（Streamable HTTP，无状态） |
| `GET /visionchat.md` | 给 agent 读的接入说明（无用户数据、无令牌） |

## 三、令牌的边界（都有单测）

| 断言 | 结果 |
| --- | --- |
| 拿 `Bearer` 打 `/api/rooms`（session 接口） | **401**——令牌不是登录态 |
| 没有令牌调 `/api/agent/me` | 401 + `WWW-Authenticate: Bearer` |
| 令牌只能读到自己的房间 | 房间里看不到第二个房间、看不到别的账号 |
| 库里有令牌原文吗 | 只有 64 位 sha256 与前缀 |
| 同名再配对 | 409 `MEMBER_EXISTS`；`reclaim` 接管同一个成员、旧令牌失效 |
| 被移出房间 / 房间解散 / 自撤 | 立刻 401 |
| 收件箱 | 自己发的不回灌；`since=0` 显式从头；不带 `since` 只回游标 |

限流：配对 20 次/分/IP，令牌发消息 30 次/分，`POST /mcp` 120 次/分/IP；一个令牌同时最多 2 条长轮询
（第 3 条 429 `AGENT_POLL_LIMIT`，释放后可再挂）——长轮询每条占 25 秒，不封顶就等于开放「令牌开几百条连接」。

## 四、连接器（可选）

`scripts/visionchat-connect.mjs`，零依赖、Node 20+：

```bash
node scripts/visionchat-connect.mjs \\
  --base https://visionqa.wavisionai.cn \\
  --token-file ~/.visionchat/token \\
  --exec "claude -p"
```

- 令牌从文件读（`0600`），不打印；`--token` 内联方式不提供，避免进 shell history。
- 提示词走 **stdin**，回答取 **stdout**：不用给命令拼接文本，绕开一整套引号与注入问题。
- 启动时连不上服务会退避重试（最多 20 次），401 立刻退出；单条命令默认 120 秒超时。
- 命令失败会把失败原因作为一句话回传（`（本地 codex 没能回话：…）`），房间不会静默。
- `--once` 给 cron 用。

## 五、端到端验证（不在单测里的那条链）

`scripts/visionchat-e2e.mjs`：临时实例 + 真账号 + 真配对码 + 真令牌 + 真连接器 + 假 agent，
跑通「人说话 → 连接器 → 本地命令 → 房间回话」并核对消息署名与内容：

```
[1] 连接器接入成功：已接入房间「端到端房间」· 成员「本地 codex」
[2] 连接器收到并回话：收到 #1 ← 主人（开场先给三个钩子，选一个） | 回了 #2（15 字）
[3] 房间里真有一条智能体消息 #2 · 本地 codex · 收到：开场先给三个钩子，选一个
[4] MCP 工具：visionchat_inbox, visionchat_send, visionchat_room
[5] /visionchat.md 1438 字符，含配对说明，不含令牌
[6] 撤销令牌后连接器拿到 401 并退出
```

## 六、界面

- 右栏「接入我的智能体」：真码（`8EG5-3PX3`）、`24 小时内有效 · 已接 1/10 个 · 只对这个房间有效`、
  复制按钮、换一张 / 作废、`/visionchat.md` 链接。
- 成员行：平台智能体写「平台智能体」；接了令牌的显示绿点与「已接入 · 刚刚在线」；撤销过的写「已断开」。
- 截图：[docs/r316-rooms-agent-1440.png](r316-rooms-agent-1440.png)、
  [docs/r316-rooms-pair-1440.png](r316-rooms-pair-1440.png)、
  [docs/r316-rooms-pair-390.png](r316-rooms-pair-390.png)（1440 / 390 溢出都是 0，页面报错 0）。

## 七、没做 / 下一段

- **直连 BYOK**（`baseUrl + apiKey + model`，AES-256-GCM 存 `DATA_DIR/user-agents.json`，出口只允许 https、
  解析后校验 IP、拒环回/私有网段/元数据地址）：还没做，作为 1b 的下一段。
- 7 个工具与「逐次批准」是 1c/1d；`/api/admin/*` 在工具层必须是零命中（单测扫表）。
- 生产未上线：本轮只到 master，等用户点头再发版。
- 平台智能体在房间里仍不会自动回话（`platform` 成员只是可被 @ 的成员，回复要靠 1c 的回合引擎或它自己的令牌）。
