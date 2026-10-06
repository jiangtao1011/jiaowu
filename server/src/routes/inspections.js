import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES, INSPECTION_CONFIG_ROLES, INSPECTION_SUBMIT_ROLES } from '../auth.js';
import { visibleTeacherIds } from '../scope.js';

const router = Router();
router.use(authRequired);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

function decodeName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 日期 -> 星期几（1=周一 … 7=周日，与 schedules.day_of_week 约定一致）
function dayOfWeekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

// ===== 学期起始（周期标记「第几周」用）=====
function defaultSemesterStart() {
  const now = new Date();
  const year = now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-09-01`;
}
function semesterStart() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'semester_start'").get();
  return row?.value || defaultSemesterStart();
}
// 达标线（组达标率口径，默认 90）
function passLineConfig() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'pass_line'").get();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 90;
}
// 日期 -> 「第 N 周」；早于学期起始返回空
function weekLabel(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return '';
  const start = new Date(`${semesterStart()}T00:00:00`);
  const d = new Date(`${String(dateStr)}T00:00:00`);
  const week = Math.floor((d - start) / (7 * 86400000)) + 1;
  return week > 0 ? `第${week}周` : '';
}

// ===== 分类 =====
function listCategories() {
  return db.prepare('SELECT * FROM inspection_categories ORDER BY position, id').all();
}

// ===== 检查类型 =====
function typeDimensions(typeId) {
  return db.prepare('SELECT * FROM inspection_score_settings WHERE type_id = ? ORDER BY position, id').all(Number(typeId));
}
// 类型行 -> 前端模型（解析检查项 + 带大类名 + 维度）
function decorateType(t) {
  let items = [];
  try { items = JSON.parse(t.items); } catch { items = []; }
  return { ...t, items, dimensions: typeDimensions(t.id) };
}
function listTypes() {
  const rows = db.prepare(`
    SELECT t.*, c.name AS category_name
    FROM inspection_templates t
    JOIN inspection_categories c ON c.id = t.category_id
    ORDER BY c.position, t.id`).all();
  return rows.map(decorateType);
}

// 打分维度 -> 数据模型：{ name: { score, weight, name, label } }，已按当前类型维度填充默认
function scoreModel(typeId) {
  const model = {};
  for (const d of typeDimensions(typeId)) model[d.name] = { score: 0, weight: Number(d.weight) || 1, name: d.name, label: d.label };
  return model;
}
function computeTotals(model) {
  let total = 0, max = 0;
  for (const m of Object.values(model)) {
    const weight = Number(m.weight) || 1;
    total += (Number(m.score) || 0) * weight;
    max += weight * 100;
  }
  return { total: Math.round(total * 10) / 10, max: Math.round(max * 10) / 10 };
}

// 教师名下「按日记录」里的候选课程（课表联动：选了某班某日，反馈该日该班的课程/教师/科目）
function lookupLessons(dateStr) {
  const valid = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr));
  if (valid) {
    const rows = db.prepare(`
      SELECT li.*, c.name AS class_name, t.name AS teacher_name, c.grade
      FROM lesson_instances li
      JOIN classes c ON c.id = li.class_id
      JOIN teachers t ON t.id = li.teacher_id
      WHERE li.date = ? AND li.cancelled = 0
      ORDER BY li.period_no, li.class_id`).all(String(dateStr));
    if (rows.length) return rows;
  }
  const base = `
    SELECT s.*, c.name AS class_name, c.grade AS grade, t.name AS teacher_name
    FROM schedules s
    JOIN classes c ON c.id = s.class_id
    JOIN teachers t ON t.id = s.teacher_id
    WHERE s.effective_to IS NULL`;
  const order = ' ORDER BY s.day_of_week, s.period_no, s.class_id';
  if (valid) return db.prepare(`${base} AND s.day_of_week = ?${order}`).all(dayOfWeekOf(String(dateStr)));
  return db.prepare(`${base}${order}`).all();
}

// ===== 分类路由 =====
router.get('/categories', (req, res) => res.json({ ok: true, data: listCategories() }));

router.post('/categories', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const { name, position } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ ok: false, error: '分类名称必填' });
  if (db.prepare('SELECT 1 FROM inspection_categories WHERE name = ?').get(n)) {
    return res.status(400).json({ ok: false, error: '分类已存在' });
  }
  const info = db.prepare('INSERT INTO inspection_categories (name, position) VALUES (?,?)')
    .run(n, position != null ? Number(position) : 0);
  logAudit(req.user.id, 'create_inspection_category', `inspection_categories:${info.lastInsertRowid}`, `创建检查大类 ${n}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/categories/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const cat = db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ ok: false, error: '分类不存在' });
  const { name, position } = req.body || {};
  db.prepare('UPDATE inspection_categories SET name = ?, position = ? WHERE id = ?')
    .run(name ? String(name).trim() : cat.name, position != null ? Number(position) : cat.position, id);
  logAudit(req.user.id, 'update_inspection_category', `inspection_categories:${id}`, `更新检查大类`);
  return res.json({ ok: true, data: { id } });
});

