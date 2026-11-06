#!/bin/bash
# 给已经用 HTTP 跑起来的站点补 HTTPS：
#   certbot(webroot) 签证书 → 重写 vhost(80 只留 ACME + 跳转 / 443 跑应用) → 打开 Secure Cookie
# 用法（root）：DOMAIN=visionqa.wavisionai.cn bash deploy/production/enable-https.sh
set -euo pipefail

DOMAIN=${DOMAIN:-visionqa.wavisionai.cn}
APP_DIR=${APP_DIR:-/opt/visionqa}
API_PORT=${API_PORT:-8799}
ACME_DIR=${ACME_DIR:-/www/wwwroot/wavisionai.cn/acme}
# 邮箱可留空：已有 Let's Encrypt 账号时会直接复用；带邮箱只是收续期提醒
EMAIL=${EMAIL:-}
NGINX_BIN=${NGINX_BIN:-/usr/sbin/nginx}
CONF=${CONF:-/etc/nginx/conf.d/${DOMAIN}.conf}
CERT_DIR=/etc/letsencrypt/live/${DOMAIN}

log() { printf '\n== %s\n' "$*"; }

log "1/4 申请证书（webroot: ${ACME_DIR}）"
mkdir -p "$ACME_DIR"
if [ -d "$CERT_DIR" ]; then
  echo "证书已存在，跳过申请"
else
  CERT_ARGS=(certonly --webroot -w "$ACME_DIR" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring)
  if [ -n "$EMAIL" ]; then CERT_ARGS+=(-m "$EMAIL"); else CERT_ARGS+=(--register-unsafely-without-email); fi
  certbot "${CERT_ARGS[@]}"
fi

log "2/4 重写 vhost：80 只做 ACME + 跳转，443 跑应用"
cat > "$CONF" <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # 续期：certbot webroot 走这里，别被跳转吃掉
    location /.well-known/acme-challenge/ {
        root ${ACME_DIR};
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    root ${APP_DIR}/dist;
    client_max_body_size 64m;
    index index.html;

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }

    location /media/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_set_header Host $host;
        add_header Cache-Control "public, max-age=604800";
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX

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
