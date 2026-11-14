# 模板帧图不再匿名可读，静态目录越界一并补上（v0.9.88）

2026-11-14 · 生产 release `20261114-011729-v0.9.88` · 入口 `index-DQ7hlXVb.js`

## 为什么做这一轮

上一轮「传一张自己的图直接评」把上传图做成了私有的：落 `uploads/<账号>/`，读的时候核归属，
匿名 401、别人 404。收尾时顺手探了一下同一个媒体目录，发现还有两个口子不用登录就能拿东西：

1. **`/media/frames/<模板 id>/<文件名>` 谁都能读。** 这条只校验路径形状（`[\w-]+/[\w.-]+`），
   不看登录、也不知道这条模板属于谁。模板 id 不是秘密——分享页的 JSON 里就带着 `id`，
   任何拿到它的人可以按 `frame-01.jpg` 一路把整条片子的抽帧下走。
   代码里三处注释都写着「`/media/frames` 是要登录的」（`server/index.mjs` 的分享注释、
   `server/project-share.mjs` 和 `src/api/projects.ts` 的说明），实现里却没有那一道门。
2. **静态托管的路径越界。** `path.join(distDir, pathname)`，而 `pathname` 已经过
   `decodeURIComponent`：`/%2e%2e%2fpackage.json` 还原成 `/../package.json`，拼完就是项目根。
   本地实测 `package.json` **200 / 1.8 KB**、`.env` **200**——服务器的密钥文件可以被一个 URL 读走。

线上 nginx 对这类 URI 会先回 400（实测），所以第二个口子今天在公网打不进去；但应用自己不该
靠外面那一层——直连 `127.0.0.1:8799`、内网任何机器、以后换反代，都会漏。

## 改了什么

- **新的帧图路由** `server/routes/frames.mjs`：`GET /media/frames/<模板 id>/<文件名>`
  - 生产（`VQ_REQUIRE_AUTH=1`）必须登录，匿名 401 `{loginRequired:true}`；本地演示（=0）不认人，照常可用
  - 登录后只认「自己看得见的模板」：别人的私有模板 404，且与「模板不存在」**同一句回答**
  - 只发 jpg / png / webp；frames 目录里的 txt、临时文件、孤儿帧一律 404
  - `Cache-Control: private, max-age=3600` + `X-Content-Type-Options: nosniff`
- **`server/index.mjs`**：删掉内联的帧图分支，改为注册 `createFramesRouter()`（与 `/media/uploads`
  同一套写法）；dist 托管改走 `distFileFor`，越界直接 404，不回 `index.html`。
