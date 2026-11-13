# 生产部署（阿里云轻量 2C2G）

目标：`https://VisionQA.wavisionai.cn`，与现有 `wavisionai.cn` 官网**共存**，不动它的 nginx 站点。

## 现状（实测 2026-11-05）

| 项 | 值 |
| --- | --- |
| 实例 | OpenClaw-uija · 38afd3f7… · 华东2（上海） |
| 规格 | 2 vCPU / 2 GiB / ESSD 40 GiB |
| 已用内存 | **1.09 GiB / 2 GiB**（OpenClaw 网关 + 宝塔） |
| 已用磁盘 | 23.52 GiB / 40 GiB |
| 80 / 443 | 已被 nginx 占用，`wavisionai.cn` 官网在线 |
| 带宽 | 峰值 200 Mbps 型（流量包计费，不是 1Mbps 固定） |

本工作台常驻内存约 **120 MB**（Node 单进程 + 384 MB 堆上限），VisionQA Canvas 三个进程另算（Python 两个共 120 MB，
网页入口不要再起 Vite，交给 nginx 发静态）。2 GiB 内存够用，但**必须分页（swap）兜底**，见下。

## 一次性准备

```bash
# 1) 2GB 内存加 1GB swap，防止并发高峰 OOM 直接杀进程
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 2) 部署
DOMAIN=VisionQA.wavisionai.cn bash deploy/production/install.sh
```

脚本是幂等的，做七件事：装依赖 → 装 Node 22（npmmirror 优先）→ 建 `visionqa` 用户 →
`git clone` + `npm ci` + `npm run build` → 写 `.env`（Key 留空）→ systemd（`--max-old-space-size=384`）→
写 nginx vhost 并 reload。

## HTTPS

服务器上已有 nginx 与 `wavisionai.cn` 的证书。二选一：

- **宝塔面板**（服务器上已装）：网站 → 添加站点 `VisionQA.wavisionai.cn` → 申请 Let's Encrypt → 把
  `deploy/production/nginx-visionqa.conf` 的内容并进去。
- **acme.sh**：
  ```bash
  curl https://get.acme.sh | sh -s email=ops@example.com
  ~/.acme.sh/acme.sh --issue -d VisionQA.wavisionai.cn -w /opt/visionqa/dist
  ~/.acme.sh/acme.sh --install-cert -d VisionQA.wavisionai.cn \
    --key-file /etc/nginx/ssl/visionqa.key \
    --fullchain-file /etc/nginx/ssl/visionqa.crt \
    --reloadcmd "nginx -s reload"
  ```
  然后在 vhost 里加 `listen 443 ssl;` 与证书路径，并把 80 的 server 改成 301 跳转。

拿到证书后把 `.env` 里的 `VQ_SECURE_COOKIES` 保持为 `1`（只有 HTTPS 能登录）。

## 必须自己填的一项

`.env` 里的模型配置现在是空的。**服务器访问不到你本机的 `127.0.0.1:10100`**，必须换成公网可用的地址：

```bash
VISION_BASE_URL=https://<你的中转站>/v1
VISION_MODEL=<模型名>
VISION_API_KEY=<key>
```

填完 `systemctl restart visionqa`，然后 `curl http://127.0.0.1:8787/api/health` 应返回 `"vision":true`。

## 验收

```bash
curl -fsS http://127.0.0.1:8787/api/health        # 本机
curl -I https://VisionQA.wavisionai.cn/           # 外网 200
```
再用浏览器登录一次（`VQ_REQUIRE_AUTH=1` 时只有一个引导账号；加人用 `npm run adduser -- --email … --password …`）。

## 回滚

```bash
systemctl disable --now visionqa
rm -f /www/server/panel/vhost/nginx/VisionQA.wavisionai.cn.conf   # 或 /etc/nginx/conf.d/
nginx -t && nginx -s reload
```
数据都在 `/var/lib/visionqa`，删目录前先备份 `templates.json` 与 `frames/`。

## 数据备份（v0.9.49）

安装/更新定时任务（幂等；第一次会生成口令文件）：

```bash
cd /opt/visionqa && bash deploy/production/install-backup.sh
```

- 归档：`/var/backups/visionqa/visionqa-<时间>.tgz.enc`（+ `.sha256`），默认留 14 份。
- 口令：`/etc/visionqa/backup.key`（`root:visionqa 0640`，目录 `0750`）。**它不在备份里**——丢了就打不开归档，务必另存一份到口令管理器。
- 手动跑一次并看结果：

```bash
systemctl start visionqa-backup.service
journalctl -u visionqa-backup.service -n 30 --no-pager   # 一行 JSON：encrypted / verify / offsite
```

- 异地副本：有第二块盘或另一台机器时，在 unit 里打开
  `Environment=VQ_BACKUP_OFFSITE=/mnt/vq-backups` 再 `systemctl daemon-reload`。
  复制后会按 sha256 校验；写不进去退出码 4。
