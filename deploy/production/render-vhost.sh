#!/bin/bash
# 把 deploy/production/nginx-{http,tls,app}.conf 里的占位符换成真值。
#
#   DOMAIN=visionqa.example.com APP_DIR=/opt/visionqa API_PORT=8799 \
#   ACME_DIR=/www/wwwroot/example/acme APP_CONF=/etc/nginx/conf.d/site.app.conf \
#   bash render-vhost.sh deploy/production/nginx-tls.conf /etc/nginx/conf.d/site.conf
#
# 占位符只有这几个：__DOMAIN__ __APP_DIR__ __API_PORT__ __ACME_DIR__ __APP_CONF__
# __CERT_DIR__ __ACCESS_LOG__ __HTTP_PORT__。渲染完还留着任何一个就报错退出——
# 模板里加变量、脚本里忘了传，是这条链上最容易犯又最难发现的错。
# scripts/check-nginx.mjs 会核对这份 sed 清单和模板里实际用到的占位符是否对得上。
set -euo pipefail

tpl=${1:?用法: render-vhost.sh <模板> <输出>}
out=${2:?用法: render-vhost.sh <模板> <输出>}

: "${DOMAIN:?缺 DOMAIN}"
: "${APP_DIR:?缺 APP_DIR}"
: "${API_PORT:?缺 API_PORT}"
: "${ACME_DIR:?缺 ACME_DIR}"
: "${APP_CONF:?缺 APP_CONF}"
CERT_DIR=${CERT_DIR:-/etc/letsencrypt/live/${DOMAIN}}
ACCESS_LOG_LINE=${ACCESS_LOG_LINE:-off}
HTTP_PORT=${HTTP_PORT:-80}

[ -f "$tpl" ] || { echo "模板不存在：$tpl" >&2; exit 1; }

mkdir -p "$(dirname "$out")"
sed -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__APP_DIR__|${APP_DIR}|g" \
    -e "s|__API_PORT__|${API_PORT}|g" \
    -e "s|__ACME_DIR__|${ACME_DIR}|g" \
    -e "s|__APP_CONF__|${APP_CONF}|g" \
    -e "s|__CERT_DIR__|${CERT_DIR}|g" \
    -e "s|__ACCESS_LOG__|${ACCESS_LOG_LINE}|g" \
    -e "s|__HTTP_PORT__|${HTTP_PORT}|g" \
    "$tpl" > "$out"

if grep -nE '__[A-Z_]+__' "$out" >/dev/null 2>&1; then
  echo "渲染后仍有没替换的占位符：$out" >&2
  grep -nE '__[A-Z_]+__' "$out" | head -5 >&2
  exit 1
fi
