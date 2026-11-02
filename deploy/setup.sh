#!/usr/bin/env bash
# =============================================================================
# 教务管理系统 一键部署脚本（腾讯云 Lighthouse / Ubuntu 22.04 或 24.04）
#
# 做什么：装 Node 24 → 拉代码 → 装依赖 → 建前端 → 生成密钥与管理员 →
#          写 systemd 服务 → 装并配 Nginx 反代 → 起服务。
#
# 用法（在服务器上以 root 或 sudo 用户执行）：
#   sudo bash deploy/setup.sh
#
# 可选环境变量（部署前可先 export 覆盖）：
#   APP_DIR        安装目录，默认 /opt/edu-admin
#   GIT_REPO       git 仓库地址（若服务器能直接 clone 则填；否则留空，代码手动放好）
#   ADMIN_PASSWORD 初始管理员密码（不填则脚本自动生成强密码）
#   JWT_SECRET     JWT 密钥（不填则脚本自动生成随机值）
#   DOMAIN         访问域名或公网 IP（写入 nginx server_name）
# =============================================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/edu-admin}"
GIT_REPO="${GIT_REPO:-}"
DOMAIN="${DOMAIN:-}"          # 留空则 fallback 到服务器公网 IP
SERVICE_NAME="edu-admin"
BACKUP_DIR="/opt/edu-backups"

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[0;36m'; NC='\033[0m'
info(){ echo -e "${B}==>${NC} $*"; }
ok(){ echo -e "${G}  ✓${NC} $*"; }
warn(){ echo -e "${Y}  !${NC} $*"; }
err(){ echo -e "${R}  ✗${NC} $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || err "请用 root 执行：sudo bash deploy/setup.sh"

# ---------- 1. 安装 Node 24 + 系统依赖 ----------
info "安装 Node 24 / git / nginx / sqlite3 / rsync ..."
command -v node >/dev/null 2>&1 && node -v | grep -q 'v2[3-9]\|v2[0-9][0-9]' || {
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
}
apt-get install -y git nginx sqlite3 rsync
NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
[ "$NODE_MAJOR" -ge 22 ] || err "Node 版本过低（需 >= 22.5，推荐 24）：$(node -v)"
ok "Node $(node -v)"

# ---------- 2. 拉取代码 ----------
if [ -d "$APP_DIR/.git" ]; then
  info "已存在仓库，执行 git pull ..."
  (cd "$APP_DIR" && git pull --ff-only) || warn "git pull 失败（可能本地有改动），沿用现有代码"
else
  if [ -n "$GIT_REPO" ]; then
    info "clone 代码：$GIT_REPO"
    git clone "$GIT_REPO" "$APP_DIR"
  else
    err "未设置 GIT_REPO 且 $APP_DIR 不存在。请先手动把代码放到 $APP_DIR，再重跑本脚本（会跳过 clone）。"
  fi
fi

# ---------- 3. 安装依赖 + 构建前端 ----------
info "安装后端依赖 ..."
(cd "$APP_DIR/server" && npm install --omit=dev)
info "安装前端依赖并构建 ..."
(cd "$APP_DIR/client" && npm install && npm run build)

# ---------- 4. 生成密钥与管理员密码 ----------
ENV_FILE="$APP_DIR/server/.env"
umask 077
touch "$ENV_FILE"

if ! grep -q '^JWT_SECRET=' "$ENV_FILE"; then
  JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
  echo "JWT_SECRET=$JWT_SECRET" >> "$ENV_FILE"
  ok "已生成 JWT_SECRET"
fi

if ! grep -q '^ADMIN_PASSWORD=' "$ENV_FILE"; then
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-16)}"
  echo "ADMIN_PASSWORD=$ADMIN_PASSWORD" >> "$ENV_FILE"
  ok "已生成初始管理员密码（见 $ENV_FILE）"
fi

chmod 600 "$ENV_FILE"

# ---------- 5. 初始化管理员账号 ----------
info "初始化管理员账号 ..."
(cd "$APP_DIR/server" && set -a && . ./.env && set +a && npm run seed)

# ---------- 6. 安装 systemd 服务 ----------
info "配置 systemd 服务 ..."
install -m 644 "$APP_DIR/deploy/edu-admin.service" "/etc/systemd/system/$SERVICE_NAME.service"
chown -R www-data:www-data "$APP_DIR"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME" && ok "服务已启动" || { err "服务启动失败，查看日志：journalctl -u $SERVICE_NAME -e"; }

# ---------- 7. 配置 Nginx 反代 ----------
info "配置 Nginx 反代 ..."
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(curl -fsSL --max-time 5 ifconfig.me 2>/dev/null || echo '_')"
fi
sed "s/jiaowu\.example\.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/$SERVICE_NAME
ln -sf /etc/nginx/sites-available/$SERVICE_NAME /etc/nginx/sites-enabled/$SERVICE_NAME
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx && ok "Nginx 已重载"

# ---------- 8. 备份 cron ----------
info "配置每日备份 ..."
mkdir -p "$BACKUP_DIR"
cat > /etc/cron.d/edu-backup <<EOF
17 2 * * * root APP_DIR=$APP_DIR BACKUP_DIR=$BACKUP_DIR bash $APP_DIR/deploy/backup.sh >> /var/log/edu-backup.log 2>&1
EOF
ok "已配置每日 02:17 备份"

# ---------- 9. 汇总 ----------
echo ""
echo -e "${G}部署完成${NC}"
echo "  访问地址：http://$DOMAIN"
echo "  初始管理员：admin / $(grep '^ADMIN_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
echo "  JWT 密钥：$ENV_FILE（已生成随机值）"
echo "  服务管理：systemctl status|restart|stop $SERVICE_NAME"
echo "  查看日志：journalctl -u $SERVICE_NAME -f"
echo ""
echo "下一步（手动）:"
echo "  1) 登录后立即修改管理员密码；"
echo "  2) 有备案域名则执行：certbot --nginx -d $DOMAIN 开启 HTTPS；"
echo "  3) 在腾讯云控制台安全组只放行 80/443/22，不暴露 4000。"