- **`server/static-path.mjs`**（新）：`distFileFor(root, pathname)` 把 `\` 统一成 `/`，
  `path.resolve` 归一化后判断是否仍在根内；越界返回空串。
- **nginx**：新增 `location ^~ /media/frames/`，把缓存头交回应用。原来的 `location /media/`
  给帧图加了 `public, max-age=604800`——帧图现在跟登录态绑定，不能挂在公开缓存上。
  配置备份 `/root/visionqa.wavisionai.cn.conf.bak-r99`。
- **模板抽屉**（顺带修的）：`analysis` 字段不全的老数据会让 `.map of undefined` 整页白屏，
  数组补默认值（`(detail.analysis.viralPoints || [])` 一类，共 4 处）。

## 证据

本地一次性实例（8909，假上游，**零真实调用、零积分**）：**17/17**

| 检查 | 结果 |
| --- | --- |
| 匿名读模板帧 | 401 `{"error":"未登录","loginRequired":true}`，响应体不含图片字节 |
| 主人读自己的帧 | 200，66,526 B **字节一致**，`image/jpeg`，`private, max-age=3600`，`nosniff` |
| 别人的私有模板 | 404 `frame not found`，与「模板不存在」**同一句** |
| frames 里的 `notes.txt` | 404（只发图片） |
| 静态越界 `/%2e%2e%2fpackage.json`、`%2e%2e%2f.env`、`%2e%2e%5cpackage.json` | 全 404，响应里没有文件内容 |
| 正常产物 `/assets/index-*.js` | 200 / 566,577 B（越界修好不误伤打包文件） |
| 分享页帧图（token 地址，匿名） | 200，66,526 B 真帧图 |
| 分享 JSON | 5,004 B，**不含** `/media/frames`（全是 `/api/share/<token>/frame/N`） |
| 登录后模板抽屉的帧图 | 分镜表 8 个镜头 → 8 张 `<img>`，`naturalWidth` 全 > 0 |
| 浏览器里清掉 cookie 再取帧图 | 401（关掉浏览器缓存后是真请求） |
| 分析字段不全的老模板 | 不白屏，标题正常显示 |
| 390 宽 | `docSW 390` / `docCW 390`，分镜表不横向溢出 |

生产机一次性实例（部署后的代码，8931 / `/tmp/r99pdata`）：**11/11**
—— 匿名 401、主人 200 且字节一致、缓存头 private + nosniff、别人 404、txt 404、
越界 `package.json` / `.env` 404、首页 200（695 B 入口 HTML）、产物 200、版本 0.9.88、
实例日志无 5xx。

生产公网探针（nginx 之后）：

| 请求 | 结果 |
| --- | --- |
| `/api/version` | 200 `{"version":"0.9.88"}` |
| `/media/frames/tpl_b1246a9f/frame-01.jpg`（匿名） | **401**，只有 `Cache-Control: no-store`（没有被加上 7 天 public） |
| `/media/uploads/...`（匿名） | 401（上一轮的口子仍然关着） |
| `/%2e%2e%2fpackage.json` | 400（nginx） |
| `/` 与 `/assets/index-DQ7hlXVb.js` | 200 / 729 B 与 200 / 566,577 B |
| 四个 unit | `visionqa` / `visionqa-internal` / `visionqa.socket` / `bdc-web` 全 active |
| journal（近 5 分钟 warning） | `-- No entries --` |
| 磁盘 | 27G / 40G，72% |
| 临时文件 | `/tmp/r99*`、`/tmp/vqstage99` 清完 0 个 |

## 踩到的坑

1. **`needsLogin` 只盖 `/api/*`。** 非 `/api` 的路径（`/media/*`、`/print/*`）全部绕过那道门，
   每一条都得自己挡。`/print/*` 早就自己挡了，`/media/frames` 漏了。
2. **`canAccess(item, null)` 返回 true。** 这是本地演示（不认人、全部可见）的设计，所以
   「匿名也能读」在单测里看起来正常；判断归属必须先有登录态，匿名分支不能拿它当安全边界。
3. **nginx 的 `/media/` 会加 7 天 public 缓存。** 私有内容落到那个 location，缓存头就变成公开的；
   必须单独 `^~ /media/frames/` 把头的决定权交回应用（`/media/uploads` 上一轮已经这么做了）。
4. **`Network.clearBrowserCookies` 不清浏览器 HTTP 缓存。** 第一版用例「清掉 cookie 再取帧图」
   拿到 200，看着像门没关；其实是命中了几分钟前那张 `private, max-age=3600` 的缓存。
   关掉缓存再请求才是真答案（401）。产品侧的含义：退出登录后，同一浏览器在 1 小时内仍可能
   从自己的缓存里显示看过的帧图——这是标准 HTTP 行为，URL 没有外泄。
5. **Windows 上 `\` 也是分隔符。** 只挡 `..` 不挡 `..\package.json`（`%5c` 解码而来），
   所以先统一分隔符再 `path.resolve`，最后比前缀。
6. **模板抽屉对老数据没有护栏。** `analysis` 是空对象时 `.viralPoints.map` 直接抛
   `TypeError`，页面兜底成「这个页面出错了」。这一轮是在真页面上撞到的，顺手补了默认数组。

## 发现但没在这一轮做

- **帧图的缓存窗口**：`private, max-age=3600` 意味着看过的画面在同一浏览器里留一小时。
  更严的做法是每次带 ETag 重验，代价是每次打开模板都要多发 8 个请求，这一轮先不换。
- **`/api/cover` 的出站抓取**：封面代理本身要登录，但它会替登录用户去抓任意 URL（内网地址已拒）。
  与这一轮的两口不同源，留待单独看。

## 边界与回退

帧图现在与登录态绑定：看不清模板的人看不到帧图，分享链接照旧（token 是凭证，走
`/api/share/...`，不经过这条路由）；交付包里的帧图是打包时复制进去的本地文件，不受影响；
管理员排障仍可读全部。上传图（`/media/uploads`）规则不变。

回退：`bash /opt/visionqa/ops/rollback.sh --to 2`（回到 v0.9.87）。nginx 的改动可用
`/root/visionqa.wavisionai.cn.conf.bak-r99` 还原后 `nginx -s reload`。

## 测试与提交

- 测试 **777/777**（+11，`test/frame-auth.test.mjs`）：匿名/主人/别人/管理员/公共模板、
  非图片、孤儿帧、405、本地演示、分享视图不含 `/media/frames`、`distFileFor` 越界矩阵。
- oxlint 0 error / 15 warning（与上一轮相同），`tsc -b` 干净，构建通过，密钥扫描 599 文件 0 命中。
- 代码提交 `f95a407`（CI 43539580704 三 job 全绿），文档提交见下一条。