router.delete('/categories/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const cat = db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ ok: false, error: '分类不存在' });
  const typeCount = db.prepare('SELECT COUNT(*) AS n FROM inspection_templates WHERE category_id = ?').get(id).n;
  if (typeCount > 0) return res.status(400).json({ ok: false, error: `该分类下还有 ${typeCount} 个检查类型，请先移动或删除` });
  db.prepare('DELETE FROM inspection_categories WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_inspection_category', `inspection_categories:${id}`, `删除检查大类 ${cat.name}`);
  return res.json({ ok: true, data: { id } });
});

// ===== 检查类型路由 =====
router.get('/types', (req, res) => res.json({ ok: true, data: listTypes() }));

router.post('/types', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const { name, category_id, cycle, items, description } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ ok: false, error: '检查类型名称必填' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: '请至少添加一个检查项' });
  const cat = db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(Number(category_id));
  if (!cat) return res.status(400).json({ ok: false, error: '请选择检查大类' });
  const cyc = cycle === 'periodic' ? 'periodic' : 'daily';
  const info = db.prepare('INSERT INTO inspection_templates (name, category, category_id, cycle, items, description, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(n, cat.name, cat.id, cyc, JSON.stringify(items), description ?? null, req.user.id);
  logAudit(req.user.id, 'create_inspection_type', `inspection_templates:${info.lastInsertRowid}`, `创建检查类型 ${n}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/types/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM inspection_templates WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ ok: false, error: '检查类型不存在' });
  const { name, category_id, cycle, items, description, active } = req.body || {};
  const cat = category_id != null
    ? db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(Number(category_id))
    : db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(t.category_id);
  if (!cat) return res.status(400).json({ ok: false, error: '请选择检查大类' });
  db.prepare('UPDATE inspection_templates SET name = ?, category = ?, category_id = ?, cycle = ?, items = ?, description = ?, active = ? WHERE id = ?')
    .run(name ? String(name).trim() : t.name, cat.name, cat.id,
      cycle ? (cycle === 'periodic' ? 'periodic' : 'daily') : t.cycle,
      items ? JSON.stringify(items) : t.items,
      description !== undefined ? description : t.description,
      active !== undefined ? (active ? 1 : 0) : t.active,
      id);
  logAudit(req.user.id, 'update_inspection_type', `inspection_templates:${id}`, `更新检查类型`);
  return res.json({ ok: true, data: { id } });
});

router.delete('/types/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM inspection_templates WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ ok: false, error: '检查类型不存在' });
  const refCount = db.prepare('SELECT COUNT(*) AS n FROM inspections WHERE template_id = ?').get(id).n;
  if (refCount > 0) return res.status(400).json({ ok: false, error: `该类型已有 ${refCount} 条检查记录，不可删除` });
  db.prepare('DELETE FROM inspection_score_settings WHERE type_id = ?').run(id);
  db.prepare('DELETE FROM inspection_templates WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_inspection_type', `inspection_templates:${id}`, `删除检查类型 ${t.name}`);
  return res.json({ ok: true, data: { id } });
});

// ===== 打分维度（按类型）=====
router.get('/types/:id/dimensions', (req, res) => res.json({ ok: true, data: typeDimensions(req.params.id) }));

router.put('/types/:id/dimensions', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM inspection_templates WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ ok: false, error: '检查类型不存在' });
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });
  db.prepare('DELETE FROM inspection_score_settings WHERE type_id = ?').run(id);
  const ins = db.prepare('INSERT INTO inspection_score_settings (type_id, name, label, weight, position) VALUES (?,?,?,?,?)');
  let position = 0;
  for (const it of items) {
    const name = String(it.name || '').trim();
    const label = String(it.label || name || '').trim();
    if (!name || !label) continue;
    const weight = Number(it.weight);
    ins.run(id, name, label, Number.isFinite(weight) && weight > 0 ? weight : 1, position++);
  }
  logAudit(req.user.id, 'update_score_settings', 'inspection_score_settings', `更新检查类型 ${t.name} 打分维度 ${position} 项`);
  return res.json({ ok: true, data: { count: position } });
});

// ===== 兼容旧接口 =====
// 旧 GET /templates —— 映射为检查类型（含 category 兼容字段 = 大类名）
router.get('/templates', (req, res) => {
  const rows = listTypes().map((t) => ({ ...t, category: t.category_name }));
  return res.json({ ok: true, data: rows });
});
// 旧 POST /templates —— 创建类型（旧前端传 category 文本 + name + items）
router.post('/templates', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const { name, category, items, description } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: '模板名称必填' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: '请至少添加一个检查项' });
  const catName = String(category || '课堂常规').trim();
  let cat = db.prepare('SELECT id FROM inspection_categories WHERE name = ?').get(catName);
  if (!cat) {
    const info = db.prepare('INSERT INTO inspection_categories (name) VALUES (?)').run(catName);
    cat = { id: Number(info.lastInsertRowid) };
  }
  const info = db.prepare('INSERT INTO inspection_templates (name, category, category_id, cycle, items, description, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(String(name).trim(), catName, cat.id, 'daily', JSON.stringify(items), description ?? null, req.user.id);
  logAudit(req.user.id, 'create_inspection_type', `inspection_templates:${info.lastInsertRowid}`, `创建检查类型 ${name}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});
