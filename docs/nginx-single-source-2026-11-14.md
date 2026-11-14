# nginx 站点配置只留一份：重跑部署不会再打回公共缓存（v0.9.92，2026-11-14）

## 结论

线上那份 vhost 是几个月里手改出来的：私有图的 `^~` 覆盖（v0.9.87 / v0.9.88）、`/print/`、
入口 HTML 的 `no-store`、`/assets/` 的 immutable、整套安全头、真实对端 IP——**全都不在仓库脚本里**。
原文（v0.9.90 的 `enable-https.sh`）内联出来只有 **38 行、3 个 location**：

```
location /api/        location /media/       location /
```

也就是说，谁照着 `deploy/production/README.md` 重跑一次部署脚本（安装脚本自称「幂等，可重复执行」），
自己上传的图会多出一条 `Cache-Control: public, max-age=604800`，模板帧图失去私有覆盖，
打印页掉回 SPA 的 `index.html`，入口 HTML 与 hash 产物的缓存策略一起丢失。这一轮把这条链路收成一份。

## 现在只有一份

| 文件 | 作用 |
| --- | --- |
| `deploy/production/nginx-app.conf` | **唯一写着 location 的文件**：静态产物、`/api/` 反代、`/media/uploads/` 与 `/media/frames/` 的私有覆盖、`/print/`、整套安全头、缓存头 |
| `deploy/production/nginx-http.conf` | HTTP 阶段外壳（证书没签下来之前）：应用段 + ACME |
| `deploy/production/nginx-tls.conf` | HTTPS 阶段外壳：80 只留 ACME + 301，443 跑应用 |
| `deploy/production/render-vhost.sh` | 一处替换 8 个占位符；渲染后还留着占位符就报错退出 |
| `scripts/check-nginx.mjs` | 把上面这些规则钉住，`npm test` 里跑；CLI 也能单独跑 |

- `install.sh` 第 7 步：`/etc/letsencrypt/live/<域名>` 已存在就装 HTTPS 版外壳，否则装 HTTP 版；
  覆盖前备份成 `<conf>.bak-<时间>`。**重跑安装不会把 HTTPS 站点换回 HTTP。**
- `enable-https.sh`：不再内联整段 vhost，只「签证书 → 换外壳 → 打开 Secure Cookie」。
- 片段落成 `<域名>.app.inc`（**不能是 .conf**，见坑 1）。
- `.gitattributes` 把 `*.conf` 也锁成 LF（渲染出来直接进 `/etc/nginx`，CRLF 会让 bash 先炸）。

## 证据

### 1) 旧脚本 vs 新模板（生产机上两个临时实例，8942 / 8943，不动线上 nginx）

同一张私有图（1×1 PNG，70 B，管理员账号上传）、同一份 `dist` 产物：

| 请求 | 旧脚本内联出来的 | 新模板渲染出来的 |
| --- | --- | --- |
| `GET /media/uploads/<我>/<图>`（带会话） | 200，`Cache-Control` **两条**：`private, no-cache` + `public, max-age=604800` | 200，只有 `private, no-cache` + `ETag` |
| 同一响应的安全头 | 只有 `nosniff`（连它自己都重复了一次） | `nosniff` + `Referrer-Policy` + `X-Frame-Options` + `Permissions-Policy` |
| `GET /media/frames/x/y.jpg`（匿名） | 401，`no-store`，**一个安全头都没有** | 401，`no-store` + 四个安全头 |
| `GET /index.html` | 200，`Cache-Control` 完全没有 | 200，`no-store, no-cache, must-revalidate` |
| `GET /assets/index-*.js` | 200，没有缓存头 | 200，`public, max-age=31536000, immutable` |
| `GET /print/nope` | 200，返回的是 **SPA 的 index.html**（ETag 与首页相同） | 200，应用自己的打印响应（`no-cache, no-store`） |

`nginx -t` 两份都过：旧的那份不是语法错，是**语义退化**——这正是文档与线上不一致最典型的样子。

### 2) 第一次渲染到生产：nginx -t 直接挡住了

```
nginx: [emerg] "location" directive is not allowed here in /etc/nginx/conf.d/visionqa.wavisionai.cn.app.conf:30
nginx: configuration file /etc/nginx/nginx.conf test failed
```

片段被写成了 `.conf`——`conf.d/*.conf` 是 nginx 在 **http 层**整段 include 的，里面不能出现 `location`。
因为 `nginx -t` 先跑、`-s reload` 后跑，这一次**没有重载**，线上站点没受任何影响；
改名为 `.app.inc` 后 `nginx -t` 通过再重载。这条规则现在由检查器钉着（配反向用例）。

### 3) 幂等

在生产上把模板再渲染一遍到真实路径，与重跑前逐字节比：

- 外壳 `visionqa.wavisionai.cn.conf`：**逐字节一致**；
- 应用段 `visionqa.wavisionai.cn.app.inc`：第一次差 4 行（0.9.92 模板新加的注释），第二次**逐字节一致**；
- `nginx -t` 通过 → `reload` → `/` 200 / 729 B、`/api/version` 0.9.92。

### 4) 线上现在的实际响应头（真 HTTPS、真 nginx）

| 路径 | 状态 | 关键头 |
| --- | --- | --- |
| `/media/uploads/<我>/<图>`（带会话） | 200 | `private, no-cache` + `ETag` + 四个安全头（`nosniff` 出现两次：应用与 nginx 各一份） |
| `/media/frames/x/y.jpg`（匿名） | 401 | `no-store` + 四个安全头 |
| `/index.html` | 200 | `no-store, no-cache, must-revalidate` |
| `/assets/index-ihWfisOn.js` | 200 | `public, max-age=31536000, immutable` |
| `/print/nope` | 200 | `no-cache, no-store`（应用的打印响应） |
| `/` | 200 | `no-store`（走 `location = /index.html`） |

