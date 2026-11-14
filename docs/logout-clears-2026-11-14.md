# 退出登录 = 这台电脑不再留你的东西（2026-11-14，v0.9.89）

## 结论先行

上一轮把帧图与上传图关进登录门之后，还剩一个 **一小时** 的口子：图片响应给的是
`private, max-age`——浏览器在这段时间里不回源，于是退出登录、换账号之后，同一台电脑照样
能把看过的画面画出来，服务端那道 401 根本没机会跑。页面这边也一样：会话清了，但智能体
对话历史（**真内容**）、上次打开的画布 id、检索词与筛选词还在 `localStorage` /
`sessionStorage` 里，下一个账号打开就看得见。

这一版把两件事一起收掉：

- 帧图与上传图改成 `private, no-cache` + 强 ETag：**每次用之前都回源**，没变化回 304
  （几十字节），没权限就 401 / 404。缓存因此不能再当登录的旁路。
- 退出登录（以及「换账号登录」）时清掉本机痕迹：对话历史、画布 id、检索词、三个列表的
  筛选词；模型偏好、形态开关、引导看过没都留着——那是这台机器的设置，不是谁的资料。

## 为什么是这两个

- **`private` 不等于「必须回源」**。`private` 只保证中间层不存，浏览器照样可以在
  `max-age` 内直接拿副本、一次请求都不发。上一轮 nginx 那边把缓存头交回了应用，
  但应用给的是 `max-age=3600`——等于把「退出登录立刻失效」这句话推迟了一小时。
- **会话清干净 ≠ 本机清干净**。`session.ts` 只删 `visionqa.session.v1` 这一个键；
  智能体对话历史是 `AgentsPage` 自己存`vq:agents:history:v1`（最多 12 条，内容是用户
  真打的字），画布 id 是 `vq:bdcCanvas`，雷达检索词在 sessionStorage，三个列表各自存
  筛选词。共用一台电脑时，这是比缓存更直接的泄露。
- 这两件事恰好是同一个承诺的两半：**退出登录之后，屏幕上不该还留着你刚才看的东西**。

## 改了什么

### 服务端：图片必须重验

- 新增 `server/image-response.mjs`（帧图与上传图共用一份）：
  - `AUTH_IMAGE_CACHE = 'private, no-cache'`（缓存头的唯一出处）
  - ETag 由「大小 + 修改时间」算（不读文件），带引号、十六进制
  - `If-None-Match` 认精确值、`W/` 弱前缀、列表与 `*`
  - 命中回 **304**：不带 body、不带 `Content-Length`，缓存头与 ETag 照给
  - 文件不存在 / 不是普通文件返回 `false`，调用方照旧回 404
- `server/routes/frames.mjs`：登录与归属判断**在缓存比对之前**，然后才轮到 304。
- `server/routes/media.mjs`：上传图同一套（原来 `private, max-age=300`）。

### 页面：本机痕迹

- 新增 `src/auth/local-residue.ts`（纯函数，只吃两个 Storage 形状，Node 里可测）：
  - 点名清：`vq:agents:history:v1`、`vq:bdcCanvas`
  - 前缀清：`vq:agents:history:`（历史键将来带版本号也能扫到）
  - 会话存储清：`vq.radar.lastSearch.v1`、`vq_projects_view:v1`、`vq_templates_view:v1`、`vq_runs_view:v1`
  - 留着：`vq.model`（模型偏好）、`vq.edition`（形态开关）、`vq_welcome_seen:<账号>`（引导看过没）
- `src/auth/session.ts`：
  - `signOut()` 在清会话键之后调 `clearResidue()`
  - `persistSession()` 先读上一份会话，**换账号**（user.id 不同）也清一遍——
    会话过期后直接登录另一个账号，不会经过「退出登录」那个按钮
- `src/pages/SettingsPage.tsx`：账号卡里加一行「退出登录会清掉什么」。

## 本地实测（一次性实例 8911 + 真 Chrome，假上游，零真实调用、零积分）

接口：**17 / 17**

