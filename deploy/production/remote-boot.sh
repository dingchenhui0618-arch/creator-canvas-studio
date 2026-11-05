#!/usr/bin/env bash
# 服务器侧一键引导：拉最新代码 → 跑 install.sh → 把日志推回观察通道
# 用法（在阿里云命令助手或 SSH 里）：curl -fsSL <raw 地址> -o /root/vqboot.sh; bash /root/vqboot.sh
set -u
REPO=${REPO:-https://github.com/dingchenhui0618-arch/creator-canvas-studio.git}
APP=${APP_DIR:-/opt/visionqa}
TOPIC=${TOPIC:-vq9f3aks}
LOG=${LOG:-/opt/vq.log}
: > "$LOG"
say() { echo "[boot] $*" >>"$LOG"; }
say "start $(date -Is) host=$(hostname)"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --depth=1 origin master >>"$LOG" 2>&1 && git -C "$APP" reset --hard FETCH_HEAD >>"$LOG" 2>&1
else
  rm -rf "$APP"
  git clone --depth=1 "$REPO" "$APP" >>"$LOG" 2>&1
fi
say "code $(git -C "$APP" log --oneline -1 2>&1)"
bash "$APP/deploy/production/install.sh" >>"$LOG" 2>&1
rc=$?
say "install rc=$rc"
tail -c 4000 "$LOG" | curl -s -X POST -H "Title: vq-boot-$rc" --data-binary @- "https://ntfy.sh/$TOPIC" >/dev/null 2>&1
echo "--- 末尾日志 ---"
tail -n 20 "$LOG"
exit $rc
