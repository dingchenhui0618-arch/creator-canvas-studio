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

systemctl restart visionqa visionqa-internal
sleep 4
systemctl is-active visionqa visionqa-internal
curl -s --max-time 10 http://127.0.0.1:8799/api/health || true
echo
echo "入口：$(ls dist/assets | grep -E '^index-.*\.js$' | head -1)"
