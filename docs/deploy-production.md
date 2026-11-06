# VisionQA Workbench 生产部署：从零到上线

> 面向：在一台干净的 Linux 服务器上，把本仓库跑成「有域名、有 HTTPS、掉线自动重启、数据可备份、客户可访问」的对外服务。
> 读法：先看第 0 节清单确认自己没漏项，再照第 2–11 节按顺序执行；第 13 节是出事时的速查表。

## 结论先行

- **形态**：一台 **4C8G / 100G SSD 的专用 Linux 机**（Ubuntu 22.04 LTS），跑**一个进程** `node server/index.mjs`（同时提供 API 与 dist 静态资源），前面挂 **Caddy**（自动 HTTPS）反代到 `127.0.0.1:8787`，用 **systemd** 守护。
- **数据只有一处**：`DATA_DIR`（默认 `<应用根>/data`，生产建议 `/var/lib/visionqa/data`）。备份就备它，恢复也只恢复它。
- **三件套必须同时打开**：`VQ_REQUIRE_AUTH=1`、`VQ_SECURE_COOKIES=1`、`VQ_DEMO_ACCOUNT=0`。少任何一个都不算「能对外」——不强制登录 / cookie 明文走 http / 公开演示入口，都是事故。
- **Node 只监听回环**：`server/index.mjs` 里写死 `listen(config.port, '127.0.0.1')`，这是**故意**的：公网流量只能经反代进来。不要为了「省一层」去改它监听 `0.0.0.0`。
- **BD Canvas 是另一个进程、另一份许可证**：只在本机 5312/5313/6677 跑，要对外只能反代 **网页入口**；源码与安装包永远不发给客户（详见第 11 节）。
- **不要在开发机上跑生产**：本机 15.8G 内存当前只剩 0.5G（2026-11-04 实测），一次复刻的 ffmpeg 全片解码就会被系统 OOM 杀掉，表现为「服务莫名其妙消失」。

配套文件（都在 `deploy/` 下，直接抄到服务器上用）：

| 文件 | 用途 |
| --- | --- |
| `deploy/Caddyfile` | Caddy 2 站点配置：自动 HTTPS、反代 8787、安全头、gzip/zstd |
| `deploy/nginx.conf` | 等价 nginx 配置（三段：http 层 / 80 / 443） |
| `deploy/vq.service` | systemd unit：`Restart=always`、`EnvironmentFile`、Node 堆上限 |
| `deploy/env.production.example` | 环境变量样例，逐项注释，**不含任何真实密钥** |

---

## 0. 上线前必做清单

一条都不能跳过。左边是勾选框，右边是「怎么验」——验收不看决心，看命令输出。

- [ ] **账号三件套同时到位**：`VQ_REQUIRE_AUTH=1` + `VQ_SECURE_COOKIES=1` + `VQ_DEMO_ACCOUNT=0`（建议再加 `VQ_REGISTRATION=0`）。
      **这四个键的代码默认值全在「不安全」那一侧**（`server/config.mjs` 实测）：`VQ_REQUIRE_AUTH` 只有等于 `1` 才鉴权，不写 = 不鉴权；`VQ_SECURE_COOKIES` 只有等于 `1` 才加 Secure，不写 = 明文 cookie；`VQ_DEMO_ACCOUNT` 只有等于 `0` 才关闭，不写 = 自动种一个演示账号；`VQ_REGISTRATION` 只有等于 `0` 才关闭注册，不写 = 任何人都能注册。
      所以它们不是「可选优化」，是**必须显式写进 /etc/visionqa/env** 的开关。
      怎么验：`curl -s https://<域名>/api/templates` 未登录必须返回 401；`grep -c '^VQ_' /etc/visionqa/env` 至少 4。
- [ ] **不存在公网直连 8787**：安全组/防火墙只放行 22、80、443。
      怎么验：`ss -lntp | grep 8787` 必须是 `127.0.0.1:8787`；从外网 `curl http://<公网IP>:8787` 必须超时。
- [ ] **域名解析生效、HTTPS 可用、http 全量跳 443**。
      怎么验：`curl -I http://<域名>` 返回 301；`curl -I https://<域名>` 返回 200 且带 `strict-transport-security`。
- [ ] **健康检查两个布尔都为 true**：`redfox`（红狐 key 已配）、`vision`（模型凭证已配）。
      `ok:true` 只代表进程能应答，不代表依赖可用——这就是要看这两个布尔的原因。
- [ ] **单机限并发 ≤ 2 个同时复刻**（不是代码限制，是资源现实，见第 14 节第 1 条）。
- [ ] **备份跑通，并做过一次恢复演练**（第 9 节）。只备份没演练过 = 没有备份。
- [ ] **日志有轮转**（journald 或 logrotate，第 10 节），确认磁盘不会被日志吃满。
- [ ] **VisionQA Canvas 未被塞进镜像/安装包**，只以反代方式对外（第 11 节）。
- [ ] **发布记录**：`/api/version` 返回的 `version` 与 `dist` 里 `index-*.js` 的 hash 与发布单一致。
- [ ] **生产密钥只存在于 `/etc/visionqa/env`**（0640 root:visionqa），仓库里、聊天记录里、镜像里都没有。

---

## 1. 事实基线（实测，别按想象改）

