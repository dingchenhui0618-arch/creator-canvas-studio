#!/bin/bash
# 给已经用 HTTP 跑起来的站点补 HTTPS：
#   certbot(webroot) 签证书 → 换 vhost(80 只留 ACME + 跳转 / 443 跑应用) → 打开 Secure Cookie
# 用法（root）：
#   DOMAIN=visionqa.wavisionai.cn bash /opt/visionqa/deploy/production/enable-https.sh
#
# vhost 不再内联在这里：应用段（所有 location、私有图覆盖、缓存头、安全头）只写在
# deploy/production/nginx-app.conf 一份，这个脚本只换外壳（nginx-tls.conf）。
# 以前这里内联了一整套，线上手加过的私有图 ^~ 覆盖、/print/、安全头从来没回来过，
# 谁重跑一次这个脚本，私有图就又会掉回 7 天 public 缓存（2026-11-14 复查发现）。
set -euo pipefail

DOMAIN=${DOMAIN:-visionqa.wavisionai.cn}
APP_DIR=${APP_DIR:-/opt/visionqa}
API_PORT=${API_PORT:-8799}
ACME_DIR=${ACME_DIR:-/www/wwwroot/wavisionai.cn/acme}
# 邮箱可留空：机器上已有 Let's Encrypt 账号时直接复用，带邮箱只是收续期提醒
EMAIL=${EMAIL:-}
NGINX_BIN=${NGINX_BIN:-/usr/sbin/nginx}
CONF=${CONF:-/etc/nginx/conf.d/${DOMAIN}.conf}
CERT_DIR=${CERT_DIR:-/etc/letsencrypt/live/${DOMAIN}}
NGINX_DIR=$(dirname "$CONF")
APP_CONF="$NGINX_DIR/${DOMAIN}.app.conf"
RENDER="$APP_DIR/deploy/production/render-vhost.sh"

log() { printf '\n== %s\n' "$*"; }

[ -f "$RENDER" ] || { echo "找不到 $RENDER：先把 deploy/ 目录同步到 $APP_DIR 再跑" >&2; exit 1; }

log "1/4 申请证书（webroot: ${ACME_DIR}）"
mkdir -p "$ACME_DIR"
if [ -d "$CERT_DIR" ]; then
  echo "证书已存在，跳过申请"
else
  CERT_ARGS=(certonly --webroot -w "$ACME_DIR" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring)
  if [ -n "$EMAIL" ]; then CERT_ARGS+=(-m "$EMAIL"); else CERT_ARGS+=(--register-unsafely-without-email); fi
  certbot "${CERT_ARGS[@]}"
fi

log "2/4 换 vhost：80 只做 ACME + 跳转，443 跑应用"
# 访问日志：有 visits 格式就照写，没有就 off（写不存在的格式名 nginx -t 直接失败）
if grep -rqs 'log_format visits' /etc/nginx/ 2>/dev/null || grep -qs 'log_format visits' "$NGINX_DIR"/*.conf 2>/dev/null; then
  ACCESS_LOG_LINE="/var/log/nginx/visits/visits.log visits"
  mkdir -p "$(dirname "$ACCESS_LOG_LINE")"
else
  ACCESS_LOG_LINE="off"
fi
TS=$(date +%Y%m%d-%H%M%S)
if [ -f "$CONF" ]; then
  cp "$CONF" "${CONF}.bak-${TS}"
  echo "原配置已备份：${CONF}.bak-${TS}"
fi
export DOMAIN APP_DIR API_PORT ACME_DIR APP_CONF CERT_DIR ACCESS_LOG_LINE HTTP_PORT=${HTTP_PORT:-80}
# 应用段顺手刷新一遍：模板改了（加一个私有目录之类）重跑这个脚本就能同步，不用等下次发版
bash "$RENDER" "$APP_DIR/deploy/production/nginx-app.conf" "$APP_CONF"
bash "$RENDER" "$APP_DIR/deploy/production/nginx-tls.conf" "$CONF"

log "3/4 nginx 校验并重载"
"$NGINX_BIN" -t
"$NGINX_BIN" -s reload

log "4/4 打开 Secure Cookie 并重启应用"
if grep -q '^VQ_SECURE_COOKIES=' "$APP_DIR/.env"; then
  sed -i 's/^VQ_SECURE_COOKIES=.*/VQ_SECURE_COOKIES=1/' "$APP_DIR/.env"
else
  echo 'VQ_SECURE_COOKIES=1' >> "$APP_DIR/.env"
fi
systemctl restart visionqa
sleep 2
curl -fsS "https://${DOMAIN}/api/health" && echo " <- HTTPS 健康检查通过"
