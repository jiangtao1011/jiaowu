// 角色作用域：把「角色 + 身份」翻译成「可见教师集合」，供检查/课时等模块按范围过滤。
// 返回规则：
//   - admin / 教务主任 / 教务员 / 分管领导 → null（全量，不过滤）
//   - 教师 → [自己]
//   - 教研组长 → 本学科全体教师
//   - 备课组长 → 本学科 + 本年级的教师
//   - 年级组长 → 本年级全体教师
// 依赖：users.teacher_id（账号↔教师）、teachers.subject、schedules(任课年级)、teacher_groups(手动/自动组)。
import { db } from './db.js';
import { ADMIN_ROLES, READONLY_ROLES } from './auth.js';
import { listGroups } from './groups.js';

// 全量查看视角：管理员（admin/教务主任/教务员）+ 分管领导（纯只读，看全校）
const FULL_VIEW_ROLES = [...ADMIN_ROLES, ...READONLY_ROLES];

// 用户 → 教师 id（无则 null）
function teacherIdOf(user) {
  const tid = user?.teacher_id;
  return tid ? Number(tid) : null;
}

// 教师的学科
function subjectOf(teacherId) {
  if (!teacherId) return null;
  const r = db.prepare('SELECT subject FROM teachers WHERE id = ?').get(teacherId);
  return r?.subject || null;
}

// 教师任课的年级集合（从课表推导；teacher_classes 通常为空，不能依赖）
function gradesOf(teacherId) {
  if (!teacherId) return new Set();
  const rows = db.prepare(`
    SELECT DISTINCT c.grade FROM schedules s
    JOIN classes c ON c.id = s.class_id
    WHERE s.teacher_id = ? AND c.grade IS NOT NULL AND c.grade != ''`).all(teacherId);
  return new Set(rows.map((r) => r.grade));
}

// 年级组长负责的年级（优先 users.managed_grade，否则从任课推导）
function managedGradeOf(user) {
  if (user?.managed_grade) return String(user.managed_grade);
  const tid = teacherIdOf(user);
  if (!tid) return null;
  const gs = [...gradesOf(tid)];
  return gs.length ? gs[0] : null;
}

// 备课组长负责的年级：优先 teacher_groups 里 leader_id=自己 teacher_id 的组的 grade
function ledGradeOf(user) {
  const tid = teacherIdOf(user);
  if (!tid) return null;
  const g = db.prepare("SELECT grade FROM teacher_groups WHERE leader_id = ? AND grade IS NOT NULL AND grade != '' ORDER BY id LIMIT 1").get(tid);
  if (g?.grade) return g.grade;
  const gs = [...gradesOf(tid)];
  return gs.length ? gs[0] : null;
}

// 返回该用户可见的教师 id 数组；null = 全量（管理员/分管领导）
export function visibleTeacherIds(user) {
  const role = user?.role;
  if (!role) return [];
  if (FULL_VIEW_ROLES.includes(role)) return null;
  const tid = teacherIdOf(user);

  if (role === '教研组长') {
    const subject = subjectOf(tid);
    if (!subject) return tid ? [tid] : [];
    return db.prepare("SELECT id FROM teachers WHERE subject = ?").all(subject).map((r) => r.id);
  }

  if (role === '备课组长') {
    const subject = subjectOf(tid);
    const grade = ledGradeOf(user);
    if (!subject) return tid ? [tid] : [];
    // 本学科 + 本年级（年级未知则退化为本学科）
    if (grade) {
      const rows = db.prepare(`
        SELECT DISTINCT t.id FROM schedules s
        JOIN teachers t ON t.id = s.teacher_id
        JOIN classes c ON c.id = s.class_id
        WHERE t.subject = ? AND c.grade = ?`).all(subject, grade).map((r) => r.id);
      if (rows.length) return rows;
    }
    return db.prepare("SELECT id FROM teachers WHERE subject = ?").all(subject).map((r) => r.id);
  }

  if (role === '年级组长') {
    const grade = managedGradeOf(user);
    if (!grade) return tid ? [tid] : [];
    return db.prepare(`
      SELECT DISTINCT t.id FROM schedules s
      JOIN teachers t ON t.id = s.teacher_id
      JOIN classes c ON c.id = s.class_id
      WHERE c.grade = ?`).all(grade).map((r) => r.id);
  }

  // 教师（及其它未知角色）→ 只有自己
  return tid ? [tid] : [];
}

// 返回该用户可见的年级集合；null = 全量（管理员/分管领导）
export function visibleGrades(user) {
  const role = user?.role;
  if (!role) return [];
  if (FULL_VIEW_ROLES.includes(role)) return null;
  if (role === '年级组长') {
    const g = managedGradeOf(user);
    return g ? [g] : [];
  }
  if (role === '备课组长') {
    const g = ledGradeOf(user);
    return g ? [g] : [];
  }
  // 教研组长 / 教师：年级维度不收敛，返回 null 交由教师维度过滤
  return null;
}

// 是否为「管理员级」（可跨全量）角色（含分管领导全量只读视角）
export function isAdminRole(user) {
  return FULL_VIEW_ROLES.includes(user?.role);
}

// 组级作用域：返回该用户可见的「组 key 数组」；null = 全量（管理员/分管领导）
// 依赖 ../groups.js 的 listGroups（自动 + 手动组）。
export function visibleGroups(user) {
  const role = user?.role;
  if (!role) return [];
  if (FULL_VIEW_ROLES.includes(role)) return null;
  const tid = teacherIdOf(user);

  // 教研组长 → 本学科全部组（教研组 + 本学科各年级备课组）
  if (role === '教研组长') {
    const subject = subjectOf(tid);
    if (!subject) return [];
    return listGroups()
      .filter((g) => g.subject === subject)
      .map((g) => g.key);
  }

  // 备课组长 → 本学科 + 本年级（退化：本学科全部）
  if (role === '备课组长') {
    const subject = subjectOf(tid);
    if (!subject) return [];
    const grade = ledGradeOf(user);
    return listGroups()
      .filter((g) => g.subject === subject && (g.type === '教研组' || !grade || g.grade === grade))
      .map((g) => g.key);
  }

  // 年级组长 → 本年级全部备课组
  if (role === '年级组长') {
    const grade = managedGradeOf(user);
    if (!grade) return [];
    return listGroups()
      .filter((g) => g.type === '备课组' && g.grade === grade)
      .map((g) => g.key);
  }

  // 教师 → 自己所在的备课组
  if (tid) {
    return listGroups()
      .filter((g) => g.type === '备课组' && g.members.includes(tid))
      .map((g) => g.key);
  }
  return [];
}
