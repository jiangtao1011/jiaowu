import os from 'node:os';

// 取对外可访问的基础地址（生成分享链接用）。优先级：
// 1) PUBLIC_BASE_URL 显式配置（有域名 / 固定公网地址时配这个，链信 / 企业微信才能稳定打开）
// 2) 当前请求 Host（IP 或域名直接用——局域网手机 / 桌面通过 IP 或域名访问，分享链接应与之保持一致）
// 3) 本机网卡 IP 兜底（无 Host 时，取第一个非回环 IPv4）
export function publicBase(req) {
  const cfg = process.env.PUBLIC_BASE_URL;
  if (cfg) return cfg.replace(/\/+$/, '');

  const host = (req.headers.host || '').trim();
  if (host) return `http://${host}`;

  const ip = lanIp();
  if (ip) return `http://${ip}:${process.env.PORT || '4000'}`;
  return '';
}

// 取本机第一个非回环 IPv4（兜底用）
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '';
}