// 旧 GET /score-settings —— 无 type_id 返回第一个类型的维度；有 type_id 返回该类型维度
router.get('/score-settings', (req, res) => {
  const { type_id } = req.query;
  if (type_id != null) return res.json({ ok: true, data: typeDimensions(type_id) });
  const first = db.prepare('SELECT id FROM inspection_templates ORDER BY id LIMIT 1').get();
  return res.json({ ok: true, data: first ? typeDimensions(first.id) : [] });
});

// ===== 检查配置（学期起始 + 达标线）=====
router.get('/config', (req, res) => res.json({ ok: true, data: { semester_start: semesterStart(), pass_line: passLineConfig() } }));
router.put('/config', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const { semester_start, pass_line } = req.body || {};
  if (semester_start !== undefined) {
    if (!semester_start || !/^\d{4}-\d{2}-\d{2}$/.test(String(semester_start))) {
      return res.status(400).json({ ok: false, error: '学期起始日期格式应为 YYYY-MM-DD' });
    }
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('semester_start', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`).run(String(semester_start));
  }
  if (pass_line !== undefined) {
    const n = Number(pass_line);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return res.status(400).json({ ok: false, error: '达标线需为 0-100 的数值' });
    }
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('pass_line', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`).run(String(n));
  }
  return res.json({ ok: true, data: { semester_start: semesterStart(), pass_line: passLineConfig() } });
});
router.get('/week-label', (req, res) => {
  const { date } = req.query;
  return res.json({ ok: true, data: { label: weekLabel(String(date || '')) } });
});

