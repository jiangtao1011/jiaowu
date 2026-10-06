#!/bin/bash
# 教务管理应用一键启动脚本
#
# 用法：
#   ./start.sh           # 直接启动（用已有的前端构建产物）
#   ./start.sh build     # 先重新构建前端，再启动（改了 client/ 代码后用这个）
#
# 启动后访问固定地址（mDNS，IP 变化不受影响）：
#   http://macdemacbook-pro.local:4000
#
# 说明：前端已由后端 4000 端口统一托管，只需这一个进程。

set -e
cd "$(dirname "$0")"

# 主机名（转小写，与 mDNS 解析一致；用于打印固定访问地址）
HOST="$(scutil --get LocalHostName 2>/dev/null | tr 'A-Z' 'a-z' || echo localhost)"

# 若指定 build，先构建前端
if [ "$1" = "build" ] || [ ! -d client/dist ]; then
  echo "==> 构建前端产物..."
  (cd client && npm run build)
fi

echo "==> 启动后端（含前端静态托管）..."
cd server
echo ""
echo "  固定访问地址: http://${HOST}.local:4000"
echo "  本机调试:     http://localhost:4000"
echo ""
npm start
