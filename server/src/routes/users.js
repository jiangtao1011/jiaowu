import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, USER_EDIT_ROLES, VALID_ROLES } from '../auth.js';

const router = Router();

router.use(authRequired);

// 列表（所有登录用户可查看，供选择人员等）
router.get('/', (req, res) => {
  const rows = db
    .prepare(`SELECT u.id, u.username, u.name, u.role, u.phone, u.active, u.teacher_id, u.managed_grade, u.created_at,
                     t.name AS teacher_name
              FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id
              ORDER BY u.id`)
    .all();
  return res.json({ ok: true, data: rows });
});

// 创建用户（admin + 教务员）。教务员不能创建 admin 角色账号。
router.post('/', roleRequired(...USER_EDIT_ROLES), (req, res) => {
  const { username, password, name, role, phone, teacher_id, managed_grade } = req.body || {};
  if (!username || !password || !name) {
    return res.status(400).json({ ok: false, error: '用户名、密码、姓名必填' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ ok: false, error: '无效的角色' });
  }
  if (req.user.role !== 'admin' && role === 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可创建管理员账号' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ ok: false, error: '用户名已存在' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, name, role, phone, teacher_id, managed_grade) VALUES (?,?,?,?,?,?,?)')
    .run(username, hash, name, role, phone ?? null, teacher_id ? Number(teacher_id) : null, managed_grade ?? null);
  logAudit(req.user.id, 'create_user', `users:${info.lastInsertRowid}`, `创建用户 ${username}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 更新用户（admin + 教务员）。教务员不能改角色、不能动 admin 账号。
router.patch('/:id', roleRequired(...USER_EDIT_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ ok: false, error: '用户不存在' });
  const isAdminUser = req.user.role === 'admin';

  // 非 admin 不能改 admin 账号
  if (!isAdminUser && target.role === 'admin') {
    return res.status(403).json({ ok: false, error: '仅管理员可修改管理员账号' });
  }

  const { name, role, phone, active, password, teacher_id, managed_grade } = req.body || {};
  const newName = name ?? target.name;
  let newRole = target.role;
  if (role !== undefined) {
    if (!isAdminUser) return res.status(403).json({ ok: false, error: '仅管理员可修改角色' });
    newRole = VALID_ROLES.includes(role) ? role : target.role;
  }
  const newPhone = phone !== undefined ? phone : target.phone;
  const newActive = active !== undefined ? (active ? 1 : 0) : target.active;
  const newTeacherId = teacher_id !== undefined ? (teacher_id ? Number(teacher_id) : null) : target.teacher_id;
  const newManagedGrade = managed_grade !== undefined ? (managed_grade || null) : target.managed_grade;

  db.prepare('UPDATE users SET name = ?, role = ?, phone = ?, active = ?, teacher_id = ?, managed_grade = ? WHERE id = ?')
    .run(newName, newRole, newPhone, newActive, newTeacherId, newManagedGrade, id);
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }
  logAudit(req.user.id, 'update_user', `users:${id}`, `更新用户 ${target.username}`);
  return res.json({ ok: true, data: { id } });
});

export default router;
