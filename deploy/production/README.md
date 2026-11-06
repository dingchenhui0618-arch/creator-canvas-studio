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
再用浏览器登录一次（`VQ_REQUIRE_AUTH=1` 时没有演示账号，需要先在服务器上建号，见 `server/auth.mjs` 的 CLI）。

## 回滚

```bash
systemctl disable --now visionqa
rm -f /www/server/panel/vhost/nginx/VisionQA.wavisionai.cn.conf   # 或 /etc/nginx/conf.d/
nginx -t && nginx -s reload
```
数据都在 `/var/lib/visionqa`，删目录前先备份 `templates.json` 与 `frames/`。
