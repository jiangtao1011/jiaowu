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

// 全局只读兜底：校长（纯只读角色）不允许任何写操作（非 GET/HEAD）。
// 放在各业务路由之前挂载，作为「漏改路由」的防御层——即便某处忘记收紧写权限，
// 校长也无法意外写入。数据范围仍由各路由的角色组显式控制。
export function readonlyGuard(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(); // 未登录，交给后续 authRequired 处理
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return next(); }
  if (user.role === '校长' && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({ ok: false, error: '校长为只读权限，无法执行该操作' });
  }
  next();
}

// ===== 角色组（岗位制重构，2026-11-05 定稿）=====
// 五层：系统层 admin / 决策层 校长 / 管理层 教务主任 / 执行层 教务员 / 教学层 教研组长·备课组长·年级组长·教师

// 系统层：数据库管理、角色管理独占
export const SYSTEM_ROLES = ['admin'];

// 决策层：纯只读（结果汇总 + 下钻 + 导出），不审批、不操作、不改配置
export const READONLY_ROLES = ['校长'];

// 管理层：业务配置（课酬系数/检查维度/考核规则/校历）+ 终审 + 建号
export const DIRECTOR_ROLES = ['admin', '教务主任'];

// 执行层：录入维护（档案/课表/通知/成绩/检查提交）
export const CLERK_ROLES = ['admin', '教务主任', '教务员'];

// 结果查看（含校长只读）：课酬统计/导出/考核排名/审批状态/数据看板
export const RESULT_VIEW_ROLES = ['admin', '校长', '教务主任', '教务员'];

// 全量业务管理（等价旧「admin+教务员+教务处」，教务处→教务主任）
export const ADMIN_ROLES = ['admin', '教务主任', '教务员'];

// 账号管理：admin + 教务主任（主任可建号/改普通信息，不可改角色、不动 admin）
export const USER_EDIT_ROLES = ['admin', '教务主任'];

// 常规检查配置（类型/维度/大类/配置项）：admin + 教务主任
export const INSPECTION_CONFIG_ROLES = ['admin', '教务主任'];
// 常规检查提交：admin/教务主任/教务员 + 教研组长 + 备课组长
export const INSPECTION_SUBMIT_ROLES = ['admin', '教务主任', '教务员', '教研组长', '备课组长'];

// 系统全部有效角色（岗位制重构后 8 角色）
export const VALID_ROLES = ['admin', '校长', '教务主任', '教务员', '教研组长', '备课组长', '年级组长', '教师'];
