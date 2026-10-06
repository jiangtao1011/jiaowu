import { Router } from 'express';
import multer from 'multer';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES } from '../auth.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';

const router = Router();
router.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const CLASS_TYPES = ['行政班', '分层', '走班'];

// 计算一个班的「统计班额」：走班默认=合班成员班额之和，若手动填了人数则以手动值为准；其余=自身班额
function effectiveSize(cls) {
  if (cls.type === '走班') {
    if (cls.student_count > 0) return cls.student_count;
    const members = db.prepare('SELECT c.student_count FROM class_members cm JOIN classes c ON c.id = cm.member_class_id WHERE cm.class_id = ?').all(cls.id);
    return members.reduce((s, m) => s + (m.student_count || 0), 0);
  }
  return cls.student_count || 0;
}

// 同步走班合班成员
function syncMembers(classId, memberIds) {
  db.prepare('DELETE FROM class_members WHERE class_id = ?').run(classId);
  if (Array.isArray(memberIds)) {
    const ins = db.prepare('INSERT INTO class_members (class_id, member_class_id) VALUES (?,?)');
    for (const mid of memberIds) {
      const m = Number(mid);
      if (Number.isInteger(m)) ins.run(classId, m);
    }
  }
}

router.get('/', (req, res) => {
  const classes = db.prepare('SELECT * FROM classes ORDER BY grade, type, name').all();
  const rows = classes.map((c) => {
    const members = db
      .prepare('SELECT c.id, c.name FROM class_members cm JOIN classes c ON c.id = cm.member_class_id WHERE cm.class_id = ? ORDER BY c.name')
      .all(c.id);
    const children = db
      .prepare('SELECT id, name, type, student_count, subject FROM classes WHERE parent_id = ? ORDER BY name')
      .all(c.id);
    return { ...c, members, children, effective_size: effectiveSize(c) };
  });
  return res.json({ ok: true, data: rows });
});

// 下载班级导入模板
router.get('/template', (req, res) => {
  downloadTemplate(
    res,
    ['班级名称', '类型', '人数', '年级', '所属班级', '学科'],
    [
      ['高一(1)班', '行政班', '45', '高一', '', ''],
      ['高一(1)班数学A层', '分层', '23', '高一', '高一(1)班', '数学'],
      ['高一政治走班', '走班', '', '高一', '高一(1)班,高一(2)班', '政治'],
      ['高一政治走班A层', '分层', '25', '高一', '高一政治走班', '政治'],
    ],
    '班级导入模板.xlsx'
  );
});

