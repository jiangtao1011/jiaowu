import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'edu-admin-dev-secret-change-me';
const TOKEN_EXPIRES = '7d';
const TOKEN_EXPIRES_REMEMBER = '30d';

// expiresIn 可用 '7d' 等字符串；remember=true 用 30 天长期
export function signToken(user, remember = false) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name, teacher_id: user.teacher_id ?? null },
    JWT_SECRET,
    { expiresIn: remember ? TOKEN_EXPIRES_REMEMBER : TOKEN_EXPIRES }
  );
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: '登录已失效，请重新登录' });
  }
}

// 可选认证：有 token 则解析到 req.user，无则 req.user=null，不拦截。
// 供免登录分享页的互动接口用（登录用账号身份，访客走姓名）。
export function authOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { req.user = null; }
  } else {
    req.user = null;
  }
  next();
}

// 仅允许指定角色访问；roles 为数组
export function roleRequired(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: '无权限执行该操作' });
    }
    next();
  };
}

// 教务员 / 教务处 视为管理员，可管理基础信息与账号
export const ADMIN_ROLES = ['admin', '教务员', '教务处'];

// 账号管理：仅 admin 全权；教务员可建账号/改普通信息但不改角色；教务处无
export const USER_EDIT_ROLES = ['admin', '教务员'];

// 常规检查配置（类型/维度/大类/配置项）：admin + 教务处
export const INSPECTION_CONFIG_ROLES = ['admin', '教务处'];
// 常规检查提交：admin/教务员/教务处 + 教研组长 + 备课组长
export const INSPECTION_SUBMIT_ROLES = ['admin', '教务员', '教务处', '教研组长', '备课组长'];