| 事实 | 值 | 出处 |
| --- | --- | --- |
| 服务进程 | **一个**：`node server/index.mjs` | `package.json` 的 `start` 脚本 |
| 监听 | `API_PORT`（默认 `8787`），地址写死 `127.0.0.1` | `server/index.mjs` 末行 |
| 端口环境变量名 | **`API_PORT`，没有 `VQ_PORT`** | `server/config.mjs` |
| 静态资源 | 同一进程直接托管 `dist`，未知路径回落 `dist/index.html` | `server/index.mjs` 的 `serveFile` |
| 构建 | `npx vite build` 产出 `dist/index.html` + `assets/index-*.js`（621 KiB ≈ 635 KB）+ `assets/index-*.css`（185 KiB ≈ 189 KB） | 2026-11-04 `dist` 实测 |
| 健康检查 | `GET /api/health` → `{ok, redfox, vision, visionModel, templates}` | `server/index.mjs` 第 97–100 行 |
| 版本接口 | `GET /api/version` → `{version, name, startedAt}` | 同上第 85–90 行 |
| 账号体系 | cookie 名固定 `vq_session`；接口 `/api/auth/{register,login,logout,me}` | `server/config.mjs` 的 `config.auth` |
| 数据 | `templates.json` / `flows.json` / `agents.json` / `runs.json` + `frames/` + `jobs/` + 账号库 `auth.db` | `data/` 实测 |
| 数据目录键 | `DATA_DIR`（默认 `<应用根>/data`） | `server/config.mjs` |
| VisionQA Canvas | 5312 后端 / 5313 后台 / 6677 网页入口，均只监听 `127.0.0.1` | `docs/visionqa-canvas-integration.md` |
| 依赖外部 | ffmpeg/ffprobe 用 `ffmpeg-static` / `ffprobe-static` 自带的二进制（82.8MB），**不需要系统装 ffmpeg** | `node_modules/ffmpeg-static` 实测 |
| 内存现状（开发机） | 总 15.8G，可用 **0.5G** | 2026-11-04 实测 |

---

## 2. 域名与 DNS

1. **先定域名再买机器**。本文统一用 `vq.example.com` 作占位符，所有配置里出现它的地方都要换成你的真实域名。
2. 加 **A 记录**指向服务器公网 IP；服务器有 IPv6 就再加 **AAAA**。TTL 先设 300，方便出错时快速改回。
3. **境内服务器必须完成 ICP 备案**才能用 80/443 对外；没备案就先别挂域名，用境外机器或先用 IP + 临时证书做内部验证。
4. 如果套 CDN（Cloudflare 之类）：**先把记录设成「仅 DNS / 灰云」签完证书**，再开代理。开着代理签 http-01 验证容易失败。
5. 验证解析生效再申请证书，Let's Encrypt 失败 5 次会临时封禁该域名：

```bash
dig +short vq.example.com
# 必须返回你服务器的 IP，且和下面一致：
curl -s https://api.ipify.org; echo
```

> 通配符证书（`*.example.com`）只在确实要多子域时才用，需要 DNS-01，配起来更麻烦。

---

## 3. 服务器准备

**规格**：4C8G / 100G SSD 起（依据见 `docs/server-sizing.md`：Node 常驻内存只有几十 MB，真正的开销是 ffmpeg 解码瞬间吃满单核 + 磁盘 IO）。**独立机器，不与其它生产服务混部**——一次复刻会吃满 1 核。

**系统**：Ubuntu 22.04 LTS。若 VisionQA Canvas 只能在 Windows 上跑，才考虑 Windows Server 2022（见 `docs/server-sizing.md` 第 5 节）。

一、建服务账号与目录：

```bash
sudo useradd -r -m -d /var/lib/visionqa -s /usr/sbin/nologin visionqa
sudo mkdir -p /opt/visionqa /var/lib/visionqa/data /var/log/visionqa
sudo chown -R visionqa:visionqa /var/lib/visionqa /var/log/visionqa
sudo chmod 750 /var/lib/visionqa/data
```

目录约定（后文全部按这个写）：

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `/opt/visionqa` | 代码：`server/` `dist/` `node_modules/` `package.json` | 属主 visionqa；运行时被 ProtectSystem 锁成只读，只有发布时才写 |
| `/var/lib/visionqa/data` | 全部运行时数据（`DATA_DIR`） | visionqa 可写 |
| `/etc/visionqa/env` | 环境变量与密钥 | `0640 root:visionqa` |
| `/var/log/visionqa` | 选配的文件日志 | visionqa 可写 |

二、装 Node（构建机与生产机都建议 22 LTS；仓库没写 `engines`，以 `npx vite build` 能成功为准）：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

三、防火墙（8787 不对公网，只放 22/80/443）：

```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable && sudo ufw status verbose
```

