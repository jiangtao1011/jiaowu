# 部署指南（腾讯云 Lighthouse / Ubuntu 22.04 或 24.04）

本目录提供把教务管理系统部署到云服务器的完整材料。服务器选购与整体方案见与本文档同期的对话记录，这里只讲操作。

## 文件清单

| 文件 | 用途 |
|------|------|
| `setup.sh` | 一键部署脚本（装环境 → 装依赖 → 起服务 → 配 Nginx → 配备份） |
| `update.sh` | 更新脚本（拉代码 → 装依赖 → 重建前端 → 重启服务，更新前自动备份） |
| `edu-admin.service` | systemd 服务单元，让后端进程常驻、开机自启 |
| `nginx.conf` | Nginx 反代配置模板（80 → 后端 4000） |
| `backup.sh` | 备份脚本（SQLite 数据库 + 上传文件，保留 14 天） |

## 前置条件

- 一台腾讯云 Lighthouse（推荐 2 核 2G、Ubuntu 22.04/24.04、3~5M 带宽）。
- 安全组/防火墙放行 **80、443、22**；**不要放行 4000**（4000 只对内，由 Nginx 转发）。
- 可选：一个已备案的域名（不备案则用公网 IP + HTTP 先跑起来）。

## 快速开始

把代码放到服务器上后，直接跑：

```bash
sudo bash deploy/setup.sh
```

脚本会：装 Node 24 → 拉代码（或沿用现有目录）→ 装依赖 + 构建前端 → 自动生成 JWT 密钥和初始管理员密码 → 装 systemd 服务 → 配 Nginx → 配每日备份。

### 几个可覆盖的参数

```bash
sudo APP_DIR=/opt/edu-admin \
     GIT_REPO=https://github.com/xxx/edu-admin.git \
     ADMIN_PASSWORD='你的强密码' \
     JWT_SECRET='随机字符串' \
     DOMAIN='jiaowu.example.com' \
     bash deploy/setup.sh
```

- `GIT_REPO`：服务器能直接 clone 时填；留空则要求代码已手动放到 `$APP_DIR`。
- `DOMAIN`：访问域名或公网 IP；留空自动探测服务器公网 IP。
- `ADMIN_PASSWORD` / `JWT_SECRET`：留空则脚本自动生成随机值并写入 `server/.env`。

## 手动部署（不想用 setup.sh 时）

1. 装 Node 24：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
   apt-get install -y nodejs git nginx sqlite3 rsync
   ```
2. 拉代码并装依赖、构建：
   ```bash
   git clone <仓库> /opt/edu-admin
   cd /opt/edu-admin
   (cd server && npm install --omit=dev)
   (cd client && npm install && npm run build)
   ```
3. 写密钥与管理员（见 `server/.env`）：
   ```bash
   cd /opt/edu-admin/server
   umask 077
   echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
   echo "ADMIN_PASSWORD=你的强密码" >> .env
   chmod 600 .env
   set -a && . ./.env && set +a && npm run seed
   ```
4. 装 systemd 服务：
   ```bash
   install -m 644 /opt/edu-admin/deploy/edu-admin.service /etc/systemd/system/edu-admin.service
   chown -R www-data:www-data /opt/edu-admin
   systemctl daemon-reload && systemctl enable --now edu-admin
   ```
5. 配 Nginx（把 `nginx.conf` 里的 `server_name` 改成你的域名/IP 后）：
   ```bash
   cp /opt/edu-admin/deploy/nginx.conf /etc/nginx/sites-available/edu-admin
   ln -s /etc/nginx/sites-available/edu-admin /etc/nginx/sites-enabled/
   rm -f /etc/nginx/sites-enabled/default
   nginx -t && systemctl reload nginx
   ```
6. 配备份 cron（见 `backup.sh` 末尾注释）。

## 日常运维命令

```bash
systemctl status edu-admin      # 看状态
systemctl restart edu-admin     # 重启
journalctl -u edu-admin -f      # 实时看日志
```

## 更新代码

首次部署用 `setup.sh`，之后日常更新用 `update.sh`（会自动先备份数据库、再拉代码、重建前端、重启服务）。

`update.sh` 会自动按自身所在目录定位应用根目录，所以**必须从代码实际所在路径运行**（`/opt/edu-admin` 只是文档里的示例路径，换成你的真实目录）：

```bash
cd /实际/部署/路径        # 例如 cd /opt/edu-admin 或 cd /root/edu-admin
sudo bash deploy/update.sh
```

只改了后端/脚本、前端没动时，可跳过前端重建加快更新：

```bash
sudo SKIP_BUILD=1 bash deploy/update.sh
```

> 找不到代码装在哪？在服务器上执行 `find / -name "update.sh" -path "*/deploy/*" 2>/dev/null`，
> 或 `systemctl cat edu-admin | grep WorkingDirectory` 查看服务的实际工作目录。

手动更新（等价步骤，排查问题时用）：

```bash
cd /实际/部署/路径 && git pull --ff-only
(cd client && npm install && npm run build)
chown -R www-data:www-data /实际/部署/路径
systemctl restart edu-admin
```

## HTTPS（有备案域名时）

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

certbot 会自动改写 nginx 配置并续期。用公网 IP 时跳过此步，先以 HTTP 运行。

## 备份与恢复

- 每日 02:17 自动备份到 `/opt/edu-backups/`（`edu-日期.db` + `uploads/`），保留 14 天。
- 建议同时开腾讯云 Lighthouse 控制台的**定时快照**，双保险。
- 恢复：停服务 → 用快照里的 `.db` 覆盖 `server/data/edu.db`、`uploads/` 覆盖 `server/uploads/` → 起服务。

## 上线前安全检查

这些是项目当前写死的默认值，公网部署必须处理（`setup.sh` 已自动做 1、2 两步）：

1. **管理员密码**：默认 `admin / admin123`，脚本会用 `ADMIN_PASSWORD` 覆盖。
2. **JWT 密钥**：默认 `edu-admin-dev-secret-change-me`，脚本会用随机值覆盖。
3. **CORS 收紧**：`server/src/index.js` 目前 `app.use(cors())` 对任意来源开放，建议改成只允许自己的域名（本目录未自动改，需手动改源码）。
4. **登录限流**：当前没有登录接口限流，建议后续加，防暴力破解。
