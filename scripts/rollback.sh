#!/usr/bin/env bash
# 一键回滚（C5）：把某个快照还原成当前版本，重启并自检。
#
#   bash /opt/visionqa/ops/rollback.sh --list      # 看有哪些快照
#   bash /opt/visionqa/ops/rollback.sh             # 回到上一个版本（= 最近一个快照）
#   bash /opt/visionqa/ops/rollback.sh --to 2      # 回到列表里第 2 个
#
# 放在 ops/ 而不是 scripts/：scripts/ 是版本内容，回滚时会被旧版本覆盖，
# 回滚工具自己不能被回滚掉。deploy.sh 每次部署会把三个脚本同步到 ops/。
#
# 回滚前会先给「现在这一版」也打一个快照，所以滚错了还能滚回来。
# 只还原程序（dist / server / scripts / package.json），不动 data。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/visionqa}"
RELEASES="$APP_DIR/releases"
KEEP="${KEEP_RELEASES:-5}"

list() {
  printf '%-3s %-18s %-8s %s\n' '#' '时间(UTC)' '大小' '入口文件'
  local index=0 file
  while read -r file; do
    [ -n "$file" ] || continue
    index=$((index + 1))
    local meta="${file%.tar.gz}.json"
    local entry='—'
    if [ -f "$meta" ]; then
      entry="$(sed -n 's/.*"entry":"\([^"]*\)".*/\1/p' "$meta")"
    fi
    printf '%-3s %-18s %-8s %s\n' "$index" "$(basename "$file" .tar.gz | cut -c1-15)" "$(du -h "$file" | cut -f1)" "${entry:-—}"
  done < <(ls -1t "$RELEASES"/*.tar.gz 2>/dev/null || true)
}

# 与 release.sh 同一套打包逻辑：这里内联，避免脚本在解包时把自己替换掉
snapshot() {
  local label="$1"
  local stamp safe file entry
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  safe="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-24)"
  mkdir -p "$RELEASES"
  cd "$APP_DIR"
  entry="$(ls dist/assets 2>/dev/null | grep -E '^index-.*\.js$' | head -1 || true)"
  file="$RELEASES/$stamp-$safe.tar.gz"
  tar -czf "$file" dist server scripts package.json
  printf '{"at":"%s","label":"%s","entry":"%s","bytes":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$safe" "$entry" "$(stat -c %s "$file")" > "${file%.tar.gz}.json"
  ls -1t "$RELEASES"/*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old" "${old%.tar.gz}.json"
  done
  echo "$file"
}

target=1
case "${1:-}" in
  '') target=1 ;;
  --list|-l) list; exit 0 ;;
  --to|-t) target="${2:-1}" ;;
  *) target="$1" ;;
esac

file="$(ls -1t "$RELEASES"/*.tar.gz 2>/dev/null | sed -n "${target}p")"
if [ -z "$file" ]; then
  echo "没有第 $target 个快照；先 bash scripts/rollback.sh --list 看看" >&2
  exit 1
fi

echo "回滚目标：$(basename "$file")"
saved="$(snapshot "before-rollback")"
echo "已为当前版本留档：$(basename "$saved")"

cd "$APP_DIR"
rm -rf dist server scripts
tar -xzf "$file" -C "$APP_DIR"
chown -R visionqa:visionqa "$APP_DIR"
systemctl restart visionqa visionqa-internal
sleep 4
systemctl is-active visionqa visionqa-internal
curl -s --max-time 10 http://127.0.0.1:8799/api/health || true
echo
echo "入口：$(ls dist/assets | grep -E '^index-.*\.js$' | head -1)"