四、时区与时间同步（日志跨时区对齐全靠它）：

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true && timedatectl
```

---

## 4. 构建与发布

### 4.1 取代码

```bash
sudo -iu visionqa
cd /opt
git clone <你的仓库地址> visionqa-src   # 或 rsync 上传，见 4.4
```

**不要**把 `node_modules/`、`dist/`、`data/`、`.env` 从开发机拷上来——它们要么平台相关，要么是本地状态。

### 4.2 安装依赖

```bash
cd /opt/visionqa-src
npm ci
```

> **坑（实测）**：`ffmpeg-static` / `ffprobe-static` 会在 `npm ci` 阶段从 GitHub 下载二进制（约 83MB）。服务器出网受限时这一步会静默失败、直到第一次复刻才报「ffmpeg 不存在」。
> 应对：构建机上 `npm ci` 后把整个 `node_modules` 打包上传；或先手动验证 `node -e "console.log(require('ffmpeg-static'))"` 能打印出存在的路径。

### 4.3 构建前端

```bash
npx vite build
ls -lh dist dist/assets
```

预期产物：`dist/index.html` + `dist/assets/index-*.js`（约 621 KiB）+ `dist/assets/index-*.css`（约 185 KiB）+ 少量公共资源。

> `npm run build` 会先跑 `tsc -b`，类型不过就中断，构建产物也就不更新。发布以 `npx vite build` 的结果为准，类型检查放到 CI 或本地做——别在上线窗口里被类型报错卡住。

### 4.4 落到 `/opt/visionqa`

第一次部署：

```bash
sudo rsync -a --delete \
  --exclude node_modules --exclude data --exclude .env \
  /opt/visionqa-src/ /opt/visionqa/
sudo rsync -a /opt/visionqa-src/node_modules/ /opt/visionqa/node_modules/
sudo chown -R visionqa:visionqa /opt/visionqa
```

后续发布推荐用「版本目录 + 软链」（回滚就是换一个链接，见第 12 节）：

```bash
/opt/visionqa-releases/2026-11-04T1200/   # 每次发布一个新目录
/opt/visionqa -> /opt/visionqa-releases/2026-11-04T1200
```

**发布前自检**：`test -f /opt/visionqa/dist/index.html` 必须为真。`deploy/vq.service` 里已经用 `ExecStartPre` 挡了这种情况，避免起一个「只有 API、页面 404」的半成品。

---

## 5. 环境变量

唯一来源是 `/etc/visionqa/env`，由 systemd 的 `EnvironmentFile=` 注入。**不要**在服务器上用 `.env` 文件——`server/config.mjs` 会读 `<工作目录>/.env`，两处并存时谁生效取决于是否已存在同名环境变量，排查事故时会疯。

```bash
sudo install -d -m 0750 -o root -g visionqa /etc/visionqa
sudo install -m 0640 -o root -g visionqa \
  /opt/visionqa/deploy/env.production.example /etc/visionqa/env