// ===== 课表联动 =====
router.get('/schedule-lookup', (req, res) => {
  const { date, class_id, period_no } = req.query;
  if (!date || !class_id || period_no == null) {
    return res.status(400).json({ ok: false, error: '请选择日期、班级和节次' });
  }
  const cid = Number(class_id);
  const pno = Number(period_no);
  const rows = lookupLessons(String(date)).filter((r) => r.class_id === cid && r.period_no === pno);
  if (!rows.length) return res.json({ ok: true, data: null, message: '该班该节没有课程' });
  const first = rows[0];
  return res.json({
    ok: true,
    data: {
      class_id: first.class_id, class_name: first.class_name, grade: first.grade,
      teacher_id: first.teacher_id, teacher_name: first.teacher_name, subject: first.subject,
      period_no: first.period_no, period_type: first.period_type, term: first.term,
      courses: rows.map((r) => ({ class_id: r.class_id, class_name: r.class_name, teacher_id: r.teacher_id, teacher_name: r.teacher_name, subject: r.subject, period_type: r.period_type, term: r.term })),
    },
  });
});

router.get('/lessons', (req, res) => {
  const { date, class_id } = req.query;
  if (!date) return res.status(400).json({ ok: false, error: '请选择日期' });
  const rows = lookupLessons(String(date));
  const filtered = class_id ? rows.filter((r) => r.class_id === Number(class_id)) : rows;
  return res.json({ ok: true, data: filtered });
});

// ===== 检查记录 =====
// 列表，支持 type_id/category_id/class_id/teacher_id/日期区间过滤
router.get('/', (req, res) => {
  const { template_id, type_id, category_id, class_id, teacher_id, date, from, to } = req.query;
  let sql = `
    SELECT i.*, t.name AS template_name, t.category, t.category_id, t.cycle,
           c.name AS class_name, tc.name AS teacher_name,
           u.name AS checker_name
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_id
    LEFT JOIN classes c ON c.id = i.class_id
    LEFT JOIN teachers tc ON tc.id = i.teacher_id
    LEFT JOIN users u ON u.id = i.checker_id
    WHERE 1=1`;
  const params = [];
  if (template_id) { sql += ' AND i.template_id = ?'; params.push(Number(template_id)); }
  if (type_id) { sql += ' AND i.template_id = ?'; params.push(Number(type_id)); }
  if (category_id) { sql += ' AND t.category_id = ?'; params.push(Number(category_id)); }
  if (class_id) { sql += ' AND i.class_id = ?'; params.push(Number(class_id)); }
  if (teacher_id) { sql += ' AND i.teacher_id = ?'; params.push(Number(teacher_id)); }
  if (date) { sql += ' AND i.lesson_date = ?'; params.push(String(date)); }
  if (from) { sql += ' AND i.lesson_date >= ?'; params.push(String(from)); }
  if (to) { sql += ' AND i.lesson_date <= ?'; params.push(String(to)); }
  // 作用域：非管理员只看本范围教师（教研组长=本学科、备课组长=本组、年级组长=本年级、教师=自己）
  const scope = visibleTeacherIds(req.user);
  if (scope) {
    sql += ` AND (i.teacher_id IS NULL OR i.teacher_id IN (${scope.map(() => '?').join(',')}))`;
    params.push(...scope);
  }
  sql += ' ORDER BY i.lesson_date DESC, i.created_at DESC, i.id DESC';
  const rows = db.prepare(sql).all(...params);
  const data = rows.map((r) => {
    let parsed = {};
    try { parsed = JSON.parse(r.data); } catch { parsed = {}; }
    let scores = [];
    try { scores = JSON.parse(r.score_data || '[]'); } catch { scores = []; }
    return { ...r, data: parsed, scores };
  });
  return res.json({ ok: true, data });
});

