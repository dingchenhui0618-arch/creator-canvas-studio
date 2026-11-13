#!/usr/bin/env bash
# 安装/更新 VisionQA 备份定时任务（幂等）。
# 口令只在服务器上生成一次，之后不再改动；它不在备份目录里，也不进任何仓库。
# 丢了 /etc/visionqa/backup.key 就打不开已有备份，所以生成后要人工抄进口令管理器。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/visionqa}"
KEY=/etc/visionqa/backup.key

install -d -m 0750 /etc/visionqa
# 目录必须让 visionqa 组能进来，否则备份进程（User=visionqa）读不到口令文件
chown root:visionqa /etc/visionqa
chmod 0750 /etc/visionqa
if [ ! -s "$KEY" ]; then
  umask 077
  openssl rand -hex 32 > "$KEY"
  chown root:visionqa "$KEY" 2>/dev/null || true
  chmod 0640 "$KEY"
  echo "已生成备份口令：$KEY"
  echo "口令指纹（sha256 前 12 位）：$(sha256sum "$KEY" | cut -c1-12)"
  echo "把它抄进口令管理器：这份文件不在备份里，机器坏了它就没了。"
else
  echo "备份口令已存在：$KEY（指纹 $(sha256sum "$KEY" | cut -c1-12)）"
fi

install -m 0644 "$APP_DIR/deploy/production/visionqa-backup.service" /etc/systemd/system/visionqa-backup.service
install -m 0644 "$APP_DIR/deploy/production/visionqa-backup.timer" /etc/systemd/system/visionqa-backup.timer
systemctl daemon-reload
systemctl enable --now visionqa-backup.timer >/dev/null
systemctl list-timers visionqa-backup.timer --no-pager