sudo editor /etc/visionqa/env      # 逐项填真值
sudo chown root:visionqa /etc/visionqa/env && sudo chmod 0640 /etc/visionqa/env
```

**语法**：systemd 的 `EnvironmentFile` 不是 shell——一行一个 `KEY=VALUE`，不写 `export`、不加引号、不写行尾注释、不展开 `$VAR`。

生产必配的最小集合：

| 键 | 生产值 | 作用 / 为什么 |
| --- | --- | --- |
| `API_PORT` | `8787` | 监听端口。**没有 `VQ_PORT` 这个键** |
| `DATA_DIR` | `/var/lib/visionqa/data` | 数据 + 账号库落点，备份就备它 |
| `VQ_REQUIRE_AUTH` | `1` | `/api/*` 强制登录（`/api/auth/*`、`/api/health`、`/api/version` 除外） |
| `VQ_SECURE_COOKIES` | `1` | 会话 cookie 带 `Secure`，只在 HTTPS 下回传 |
| `VQ_DEMO_ACCOUNT` | `0` | 关闭演示账号种子，避免公开入口 |
| `VQ_DEMO_PASSWORD` | 留空 | 仅演示账号开启时读取；**永远不填真密码** |
| `VQ_REGISTRATION` | `0` | 关闭自助注册，先只给已有账号 |
| `VQ_SESSION_DAYS` / `VQ_REMEMBER_DAYS` | `7` / `30` | 会话有效期 / 记住我有效期（天） |
| `VISION_API_KEY` | 生产 key | 为空时开发版会回落读 `~/.codex/auth.json`，生产被 `ProtectHome=true` 掐断，所以必须显式给 |
| `VISION_BASE_URL` | `https://<网关>/v1` | 默认值指向开发机本地代理 `127.0.0.1:10100`，生产不可用 |
| `VISION_MODEL` / `VISION_FALLBACKS` | 网关里已开通的模型 | 主力 + 降级链 |
| `VISION_TIMEOUT_MS` | `300000` | 评审实测 60–85s，长视频更久，别调小 |
| `REDFOX_API_KEY` | 红狐 key | 为空时雷达显示「示例数据」并明确标注，不会假装真实数据 |
| `REDFOX_CACHE_TTL_MS` | `300000` | 红狐按次计费 + 有频控（抖音 10/s、小红书 20/s） |
| `MAX_VIDEO_MB` | `160` | 必须 ≤ 反代请求体上限（样例 200MB） |
| `MAX_FRAMES` | `18` | 每视频最多抽帧数 |
| `BDC_WEB_URL` / `BDC_ADMIN_URL` / `BDC_API_URL` | 对外时 `BDC_WEB_URL=https://bdc.example.com`，另两个留 `127.0.0.1` | 画布探活与 iframe 内嵌地址；**浏览器会直接用 `BDC_WEB_URL`**，写 127.0.0.1 客户就打不开（见 11.3） |

`VQ_REQUIRE_AUTH` / `VQ_SECURE_COOKIES` / `VQ_DEMO_ACCOUNT` / `VQ_REGISTRATION` 这四个开关不写就是「不安全」的那一侧（见第 0 节），所以这张表不是可选配置，是必须逐条落实的清单。

改完 `/etc/visionqa/env` 必须 `sudo systemctl restart vq`——`EnvironmentFile` 只在进程启动时读一次。

**校验权限**：`sudo stat -c '%a %U:%G' /etc/visionqa/env` 必须是 `640 root:visionqa`。

---

## 6. 启动与守护（systemd）

```bash
sudo install -m 0644 /opt/visionqa/deploy/vq.service /etc/systemd/system/vq.service
sudo systemctl daemon-reload
sudo systemctl enable --now vq
systemctl status vq --no-pager
journalctl -u vq -n 50 --no-pager
```

启动成功时日志里应该有一行（来自 `server/index.mjs`）：

```
[api] http://127.0.0.1:8787  redfox=on  vision=<模型名>
```

### 6.1 unit 里几个关键选择（都有理由，别随手改）

| 配置 | 值 | 为什么 |
| --- | --- | --- |
| `WorkingDirectory` | `/opt/visionqa` | `config.mjs` 用 `process.cwd()` 找 `.env` / `package.json` / `dist`，指错目录会「API 正常、页面 404」 |
| `EnvironmentFile` | `/etc/visionqa/env` | 全站唯一密钥来源 |
| `Restart=always` + `RestartSec=3` | — | 崩溃 / 被 OOM / 手工 kill 都会 3 秒后自动回来 |
| `StartLimitIntervalSec=0` | — | 无限重试。代价是配置本身错时会一直刷日志；想「试 5 次就停下等人看」就删掉这行 |
| `--max-old-space-size=1536` | 1536MB | **Node 堆**上限，不是整进程内存 |
| `MemoryMax=2G` | 2G | **整个 cgroup** 的硬上限。ffmpeg/ffprobe 是 `execFile` 起的子进程，也在这个 cgroup 里，所以要给 Node 堆之外再留 400–500MB |
| `CPUQuota=300%` | 3 核 | 4 核机上留 1 核给系统和反代，避免解码把机器拖到登录不上 |
| `ProtectHome=true` | — | **有意为之**：掐掉 `~/.codex/auth.json` 回落，模型 key 必须显式配置，不会静默借用开发机凭证 |
| `ReadWritePaths` | `/var/lib/visionqa /var/log/visionqa` | 除这两处外全系统只读；**这两个目录必须先存在**，否则服务会因为建不了 mount namespace 起不来；改了 `DATA_DIR` 要同步改这里 |

### 6.2 验证自启动

```bash
sudo reboot
# 等 1 分钟重新登录后
systemctl is-active vq
curl -s http://127.0.0.1:8787/api/health
```

---

## 7. 反向代理与证书

两条路选一条：**Caddy（推荐，自动 HTTPS）** 或 **nginx**。两者配置等价，安全头、压缩、超时、上传上限都对齐过。

### 7.1 Caddy（推荐）

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp /opt/visionqa/deploy/Caddyfile /etc/caddy/Caddyfile
sudo editor /etc/caddy/Caddyfile          # 改域名
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
journalctl -u caddy -n 50 --no-pager
```

Caddy 会自动：申请证书（首次约 10–30 秒）→ 配置 80→443 跳转 → 续期。验证：

```bash
curl -sI https://vq.example.com | head -20
```

必须看到 `strict-transport-security`、`x-content-type-options`、`referrer-policy` 三个头，且 `curl -I http://vq.example.com` 返回 301。

### 7.2 nginx（等价方案）

```bash
sudo apt-get install -y nginx certbot
sudo mkdir -p /var/www/certbot

# 第 1 段（http 上下文）→ 单独一个 conf.d 文件；第 2 段（80 端口）→ vq.conf
sudo cp /opt/visionqa/deploy/nginx.conf /etc/nginx/conf.d/vq.conf   # 按文件内注释拆分三段
sudo nginx -t && sudo systemctl reload nginx

# 拿证书（先只有 80 端口那段）
sudo certbot certonly --webroot -w /var/www/certbot -d vq.example.com

# 加 443 那段后再测
sudo nginx -t && sudo systemctl reload nginx
```

证书续期由 `certbot.timer` 自动完成：`systemctl list-timers | grep certbot` 能看到下次执行时间。

### 7.3 反代层的四个关键参数（两套配置都设了）

| 参数 | 值 | 为什么是这个值 |
| --- | --- | --- |
| 读超时 | `300s` | 复刻实测 90–180s、视觉评审 60–85s、智能体 20–50s；默认的 60s 会把长任务掐成 502 |
| 请求体上限 | `200MB` | 大于后端 `MAX_VIDEO_MB=160`，给 multipart 开销留余量；反过来会得到反代层 413，界面只显示「请求失败」 |
| 安全头 | HSTS / nosniff / Referrer-Policy / X-Frame-Options / Permissions-Policy | 见配置注释；**HSTS 的 `includeSubDomains` 只在所有子域都上了 HTTPS 时才开** |
| 压缩 | zstd + gzip（Caddy）/ gzip（nginx） | 前端是 621 KiB JS + 185 KiB CSS 的文本资源，压缩收益明显 |

> nginx 陷阱：只要某个 `location` 里写了 `add_header`，`server` 级的 `add_header` 就全部失效。要在那个 location 里把安全头重写一遍。

> **X-Forwarded-For 别照抄默认写法**：后端用 `X-Forwarded-For` 的第一个值做登录失败限流（`server/auth.mjs` 的 `clientIp`）。nginx 的 `$proxy_add_x_forwarded_for` 会**保留客户端自己伪造的头**，攻击者换个假 IP 就能绕开限流，所以 `deploy/nginx.conf` 里用的是 `$remote_addr`。Caddy 默认就会用自己的对端地址覆盖，无需额外配置。
>
> 这条能成立还有一个前提，值得说清因果：**Node 只监听 `127.0.0.1`，外部根本连不到它**，所以任何请求都必然经过反代这一跳，「信任反代写的对端地址」才是安全的。反过来说，一旦你为了让某个工具直连而把监听地址改成 `0.0.0.0`（或加了端口映射），客户端就能绕过反代直接发请求，并自己伪造 `X-Forwarded-For`——限流、访问日志里的 IP、反代上的 IP 白名单会同时失效。**监听回环是这些安全措施的地基，不要改动它。**

---

## 8. 健康检查

### 8.1 三层检查

```bash
# 1) 进程与本地端口
systemctl is-active vq
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/health

# 2) 依赖状态（真正该看的）
curl -s http://127.0.0.1:8787/api/health | python3 -m json.tool

# 3) 经过反代的公网链路
curl -s https://vq.example.com/api/health
```

返回形如：

```json
{"ok":true,"redfox":true,"vision":true,"visionModel":"<模型名>","templates":<模板条数>}
```

| 字段 | 含义 | 异常时的意思 |
| --- | --- | --- |
| `ok` | 进程能应答 | `ok:false` 或连不上 = 进程挂了，看 `journalctl -u vq` |
| `redfox` | `REDFOX_API_KEY` 是否已配置 | `false`：雷达会显示示例数据（界面有标注），不是崩溃 |
| `vision` | 模型凭证是否可用 | `false`：复刻的视觉分析、智能体对话、流程执行都会报「未配置模型凭证」 |
| `visionModel` | 当前主力模型名 | 与发布单不一致时说明 env 没生效（改完没有 restart） |
| `templates` | 模板库条数 | 恢复备份后用它核对条数是否回到备份前 |

### 8.2 常驻监控（脚本 + cron，不依赖云监控）

```bash
sudo tee /usr/local/bin/vq-healthcheck.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
URL=http://127.0.0.1:8787/api/health

body=$(curl -fsS --max-time 5 "$URL" 2>/dev/null) || {
  echo "[$(date -Is)] DOWN: 无响应 $URL" >&2
  exit 1
}

echo "$body" | grep -q '"ok":true' || { echo "[$(date -Is)] BAD: $body" >&2; exit 1; }
echo "$body" | grep -q '"vision":true' || echo "[$(date -Is)] WARN: vision 未配置（复刻/评审不可用）" >&2
echo "$body" | grep -q '"redfox":true' || echo "[$(date -Is)] WARN: redfox 未配置（雷达只有示例数据）" >&2
EOF
sudo chmod 0755 /usr/local/bin/vq-healthcheck.sh

# 每 2 分钟跑一次，失败写日志（有告警通道再挂 webhook/邮件）
sudo tee /etc/cron.d/vq-health >/dev/null <<'EOF'
*/2 * * * * root /usr/local/bin/vq-healthcheck.sh >> /var/log/visionqa/health.log 2>&1
EOF
```

> 注意：健康检查只证明「进程活着 + 依赖配置齐」。它**不证明**业务正确——发布后仍需用真实账号走一遍登录 → 雷达搜索 → 复刻 → 模板库 → 画布。

---

## 9. 备份与恢复

### 9.1 备什么

| 路径 | 内容 | 必须备 | 说明 |
| --- | --- | --- | --- |
| `$DATA_DIR/auth.db` | 账号库（SQLite） | ✅ | 丢了等于所有用户要重注册 |
| `$DATA_DIR/*.json` | `templates.json` `flows.json` `agents.json` `runs.json` | ✅ | 每次全量读写，一个坏文件就丢一类数据 |
| `$DATA_DIR/frames/` | 抽帧图片 | ✅ | 体积小（22KB/张），模板详情页直接引用 |
| `$DATA_DIR/jobs/` | 复刻过程临时文件 | ❌ | 成功后会自动删；半成品没有恢复价值 |
| `/etc/visionqa/env` | 密钥 | ✅（离线保管） | 不入对象存储、不进 git，用密码管理器另存 |
| `/opt/visionqa` | 代码 | ⚠️ | 有 git 就不必备；但发布目录要能回溯版本 |

### 9.2 备份脚本

```bash
sudo tee /usr/local/bin/vq-backup.sh >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DATA_DIR=/var/lib/visionqa/data
DEST=/var/backups/visionqa
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"

# 1) SQLite 账号库：必须用 .backup，不能直接 cp（正在写的库会拿到半截内容）
if [ -f "$DATA_DIR/auth.db" ]; then
  sqlite3 "$DATA_DIR/auth.db" ".backup '$DEST/auth-$STAMP.db'"
fi

# 2) JSON 库 + 帧图（jobs/ 与日志不备）
cd "$DATA_DIR"
ITEMS=$(ls -1 *.json 2>/dev/null || true)
if [ -d frames ]; then ITEMS="$ITEMS frames"; fi
if [ -n "$ITEMS" ]; then
  tar -czf "$DEST/data-$STAMP.tgz" $ITEMS
fi

# 3) 保留 14 天
find "$DEST" -type f -mtime +14 -delete
echo "[$STAMP] backup ok -> $DEST"
EOF
sudo chmod 0700 /usr/local/bin/vq-backup.sh
sudo apt-get install -y sqlite3          # 脚本依赖 sqlite3 命令
sudo /usr/local/bin/vq-backup.sh         # 先手工跑一次，确认没报错（脚本以 root 跑）
```

每天 03:30 跑（夜间低峰；注意别和 VisionQA Canvas 的清理任务撞）：

```bash
sudo tee /etc/cron.d/vq-backup >/dev/null <<'EOF'
30 3 * * * root /usr/local/bin/vq-backup.sh >> /var/log/visionqa/backup.log 2>&1
EOF
```

### 9.3 异机保存（必须做）

同机备份挡不住「盘挂了 / 机器被格式化」。目标是最小 3-2-1：3 份副本、2 种介质、1 份异地。

```bash
# 用 rclone 推到对象存储（先 rclone config 配一个 remote）
rclone copy /var/backups/visionqa oss:my-bucket/visionqa-backup/ --max-age 48h
```

推上去之前确认：**备份里没有明文密钥**（脚本只打 `data`，不包含 `/etc/visionqa/env`，这是故意的）。

### 9.4 恢复演练（上线前必须做一次）

```bash
sudo systemctl stop vq
sudo mv /var/lib/visionqa/data /var/lib/visionqa/data.broken
sudo mkdir -p /var/lib/visionqa/data
sudo tar -xzf /var/backups/visionqa/data-<时间戳>.tgz -C /var/lib/visionqa/data
# 有 auth.db 时再单独放回去：
# sudo cp /var/backups/visionqa/auth-<时间戳>.db /var/lib/visionqa/data/auth.db
sudo chown -R visionqa:visionqa /var/lib/visionqa/data
sudo systemctl start vq
curl -s http://127.0.0.1:8787/api/health
```

验收标准：`templates` 的条数与备份前**一致**；用真实账号能登录；模板库与运行记录页面能看到数据。演练完记得删掉 `data.broken`。

---

## 10. 日志

### 10.1 应用日志（systemd / journald，默认方案）

```bash
journalctl -u vq -f                          # 实时
journalctl -u vq --since '1 hour ago' --no-pager
journalctl -u vq -p err --since today        # 只看错误
```

限制 journald 占用，别让日志吃满盘：

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/vq.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=2G
MaxRetentionSec=30day
EOF
sudo systemctl restart systemd-journald
```

### 10.2 想落文件时（选配，必须同时配 logrotate）

`deploy/vq.service` 里的 `StandardOutput=append:/var/log/visionqa/vq.log` 不会自动轮转。打开它就必须加：

```bash
sudo tee /etc/logrotate.d/visionqa >/dev/null <<'EOF'
/var/log/visionqa/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
sudo logrotate -d /etc/logrotate.d/visionqa    # 干跑验证语法
```

### 10.3 应用自己记了什么（实际情况，别期待更多）

- 启动时一行 `[api] http://127.0.0.1:8787 redfox=... vision=...`。
- 业务异常不写文件，只作为 HTTP 500 的响应体返回（`{"error": "..."}`）；所以**排查用户报错要靠反代访问日志 + 复现**。
- **复刻过程日志存在内存里**（`server/jobs.mjs` 的 `jobs` Map，最多 40 条，`Restart` 后全丢）。要留痕就看 `data/runs.json`（画布/流程运行记录落盘）。
- 前端版本不匹配看 `/api/version` 的 `version` 与 `startedAt`。

### 10.4 反代日志

- Caddy：`/var/log/caddy/vq-access.log`（JSON，50MiB × 10 份，保留 14 天，已在 Caddyfile 里配好）。
- nginx：`/var/log/nginx/vq-access.log`（JSON，用 `log_format vq_json`），轮转由系统自带的 `/etc/logrotate.d/nginx` 负责。

常用排查：

```bash
sudo jq -r 'select(.status >= 500) | "\(.ts) \(.status) \(.request.uri)"' /var/log/caddy/vq-access.log | tail -20
```

---

## 11. VisionQA Canvas：独立进程与许可证边界（最容易踩线的一节）

### 11.1 事实

- BD Canvas 是**独立部署的 Source-Available 项目**，代码**不在本仓库**里，也不随本仓库分发。
- 三个端口都只监听 `127.0.0.1`：**5312** 后端 API、**5313** 后台管理、**6677** 网页入口。
- 本仓库只做两件事：`/api/bdc/status` 探活（结果给后台版「系统」页看）、画布页用 iframe 内嵌 `6677`。

### 11.2 许可证允许与禁止（Source-Available License v1.0）

| 可以做 | 不可以做 |
| --- | --- |
| 自己用、自己改 | 以任何形式**再分发源码或修改版**（免费送也不行） |
| 商用 | 打包进镜像 / 安装包 / 交付物给客户 |
| 部署在自己的服务器上，给自己的客户通过浏览器使用 | 做 SaaS 转售（把它的能力当独立产品卖给别人） |

**落地成三条操作规则**：
1. 客户只会拿到**浏览器里的一个地址**，永远不接触源码、安装包、后台管理端口。
2. 镜像与发布包里不得出现 VisionQA Canvas 的任何文件；发布流程里加一步 `git status --short` + 目录扫描确认没混进去。
3. 合同/报价里写「服务提供，不含源码交付」，不要写「提供 BD Canvas」。

### 11.3 要对外时的反代方式

只反代**网页入口 6677**，并且加一层门锁（Basic Auth 或 IP 白名单）。5313 后台只在需要管理时临时开、用完关；5312 永不对外。

Caddy 片段（放在主站块之外，单独的站点）：

```caddyfile
bdc.example.com {
	encode zstd gzip

	# 只允许团队出口 IP 访问（比口令更省事的首选）
	@bad not remote_ip 203.0.113.0/24
	respond @bad "forbidden" 403

	basic_auth {
		team $2a$14$用 caddy hash-password 生成的哈希
	}

	request_body {
		max_size 500MB          # VisionQA Canvas 出视频，给大一点
	}

	reverse_proxy 127.0.0.1:6677 {
		transport http {
			dial_timeout 5s
			response_header_timeout 600s   # 出视频可能很久
		}
	}
}
```

> **坑（很容易到客户机器上才炸）**：画布页内嵌的是 `/api/bdc/status` 返回的 `web.url`，也就是 `BDC_WEB_URL`（`src/pages/CanvasPage.tsx` 里 `<iframe src={bdc.web.url}>`）。
> 如果在 `/etc/visionqa/env` 里保持默认的 `http://127.0.0.1:6677`，**客户浏览器会把 127.0.0.1 解析成他自己的电脑**，iframe 直接打不开——服务器上一切正常，只有客户端是坏的。
> 对外时把 `BDC_WEB_URL` 改成浏览器可达的地址（如 `https://bdc.example.com`），并让那个站点允许被主站嵌入：

```caddyfile
bdc.example.com {
	# 允许主站用 iframe 嵌入。VisionQA Canvas 自己若发 X-Frame-Options: SAMEORIGIN，
	# 必须用 -X-Frame-Options 删掉，否则跨域 iframe 一定被拦（改 CSP 不够）。
	header {
		Content-Security-Policy "frame-ancestors https://vq.example.com"
		-X-Frame-Options
	}
	# ...其余反代配置同上
}
```

> 另一个选择是让 VisionQA Canvas 开在独立标签页（页面里已经有「新窗口」按钮，指向同一个 `bdc.web.url`），主站不做 iframe 内嵌。内测阶段这样最省事，也顺带绕开所有跨域头问题。

---

## 12. 升级与回滚

推荐布局（发布即换软链，回滚是原子的）：

```
/opt/visionqa-releases/
  2026-11-04T1200/
  2026-11-10T0930/
/opt/visionqa -> /opt/visionqa-releases/2026-11-04T1200
```

升级步骤：

```bash
# 1) 备份数据（最坏情况也能回来）
sudo /usr/local/bin/vq-backup.sh

# 2) 新版本落到新目录
sudo rsync -a --exclude node_modules --exclude data --exclude .env \
  /opt/visionqa-src/ /opt/visionqa-releases/2026-11-10T0930/
sudo chown -R visionqa:visionqa /opt/visionqa-releases/2026-11-10T0930
cd /opt/visionqa-releases/2026-11-10T0930
sudo -u visionqa npm ci && sudo -u visionqa npx vite build

# 3) 切换 + 重启
sudo ln -sfn /opt/visionqa-releases/2026-11-10T0930 /opt/visionqa
sudo systemctl restart vq
sleep 2
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/version
```

回滚（1 条命令）：

```bash
sudo ln -sfn /opt/visionqa-releases/2026-11-04T1200 /opt/visionqa
sudo systemctl restart vq
curl -s http://127.0.0.1:8787/api/health
```

> 数据库结构变更（比如以后从 JSON 换 SQLite）**不能只靠换软链回滚**：先备份、先看迁移是否可逆，再动生产。当前账号库 `auth.db` 只有一个版本，改动前必做备份。

---

## 13. 排障速查

| 现象 | 最可能的原因 | 动作 |
| --- | --- | --- |
| 502 / 504 | Node 没起、或长任务超过反代读超时 | `systemctl status vq`；把 `response_header_timeout` / `proxy_read_timeout` 确认是 300s |
| 服务过一会儿自己没了，日志里有 `Killed` | 撞了 `MemoryMax` 或宿主 OOM | 看 `journalctl -u vq -n 200` 找 `oom-kill`；调低并发、必要时上调 `MemoryMax` 并确认机器余量 |
| 页面白屏，但 `/api/health` 正常 | `dist` 缺失或不是这次构建的 | `ls -l /opt/visionqa/dist/index.html`；unit 的 `ExecStartPre` 应让这种服务起不来 |
| 登录成功但一刷新就掉线 | `VQ_SECURE_COOKIES=1` 但站点走的是 http，或反代没传 `X-Forwarded-Proto` | 确认 80 已全量跳 443；反代带 `X-Forwarded-Proto $scheme` |
| 所有 `/api/*` 都 401 | `VQ_REQUIRE_AUTH=1` 生效但 cookie 没带上（域名不一致 / 反代丢了 Cookie 头） | 浏览器开发者工具看请求是否带 `vq_session`；确认访问域名与签发时一致 |
| 雷达全是示例数据 | `REDFOX_API_KEY` 为空，或红狐返回 3105（key 被禁用）/ 积分不足 | `curl -s http://127.0.0.1:8787/api/health` 看 `redfox`；查红狐后台 |
| 复刻报「未配置模型凭证」 | `VISION_API_KEY` 为空（生产被 `ProtectHome=true` 掐掉了 `~/.codex/auth.json` 回落） | 补 `VISION_API_KEY` 后 `systemctl restart vq` |
| 复刻一直卡住 / 很慢 | 多个复刻同时在跑，ffmpeg 抢 CPU | 本机限 2 个同时；`top` 看 `ffmpeg` 占用 |
| 上传大视频立刻失败 | 反代请求体上限小于文件体积 | 调 `request_body max_size` / `client_max_body_size`，且 ≥ `MAX_VIDEO_MB` |
| 证书申请失败 | DNS 未生效 / 80 被占 / 该域名失败次数过多被限流 | `dig` 确认解析；`ss -lntp` 看 80 是否被别的服务占用；换个时间重试 |
| 修改 env 后不生效 | `EnvironmentFile` 只在启动时读 | `sudo systemctl restart vq` |

---

## 14. 上线前还差什么（代码层面，不改代码就要用运维手段兜）

1. **复刻没有并发上限**。`server/jobs.mjs` 的 `startReplicate` 每次调用直接起 pipeline，`MAX_JOBS=40` 只是清理历史记录、不排队；每次复刻会 `execFile` 起 ffmpeg 全片解码，镜头检测那步**吃满 1 核**。
   → 4C8G 机器上**同时复刻控制在 2 个以内**（依据：解码占 1 核 + Node/视觉调用往返，留 1 核给系统和反代），超出的请求靠人约定或反代 `limit_req` 挡住。要根治得加任务队列。
2. **JSON 存储不是事务**。`templates.json` / `runs.json` / `flows.json` / `agents.json` 每写一次全量读写，多人并发写会互相覆盖。
   → 内测（<5 人同时操作）够用；**写入频率 > 5 req/s 或单文件 > 50MB 时换 SQLite + WAL**（账号库已经是 SQLite）。
3. **单机无冗余**。工作台 + VisionQA Canvas 同机，机器挂了一锅端；没有健康检查自动摘流量的能力。
   → 对外承诺可用性前，先接受「单机维护窗口」；要谈 SLA 就得上第二台 + 负载均衡 + 共享存储。
4. **原始视频留在本地盘**。`MAX_VIDEO_MB=160`，1000 条就是 160GB。
   → 视频转对象存储 + 签名 URL，本机只留帧图（帧图 22KB/张，1000 条模板约 0.7GB）。
5. **账号体系还没有找回密码**。契约只有 `register/login/logout/me`。
   → 丢密码只能管理员改库；对外放号前要想清楚这条。
6. **没有 WAF / 风控**。只有反代层可选的 `limit_req`。
   → 内测阶段用 IP 白名单最省事；公开后要加登录失败限流（后端已对登录做 429，但仍建议反代层再挡一层）。

---

## 附录 A：为什么不能在开发机上跑生产（实测依据）

- 开发机总内存 15.8G，**当前可用只剩 0.5G**（2026-11-04 实测）。
- 一次复刻的流程是：下载/上传视频（≤160MB）→ `ffprobe` 探元数据 → `ffmpeg` **全片解码**做镜头检测 → 抽 18 帧 → 逐帧调视觉模型（60–85s）。
- 其中「全片解码」会吃满一个核并推高内存，在只剩 0.5G 的机器上会被系统 OOM killer 直接杀掉 Node 进程，现象是**服务无声消失、日志里没有应用层报错**。
- 结论：生产必须独立机器；本机只用于开发与验收截图。

## 附录 B：新机 20 分钟命令序列（密集版）

```bash
# 0) 前置：DNS 已指向本机；安全组放行 22/80/443
sudo useradd -r -m -d /var/lib/visionqa -s /usr/sbin/nologin visionqa
sudo mkdir -p /opt/visionqa /var/lib/visionqa/data /var/log/visionqa
sudo chown -R visionqa:visionqa /var/lib/visionqa /var/log/visionqa

# 1) Node 22 + 取代码 + 构建
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
sudo git clone <仓库地址> /opt/visionqa-src && cd /opt/visionqa-src
sudo npm ci && sudo npx vite build
sudo rsync -a --exclude node_modules --exclude data /opt/visionqa-src/ /opt/visionqa/
sudo rsync -a /opt/visionqa-src/node_modules/ /opt/visionqa/node_modules/
sudo chown -R visionqa:visionqa /opt/visionqa

# 2) 环境变量
sudo install -d -m 0750 -o root -g visionqa /etc/visionqa
sudo install -m 0640 -o root -g visionqa /opt/visionqa/deploy/env.production.example /etc/visionqa/env
sudo editor /etc/visionqa/env            # 填真值：VQ_* 三件套 + VISION_* + REDFOX_*

# 3) 守护
sudo install -m 0644 /opt/visionqa/deploy/vq.service /etc/systemd/system/vq.service
sudo systemctl daemon-reload && sudo systemctl enable --now vq
curl -s http://127.0.0.1:8787/api/health

# 4) 反代 + HTTPS
sudo apt-get install -y caddy
sudo cp /opt/visionqa/deploy/Caddyfile /etc/caddy/Caddyfile && sudo editor /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -sI https://vq.example.com | head

# 5) 备份 + 监控
sudo /usr/local/bin/vq-backup.sh         # 先按第 9 节安装脚本
sudo /usr/local/bin/vq-healthcheck.sh    # 先按第 8 节安装脚本
```
