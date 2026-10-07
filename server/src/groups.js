// 备课组/教研组的统一推导（自动 + 手动），供常规检查、教学业绩共用。
// 关键约定：组用「key 字符串」标识——
//   - 自动组（按教师/课表推导，不落库）：`教研组:${subject}`、`备课组:${grade}:${subject}`
//   - 手动组（落库 teacher_groups，is_auto=0）：`manual:${id}`
// 业绩考核的「考核单元」是备课组（type='备课组'），教研组由备课组聚合。
import { db } from './db.js';

// 自动推导组：教研组=学科、备课组=学科+年级（来源 teachers.subject 与 schedules JOIN classes.grade）
export function autoGroups() {
  const groups = [];
  const subjects = db.prepare("SELECT DISTINCT subject FROM teachers WHERE subject IS NOT NULL AND subject != '' ORDER BY subject").all();
  for (const { subject } of subjects) {
    const members = db.prepare('SELECT id FROM teachers WHERE subject = ?').all(subject).map((r) => r.id);
    groups.push({ key: `教研组:${subject}`, name: `${subject}教研组`, type: '教研组', subject, grade: null, is_auto: true, members });
  }
  const rows = db.prepare(`
    SELECT DISTINCT t.subject AS subject, c.grade AS grade
    FROM schedules s
    JOIN teachers t ON t.id = s.teacher_id
    JOIN classes c ON c.id = s.class_id
    WHERE t.subject IS NOT NULL AND t.subject != '' AND c.grade IS NOT NULL AND c.grade != ''
    ORDER BY c.grade, t.subject`).all();
  for (const { subject, grade } of rows) {
    const members = db.prepare(`
      SELECT DISTINCT t.id FROM schedules s
      JOIN teachers t ON t.id = s.teacher_id
      JOIN classes c ON c.id = s.class_id
      WHERE t.subject = ? AND c.grade = ?`).all(subject, grade).map((r) => r.id);
    groups.push({ key: `备课组:${grade}:${subject}`, name: `${grade}${subject}备课组`, type: '备课组', subject, grade, is_auto: true, members });
  }
  return groups;
}

// 手动组：teacher_groups（is_auto=0），成员在 teacher_group_members
export function manualGroups() {
  const groups = db.prepare('SELECT * FROM teacher_groups WHERE is_auto = 0 ORDER BY type, grade, subject, id').all();
  return groups.map((g) => ({
    ...g,
    key: `manual:${g.id}`,
    is_auto: false,
    leader_name: g.leader_id ? (db.prepare('SELECT name FROM teachers WHERE id = ?').get(g.leader_id)?.name ?? null) : null,
    members: db.prepare('SELECT teacher_id FROM teacher_group_members WHERE group_id = ?').all(g.id).map((m) => m.teacher_id),
  }));
}

// 全部组（手动 + 自动），供录入/统计统一遍历
export function listGroups() {
  return [...manualGroups(), ...autoGroups()];
}

// 按 key 解析单个组对象（无则 null）
export function resolveGroup(key) {
  return listGroups().find((g) => g.key === key) ?? null;
}
