#!/bin/bash
# =============================================================================
# 教务管理应用 一键启动/重启/停止脚本
#
# 两种运行模式：
#   【生产模式】（默认）前端构建产物由后端 4000 端口统一托管，单进程、最省事，
#                局域网手机/桌面只需访问一个地址。改完前端代码用 restart --build。
#   【开发模式】 后端 4000 + 前端 vite 5173 双进程，前端热更新，改前端代码即时生效。
#
# 用法：
#   ./start.sh                    # 生产模式启动（首次/缺产物时自动构建前端）
#   ./start.sh start              # 同上
#   ./start.sh build              # 重新构建前端并启动（改了 client/ 代码后用）
#   ./start.sh restart            # 重启后端（不重建前端，快）
#   ./start.sh restart --build    # 重建前端 + 重启后端
#   ./start.sh stop               # 停止全部
#   ./start.sh status             # 查看运行状态与访问地址
#   ./start.sh logs               # 查看后端日志（-f 持续跟随）
#   ./start.sh dev                # 开发模式（双进程，前端热更新）
#   ./start.sh dev-stop           # 停止开发模式
#
# 访问地址（启动后按 status 显示的为准）：
#   局域网 IP:   http://<本机IP>:4000     —— 手机/桌面都填这个；有域名时用域名
#   本机调试:    http://localhost:4000
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")"

# ---------- 配置 ----------
RUN_DIR=".run"                       # 运行时目录（PID / 日志），已 gitignore
LOG_DIR="$RUN_DIR/logs"
SERVER_PORT=4000                     # 后端（生产=托管前端）
CLIENT_PORT=5173                     # 前端 vite（仅开发模式）
PID_SERVER="$RUN_DIR/server.pid"
PID_CLIENT="$RUN_DIR/client.pid"

