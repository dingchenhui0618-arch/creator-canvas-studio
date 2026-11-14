#!/usr/bin/env bash
# 安装/更新封存包巡检定时任务（幂等）。
# 巡检只读封存包、只写一份 data/package-audits.json，不需要任何口令。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/visionqa}"

install -m 0644 "$APP_DIR/deploy/production/visionqa-package-audit.service" /etc/systemd/system/visionqa-package-audit.service
install -m 0644 "$APP_DIR/deploy/production/visionqa-package-audit.timer" /etc/systemd/system/visionqa-package-audit.timer
systemctl daemon-reload
systemctl enable --now visionqa-package-audit.timer >/dev/null
systemctl list-timers visionqa-package-audit.timer --no-pager
