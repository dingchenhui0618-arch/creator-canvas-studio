# 画布数据按账号隔离（r296 / v0.9.278 + 画布侧改动，2026-11-23）

## 用户报的问题

> 有一个非常严重的问题 不同账号之间画布数据并没有隔离

这一条属实，而且比「界面上看得见」更严重：**画布的 JSON 接口本身不认人**。

## 实测到的根因（改前，生产）

```
curl -s http://127.0.0.1:5312/api/canvas/list          # 不带任何凭据
→ {"canvases":[ 5 块 ]}   ← 全部画布（名字、节点数、版本）都给
```

- 画布 API（5312，经 6677 代理）的 `@jwt_required` 只是「有 token 就解析」，没有 token 也放行；
  解析出来的 `g.current_user` 也没人用来做归属判断。
- 画布文件都在同一个 workspace 目录（`…/BD Canvas/workspace/canvases/*.json`），文件里没有任何归属字段。
- VisionQA 侧确实有归属表（`DATA_DIR/canvas-owners.json`）和 `visibleCanvases`，但它只作用于
  **我们自己的** `/api/bdc/canvases`（作品流、概览、Bar 上的列表）；嵌进去的画布应用直接调 5312，
  那里的 list / load / save / delete 全是全局的。
- 于是：任何登录了 VisionQA 的账号，在无限画布里都能看到全部画布，也能按 id 打开、覆盖、删除别人的。
  另外 `/api/bdc/canvases/note`（往画布落评审笔记）只凭一个 canvasId 就能写，等同绕过读隔离。

## 改法（四层，缺一层都能漏）

1. **画布接口认人**：企业服务在登录/换票（`/enterprise/api/auth/login|exchange`）时种一张 httpOnly
   cookie `bd_canvas_session`。SPA 里所有 `fetch('/api/canvas/…')` 都是裸调用，只有 cookie 会
   被浏览器自动带上；不改前端也能让后端认出「这次请求是谁」。
2. **画布文件记归属**：每个 JSON 里加 `_owner`（`vq:<VisionQA 用户 id>` 或 `bd:<画布本地用户 id>`）。
   `list` 只回自己的（管理员角色看全部），`load` 别人的按 404 回答（不暴露是否存在），
   `save` / `DELETE` 别人的 403 / 404；新建时把 `_owner` 写进去，之后改名改内容都不许改归属。
   认不出人时不回清单（`auth_required: true`），不再是「匿名也能列全部」。
3. **VisionQA 服务端调用带签名**：作品流要读画布节点、评审要往画布落笔记，这些是本机服务调用，
   带 `X-VQ-Canvas: <body>.<hmac>`（密钥与画布信任票据同一把 `VISIONQA_TRUST_SECRET`，
   60 秒过期，只在环回上发）。没配密钥就**不发**这个头（画布按匿名处理，不会误开服务端身份）。
4. **落笔记按归属拦**：`/api/bdc/canvases/note` 写之前先判 `canvasOwnerId`（管理员例外），
   不是自己的一律 403 `CANVAS_FOREIGN`。
5. 画布前端补一处：隔离之后首屏可能在换票（种 cookie）之前就拉了 `?loadCanvas=` 的画布，
   落成 `Load failed` 标签；换票成功后**每个标签页刷一次**（sessionStorage 标记，防循环）。

## 迁移

`/var/lib/visionqa/canvas-owners.json` 里已有的两条按原样搬进 `_owner`；其余无主的老画布归管理员。

| 画布 | 归属 |
| --- | --- |
| `vq-mwrean75` | `vq:usr_FREfD8DfpBE1`（画布归属表里原本就是它） |
| `20261109-nmeom5h`（默认画布） / `vq-mwja6jm8` / `vq-mweo43lf` / `vq-mwja3208` | `vq:usr_DHZnmjNxrF0e`（VisionQA 管理员） |

## 验收（生产，改后）

| 场景 | 结果 |
| --- | --- |
| `GET /api/canvas/list` 无凭据 | `{"canvases":[], "auth_required":true}`（改前 5 块全给） |
| 管理员会话（cookie） | 5 块（自己的 4 + 迁移时归自己的） |
| mark 会话（cookie） | 0 块（他名下本来就没有画布） |
| mark 打开管理员画布 | 404 |
| mark 往管理员画布保存 | 403 `CANVAS_FORBIDDEN` |
| mark 删管理员画布 | 404 |
| mark 新建自己的画布 | 200，`_owner = vq:usr_7s55Vz2pejJ_`，读得回来 |
| VisionQA `/api/bdc/canvases` | 管理员 5 条 / mark 0 条 |
| `/api/bdc/canvases/note` | mark→管理员画布 403；管理员→自己画布 200（自检节点已删掉） |

截图：`docs/r296-board-admin-1440.png`（管理员，画布照常打开、2 个节点都在）、
`docs/r296-board-mark-1440.png`（mark，列表「暂无已保存的画布」，画布区空白）。

## 改动落点

- 画布侧（生产 `/opt/bdcanvas`）：`enterprise_server/auth.py`（种 cookie）、`server_v2.py`
  （认人 + 归属 + 服务端签名）、`src/main.ts`（换票后刷一次）。
- VisionQA：`server/bdc.mjs`（发 `X-VQ-Canvas` 签名）、`server/index.mjs`（落笔记按归属拦）、
  `test/canvas-isolation-r296.test.mjs`（3 条）。
- 门禁：1959/1959 测试、lint 0 error / 24 warning（672 文件）、`tsc -b` 干净、密钥扫描 1080 文件无命中、
  入口 `index-R33d5rdj.js`。生产 0.9.278，发布标签 `20261123-040252-20261123-1205-r296canvas`。

## 回滚

- VisionQA：`ops/rollback.sh --to 1` 回 0.9.277。
- 画布：`/var/backups/bdcanvas/bdcanvas-pre-r296-owner-20261123-114511.tgz`（源码）+
  `canvases-pre-owner-20261123-114637.tgz`（改归属前的画布文件）；解回后重启 bdc-api / bdc-enterprise。

## 边界（还没做的）

- 画布里的**素材与成片**（workspace 的 `assets/`、`outputs/`、`downloads/`）仍是同一个目录、同一套静态
  路由，拿到文件名就能看；这一轮只隔离了画布 JSON（列表 / 打开 / 保存 / 删除）。
- 画布本地账号（`bdadmin` 等）走自己的角色：admin/super_admin 看全部；VisionQA 管理员在企业侧是
  `user` 角色，所以他在画布应用里只看自己的，而 VisionQA 的列表对管理员是「看全部」——两处口径不完全一致。
- cookie 是 httpOnly，但没有设 `Secure`（本机 http 调试也要用）。公网走 https，暂不强制。
- 老的「无主」画布现在只有管理员能看到，普通账号不会自动获得。
- 本轮 0 次真实上游调用、0 费用。
