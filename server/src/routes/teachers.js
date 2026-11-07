import { Router } from 'express';
import multer from 'multer';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, CLERK_ROLES } from '../auth.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';
import { createDraft, getDraft, deleteDraft } from '../import-stage.js';

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

// 解析 + 校验单行（不写库），返回 { ok, record } 或 { ok:false, reason }
function buildTeacherRecord(row, exists) {
  const name = String(keyOf(row, '姓名', '教师', 'name') ?? '').trim();
  if (!name) return { ok: false, reason: '缺少姓名' };
  if (exists.get(name)) return { ok: false, reason: '已存在', duplicate: true };

  const phone = String(keyOf(row, '电话', 'phone') ?? '').trim() || null;
  const subject = String(keyOf(row, '学科', '科目', 'subject') ?? '').trim() || null;
  const pay = {};
  for (const k of PAY_KEYS) {
    const v = Number(keyOf(row, k) ?? '');
    if (Number.isFinite(v) && v > 0) pay[k] = v;
  }
  return { ok: true, record: { name, phone, subject, pay_standard: Object.keys(pay).length ? JSON.stringify(pay) : null } };
}

// 写库（已校验）
function persistTeacher(record) {
  db.prepare('INSERT INTO teachers (name, phone, subject, pay_standard) VALUES (?,?,?,?)')
    .run(record.name, record.phone, record.subject, record.pay_standard);
}

// 预览：解析 + 校验，逐行返回状态，暂存归一化草稿，不写库
router.post('/import/preview', roleRequired(...CLERK_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传教师文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const exists = db.prepare('SELECT id FROM teachers WHERE name = ?');
  const columns = ['姓名', '电话', '学科', ...PAY_KEYS];
  const draftRows = [];
  const summary = { total: rows.length, ok: 0, duplicate: 0, error: 0 };

  for (let i = 0; i < rows.length; i++) {
    const r = buildTeacherRecord(rows[i], exists);
    const cells = columns.map((c) => String(keyOf(rows[i], c) ?? ''));
    if (r.ok) {
      summary.ok++;
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'ok', reason: null, record: r.record });
    } else if (r.duplicate) {
      summary.duplicate++;
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'duplicate', reason: r.reason, record: null });
    } else {
      summary.error++;
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'error', reason: r.reason, record: null });
    }
  }

  const token = createDraft('teachers', req.user.id, { rows: draftRows });
  return res.json({ ok: true, data: { token, rows: draftRows.map(({ record, ...r }) => r), summary } });
});

// 确认入库：凭 token 取回草稿，按 row_ids 只导入选中的「可导入」行
router.post('/import/confirm', roleRequired(...CLERK_ROLES), (req, res) => {
  const { token, row_ids } = req.body || {};
  const draft = getDraft(token, req.user.id, 'teachers');
  if (!draft) return res.status(400).json({ ok: false, error: '预览已失效，请重新上传' });

  const selected = new Set(Array.isArray(row_ids) ? row_ids.map(Number) : []);
  const exists = db.prepare('SELECT id FROM teachers WHERE name = ?');
  let inserted = 0;
  const errors = [];

  for (const r of draft.payload.rows) {
    if (r.status !== 'ok' || !selected.has(r.row_id)) continue;
    if (exists.get(r.record.name)) { errors.push(`第 ${r.line} 行「${r.record.name}」已存在`); continue; }
    persistTeacher(r.record);
    inserted++;
  }

  deleteDraft(token);
  logAudit(req.user.id, 'import_teachers', 'teachers', `批量导入教师 ${inserted} 条${errors.length ? `，冲突 ${errors.length} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// 旧接口（已弃用，改为两阶段）。保留以兼容可能的历史调用。
router.post('/import', roleRequired(...CLERK_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传教师文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const exists = db.prepare('SELECT id FROM teachers WHERE name = ?');
  let inserted = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = buildTeacherRecord(rows[i], exists);
    if (!r.ok) { if (r.duplicate) skipped++; else errors.push(`第 ${i + 2} 行 ${r.reason}`); continue; }
    persistTeacher(r.record);
    inserted++;
  }

  logAudit(req.user.id, 'import_teachers', 'teachers', `批量导入教师 ${inserted} 条${skipped ? `，跳过已存在 ${skipped} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, skipped, errors } });
});

router.post('/', roleRequired(...CLERK_ROLES), (req, res) => {
  const { name, phone, subject, pay_standard } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: '教师姓名必填' });
  const info = db
    .prepare('INSERT INTO teachers (name, phone, subject, pay_standard) VALUES (?,?,?,?)')
    .run(name, phone ?? null, subject ?? null, pay_standard ? JSON.stringify(pay_standard) : null);
  logAudit(req.user.id, 'create_teacher', `teachers:${info.lastInsertRowid}`, `创建教师 ${name}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/:id', roleRequired(...CLERK_ROLES), (req, res) => {
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
router.post('/:id/classes', roleRequired(...CLERK_ROLES), (req, res) => {
  const teacherId = Number(req.params.id);
  const { class_id, subject, effective_from } = req.body || {};
  if (!class_id) return res.status(400).json({ ok: false, error: '请选择班级' });
  const info = db
    .prepare('INSERT INTO teacher_classes (teacher_id, class_id, subject, effective_from) VALUES (?,?,?,?)')
    .run(teacherId, Number(class_id), subject ?? null, effective_from ?? null);
  logAudit(req.user.id, 'assign_teacher_class', `teacher_classes:${info.lastInsertRowid}`, `教师 ${teacherId} 任教班级 ${class_id}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.delete('/:id/classes/:linkId', roleRequired(...CLERK_ROLES), (req, res) => {
  const linkId = Number(req.params.linkId);
  const link = db.prepare('SELECT * FROM teacher_classes WHERE id = ?').get(linkId);
  if (!link) return res.status(404).json({ ok: false, error: '任课关系不存在' });
  db.prepare('DELETE FROM teacher_classes WHERE id = ?').run(linkId);
  logAudit(req.user.id, 'remove_teacher_class', `teacher_classes:${linkId}`, `移除任课关系`);
  return res.json({ ok: true, data: { id: linkId } });
});

export default router;
