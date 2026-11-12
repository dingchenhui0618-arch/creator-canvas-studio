#!/usr/bin/env bash
# 部署前给当前版本留一份可回滚的快照（C5）。
#
#   bash scripts/release.sh                  # 打一个快照，标签 manual
#   bash scripts/release.sh "v0.1.0"         # 打一个快照并带上标签
#   bash scripts/release.sh list             # 看现有快照
#
# 快照只装「程序」：dist / server / scripts / package.json。
# data（模板、账号、日志）不在里面——回滚版本不该回滚数据。
# 默认保留最近 5 个（KEEP_RELEASES 可改），更多的从最旧的删。
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

if [ "${1:-}" = "list" ]; then
  list
  exit 0
fi

label="${1:-manual}"
stamp="$(date -u +%Y%m%d-%H%M%S)"
safe="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-' | cut -c1-24)"
mkdir -p "$RELEASES"
cd "$APP_DIR"

entry="$(ls dist/assets 2>/dev/null | grep -E '^index-.*\.js$' | head -1 || true)"
file="$RELEASES/$stamp-$safe.tar.gz"
tar -czf "$file" dist server scripts package.json
printf '{"at":"%s","label":"%s","entry":"%s","bytes":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$safe" "$entry" "$(stat -c %s "$file")" > "${file%.tar.gz}.json"

# 只留最近 KEEP 个；删快照时连元数据一起删
ls -1t "$RELEASES"/*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" "${old%.tar.gz}.json"
done

echo "$file"
