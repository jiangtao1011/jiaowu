// 教务管理 MCP 服务 —— 后端 API 客户端
// 负责：登录换取 token、转发请求到后端 REST API、把响应统一为 { ok, data | error }。
// 后端地址可用环境变量 EDU_ADMIN_BASE 覆盖，默认 http://localhost:4000。

const DEFAULT_BASE = process.env.EDU_ADMIN_BASE || 'http://localhost:4000';

export class EduAdminClient {
  constructor({ baseUrl = DEFAULT_BASE } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = null;
  }

  // 登录：换取 JWT，保存 token
  async login({ username, password }) {
    const r = await this._req('POST', '/api/auth/login', { username, password }, false);
    if (r.ok && r.data?.token) this.token = r.data.token;
    return r;
  }

  // 设置已有 token（供调用方跳过登录）
  setToken(token) {
    this.token = token;
  }

  // 通用请求。auth=true 时自动附加 Bearer token。body 支持 JSON 对象或 FormData（文件上传）。
  async _req(method, path, body, auth = true) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = {};
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (!isForm) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: isForm ? body : (body === undefined ? undefined : JSON.stringify(body)),
    });
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（如导出文件） */ }
    if (!res.ok) {
      const msg = json?.error || `请求失败（HTTP ${res.status}）`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return json ?? { ok: true, data: null };
  }

  // GET 查询（带 query 对象）
  async get(path, query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const suffix = qs.toString() ? `?${qs}` : '';
    return this._req('GET', path + suffix);
  }

  async post(path, body) {
    return this._req('POST', path, body ?? {});
  }
}
