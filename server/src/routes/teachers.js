import { Router } from 'express';
import multer from 'multer';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES } from '../auth.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';

const router = Router();
router.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 课酬标准的列名（与前端一致）
const PAY_KEYS = ['夏令营', '冬令营', '全员夏令营', '全员冬令营', '节假补课'];

router.get('/', (req, res) => {
  const teachers = db.prepare('SELECT * FROM teachers ORDER BY id').all();
  const rows = teachers.map((t) => {
    const links = db
      .prepare('SELECT tc.*, c.name as class_name, c.type as class_type, c.subject as class_subject FROM teacher_classes tc JOIN classes c ON c.id = tc.class_id WHERE tc.teacher_id = ? ORDER BY tc.id')
      .all(t.id);
    return { ...t, classes: links };
  });
  return res.json({ ok: true, data: rows });
});

// 下载教师导入模板
router.get('/template', (req, res) => {
  downloadTemplate(
    res,
    ['姓名', '电话', '学科', ...PAY_KEYS],
    [['张三', '13800000000', '数学', '100', '120', '150', '170', '200']],
    '教师导入模板.xlsx'
  );
});

// 批量导入
router.post('/import', roleRequired(...ADMIN_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传教师文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const insert = db.prepare('INSERT INTO teachers (name, phone, subject, pay_standard) VALUES (?,?,?,?)');
  const exists = db.prepare('SELECT id FROM teachers WHERE name = ?');
  let inserted = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = String(keyOf(row, '姓名', '教师', 'name') ?? '').trim();
    if (!name) { errors.push(`第 ${i + 2} 行缺少姓名`); continue; }
    if (exists.get(name)) { skipped++; continue; }

    const phone = String(keyOf(row, '电话', 'phone') ?? '').trim() || null;
    const subject = String(keyOf(row, '学科', '科目', 'subject') ?? '').trim() || null;
    const pay = {};
    for (const k of PAY_KEYS) {
      const v = Number(keyOf(row, k) ?? '');
      if (Number.isFinite(v) && v > 0) pay[k] = v;
    }
    insert.run(name, phone, subject, Object.keys(pay).length ? JSON.stringify(pay) : null);
    inserted++;
  }

  logAudit(req.user.id, 'import_teachers', 'teachers', `批量导入教师 ${inserted} 条${skipped ? `，跳过已存在 ${skipped} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, skipped, errors } });
});

router.post('/', roleRequired(...ADMIN_ROLES), (req, res) => {
  const { name, phone, subject, pay_standard } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: '教师姓名必填' });
  const info = db
    .prepare('INSERT INTO teachers (name, phone, subject, pay_standard) VALUES (?,?,?,?)')
    .run(name, phone ?? null, subject ?? null, pay_standard ? JSON.stringify(pay_standard) : null);
  logAudit(req.user.id, 'create_teacher', `teachers:${info.lastInsertRowid}`, `创建教师 ${name}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ ok: false, error: '教师不存在' });

  const { name, phone, subject, pay_standard, active } = req.body || {};
  const ps = pay_standard !== undefined ? JSON.stringify(pay_standard) : target.pay_standard;
  db.prepare('UPDATE teachers SET name = ?, phone = ?, subject = ?, pay_standard = ?, active = ? WHERE id = ?')
    .run(name ?? target.name, phone ?? target.phone, subject ?? target.subject, ps, active !== undefined ? (active ? 1 : 0) : target.active, id);
  logAudit(req.user.id, 'update_teacher', `teachers:${id}`, `更新教师 ${name ?? target.name}`);
  return res.json({ ok: true, data: { id } });
});

// 任课关系（带时间版本，保留历史）
router.post('/:id/classes', roleRequired(...ADMIN_ROLES), (req, res) => {
  const teacherId = Number(req.params.id);
  const { class_id, subject, effective_from } = req.body || {};
  if (!class_id) return res.status(400).json({ ok: false, error: '请选择班级' });
  const info = db
    .prepare('INSERT INTO teacher_classes (teacher_id, class_id, subject, effective_from) VALUES (?,?,?,?)')
    .run(teacherId, Number(class_id), subject ?? null, effective_from ?? null);
  logAudit(req.user.id, 'assign_teacher_class', `teacher_classes:${info.lastInsertRowid}`, `教师 ${teacherId} 任教班级 ${class_id}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.delete('/:id/classes/:linkId', roleRequired(...ADMIN_ROLES), (req, res) => {
  const linkId = Number(req.params.linkId);
  const link = db.prepare('SELECT * FROM teacher_classes WHERE id = ?').get(linkId);
  if (!link) return res.status(404).json({ ok: false, error: '任课关系不存在' });
  db.prepare('DELETE FROM teacher_classes WHERE id = ?').run(linkId);
  logAudit(req.user.id, 'remove_teacher_class', `teacher_classes:${linkId}`, `移除任课关系`);
  return res.json({ ok: true, data: { id: linkId } });
});

export default router;