// 批量导入
router.post('/import', roleRequired(...ADMIN_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传班级文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const classByName = Object.fromEntries(db.prepare('SELECT id, name FROM classes').all().map((c) => [c.name, c.id]));
  const insert = db.prepare('INSERT INTO classes (name, type, student_count, grade, parent_id, subject) VALUES (?,?,?,?,?,?)');
  const exists = db.prepare('SELECT id FROM classes WHERE name = ?');
  const insMember = db.prepare('INSERT INTO class_members (class_id, member_class_id) VALUES (?,?)');

  let inserted = 0, skipped = 0;
  const errors = [];

  // 先解析成结构，两遍导入：
  //   第一遍：插入行政班（它们的名称是后续分层/走班引用的基础）
  //   第二遍：插入分层、走班（此时父级/合班成员均已存在，无需按文件顺序）
  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = String(keyOf(row, '班级名称', '班级', 'name') ?? '').trim();
    const type = String(keyOf(row, '类型', 'type') ?? '行政班').trim() || '行政班';
    const finalType = CLASS_TYPES.includes(type) ? type : '行政班';
    const student_count = Number(keyOf(row, '人数', 'student_count') ?? 0) || 0;
    const grade = String(keyOf(row, '年级', 'grade') ?? '').trim() || null;
    const subject = String(keyOf(row, '学科', 'subject') ?? '').trim() || null;
    const parentName = String(keyOf(row, '所属班级', 'parent', 'parent_id') ?? '').trim();
    parsed.push({ line: i + 2, name, finalType, student_count, grade, subject, parentName });
  }

  const insertRow = (p) => {
    if (!p.name) { errors.push(`第 ${p.line} 行缺少班级名称`); return false; }
    if (classByName[p.name] || exists.get(p.name)) { skipped++; return false; }
    const info = insert.run(p.name, p.finalType, p.student_count, p.grade, null, p.subject);
    classByName[p.name] = Number(info.lastInsertRowid);
    inserted++;
    return true;
  };

  // 第一遍：行政班（名称是分层/走班引用的基础）
  for (const p of parsed) if (p.finalType === '行政班') insertRow(p);

  // 第二遍：走班（只依赖行政班）
  for (const p of parsed) {
    if (p.finalType !== '走班') continue;
    if (!p.name) { errors.push(`第 ${p.line} 行缺少班级名称`); continue; }
    if (classByName[p.name] || exists.get(p.name)) { skipped++; continue; }

    // 所属班级 = 逗号/顿号分隔的合班行政班名单
    const members = (p.parentName || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const memberIds = [];
    for (const m of members) {
      const mid = classByName[m] ?? exists.get(m)?.id;
      if (!mid) { errors.push(`第 ${p.line} 行合班班级「${m}」不存在`); continue; }
      memberIds.push(mid);
    }
    if (!memberIds.length) { errors.push(`第 ${p.line} 行走班「${p.name}」缺少合班班级`); continue; }
    const info = insert.run(p.name, '走班', p.student_count, p.grade, null, p.subject);
    const newId = Number(info.lastInsertRowid);
    classByName[p.name] = newId;
    for (const mid of memberIds) insMember.run(newId, mid);
    inserted++;
  }

  // 第三遍：分层（依赖行政班或走班）
  for (const p of parsed) {
    if (p.finalType !== '分层') continue;
    if (!p.name) { errors.push(`第 ${p.line} 行缺少班级名称`); continue; }
    if (classByName[p.name] || exists.get(p.name)) { skipped++; continue; }

    // 所属班级 = 父级（行政班或走班）
    const pid = classByName[p.parentName] ?? exists.get(p.parentName)?.id;
    if (!pid) { errors.push(`第 ${p.line} 行所属班级「${p.parentName}」不存在`); continue; }
    const info = insert.run(p.name, '分层', p.student_count, p.grade, pid, p.subject);
    classByName[p.name] = Number(info.lastInsertRowid);
    inserted++;
  }

  logAudit(req.user.id, 'import_classes', 'classes', `批量导入班级 ${inserted} 条${skipped ? `，跳过已存在 ${skipped} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, skipped, errors } });
});

router.post('/', roleRequired(...ADMIN_ROLES), (req, res) => {
  const { name, type, student_count, grade, parent_id, subject, member_ids } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: '班级名称必填' });
  const exists = db.prepare('SELECT id FROM classes WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ ok: false, error: '班级已存在' });

  const finalType = CLASS_TYPES.includes(type) ? type : '行政班';
  const info = db
    .prepare('INSERT INTO classes (name, type, student_count, grade, parent_id, subject) VALUES (?,?,?,?,?,?)')
    .run(name, finalType, Number(student_count) || 0, grade ?? null, parent_id ? Number(parent_id) : null, subject ?? null);
  const newId = Number(info.lastInsertRowid);
  if (finalType === '走班') syncMembers(newId, member_ids);
  logAudit(req.user.id, 'create_class', `classes:${newId}`, `创建班级 ${name}（${finalType}）`);
  return res.json({ ok: true, data: { id: newId } });
});

router.patch('/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ ok: false, error: '班级不存在' });

  const { name, type, student_count, grade, parent_id, subject, member_ids } = req.body || {};
  const finalType = type ?? target.type;
  db.prepare('UPDATE classes SET name = ?, type = ?, student_count = ?, grade = ?, parent_id = ?, subject = ? WHERE id = ?')
    .run(name ?? target.name, finalType, Number(student_count ?? target.student_count), grade ?? target.grade,
      parent_id !== undefined ? (parent_id ? Number(parent_id) : null) : target.parent_id, subject ?? target.subject, id);
  if (finalType === '走班') {
    // 仅当请求显式携带 member_ids 时同步合班成员；否则保持原成员不变（避免只改人数时误清空）
    if (Array.isArray(member_ids)) syncMembers(id, member_ids);
  } else if (target.type === '走班' && finalType !== '走班') db.prepare('DELETE FROM class_members WHERE class_id = ?').run(id);
  logAudit(req.user.id, 'update_class', `classes:${id}`, `更新班级 ${name ?? target.name}`);
  return res.json({ ok: true, data: { id } });
});

export default router;
