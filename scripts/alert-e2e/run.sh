#!/bin/bash
set -u
ROOT="${ALERT_E2E_DIR:-/tmp/vq-alert-e2e}"
APP_ROOT="${VQ_APP_ROOT:-/opt/visionqa}"
AT='@'
EMAIL="alerttest${AT}example.com"
NODE="${NODE_BIN:-/usr/local/bin/node}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$(cd "$HERE/../mail-e2e" && pwd)/seed-user.mjs"
rm -rf "$ROOT/data" "$ROOT/inbox" "$ROOT/logs"
mkdir -p "$ROOT/data" "$ROOT/inbox"

echo "== 1. 起本地假告警接收端（2526） =="
SINK_PORT=2526 SINK_OUT="$ROOT/inbox" nohup $NODE "$HERE/sink.mjs" > "$ROOT/sink.log" 2>&1 &
SINK_PID=$!
sleep 1
cat "$ROOT/sink.log" | tail -2

echo "== 2. 在临时 DATA_DIR 建测试账号 =="
cd "$APP_ROOT"
DATA_DIR="$ROOT/data" VQ_APP_ROOT="$APP_ROOT" $NODE --experimental-sqlite "$SEED" "$EMAIL" 'TestPass123' 2>&1 | tail -2

echo "== 3. 起临时实例（8803） =="
DATA_DIR="$ROOT/data" API_PORT=8803 VQ_ADMIN_EMAILS="$EMAIL" VQ_LOG_DIR="$ROOT/logs" nohup $NODE --experimental-sqlite "$APP_ROOT/server/index.mjs" > "$ROOT/app.log" 2>&1 &
APP_PID=$!
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8803/api/health || true)
  if [ "$code" = "200" ]; then echo "health 200 after ${i}s"; break; fi
  sleep 1
done

echo "== 4. 跑告警外推全链路 =="
SINK_OUT="$ROOT/inbox" SINK_PORT=2526 BASE=http://127.0.0.1:8803 $NODE "$HERE/e2e.mjs" TestPass123 > "$ROOT/e2e.json" 2>&1
echo "E2E_EXIT=$?"
cat "$ROOT/e2e.json"

echo "== 5. 生产数据目录有没有被碰 =="
ls /var/lib/visionqa/alert-channel.json /var/lib/visionqa/alert-outbox.json 2>&1 | head -3
systemctl is-active visionqa

echo "== 6. 收尾 =="
kill $APP_PID $SINK_PID 2>/dev/null
sleep 1
printf 'DONE\n'
