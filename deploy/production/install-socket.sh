#!/bin/bash
# 打开 / 同步 socket 激活（幂等）。放在 deploy.sh 里每次发版跑一次，也完全可以手动跑。
#
# 为什么需要单独的切换动作：socket 单元要 bind 8799，而旧进程正占着这个端口——
# 只能「先停应用、再起 socket 单元、再起应用」。切换会有一两秒的空窗（第一次），
# 之后每次重启都不断端口。
# 切换后自检失败会自己退回去（关 socket 单元、按普通方式重启），绝不留一个起不来的站。
set -uo pipefail

APP_DIR=${APP_DIR:-/opt/visionqa}
API_PORT=${API_PORT:-8799}
SERVICE=visionqa
SOCKET_UNIT=/etc/systemd/system/${SERVICE}.socket
TEMPLATE="$APP_DIR/deploy/production/${SERVICE}.socket"

[ "$(id -u)" = "0" ] || { echo "请用 root 执行"; exit 1; }
[ -f "$TEMPLATE" ] || { echo "缺少 $TEMPLATE，跳过"; exit 0; }

# 1) 同步 unit 内容（端口跟着 API_PORT 走）
sed "s|__API_PORT__|${API_PORT}|g" "$TEMPLATE" > "$SOCKET_UNIT.new"
if [ -f "$SOCKET_UNIT" ] && cmp -s "$SOCKET_UNIT.new" "$SOCKET_UNIT"; then
  rm -f "$SOCKET_UNIT.new"
else
  mv "$SOCKET_UNIT.new" "$SOCKET_UNIT"
  echo "已更新 $SOCKET_UNIT"
fi
chmod 644 "$SOCKET_UNIT"
systemctl daemon-reload

if systemctl is-active --quiet "$SERVICE.socket"; then
  echo "socket 激活已开启（$SERVICE.socket active），本次不动服务"
  exit 0
fi

echo "切换 socket 激活：先停 $SERVICE 让出 $API_PORT，再起 socket 单元"
systemctl stop "$SERVICE"
systemctl enable --now "$SERVICE.socket" >/dev/null
systemctl restart "$SERVICE"

ready=0
for _attempt in 1 2 3 4 5 6 7 8; do
  sleep 1
  if curl -fsS --max-time 5 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then ready=1; break; fi
done

if [ "$ready" != "1" ]; then
  echo "socket 激活后自检失败，退回普通端口监听" >&2
  systemctl disable --now "$SERVICE.socket" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
  exit 1
fi

echo "socket 激活已生效，health ok"
