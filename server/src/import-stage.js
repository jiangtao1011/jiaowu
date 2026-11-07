// 导入「预览确认」两阶段共享模块：草稿暂存 + token 生命周期。
// preview 阶段把「已解析 + 已校验 + 已归一化」的行快照存入 import_drafts（不写业务表），
// confirm 阶段凭 token 取回快照直接写库，不重解析、不重校验、不重新 resolve 引用。
import crypto from 'node:crypto';
import { db } from './db.js';

const DRAFT_TTL_MS = 30 * 60 * 1000; // 30 分钟

function token() {
  return crypto.randomBytes(16).toString('hex');
}

function nowLocal() {
  // 与 db 默认时间戳一致（datetime('now','localtime')），用于 expires_at 字符串比较
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function expireAt() {
  const d = new Date(Date.now() + DRAFT_TTL_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 写入草稿，返回 token；顺带清理过期草稿
export function createDraft(kind, userId, payload) {
  const t = token();
  const exp = expireAt();
  db.prepare('DELETE FROM import_drafts WHERE expires_at < ?').run(nowLocal());
  db.prepare(
    'INSERT INTO import_drafts (token, kind, user_id, payload, expires_at) VALUES (?,?,?,?,?)'
  ).run(t, kind, userId ?? null, JSON.stringify(payload), exp);
  return t;
}

// 取回草稿（校验 user_id + kind + 未过期），不存在/过期返回 null
export function getDraft(t, userId, kind) {
  if (!t) return null;
  const row = db.prepare('SELECT * FROM import_drafts WHERE token = ?').get(t);
  if (!row) return null;
  if (row.user_id != null && userId != null && row.user_id !== userId) return null;
  if (row.kind !== kind) return null;
  if (row.expires_at < nowLocal()) {
    db.prepare('DELETE FROM import_drafts WHERE token = ?').run(t);
    return null;
  }
  try {
    return { token: row.token, kind: row.kind, payload: JSON.parse(row.payload) };
  } catch {
    return null;
  }
}

export function deleteDraft(t) {
  if (!t) return;
  db.prepare('DELETE FROM import_drafts WHERE token = ?').run(t);
}