| 检查 | 结果 |
| --- | --- |
| 主人读帧图 | 200 / 66,526 B **字节一致** / `private, no-cache` / ETag `"103de-1a1cf6a9466"` / nosniff |
| 带自己的 ETag 再来 | **304** / body 0 B / 无 `Content-Length` / ETag 不变 |
| 匿名带 ETag 重验 | **401** + `loginRequired`，且不带 ETag（缓存不能当登录旁路） |
| 别人带 ETag | **404**，与「模板不存在」同一句 `frame not found` |
| 弱 ETag `W/"…"` | **304**（中间层会改写） |
| 上传图四态 | 200（`private, no-cache` + ETag）/ 304 / 匿名 401 / 别人 404 |
| 分享页 token 帧图 | 匿名 **200**（不经过这条路由） |

浏览器（1440×980 与 390×844）：

| 检查 | 结果 |
| --- | --- |
| 登录后分镜表 | 8 个镜头 8 张帧图，`naturalWidth` 全 > 0 |
| 刷新一次 | 8 / 8 仍渲染，帧图响应 **8 条全是 304**（重验，不是重下） |
| **只清 cookie、不清缓存**再取帧图 | **401**（上一轮这里是 200 —— 从缓存里拿的） |
| 直接打开 `/media/frames/…` | 401 页面，DOM 里 **0 张图** |
| 390 宽 | `docSW 390`，不横向溢出 |
| 设置页 | 「退出登录会清掉什么」在位 |
| 点「退出登录」后 | 对话历史与画布 id 都不在；`vq.model`、`vq_welcome_seen:…` 还在；会话键不在 |
| sessionStorage | 检索词与筛选词清空 |
| 退出后的页面 | 登录表单（email / password）接住整页，「已退出登录。」提示在位，DOM 里 0 张帧图 |

## 生产实测（v0.9.89，入口 `index-BjLykdCX.js`，快照 `20261114-013006-v0.9.89`）

用真实管理员会话**穿过 nginx** 打同一张帧图，部署前后各一次：

| | 部署前（v0.9.88） | 部署后（v0.9.89） |
| --- | --- | --- |
| 状态 | 200 / 33,317 B | 200 / 33,317 B（**字节一致**） |
| 缓存头 | `private, max-age=3600` | `private, no-cache` |
| ETag | 无 | `"8225-1a1ca614690"` |
| 带 ETag 再来 | ——（浏览器根本不会来） | **304** / 0 B / 无 `Content-Length` |
| 匿名带 ETag | —— | **401** `{"error":"未登录","loginRequired":true}`，只有 `no-store` |
| 匿名直接取 | 401 | 401 |

访问日志把这三步都记下来了（同一秒三条）：

```
GET /media/frames/tpl_b1246a9f/frame-01.jpg s=304 u=<管理员>
GET /media/frames/tpl_b1246a9f/frame-01.jpg s=401 u=
GET /media/frames/tpl_b1246a9f/frame-01.jpg s=401 u=
```

其余：`/api/version` 0.9.89；四个 unit 全 active；journal 近 5 分钟只有 access 行、
无 warning；盘 27G/40G（72%）；首页 200 / 729 B，`/assets/index-BjLykdCX.js` 200 / 567,756 B。

生产机一次性实例（**部署后的代码**，8931 / `/tmp/r100pdata`）**5 / 5**：帧图
200（`private, no-cache` + ETag）/ 304（0 B）/ 匿名带 ETag 401 / 别人 404；上传图
200 / 304 / 401 / 404 四态；跑完删掉临时目录，`/tmp/r100*` 0 个。

生产 UI（真浏览器，管理员只读）：模板抽屉分镜表 **8 / 8** 帧图渲染；刷新一次仍是
8 / 8，其中帧图响应 **21 条 304 + 9 条 200** ——重验在工作，画面没有因为改缓存头而消失。

## 踩到的坑