# ---------- 颜色 ----------
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[0;36m'; NC='\033[0m'
ok()  { echo -e "${G}$*${NC}"; }
warn(){ echo -e "${Y}$*${NC}"; }
err() { echo -e "${R}$*${NC}"; }
info(){ echo -e "${B}$*${NC}"; }

# ---------- 工具 ----------
# 取端口上监听的进程 PID（lsof 兜底，比 PID 文件更可靠）
pid_of_port() {
  lsof -ti ":$1" 2>/dev/null | head -1 || true
}

# 停止某端口上的进程
kill_port() {
  local port="$1" label="$2"
  local pid; pid="$(pid_of_port "$port")"
  if [ -z "$pid" ]; then
    echo "  ${label}（端口 $port）未在运行"
    return 0
  fi
  echo "  停止 ${label}（端口 $port，PID $pid）"
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    [ -z "$(pid_of_port "$port")" ] && break
    sleep 0.4
  done
  if [ -n "$(pid_of_port "$port")" ]; then
    kill -9 "$(pid_of_port "$port")" 2>/dev/null || true
    sleep 0.3
  fi
}

# 本机局域网 IP（用于打印手机可访问地址）
lan_ip() {
  ipconfig getifaddr en0 2>/dev/null \
    || ipconfig getifaddr en1 2>/dev/null \
    || echo ""
}

# ---------- 生产模式 ----------
# 启动后端（单进程，托管前端）
start_prod() {
  local rebuild="${1:-0}"
  if [ "$rebuild" = "1" ] || [ ! -d client/dist ]; then
    info "==> 构建前端产物（client/dist）..."
    (cd client && npm run build)
  fi

  if [ -n "$(pid_of_port "$SERVER_PORT")" ]; then
    warn "后端已在运行（端口 $SERVER_PORT），无需重复启动。"
    return 0
  fi

  info "==> 启动后端（含前端静态托管，端口 $SERVER_PORT）..."
  mkdir -p "$LOG_DIR"
  # 直接 node 启动（避免 npm 包裹层导致 PID 不准确）
  (
    cd server
    nohup node src/index.js > "../$LOG_DIR/server.log" 2>&1 &
    echo $! > "../$PID_SERVER"
  )
  sleep 1.5

  if [ -z "$(pid_of_port "$SERVER_PORT")" ]; then
    err "后端启动失败，请查看日志：./start.sh logs"
    exit 1
  fi
  ok "后端已启动。"
}

# ---------- 开发模式 ----------
start_dev() {
  if [ -z "$(pid_of_port "$SERVER_PORT")" ]; then
    info "==> 启动后端（端口 $SERVER_PORT）..."
    (
      cd server
      nohup node src/index.js > "../$LOG_DIR/server.log" 2>&1 &
      echo $! > "../$PID_SERVER"
    )
  else
    info "后端已在运行（端口 $SERVER_PORT）"
  fi

  if [ -z "$(pid_of_port "$CLIENT_PORT")" ]; then
    info "==> 启动前端 vite（端口 $CLIENT_PORT，热更新）..."
    (
      cd client
      nohup npm run dev > "../$LOG_DIR/client.log" 2>&1 &
      echo $! > "../$PID_CLIENT"
    )
  else
    info "前端已在运行（端口 $CLIENT_PORT）"
  fi
  sleep 2
}

# 停止开发模式（不碰后端？不，都停更干净——见 stop_all）
stop_all() {
  info "==> 停止前后端..."
  kill_port "$CLIENT_PORT" "前端 vite"
  kill_port "$SERVER_PORT" "后端"
  rm -f "$PID_SERVER" "$PID_CLIENT"
  ok "已停止。"
}

# ---------- 状态 ----------
show_status() {
  local ip; ip="$(lan_ip)"
  echo ""
  if [ -n "$ip" ]; then
    echo "  ★ 局域网访问地址: http://${ip}:${SERVER_PORT}   （手机/桌面都填这个；有域名时用域名）"
  else
    echo "  ★ 局域网访问地址: 未检测到，请手动查本机 IP 后访问 http://<IP>:${SERVER_PORT}"
  fi
  echo "    本机调试:        http://localhost:${SERVER_PORT}"
  echo ""
  local spid cpid
  spid="$(pid_of_port "$SERVER_PORT")"
  cpid="$(pid_of_port "$CLIENT_PORT")"
  if [ -n "$spid" ]; then ok "  ● 后端  运行中（端口 $SERVER_PORT，PID $spid）"; else echo "  ○ 后端  未运行"; fi
  if [ -n "$cpid" ]; then ok "  ● 前端  运行中（端口 $CLIENT_PORT，PID $cpid，开发模式）"; else echo "  ○ 前端  未运行（生产模式由后端托管，无需单独前端）"; fi
  echo ""
}

# ---------- 日志 ----------
show_logs() {
  local follow="${1:-0}"
  if [ "$follow" = "1" ]; then
    tail -f "$LOG_DIR/server.log"
  else
    tail -n 60 "$LOG_DIR/server.log" 2>/dev/null || err "暂无后端日志。"
  fi
}

# ---------- 命令分发 ----------
CMD="${1:-start}"
case "$CMD" in
  start)
    start_prod 0
    show_status
    ;;
  build)
    start_prod 1
    show_status
    ;;
  restart)
    REBUILD=0
    [ "${2:-}" = "--build" ] && REBUILD=1
    info "==> 重启后端..."
    kill_port "$SERVER_PORT" "后端"
    start_prod "$REBUILD"
    show_status
    ;;
  stop)
    stop_all
    ;;
  status)
    show_status
    ;;
  logs)
    FOLLOW=0
    [ "${2:-}" = "-f" ] && FOLLOW=1
    show_logs "$FOLLOW"
    ;;
  dev)
    start_dev
    show_status
    ;;
  dev-stop)
    stop_all
    ;;
  *)
    err "未知命令：$CMD"
    echo ""
    echo "可用命令：start | build | restart [--build] | stop | status | logs [-f] | dev | dev-stop"
    exit 1
    ;;
esac
