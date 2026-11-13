#!/usr/bin/env bash
# 旧的备份入口，保留兼容：真实实现已搬到 scripts/backup.mjs（一致性快照 + 加密 + 恢复演练）。
# 仍然用这个脚本的机器会得到同样的行为，只是日志格式变成一行 JSON。
# 新的安装方式：bash deploy/production/install-backup.sh
set -euo pipefail
PRIMARY=/opt/visionqa/scripts/backup.mjs
FALLBACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/backup.mjs"
TARGET="$PRIMARY"
[ -f "$TARGET" ] || TARGET="$FALLBACK"
exec "${NODE_BIN:-/usr/local/bin/node}" --experimental-sqlite "$TARGET" "$@"
