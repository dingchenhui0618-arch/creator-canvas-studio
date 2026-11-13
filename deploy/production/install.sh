#!/bin/bash
# VisionQA 生产部署（幂等，可重复执行）
# 用法（root）：
#   DOMAIN=VisionQA.wavisionai.cn bash deploy/production/install.sh
# 可选环境变量：APP_DIR / APP_USER / API_PORT / NODE_VERSION / REPO / VISION_* / REDFOX_API_KEY
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/visionqa}
APP_USER=${APP_USER:-visionqa}
API_PORT=${API_PORT:-8799}
NODE_VERSION=${NODE_VERSION:-22.12.0}
DOMAIN=${DOMAIN:-VisionQA.wavisionai.cn}
REPO=${REPO:-https://github.com/dingchenhui0618-arch/creator-canvas-studio.git}
DATA_DIR=${DATA_DIR:-/var/lib/visionqa}
# 站点走法：0 = 先跑 HTTP（证书没签下来之前必须是 0，否则登录 cookie 带 Secure 会掉）
SECURE_COOKIES=${SECURE_COOKIES:-0}
# ACME 续期目录：这台机器上 wavisionai.cn 用的就是它
ACME_DIR=${ACME_DIR:-/www/wwwroot/wavisionai.cn/acme}
# 部署引导账号（库里没有该邮箱时建一条普通账号；口令不写入日志、不下发给访客）
SEED_EMAIL=${SEED_EMAIL:-admin@visionqa.local}
# 口令不留默认值：以前写死一个 Changes-Me-2026，谁部署完忘了改，站上就有一个公开口令的账号。
# 没给 SEED_PASSWORD 就现生成一条随机口令，只在安装时打印一次（之后请自己改）。
SEED_PASSWORD=${SEED_PASSWORD:-}
GENERATED_SEED_PASSWORD=0
if [ -z "$SEED_PASSWORD" ]; then
  SEED_PASSWORD=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-20)
  GENERATED_SEED_PASSWORD=1
fi

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "请用 root 执行"; exit 1; }

log "1/7 系统依赖（已装则跳过；源不可用不影响后续）"
need_pkg=0
for bin in git curl xz; do command -v "$bin" >/dev/null 2>&1 || need_pkg=1; done
if [ "$need_pkg" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq || true
    apt-get install -y -qq curl xz-utils git ca-certificates >/dev/null || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q --setopt=*.skip_if_unavailable=true curl xz git ca-certificates >/dev/null || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q --disablerepo=docker-ce-stable curl xz git ca-certificates >/dev/null || true
  fi
else
  echo "git/curl/xz 已存在，跳过装包"
fi

log "2/7 Node ${NODE_VERSION}"
if ! /usr/local/node/bin/node -v 2>/dev/null | grep -q "^v${NODE_VERSION%%\..*}"; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) echo "不支持的架构 $ARCH"; exit 1 ;; esac
  TARBALL="node-v${NODE_VERSION}-linux-${NARCH}.tar.xz"
  mkdir -p /usr/local/node
  # 国内直连 npmmirror，官方源做兜底
  curl -fsSL -o /tmp/${TARBALL} "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${TARBALL}" \
    || curl -fsSL -o /tmp/${TARBALL} "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
  tar -xJf /tmp/${TARBALL} -C /usr/local/node --strip-components=1
  rm -f /tmp/${TARBALL}
  ln -sf /usr/local/node/bin/node /usr/local/bin/node
  ln -sf /usr/local/node/bin/npm /usr/local/bin/npm
fi
node -v; npm -v

log "3/7 账号与目录"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -m -d /home/$APP_USER -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$APP_USER":"$APP_USER" "$DATA_DIR"

log "4/7 拉取代码与构建"
if [ -d "$APP_DIR/.git" ]; then
  # 目录已 chown 给运行用户，root 执行 git 需要显式信任，否则报 dubious ownership
  # 浅克隆下 fetch 只更新 FETCH_HEAD，origin/master 可能是旧的，必须 reset 到 FETCH_HEAD
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch --depth=1 origin master
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset --hard FETCH_HEAD
else
  git clone --depth=1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
# 国内机器直接走 npmmirror，快一个数量级
/usr/local/bin/npm config set registry https://registry.npmmirror.com || true
# --ignore-scripts：跳过 ffmpeg-static / ffprobe-static 的安装期下载（每个 80MB+，国内常常卡住）。
# 生产按「远端算力」抽帧时本来就不需要本地 ffmpeg；真要在服务器抽帧再单独 npm rebuild ffmpeg-static。
# 依赖已装且 lock 没变就跳过，方便重复执行时只重建
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund --ignore-scripts
else
  echo "node_modules 已是最新，跳过 npm ci"
fi
npm run build
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

