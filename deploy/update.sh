#!/usr/bin/env bash
# =============================================================================
# 教务管理系统 服务器更新脚本
#
# 用于把已部署的服务器更新到最新代码：拉取代码 → 装依赖 → 重建前端 → 重启服务。
# 与 setup.sh 分工：setup.sh 负责「首次部署」，本脚本负责「日常更新」。
#
# 用法：把本脚本放到应用根目录（或其 deploy/ 子目录），在服务器上以 root 执行：
#   sudo bash /实际/部署路径/deploy/update.sh
#   或先 cd 到应用根目录，再：  sudo bash deploy/update.sh
#
# APP_DIR 无需指定——脚本会自动按「自身所在目录的上一级」定位应用根。
# 可选环境变量：
#   APP_DIR   应用安装目录（默认 = 脚本上一级，一般无需设置）
#   SERVICE   systemd 服务名，默认 edu-admin
#   SKIP_BUILD 任意非空值则跳过前端重建（仅后端/脚本改动时可用，加快更新）
# =============================================================================

set -euo pipefail

# 应用根目录：默认取「脚本所在目录的上一级」（update.sh 位于 deploy/ 下，其父目录即应用根）。
# 这样无论代码部署在哪个路径，只要按实际路径运行本脚本就能自动定位，无需硬编码。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${APP_DIR:-$(dirname "$SCRIPT_DIR")}"
SERVICE="${SERVICE:-edu-admin}"
SKIP_BUILD="${SKIP_BUILD:-}"
BACKUP_DIR="${BACKUP_DIR:-/opt/edu-backups}"

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[0;36m'; NC='\033[0m'
info(){ echo -e "${B}==>${NC} $*"; }
ok(){ echo -e "${G}  ✓${NC} $*"; }
warn(){ echo -e "${Y}  !${NC} $*"; }
err(){ echo -e "${R}  ✗${NC} $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || err "请用 root 执行：sudo bash deploy/update.sh"
[ -d "$APP_DIR/.git" ] || err "未找到仓库 $APP_DIR，请确认 APP_DIR 正确（或先用 setup.sh 部署）"

# ---------- 1. 更新前自动备份一次数据库 ----------
info "更新前备份数据库 ..."
if [ -x "$APP_DIR/deploy/backup.sh" ]; then
  bash "$APP_DIR/deploy/backup.sh" >/dev/null 2>&1 \
    && ok "已备份到 $BACKUP_DIR" \
    || warn "备份失败（不影响更新，继续）"
fi

# ---------- 2. 拉取最新代码 ----------
info "拉取最新代码 ..."
(cd "$APP_DIR" && git pull --ff-only) || err "git pull 失败，请手动排查（可能有本地改动）"

# ---------- 3. 安装依赖 + 重建前端 ----------
info "安装后端依赖 ..."
(cd "$APP_DIR/server" && npm install --omit=dev)

if [ -z "$SKIP_BUILD" ]; then
  info "安装前端依赖并重建 ..."
  (cd "$APP_DIR/client" && npm install && npm run build)
else
  warn "已跳过前端重建（SKIP_BUILD 非空）"
fi

# ---------- 4. 恢复 www-data 属主（git pull / 构建可能用 root 产生新文件） ----------
info "修正文件属主 ..."
chown -R www-data:www-data "$APP_DIR"

# ---------- 5. 重启服务 ----------
info "重启服务 $SERVICE ..."
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  ok "服务已重启并运行中"
else
  err "服务启动失败，查看日志：journalctl -u $SERVICE -e"
fi

echo ""
echo -e "${G}更新完成${NC}"
echo "  查看状态：systemctl status $SERVICE"
echo "  查看日志：journalctl -u $SERVICE -f"
