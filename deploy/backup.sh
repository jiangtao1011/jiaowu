#!/usr/bin/env bash
# 教务管理系统备份脚本：SQLite 数据库 + 上传文件
# 用法：sudo bash deploy/backup.sh
# 建议配合 cron 每天定时执行（见文件末尾注释）。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/edu-admin}"
BACKUP_DIR="${BACKUP_DIR:-/opt/edu-backups}"
DB="$APP_DIR/server/data/edu.db"
UPLOADS="$APP_DIR/server/uploads"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%F_%H-%M-%S)"

# 1. SQLite 在线备份（.backup 保证一致性，不用直接 cp）
if [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$BACKUP_DIR/edu-$STAMP.db'"
  echo "数据库已备份：$BACKUP_DIR/edu-$STAMP.db"
else
  echo "警告：未找到数据库 $DB，跳过"
fi

# 2. 上传文件
if [ -d "$UPLOADS" ]; then
  rsync -a --delete "$UPLOADS/" "$BACKUP_DIR/uploads/"
  echo "上传文件已同步：$BACKUP_DIR/uploads/"
fi

# 3. 只保留最近 14 天的数据库快照，防止磁盘膨胀
find "$BACKUP_DIR" -name 'edu-*.db' -mtime +14 -delete

echo "备份完成：$BACKUP_DIR"

# =============================================================================
# 定时任务：把下面一行放进 /etc/cron.d/edu-backup（每天凌晨 2:17 执行）
#   17 2 * * * root APP_DIR=/opt/edu-admin BACKUP_DIR=/opt/edu-backups bash /opt/edu-admin/deploy/backup.sh >> /var/log/edu-backup.log 2>&1
# 或直接执行：echo '17 2 * * * root ...' > /etc/cron.d/edu-backup
# =============================================================================