// 提交检查记录（教务员/教务处/admin + 教研组长/备课组长；非管理员按作用域限定教师）
router.post('/', roleRequired(...INSPECTION_SUBMIT_ROLES), (req, res) => {
  const { template_id, type_id, class_id, teacher_id, subject, day_of_week, period_no, lesson_date, cycle_label, data, scores } = req.body || {};
  const tid = Number(type_id ?? template_id);
  if (!tid) return res.status(400).json({ ok: false, error: '请选择检查类型' });
  const template = db.prepare('SELECT * FROM inspection_templates WHERE id = ?').get(tid);
  if (!template) return res.status(404).json({ ok: false, error: '检查类型不存在' });
  if (!data || typeof data !== 'object') return res.status(400).json({ ok: false, error: '检查数据不能为空' });

  // 作用域：非管理员只能检查本范围内的教师
  if (!ADMIN_ROLES.includes(req.user.role) && teacher_id) {
    const scope = visibleTeacherIds(req.user);
    if (scope && !scope.includes(Number(teacher_id))) {
      return res.status(403).json({ ok: false, error: '只能检查本职责范围内的教师' });
    }
  }

  // 打分：以当前类型维度对齐，缺省记 0
  let scoreTotal = null, scoreMax = null, scoreSnapshot = null;
  if (Array.isArray(scores) && scores.length) {
    const model = scoreModel(tid);
    const byName = {};
    for (const s of scores) if (s && s.name) byName[s.name] = Number(s.score) || 0;
    for (const m of Object.values(model)) {
      if (byName[m.name] != null) m.score = Math.max(0, Math.min(100, byName[m.name]));
    }
    const totals = computeTotals(model);
    scoreTotal = totals.total;
    scoreMax = totals.max;
    scoreSnapshot = JSON.stringify(Object.fromEntries(Object.values(model).map((m) => [m.name, { score: m.score, weight: m.weight, label: m.label }])));
  }

  // 周期标记：周期类按日期自动算（可被前端传入覆盖），日常类留空
  let cycle = null;
  if (template.cycle === 'periodic') {
    cycle = cycle_label ? String(cycle_label).trim() : weekLabel(lesson_date);
  }

  const info = db
    .prepare(`INSERT INTO inspections
      (template_id, class_id, teacher_id, subject, day_of_week, period_no, lesson_date, cycle_label, data, score_data, score_total, score_max, checker_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tid, class_id ? Number(class_id) : null, teacher_id ? Number(teacher_id) : null,
      subject ?? null, day_of_week != null ? Number(day_of_week) : null, period_no != null ? Number(period_no) : null,
      lesson_date ?? null, cycle, JSON.stringify(data), scoreSnapshot, scoreTotal, scoreMax, req.user.id);
  logAudit(req.user.id, 'create_inspection', `inspections:${info.lastInsertRowid}`, `提交检查（类型 ${template.name}${cycle ? ` ${cycle}` : ''}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid), cycle_label: cycle } });
});

// 单条详情（路由放末尾，避免抢在 /groups /stats 等单段路径之前）
router.post('/:id/photos', roleRequired(...INSPECTION_SUBMIT_ROLES), upload.array('photos', 9), (req, res) => {
  const id = Number(req.params.id);
  const inspection = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id);
  if (!inspection) return res.status(404).json({ ok: false, error: '检查记录不存在' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ ok: false, error: '请选择照片' });
  const insert = db.prepare('INSERT INTO inspection_photos (inspection_id, filename, stored_path) VALUES (?,?,?)');
  const saved = [];
  for (const f of files) {
    const info = insert.run(id, decodeName(f.originalname), f.filename);
    saved.push({ id: Number(info.lastInsertRowid), filename: decodeName(f.originalname) });
  }
  return res.json({ ok: true, data: saved });
});

router.get('/photos/:photoId', (req, res) => {
  const p = db.prepare('SELECT * FROM inspection_photos WHERE id = ?').get(Number(req.params.photoId));
  if (!p) return res.status(404).json({ ok: false, error: '照片不存在' });
  res.sendFile(path.join(UPLOAD_DIR, p.stored_path));
});

