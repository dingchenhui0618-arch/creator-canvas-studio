#!/bin/bash
set -u
ROOT="${MAIL_E2E_DIR:-/tmp/vq-mail-e2e}"
APP_ROOT="${VQ_APP_ROOT:-/opt/visionqa}"
AT='@'
EMAIL="mailtest${AT}example.com"
NODE="${NODE_BIN:-/usr/local/bin/node}"
HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$ROOT/data" "$ROOT/inbox" "$ROOT/logs"
mkdir -p "$ROOT/data" "$ROOT/inbox"

echo "== 1. 起本地假 SMTP =="
SINK_PORT=2525 SINK_OUT="$ROOT/inbox" nohup $NODE "$HERE/sink.mjs" > "$ROOT/sink.log" 2>&1 &
SINK_PID=$!
sleep 1
pgrep -a -f smtp-sink.mjs | head -2

echo "== 2. 在临时 DATA_DIR 建测试账号 =="
cd "$APP_ROOT"
DATA_DIR="$ROOT/data" $NODE --experimental-sqlite "$HERE/seed-user.mjs" "$EMAIL" 'TestPass123' 2>&1 | tail -3

echo "== 3. 起临时实例（8802，只读自己的 DATA_DIR） =="
DATA_DIR="$ROOT/data" API_PORT=8802 VQ_ADMIN_EMAILS="$EMAIL" VQ_LOG_DIR="$ROOT/logs" nohup $NODE --experimental-sqlite "$APP_ROOT/server/index.mjs" > "$ROOT/app.log" 2>&1 &
APP_PID=$!
echo "APP_PID=$APP_PID"
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8802/api/health || true)
  if [ "$code" = "200" ]; then echo "health 200 after ${i}s"; break; fi
  sleep 1
done

echo "== 4. 跑找回密码全链路 =="
SINK_OUT="$ROOT/inbox" SINK_PORT=2525 BASE=http://127.0.0.1:8802 $NODE "$HERE/e2e.mjs" TestPass123 NewPass456 > "$ROOT/e2e.json" 2>&1
echo "E2E_EXIT=$?"
cat "$ROOT/e2e.json"

echo "== 5. 临时实例的邮件日志 =="
grep -o 'mail-[a-z]*' "$ROOT/logs"/*.log 2>/dev/null | sort | uniq -c | head
echo "== 6. 收件箱 =="
ls -la "$ROOT/inbox" | tail -5
echo "== 7. 生产数据目录有没有被碰 =="
ls -la /var/lib/visionqa/mail.json 2>&1 | head -2
systemctl is-active visionqa

echo "== 8. 收尾：停临时实例与 sink =="
kill $APP_PID $SINK_PID 2>/dev/null
sleep 1
pgrep -af 'API_PORT=8802|smtp-sink.mjs' | head -3 || true
echo DONE