import os from 'node:os';

const FRONTEND_PORT = process.env.FRONTEND_PORT || '5173';

// 取对外可访问的基础地址（生成分享链接用）。优先级：
// 1) PUBLIC_BASE_URL 显式配置（生产建议配成 https 域名，链信/企业微信才能稳定打开）
// 2) 当前请求 Host（非 localhost 时，说明正通过局域网 IP / 域名访问）
// 3) 服务器局域网 IP + 前端端口（本机 localhost 访问时的兜底，避免复制出 localhost 链接）
export function publicBase(req) {
  const cfg = process.env.PUBLIC_BASE_URL;
  if (cfg) return cfg.replace(/\/+$/, '');
  const host = (req.headers.host || '').trim();
  const hostname = host.replace(/:\d+$/, '');
  if (hostname && !/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hostname)) {
    return `http://${host}`;
  }
  const ip = lanIP();
  return ip ? `http://${ip}:${FRONTEND_PORT}` : '';
}

// 取首个非内网的 IPv4 局域网地址
export function lanIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ifc of ifs[name] || []) {
      if (ifc.family === 'IPv4' && !ifc.internal) return ifc.address;
    }
  }
  return null;
}