1. **`private` 只挡中间层，不挡浏览器**。「私有」让人误以为已经安全，实际浏览器在
   `max-age` 内连一次请求都不发；安全语义必须靠 `no-cache`（或 `must-revalidate`）
   加兑现方（服务端真的会回 401）来保证。
2. **304 必须排在鉴权之后**。先比 ETag 再判登录，等于给缓存发了通行证；代码里这两行的
   顺序就是安全边界，用例专门钉住「匿名带 ETag = 401，不是 304」。
3. **清 cookie 不清缓存**。上一轮这条是「测试假象」，这一轮它变成了「要修的真问题」：
   同一个浏览器只清 cookie 再取帧图，旧代码给 200，新代码给 401。
4. **会话清了不等于本机清了**。`session.ts` 只删自己的键；对话历史是 `AgentsPage` 里的
   另一个键。清残留这件事必须按「谁存了内容」逐一列，不能假设「退出登录会顺手带上」。
5. **换账号不一定走退出**。会话过期后直接登录另一个账号，压根不会点「退出登录」——
   所以在 `persistSession` 里比上一份的 `user.id`，两处都清。
6. **不要整库清 localStorage**。`vq.edition` 是运维的形态开关、`vq.model` 是偏好，
   被顺手清掉会让人以为界面坏了。点名键 + 前缀扫，比「`localStorage.clear()`」安全。
7. **PowerShell 5.1 会把带引号的 ETag 参数改坏**。`curl -H 'If-None-Match: "8225-…"'`
   发出去时那个头根本没到服务端，于是看到「部署后还是 200」，差点误判成没生效；
   换 `node fetch` 立刻就是 304。带引号的探测值一律用脚本发。

## 发现但没在这一轮做

- **分享页与交付包的帧图仍是 `public, max-age=600`**：这是故意的（`project-share.mjs`
  里注释写着「停止分享后旧链接失效，缓存不该比链接活得更久」）。token 是凭证，10 分钟
  比链接的失效粒度粗一档，但不会因为「登录态变了」而错给图。
- **退出登录没发 `Clear-Site-Data`**。那样能一次清掉整个源的缓存，但要求 https、
  浏览器支持不一致，而且会把所有静态资源一起清掉；这一轮选了语义更窄的做法
  （只让图片必须重验），代价是每次打开模板多 8 次条件请求（实测 8 条 304 约 2 KB）。
- **`/api/cover` 仍没有每账号限流与整机并发帽**（上一轮记过）：它替登录用户出站抓图，
  有协议/内网/超时/8 MB 上限，但堆 20 个 15 秒超时仍会吃连接。
- **ETag 用大小 + 修改时间**：同一毫秒内改写且大小完全相同会命中旧 ETag（抽帧场景几乎
  不可能发生）；要更严就得对内容算哈希，代价是每次请求多读一遍文件。

## 边界与回退

- **本地演示**（`VQ_REQUIRE_AUTH=0`）匿名照常 200，只是每次多一次回源；离线开发不受影响。
- **分享页 / 交付包 / 打印页不受影响**：它们走带 token 的地址，不经过 `/media/frames`。
- **管理员**仍可读全部。
- 只清「内容」类本地键；模型偏好、形态开关、引导标记留着。
- 回退：`bash /opt/visionqa/ops/rollback.sh --to 2`（回到 v0.9.88）。这一轮没动 nginx，
  不需要还原配置。

## 测试与提交

- 测试 **795 / 795**（+18）：新增 `test/image-response.test.mjs`（5：ETag 算法、
  If-None-Match 四种写法、304 头、缺文件、内容变了）、`test/local-residue.test.mjs`（7），
  `test/frame-auth.test.mjs` +5（no-cache、304、匿名带 ETag 401、弱 ETag、内容变），
  `test/upload-media.test.mjs` +1（四态）。
- oxlint 0 error / 15 warning，`tsc -b` 干净，构建通过（入口 `index-BjLykdCX.js` 567,756 B），
  密钥扫描 603 文件 0 命中。
- 代码提交 `14d345a`，CI **43540817649** 三个 job 全 success。