log "5/7 环境变量"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<EOF
# 生产配置（由 install.sh 生成，请按需修改后 systemctl restart visionqa）
API_PORT=${API_PORT}
DATA_DIR=${DATA_DIR}
VQ_REQUIRE_AUTH=1
VQ_SECURE_COOKIES=${SECURE_COOKIES}
# 注册关闭；首个账号由下面的邮箱/口令种子化（普通账号，不是演示入口）
VQ_SEED_ACCOUNT=1
VQ_SEED_EMAIL=${SEED_EMAIL}
VQ_SEED_PASSWORD=${SEED_PASSWORD}
VQ_REGISTRATION=0
# 视觉模型：必须是这台服务器能访问到的地址
VISION_BASE_URL=${VISION_BASE_URL:-}
VISION_MODEL=${VISION_MODEL:-}
# 界面上「模型」下拉框的选项就来自这一行（逗号分隔，首选在前）；加模型只需改这里再重启
VISION_MODELS=${VISION_MODELS:-}
VISION_FALLBACKS=${VISION_FALLBACKS:-}
VISION_API_KEY=${VISION_API_KEY:-}
# 远端算力（抽帧）：留空则用服务器本地 ffmpeg
REPLICATE_REMOTE_URL=${REPLICATE_REMOTE_URL:-}
REPLICATE_REMOTE_TOKEN=${REPLICATE_REMOTE_TOKEN:-}
EOF
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "已生成 $APP_DIR/.env（模型 Key 仍是空的，填好再启动）"
  if [ "$GENERATED_SEED_PASSWORD" = "1" ]; then
    echo "引导账号 $SEED_EMAIL 的初始口令：$SEED_PASSWORD （只显示这一次，登录后请改掉）"
  else
    echo "引导账号 $SEED_EMAIL 的口令由 SEED_PASSWORD 指定（这里不打印）"
  fi
else
  echo "保留已有 $APP_DIR/.env"
fi

log "6/7 systemd"
cat > /etc/systemd/system/visionqa.service <<EOF
[Unit]
Description=VisionQA Workbench
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
# node:sqlite 在 Node 22 里要显式开；Node 24 起默认可用
ExecStart=/usr/local/bin/node --experimental-sqlite server/index.mjs
Restart=always
RestartSec=3
# 2GB 机器上给 Node 留足余量，别让它把系统拖死
Environment=NODE_OPTIONS=--max-old-space-size=384

[Install]
WantedBy=multi-user.target
EOF
# 监听套接字：把 8799 交给 systemd 一直握着，发版重启时端口不断开（B3 发布不中断）。
# 服务进程会通过 LISTEN_FDS 拿到这个套接字（见 server/listen.mjs）；
# 没有 socket 单元的老部署照样按端口监听，两种方式都在。
if [ -f "$APP_DIR/deploy/production/visionqa.socket" ]; then
  sed "s|__API_PORT__|${API_PORT}|g" "$APP_DIR/deploy/production/visionqa.socket" > /etc/systemd/system/visionqa.socket
  chmod 644 /etc/systemd/system/visionqa.socket
  systemctl daemon-reload
  systemctl enable --now visionqa.socket >/dev/null 2>&1 || echo "socket 单元启用失败，按普通端口监听" >&2
fi

systemctl daemon-reload
systemctl enable visionqa >/dev/null
systemctl restart visionqa
sleep 2
systemctl --no-pager --lines=5 status visionqa || true
curl -fsS "http://127.0.0.1:${API_PORT}/api/health" && echo " <- 本地健康检查通过"

log "7/7 nginx 站点"
NET_CONF="deploy/production/nginx-visionqa.conf"
# 按「真正在跑的 nginx」选配置目录：宝塔 / 系统 nginx 两套路径
if [ -x /www/server/nginx/sbin/nginx ]; then
  CONF=/www/server/panel/vhost/nginx/${DOMAIN}.conf
  NGINX_BIN=/www/server/nginx/sbin/nginx
else
  CONF=/etc/nginx/conf.d/${DOMAIN}.conf
  NGINX_BIN=/usr/sbin/nginx
  [ -x "$NGINX_BIN" ] || NGINX_BIN=$(command -v nginx)
fi
cp "$NET_CONF" "$CONF"
mkdir -p "$ACME_DIR"
sed -i "s|__DOMAIN__|${DOMAIN}|g; s|__APP_DIR__|${APP_DIR}|g; s|__API_PORT__|${API_PORT}|g; s|__ACME_DIR__|${ACME_DIR}|g" "$CONF"
echo "已写入 $CONF"
"$NGINX_BIN" -t && "$NGINX_BIN" -s reload
echo "完成。HTTP 已可访问 http://${DOMAIN}/ ，HTTPS 证书见 deploy/production/README.md"