// ===== 备课组/教研组 =====
function autoGroups() {
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
function manualGroups() {
  const groups = db.prepare('SELECT * FROM teacher_groups WHERE is_auto = 0 ORDER BY type, grade, subject, id').all();
  return groups.map((g) => ({
    ...g,
    key: `manual:${g.id}`,
    is_auto: false,
    leader_name: g.leader_id ? (db.prepare('SELECT name FROM teachers WHERE id = ?').get(g.leader_id)?.name ?? null) : null,
    members: db.prepare('SELECT teacher_id FROM teacher_group_members WHERE group_id = ?').all(g.id).map((m) => m.teacher_id),
  }));
}

router.get('/groups', (req, res) => res.json({ ok: true, data: { manual: manualGroups(), auto: autoGroups() } }));

router.post('/groups', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const { name, type, subject, grade, leader_id, member_ids } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ ok: false, error: '组名必填' });
  const gt = type === '教研组' ? '教研组' : '备课组';
  const info = db.prepare('INSERT INTO teacher_groups (name, type, subject, grade, leader_id, is_auto, created_by) VALUES (?,?,?,?,?,0,?)')
    .run(n, gt, subject ?? null, grade ?? null, leader_id ? Number(leader_id) : null, req.user.id);
  const gid = Number(info.lastInsertRowid);
  if (Array.isArray(member_ids)) {
    const ins = db.prepare('INSERT INTO teacher_group_members (group_id, teacher_id) VALUES (?,?)');
    for (const mid of member_ids) if (mid) ins.run(gid, Number(mid));
  }
  logAudit(req.user.id, 'create_teacher_group', `teacher_groups:${gid}`, `创建${gt} ${n}`);
  return res.json({ ok: true, data: { id: gid } });
});

router.patch('/groups/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM teacher_groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ ok: false, error: '组不存在' });
  const { name, type, subject, grade, leader_id, member_ids } = req.body || {};
  db.prepare('UPDATE teacher_groups SET name = ?, type = ?, subject = ?, grade = ?, leader_id = ? WHERE id = ?')
    .run(name ? String(name).trim() : g.name, type ? (type === '教研组' ? '教研组' : '备课组') : g.type,
      subject !== undefined ? subject : g.subject, grade !== undefined ? grade : g.grade,
      leader_id !== undefined ? (leader_id ? Number(leader_id) : null) : g.leader_id, id);
  if (Array.isArray(member_ids)) {
    db.prepare('DELETE FROM teacher_group_members WHERE group_id = ?').run(id);
    const ins = db.prepare('INSERT INTO teacher_group_members (group_id, teacher_id) VALUES (?,?)');
    for (const mid of member_ids) if (mid) ins.run(id, Number(mid));
  }
  logAudit(req.user.id, 'update_teacher_group', `teacher_groups:${id}`, `更新组`);
  return res.json({ ok: true, data: { id } });
});

router.delete('/groups/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const g = db.prepare('SELECT * FROM teacher_groups WHERE id = ?').get(id);
  if (!g) return res.status(404).json({ ok: false, error: '组不存在' });
  db.prepare('DELETE FROM teacher_group_members WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM teacher_groups WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_teacher_group', `teacher_groups:${id}`, `删除组 ${g.name}`);
  return res.json({ ok: true, data: { id } });
});

// ===== 考核统计 =====
// 个人得分口径：Σ实得 / Σ满分 × 100（满分不同时按满分加权）
function buildWhere(req) {
  const { from, to, type_id, category_id, teacher_id } = req.query;
  let sql = ' WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND i.lesson_date >= ?'; params.push(String(from)); }
  if (to) { sql += ' AND i.lesson_date <= ?'; params.push(String(to)); }
  if (type_id) { sql += ' AND i.template_id = ?'; params.push(Number(type_id)); }
  if (category_id) { sql += ' AND t.category_id = ?'; params.push(Number(category_id)); }
  if (teacher_id) { sql += ' AND i.teacher_id = ?'; params.push(Number(teacher_id)); }
  // 作用域：非管理员只看本范围教师
  const scope = visibleTeacherIds(req.user);
  if (scope) {
    sql += ` AND (i.teacher_id IS NULL OR i.teacher_id IN (${scope.map(() => '?').join(',')}))`;
    params.push(...scope);
  }
  return { sql, params };
}