线上 vhost 现在是 `include /etc/nginx/conf.d/visionqa.wavisionai.cn.app.inc;`，应用段 **8 个 location**。

### 5) 检查器本身

- `npm test`：**835/835**（新增 18 个用例）；`node scripts/check-nginx.mjs` 通过。
- 生产机（Node 22.12.0）上直接跑 `node scripts/check-nginx.mjs`：**通过**（不是只在开发机上绿）。
- 18 个用例里有 **15 个是反向用例**：删掉 `^~ /media/frames/`、给私有目录自己加 `Cache-Control`、
  私有目录丢 `X-Real-IP`、顶层少一个安全头、某个 location 少一个头、`$proxy_add_x_forwarded_for` 回来、
  入口 HTML 改成可缓存、私有目录排到 `/media/` 后面、外壳里再塞 location、脚本里内联 location/安全头、
  模板用了没登记的占位符、渲染脚本少传占位符、安装脚本不判断证书、片段叫回 `.app.conf`……
  每条都必须让检查器报出具体那一句，测试才算过。
- oxlint 0 error / 15 warning、`tsc -b` 干净、构建通过、密钥扫描 613 文件 0 命中。

## 坑

1. **`conf.d/*.conf` 是在 http 层 include 的**：带 `location` 的片段必须用别的后缀（我们现在是 `.app.inc`）。
   第一次渲染就撞上，`nginx -t` 挡住了 reload——先 `-t` 后 `reload` 这个顺序值一次事故。
2. **`add_header` 不会跨层合并**：某个 location 只要自己写了一条 `add_header`，上一层（server 段）的
   那些头对它**全部失效**。`/api/` 之所以安全头齐全，恰恰是因为它一条都不写、整套继承；
   而手加 `^~` 覆盖那次只重复了两个头，另外三个就悄悄没了。现在每个写了头的 location 都必须整套重复，
   漏一个检查器就红。
3. **`add_header` 不带 `always` 只作用于 200/201/204/206/301/302/303/304/307/308**：
   旧配置给 `/media/` 加 7 天 public 缓存时没写 `always`，所以匿名 401 那张看起来「没事」，
   真正带 200 的私有图却拿到了那条 `public`。**别拿 401 的响应头证明私有图没被公开缓存。**
4. **nginx 和应用的 `Cache-Control` 会叠加成两条**：应用给 `private, no-cache`，nginx 再补一条
   `public, max-age=604800`，中间层/浏览器怎么选不好说。私有目录的缓存头只能由应用给。
5. **`deploy/` 是合并拷贝不是替换**：`deploy.sh` 里是 `cp -a "$STAGE/deploy" "$APP_DIR/"`，
   从仓库删掉的文件不会跟着从服务器消失（这次 `nginx-visionqa.conf` 就留着，已手工删）。
6. **注释也会被自己的规则打中**：脚本里写「不能内联 location」这种说明，会被「脚本不许出现 location」的
   检查误判——所以脚本类检查只看可执行行。
7. **CRLF**：渲染出来的文件直接进 `/etc/nginx`，`*.conf` 也进了 `.gitattributes` 的 `eol=lf`。
8. **先 `-t` 再 `reload` 是唯一的刹车**：这次唯一的「失败」发生在 `-t`，站点零影响；
   如果顺序反了，那次失败就是一次站点中断。

## 发现但没做

- 换机器仍然要**手工跑一次** `install.sh` / `enable-https.sh`：没有 CI 到服务器的部署钩子，
  nginx 配置也不进 `deploy.sh` 的自动替换（只同步模板，不重载）。
- CI 里没有 nginx 二进制，检查器是**静态规则**而不是「真的让 nginx 解析一遍」；`nginx -t` 仍然只在机器上跑。
- `deploy/` 的合并语义没改（删文件要手工清）。要改就得处理机器上的 `env.applied` 之类现场文件，风险大于收益。
- 两个实例（8799 / 8800）各一份 cover 缓存的事没动（上一轮的「发现但没做」）。
- `/media/` 的 7 天 public 缓存仍然覆盖「其余 `/media/`」；将来再加私有目录，记得同时加 `^~` 覆盖
  ——否则现在是检查器红，不是线上出事。

## 边界与回退

- 站点行为不变：`/` 200、入口 JS 200、`/api/version` 0.9.92、四个 unit active、磁盘 27G/40G（72%）。
- 回滚应用：`bash /opt/visionqa/ops/rollback.sh --to 2`（v0.9.91）。
- 回滚 vhost：`cp /etc/nginx/conf.d/visionqa.wavisionai.cn.conf.bak-20261114-100004 /etc/nginx/conf.d/visionqa.wavisionai.cn.conf && nginx -t && nginx -s reload`
  （那份就是手改时代最后一份可用的配置）。
- 检查器可以单独关：它只是 `npm test` 里的一组断言，不参与运行时。

## 数字

- 发布：`20261114-015813-v0.9.91`、`20261114-020239-v0.9.92`；入口 `index-ihWfisOn.js`（567,970 B）。
- 提交：`58dcbec`（模板拆分 + 检查器 + 18 用例）、`9e18d79`（`.gitattributes` 锁 `*.conf` LF）、
  `bbb8a4a`（片段改 `.app.inc`，v0.9.92）。
- CI：**43543534733**（v0.9.91）、**43543946482**（v0.9.92）三个 job 全 success。
- 测试 **835/835**（+18），oxlint 0 error / 15 warning，`tsc -b` 干净，构建通过，密钥扫描 613 文件 0。

这一轮没有界面改动（部署配置与检查脚本），所以没有截图；可见的变化是「线上响应头」，
上面第 4 节就是它的实测结果。