- 恢复演练（另起一个进程，不碰线上目录）：

```bash
/usr/local/bin/node --experimental-sqlite scripts/restore-backup.mjs \
  /var/backups/visionqa/visionqa-<时间>.tgz.enc \
  --target /tmp/vq-restore --passphrase-file /etc/visionqa/backup.key
```

真恢复时：停服务 → 把 `/var/lib/visionqa` 改名留档 → 用上面的命令还原到 `/var/lib/visionqa`
→ `chown -R visionqa:visionqa` → 起服务 → 验账号、模板、Key。

注意：prod 的 `/usr/bin/node` 不带 `node:sqlite`，必须用 `/usr/local/bin/node`（unit 里已经写好）。

## 邀请码（v0.9.50）

注册全局关闭（`VQ_REGISTRATION=0`）时，内测放号走邀请码，不用管理员在线建号。

1. 后台「账号 → 邀请码」：填可用次数 / 有效天数 / 赠送积分 / 备注 → 签发。
2. 签完当场复制注册链接，形如：

```
https://<域名>/#/register?code=VQ-XXXX-XXXX
```

3. 对方打开即进注册页、邀请码已预填；提交后直接登录，赠送积分在账本里单独记 `invite`。
4. 没用完的码可以随时在后台撤销，撤销后立即失效（HTTP 410）。

环境变量（都有默认值，一般不用写）：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `VQ_INVITE_CREDITS` | 100 | 每枚码默认赠送积分 |
| `VQ_INVITE_DAYS` | 7 | 默认有效期（天） |
| `VQ_INVITE_USES` | 1 | 默认可用次数 |
| `VQ_INVITE_IP_LIMIT` | 3 | 同一来源 24h 内最多开几个邀请号 |

注意：

- 码就是凭证，一人一码更安全；不要把手里的可用码发到公开频道。
- 目前**没有邮件通道**，链接需要手动发给受邀人（等 A5 SMTP 接入后可自动发送）。
- 反滥用只到来源计数：同一 NAT 出口的同事共享 3 个名额。
- 赠送积分在注册时到账；「首次成功任务后解锁」与新账号 24h 复刻并发限制还没做。
- 核查接口：`GET /api/admin/invites`（管理员 cookie），返回状态、已用/上限与最近使用者。

## 画布下载补丁（2026-11-13）

画布（BD Canvas）把 `canvas.wavisionai.cn` 当「本机安装」，下载会把文件存到**服务器**；
改走浏览器下载后又要过 nginx 的 Basic Auth。补丁脚本在仓库 `deploy/bd-canvas/patch-download-credentials.mjs`：

```bash
scp deploy/bd-canvas/patch-download-credentials.mjs root@<host>:/tmp/
ssh root@<host> "node /tmp/patch-download-credentials.mjs --root /opt/bdcanvas --check"   # 1 = 未打
ssh root@<host> "node /tmp/patch-download-credentials.mjs --root /opt/bdcanvas --write"   # 首次留 .bak-vq-download
```

- 画布由 Vite dev 直接读源码，**刷新画布页面即生效**，不需要重新构建；
- 画布升级覆盖 `src/main.ts` 后重跑一次；`--check` 退出码 1 就表示没打上；
- 回滚：`cp /opt/bdcanvas/src/main.ts.bak-vq-download /opt/bdcanvas/src/main.ts`。

## 告警外推通道（2026-11-13，v0.9.53）

通道在后台「系统 → 告警 → 外推通道」直接配，地址与签名密钥落在数据目录 `alert-channel.json`（0600），**不用改 .env、不用重启**。
环境变量 `VQ_ALERT_WEBHOOK` 只作兜底（后台没配时用它），`VQ_ALERT_SECRET` 给环境变量通道加签名。

```bash
# 看当前通道（只回掩码）、投递计数与待重试条目
curl -s -H "Cookie: $SESSION" http://127.0.0.1:8799/api/admin/alerts | head -c 600
# 自检：记一条测试告警，并等这次外推的结果（notify.status / ms）
curl -s -X POST -H "Cookie: $SESSION" http://127.0.0.1:8799/api/admin/alerts/test -d '{}'
```

- 推失败进 `alert-outbox.json`，按 1 / 5 / 15 分钟退避重试，四次仍失败标 `dead`，后台可手动补发；
- 签名头 `x-vq-signature: sha256=<HMAC-SHA256(密钥, 请求体原文)>`，密钥只在保存通道那一次回明文；
- 回滚：后台「清掉通道」即回到环境变量；两个数据文件（`alert-channel.json` / `alert-outbox.json`）删掉即回到「没有通道、没有待重试」。

## 邮件通道与找回密码（2026-11-13，v0.9.54）