router.get('/stats/teachers', (req, res) => {
  const { sql, params } = buildWhere(req);
  const rows = db.prepare(`
    SELECT i.teacher_id, tc.name AS teacher_name, tc.subject,
           COUNT(*) AS cnt,
           COALESCE(SUM(i.score_total), 0) AS sum_total,
           COALESCE(SUM(i.score_max), 0) AS sum_max
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_id
    LEFT JOIN teachers tc ON tc.id = i.teacher_id
    ${sql}
    GROUP BY i.teacher_id`).all(...params);
  const data = rows
    .filter((r) => r.teacher_id != null)
    .map((r) => {
      const avg = r.sum_max > 0 ? Math.round((r.sum_total / r.sum_max) * 1000) / 10 : null;
      return { teacher_id: r.teacher_id, teacher_name: r.teacher_name, subject: r.subject, count: r.cnt, avg_score: avg };
    });
  return res.json({ ok: true, data });
});

router.get('/stats/groups', (req, res) => {
  const passLine = req.query.pass_line != null && req.query.pass_line !== ''
    ? Number(req.query.pass_line)
    : passLineConfig();
  const { sql, params } = buildWhere(req);

  // 每教师在范围内得分
  const teacherRows = db.prepare(`
    SELECT i.teacher_id, COALESCE(SUM(i.score_total),0) AS st, COALESCE(SUM(i.score_max),0) AS sm
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_id
    ${sql}
    GROUP BY i.teacher_id`).all(...params);
  const teacherScore = new Map();
  for (const r of teacherRows) {
    if (r.teacher_id == null) continue;
    teacherScore.set(r.teacher_id, r.sm > 0 ? (r.st / r.sm) * 100 : null);
  }

  let groups = [...manualGroups(), ...autoGroups()];
  // 作用域：非管理员只看自己相关的组（教研组长=本学科教研组、备课组长=本组、年级组长=本年级各组）
  const scope = visibleTeacherIds(req.user);
  if (scope) {
    const scopeSet = new Set(scope);
    groups = groups.filter((g) => g.members.some((mid) => scopeSet.has(mid)));
  }
  const data = groups.map((g) => {
    let members = g.members || [];
    if (scope) {
      const scopeSet = new Set(scope);
      members = members.filter((mid) => scopeSet.has(mid));
    }
    const scored = members
      .map((tid) => teacherScore.get(tid))
      .filter((v) => v != null && Number.isFinite(v));
    const avg = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;
    const passed = scored.filter((v) => v >= passLine).length;
    const passRate = scored.length ? Math.round((passed / scored.length) * 1000) / 10 : null;
    const coverage = members.length ? Math.round((scored.length / members.length) * 1000) / 10 : null;
    return {
      key: g.key, name: g.name, type: g.type, subject: g.subject, grade: g.grade,
      is_auto: g.is_auto, leader_name: g.leader_name ?? null,
      members,
      teacher_count: members.length, checked_count: scored.length,
      avg_score: avg, pass_rate: passRate, coverage,
    };
  });
  return res.json({ ok: true, data, pass_line: passLine });
});

// 单条详情（放末尾，避免 /:id 抢在 /groups /stats 等单段路径之前）
router.get('/:id', (req, res) => {
  const r = db
    .prepare(`SELECT i.*, t.name AS template_name, t.category, t.category_id, t.cycle,
             c.name AS class_name, tc.name AS teacher_name, u.name AS checker_name
             FROM inspections i
             JOIN inspection_templates t ON t.id = i.template_id
             LEFT JOIN classes c ON c.id = i.class_id
             LEFT JOIN teachers tc ON tc.id = i.teacher_id
             LEFT JOIN users u ON u.id = i.checker_id
             WHERE i.id = ?`)
    .get(Number(req.params.id));
  if (!r) return res.status(404).json({ ok: false, error: '检查记录不存在' });
  let parsed = {};
  try { parsed = JSON.parse(r.data); } catch { parsed = {}; }
  let scores = [];
  try { scores = JSON.parse(r.score_data || '[]'); } catch { scores = []; }
  const photos = db.prepare('SELECT id, filename, created_at FROM inspection_photos WHERE inspection_id = ?').all(r.id);
  return res.json({ ok: true, data: { ...r, data: parsed, scores, photos } });
});

export default router;
