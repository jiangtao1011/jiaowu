import os from 'node:os';

// 取对外可访问的基础地址（生成分享链接用）。优先级：
// 1) PUBLIC_BASE_URL 显式配置（生产建议配成 https 域名，链信/企业微信才能稳定打开）
// 2) 当前请求 Host——但仅当它是「主机名/域名」（非 IP）时才用，因为 IP 会变、不可作为分享地址
// 3) mDNS 主机名 + 后端端口（兜底；主机名稳定，局域网 IP 会变故弃用）
export function publicBase(req) {
  const cfg = process.env.PUBLIC_BASE_URL;
  if (cfg) return cfg.replace(/\/+$/, '');

  const host = (req.headers.host || '').trim();
  const hostname = host.replace(/:\d+$/, '');
  if (isStableHostname(hostname)) {
    return `http://${host}`;
  }

  // 兜底：mDNS 主机名（如 jiaowu.local）稳定不变；端口用后端 PORT（前端由后端统一托管）
  const port = process.env.PORT || '4000';
  const mdns = normalizeHostname(os.hostname());
  if (mdns) return `http://${mdns}:${port}`;
  return '';
}

// 是否为「稳定主机名」：非空、非 localhost/回环、且不是裸 IP（IPv4/IPv6）。
// 裸 IP 会随 DHCP 变化，不能作为分享地址，故视为不稳定。
function isStableHostname(hostname) {
  if (!hostname) return false;
  if (/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(hostname)) return false;
  // 纯 IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  // IPv6（含方括号 / 含冒号）
  if (hostname.includes(':') || hostname.startsWith('[')) return false;
  return true;
}

// 规范化主机名：去掉可能带的多余后缀，统一成 <名>.local 形式。
// os.hostname() 在 macOS 上通常已返回 name.local；Linux/其他平台可能只返回 name。
function normalizeHostname(h) {
  if (!h) return '';
  const name = h.replace(/\.local\.?$/i, '').replace(/\.$/, '');
  if (!name || /^(localhost|127\.0\.0\.1|::1)$/i.test(name)) return '';
  return `${name}.local`;
}