后台「系统 → 邮件通道」直接填 SMTP，保存即可生效，**不用改 .env、不用重启**。环境变量只是兜底：
`VQ_SMTP_HOST` / `VQ_SMTP_PORT` / `VQ_SMTP_SECURE=1`（直连 TLS 465）/ `VQ_SMTP_STARTTLS=0`（关掉 STARTTLS）/ `VQ_SMTP_USER` / `VQ_SMTP_PASS` / `VQ_SMTP_FROM` / `VQ_SMTP_FROM_NAME`。

自检（把 cookie 换成管理员会话）：

```sh
BASE=https://visionqa.wavisionai.cn
COOKIE='vq_session=…'

# 现在的通道（口令只回「有没有」，账号是掩码）
curl -s -H "cookie: $COOKIE" $BASE/api/admin/mail

# 保存一条通道（口令留空 = 沿用旧口令；这里示例是 465 直连 TLS）
curl -s -X PUT -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"host":"smtp.example.com","port":465,"secure":true,"user":"bot","pass":"换成真实口令","fromName":"VisionQA","fromAddress":"发件地址"}' \
  $BASE/api/admin/mail/channel

# 真的发一封，等 SMTP 的结果
curl -s -X POST -H "cookie: $COOKIE" -H 'content-type: application/json' -d '{}' $BASE/api/admin/mail/test

# 清掉后台配置（回落到环境变量；都没有就关闭自助找回）
curl -s -X DELETE -H "cookie: $COOKIE" $BASE/api/admin/mail/channel
```

行为约定：

- 登录页「忘记密码」是否出现，由 `GET /api/auth/config` 的 `passwordReset` 决定；没配通道时不摆死入口。
- 链接是**一次性**、**30 分钟**有效（`VQ_RESET_TTL_MINUTES` 可调 5–120）；申请新的会让旧链接立即失效。
- 改完口令会注销这个账号的全部会话（返回 `signedOut` 数）。
- 限流：同一邮箱 3 次/小时、同一来源 10 次/小时（进程内，重启清零）。
- 发信失败只进日志（`mail-failed`）与后台审计，不会主动告警；邮件在后台发，「申请成功」只表示已排队。

回滚：`/opt/visionqa/ops/rollback.sh`。只想关掉找回就「清掉通道」。


## 生成通道的幂等键（2026-11-13，v0.9.56）

画布走平台生成通道时，SeeAPI 的**同步出图是计费请求**，必须带 `Idempotency-Key`。画布本身在请求头里带了（它直连 SeeAPI 就是这个写法），平台现在把这个头透传上去；调用方没带时，先看正文 `idempotency_key`，再没有就补 `vq-<uuid>`；方舟（Ark）不发这个头。

- 同一次请求换下一把 Key 重试时沿用同一个幂等键：同一次生成不会在上游被扣两次。
- 上游回 `502/503/504 + provider_submit_outcome_unknown`（接了单但没确认结果）：只拿同一个键重放一次，**不换 Key**（换一把就是新的一次提交）；仍然不明就回 `UPSTREAM_OUTCOME_UNKNOWN`，等一会儿再看，不要重复点生成。
- 上游拒绝时回包固定带 `upstreamStatus` 与 `upstreamCode`，例如 `invalid_idempotency_key`，照着 code 修，不要再从「凭证无效」猜。

自检（本机假上游，不消耗上游额度）：

```sh
# 1) 起个假 SeeAPI：要求幂等键，收到就回 200
mkdir -p /tmp/r67 && cat > /tmp/r67/sink.mjs <<'EOF'
import http from 'node:http'
http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    console.log(JSON.stringify({ url: req.url, idem: req.headers['idempotency-key'] || '', body }))
    if (!req.headers['idempotency-key']) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { code: 'invalid_idempotency_key', message: 'Idempotency-Key is required for synchronous billable requests.' } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ url: 'https://example.invalid/canary.png' }] }))
  })
}).listen(2588, '127.0.0.1', () => console.log('sink ready'))
EOF
node /tmp/r67/sink.mjs > /tmp/r67/sink.log 2>&1 &

# 2) 后台加一把只认 canary 模型、指向假上游的临时 Key（贴 key 时地址里带 seeapi 就按 SeeAPI 协议走）
#    baseUrl = http://127.0.0.1:2588/seeapi，models = ["vq-canary"]

# 3) 用平台令牌打一次（TOKEN 取 /opt/visionqa/.env 里的 VQ_GATEWAY_TOKEN）
curl -s -X POST http://127.0.0.1:8799/api/gateway/v1/images/generations \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: bd-canvas-canary' \
  -d '{"model":"vq-canary","prompt":"canary"}'

# 4) 假上游日志里应看到 idempotency-key: bd-canvas-canary，正文里没有这个字段
cat /tmp/r67/sink.log
```

验完把临时 Key 删掉、假上游停掉；生产不该留多余 Key。
