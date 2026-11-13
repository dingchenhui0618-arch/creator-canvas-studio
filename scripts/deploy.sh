#!/usr/bin/env bash
# 部署一个发布包（C5）：
#   1) 解开到临时目录；
#   2) 给当前版本打一个可回滚的快照（scripts/release.sh）；
#   3) 替换 dist / server / scripts / package.json（data 不动）；
#   4) 重启两个服务并自检健康。
#
#   bash /tmp/vqstage/scripts/deploy.sh /tmp/vqdeploy.tgz "v0.1.1"
#
# 脚本自己是从临时目录跑的：替换 scripts/ 时不会把自己删掉。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/visionqa}"
BUNDLE="${1:?用法: deploy.sh <发布包.tgz> [标签]}"
LABEL="${2:-deploy}"

STAGE="$(mktemp -d /tmp/vqstage.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$BUNDLE" -C "$STAGE"
if [ ! -d "$STAGE/dist" ] || [ ! -d "$STAGE/server" ]; then
  echo "发布包里缺少 dist 或 server，先确认打包内容" >&2
  exit 1
fi

cd "$APP_DIR"
bash "$STAGE/scripts/release.sh" "$LABEL"

rm -rf dist server scripts
cp -a "$STAGE/dist" "$STAGE/server" "$STAGE/scripts" "$APP_DIR/"
cp "$STAGE/package.json" "$APP_DIR/package.json"
if [ -d "$STAGE/deploy" ]; then
  cp -a "$STAGE/deploy" "$APP_DIR/"
fi

# 运维脚本另放 ops/：scripts/ 属于版本内容，回滚时会被旧版本覆盖，
# 把 rollback.sh 放在里面就会出现「一回滚就把回滚工具删掉」的尴尬。
mkdir -p "$APP_DIR/ops"
cp "$STAGE/scripts/release.sh" "$STAGE/scripts/rollback.sh" "$STAGE/scripts/deploy.sh" "$APP_DIR/ops/"
chmod +x "$APP_DIR"/ops/*.sh
chown -R visionqa:visionqa "$APP_DIR"

# 备份定时任务跟着仓库走：unit 内容变了就同步，避免线上跑着一份和仓库不一致的备份配置。
# 装不上不影响这次发布（备份失败会在后台「数据备份」卡片里亮出来），所以只告警。
# Windows 上打包的脚本没有可执行位，所以这里按「文件存在」判断，并用 bash 显式执行。
if [ -f "$APP_DIR/deploy/production/install-backup.sh" ]; then
  chmod +x "$APP_DIR/deploy/production/install-backup.sh" 2>/dev/null || true
  bash "$APP_DIR/deploy/production/install-backup.sh" > /tmp/vq-backup-install.log 2>&1 || echo "备份定时任务安装失败，详见 /tmp/vq-backup-install.log" >&2
fi

# 监听端口交给 systemd（B3 发布不中断）：socket 单元握着 127.0.0.1:8799，
# 重启只换进程、端口不断开，新连接排队等新进程接手，不再是 3–10 秒 502。
# 幂等：已经开启时这里什么都不做；第一次会多停一次服务（让出端口给 socket 单元）。
# 装不上不影响这次发布，只是这一版仍按普通端口监听（后台日志里能看到失败原因）。
if [ -f "$APP_DIR/deploy/production/install-socket.sh" ]; then
  chmod +x "$APP_DIR/deploy/production/install-socket.sh" 2>/dev/null || true
  bash "$APP_DIR/deploy/production/install-socket.sh" > /tmp/vq-socket-install.log 2>&1 || echo "socket 激活安装失败，本版仍按端口监听，详见 /tmp/vq-socket-install.log" >&2
fi

systemctl restart visionqa visionqa-internal

# 启动自检要真的等到 /api/health 就绪：只看 systemctl is-active 会拿到 activating，
# curl 失败又被 || true 吞掉，等于「部署成功」是自己说的（2026-11-12 踩过一次）。
ready=0
for _attempt in 1 2 3 4 5 6 7 8; do
  sleep 2
  if curl -fsS --max-time 5 http://127.0.0.1:8799/api/health > /tmp/vq-health.json 2>/dev/null; then
    ready=1
    break
  fi
done
systemctl is-active visionqa visionqa-internal || true
if [ "$ready" != "1" ]; then
  echo '部署自检失败：/api/health 在 16 秒内没有就绪，最近日志如下' >&2
  journalctl -u visionqa -n 30 --no-pager >&2 || true
  echo "回上一个版本：bash $APP_DIR/ops/rollback.sh" >&2
  exit 1
fi
cat /tmp/vq-health.json
echo
echo "入口：$(ls dist/assets | grep -E '^index-.*\.js$' | head -1)"
