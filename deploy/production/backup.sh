#!/usr/bin/env bash
# VisionQA 数据备份：把 /var/lib/visionqa 整个打包到 /var/backups/visionqa，留 7 天。
# 为什么整目录打包而不是只拷 auth.db：SQLite 是 WAL 模式，只拷主文件会拿到不完整的库；
# 连 -wal / -shm 一起打，恢复时 SQLite 会自己重放并还原到一致状态。
# 安装：见 deploy/production/backup.README（systemd timer 每天 04:10 跑一次）。
set -euo pipefail

SRC=${VQ_DATA_DIR:-/var/lib/visionqa}
DEST=${VQ_BACKUP_DIR:-/var/backups/visionqa}
KEEP=${VQ_BACKUP_KEEP:-7}
ts=$(date +%Y%m%d-%H%M%S)

mkdir -p "$DEST"
tar -czf "$DEST/data-$ts.tar.gz" -C "$(dirname "$SRC")" "$(basename "$SRC")"
# 只保留最近 $KEEP 份
ls -1t "$DEST"/data-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "backup ok: $DEST/data-$ts.tar.gz ($(du -h "$DEST/data-$ts.tar.gz" | cut -f1))"
