import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { signToken, authRequired } from '../auth.js';

const router = Router();

// 扫码登录一次性 code（内存缓存：code -> { user_id, expires }），进程重启即失效（可接受）
const scanCodes = new Map();
const SCAN_TTL = 3 * 60 * 1000; // 3 分钟有效

router.post('/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: '请输入用户名和密码' });
  }
  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);
  if (!user || !user.active) {
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  const token = signToken(user, !!remember);
  const { password_hash, ...safe } = user;
  return res.json({ ok: true, data: { token, user: safe } });
});

// 已登录用户在桌面端生成一个一次性扫码 code，手机端用它换 token 登录
router.post('/scan-code', authRequired, (req, res) => {
  const code = crypto.randomBytes(12).toString('hex');
  scanCodes.set(code, { user_id: req.user.id, expires: Date.now() + SCAN_TTL });
  // 清理过期项（顺带做，避免无限增长）
  for (const [k, v] of scanCodes) if (v.expires < Date.now()) scanCodes.delete(k);
  return res.json({ ok: true, data: { code, expires_in: Math.floor(SCAN_TTL / 1000) } });
});

// 手机端用扫码得到的 code 换取登录态（免密码，一次性）
router.post('/scan-login', (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!code) return res.status(400).json({ ok: false, error: '缺少扫码凭证' });
  const entry = scanCodes.get(code);
  if (!entry || entry.expires < Date.now()) {
    if (entry) scanCodes.delete(code);
    return res.status(401).json({ ok: false, error: '扫码凭证已失效，请重新扫码' });
  }
  scanCodes.delete(code); // 一次性
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(entry.user_id);
  if (!user || !user.active) return res.status(401).json({ ok: false, error: '账号已失效' });
  const token = signToken(user, true);
  const { password_hash, ...safe } = user;
  return res.json({ ok: true, data: { token, user: safe } });
});

router.get('/me', authRequired, (req, res) => {
  const user = db
    .prepare('SELECT id, username, name, role, phone, active, teacher_id, created_at FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  return res.json({ ok: true, data: user });
});

export default router;
