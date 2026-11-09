#!/usr/bin/env bash
# 把 deploy/env.applied 里的键合并进 .env：同名的旧行先删掉，其余原样保留，并留一份带时间戳的备份。
# 用法：cd /opt/visionqa && bash deploy/production/apply-env.sh && sudo systemctl restart visionqa
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$APP_DIR"

[ -f deploy/env.applied ] || { echo "缺少 deploy/env.applied"; exit 1; }
[ -f .env ] || : > .env

BAK=".env.bak-$(date +%Y%m%d-%H%M%S)"
cp .env "$BAK"

KEYS="$(grep -oE '^[A-Z0-9_]+' deploy/env.applied | sort -u | paste -sd'|' -)"
if [ -n "$KEYS" ]; then
  grep -vE "^($KEYS)=" "$BAK" > .env || true
fi
printf '\n' >> .env
cat deploy/env.applied >> .env
chmod 600 .env
echo "已合并 $(grep -c . deploy/env.applied) 行；旧值备份在 $BAK"
