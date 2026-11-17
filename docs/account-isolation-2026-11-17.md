# 账号隔离复核（2026-11-17）

0.9.171–0.9.174 这几轮把「账号」做成了真身份：手机号当登录名、找回密码走真邮箱、后台能改身份与重置口令。
用户对这块的要求只有一句——**后台管理只在管理员账号下显现，其余账号看不见**；再加一层含义：一个账号不该看见、改到、下到另一个账号的东西。

隔离不是一句口号，是一串判断。这份文档把「哪类数据归谁、在哪一层挡、拿什么证明」列清楚，并配一组回归测试
`test/account-isolation.test.mjs`（7 条，真实路由 + 真实 SQLite）。

## 三层门

| 层 | 在哪 | 挡什么 |
| --- | --- | --- |
| 应用层 | `server/index.mjs` 的 `needsLogin` | 除 `PUBLIC_API` 白名单外，`/api/` 下未登录一律 401；**排在功能路由之前** |
| 路由层 | 各 `server/routes/*.mjs` | 按 id 的操作一律用带 `user` 的取法（`getProject(id, user)`、`getRun(id, user)`），取不到就 404——连「存在不存在」都不告诉对方 |
| 存储层 | `server/owner.mjs` 的 `canAccess` | 自己的、管理员、公共条目（shared 或没有 ownerId）能看，其余 null。路由就算漏判，数据层也拿不到 |

## 隔离矩阵

| 数据 | 别人的账号能做什么 | 挡在哪 | 谁验过 |
| --- | --- | --- | --- |
| 模板 `templates.json` | 列表里看不到、按 id 取不到、改不了、删不了 | `canAccess` | `test/owner.test.mjs` + 既有 templates 测试 |
| 作品 `projects.json` | 详情 404、改名 404、删除 404，且对方数据不变 | `canAccess` + `getProject(id, user)` | 本组第 1 条 |
| 工作流 `flows.json` | 列表里没有；按 id 取 null | `canAccess` | 本组第 2 条 |
| 运行记录 | 列表里没有；按 id 取 null | `canAccess`（`listRuns` / `getRun` 带 user） | 本组第 2 条 |
| 上传的图 `uploads/<账号>/` | 别人的下载地址 404；管理员排障可看 | 路由判 `ownerId` | 本组第 3 条 |
| 生成任务 `media/tasks` | 任务 403 `MEDIA_TASK_FORBIDDEN`，结果文件同样 403 | 路由判 `task.userId` | 本组第 4 条 |
| 积分账本 `credit_ledger` | 各算各的，读不到对方的流水与余额 | 按 `user_id` 查 | 本组第 5 条 |
| 偏好 `preferences` | 各存各的 | 按 `user.id` 存 / 读 | 本组第 5 条 |
| 后台 `/api/admin/*` | 普通账号 403；**自己改自己也是 403** | `isAdmin` 在路由最前面 | 本组第 6 条 |
| 主接口（未登录） | 自判登录的路由 401；其余靠应用层那道门 | `needsLogin` + 各路由自检 | 本组第 7 条 |

## 最要紧的一条：自己也不能给自己改身份

`PATCH /api/admin/users/:id` 能改邮箱与登录手机号（0.9.174）。如果这道门只判「是不是同一个账号」，
普通账号就能把自己的登录手机号换掉、把找回密码的邮箱换成自己的——等于绕过后台。
现在的实现是**先判 `isAdmin`、再判人**：普通账号对自己 id 的补丁也是 403，数据不动
（测试里连 `users.email` 都复查了一遍，确认一个字段都没写进去）。

## 两层登录门的分工（改分发顺序前先读这段）

`server/index.mjs` 里那句注释是踩过坑写下的：

> 登录门必须排在功能路由前面：featureRoutes 以前放在门之前，`VQ_REQUIRE_AUTH=1` 时
> `/api/agents`、`/api/flows`、`/api/billing` 仍然匿名可读（实测线上 200），等于把智能体提示词和工作流公开了。

所以 `/api/flows` 这类路由**本身不判登录**，完全依赖应用层那道门；而 `/api/projects`、`/api/credits`、
`/api/preferences`、`/api/media/*`、`/api/admin/*` 会再自己判一次（单测直接调路由时行为不依赖外层）。

## 边界（没做到的）

- 模板的路由没有单独测：它的处理内联在 `server/index.mjs` 里，不是独立 router；本组只在存储层覆盖了 `canAccess`，路由层靠既有 templates 测试与代码审阅。
- 改角色后的旧会话：0.9.171 验过后台接口对普通账号 403，但这组测试不覆盖「刚被降级的会话下一次请求」。
- 反代层：这组测试跑的是路由与存储层，不含 nginx 配置。
- 全量测试的环境敏感项：`test/global-heavy.test.mjs` 在可用内存很低时，内存水位守卫会先返回 `MEMORY_PRESSURE`，而它期望 `SERVER_BUSY`。这是机器状态（本轮本机仅 576 MB / 16 GB 空闲），不是隔离问题；单跑该文件通过。
