import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES, INSPECTION_CONFIG_ROLES, INSPECTION_SUBMIT_ROLES, RESULT_VIEW_ROLES } from '../auth.js';
import { visibleTeacherIds } from '../scope.js';
import { autoGroups, manualGroups } from '../groups.js';

const router = Router();
router.use(authRequired);

// 导出报表权限：管理层（admin/校长/教务主任/教务员）+ 组长（教研组长/备课组长/年级组长）
// = 除普通教师外的所有角色。
const EXPORT_ROLES = [...RESULT_VIEW_ROLES, '教研组长', '备课组长', '年级组长'];

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
// 需关注覆盖率关注线（默认 100，覆盖率低于该值即需关注）
function attentionCoverageConfig() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'attention_coverage'").get();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 100;
}
// 需关注事项条数上限（默认 5）
function attentionLimitConfig() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'attention_limit'").get();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.floor(n) : 5;
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
  const { name, category_id, cycle, items, description, schedule_link } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ ok: false, error: '检查类型名称必填' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: '请至少添加一个检查项' });
  const cat = db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(Number(category_id));
  if (!cat) return res.status(400).json({ ok: false, error: '请选择检查大类' });
  const cyc = cycle === 'periodic' ? 'periodic' : 'daily';
  const link = schedule_link === 0 || schedule_link === false ? 0 : 1;
  const info = db.prepare('INSERT INTO inspection_templates (name, category, category_id, cycle, items, description, schedule_link, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(n, cat.name, cat.id, cyc, JSON.stringify(items), description ?? null, link, req.user.id);
  logAudit(req.user.id, 'create_inspection_type', `inspection_templates:${info.lastInsertRowid}`, `创建检查类型 ${n}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/types/:id', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM inspection_templates WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ ok: false, error: '检查类型不存在' });
  const { name, category_id, cycle, items, description, active, schedule_link } = req.body || {};
  const cat = category_id != null
    ? db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(Number(category_id))
    : db.prepare('SELECT * FROM inspection_categories WHERE id = ?').get(t.category_id);
  if (!cat) return res.status(400).json({ ok: false, error: '请选择检查大类' });
  const link = schedule_link === 0 || schedule_link === false ? 0 : (schedule_link != null ? 1 : t.schedule_link ?? 1);
  db.prepare('UPDATE inspection_templates SET name = ?, category = ?, category_id = ?, cycle = ?, items = ?, description = ?, active = ?, schedule_link = ? WHERE id = ?')
    .run(name ? String(name).trim() : t.name, cat.name, cat.id,
      cycle ? (cycle === 'periodic' ? 'periodic' : 'daily') : t.cycle,
      items ? JSON.stringify(items) : t.items,
      description !== undefined ? description : t.description,
      active !== undefined ? (active ? 1 : 0) : t.active,
      link,
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

// ===== 检查配置（学期起始 + 达标线 + 需关注阈值）=====
router.get('/config', (req, res) => res.json({
  ok: true,
  data: {
    semester_start: semesterStart(),
    pass_line: passLineConfig(),
    attention_coverage: attentionCoverageConfig(),
    attention_limit: attentionLimitConfig(),
  },
}));
router.put('/config', roleRequired(...INSPECTION_CONFIG_ROLES), (req, res) => {
  const { semester_start, pass_line, attention_coverage, attention_limit } = req.body || {};
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
  if (attention_coverage !== undefined) {
    const n = Number(attention_coverage);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return res.status(400).json({ ok: false, error: '覆盖率关注线需为 0-100 的数值' });
    }
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('attention_coverage', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`).run(String(n));
  }
  if (attention_limit !== undefined) {
    const n = Number(attention_limit);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return res.status(400).json({ ok: false, error: '需关注条数上限需为 1-100 的整数' });
    }
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('attention_limit', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`).run(String(Math.floor(n)));
  }
  return res.json({
    ok: true,
    data: {
      semester_start: semesterStart(),
      pass_line: passLineConfig(),
      attention_coverage: attentionCoverageConfig(),
      attention_limit: attentionLimitConfig(),
    },
  });
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

// 打分：以当前类型维度对齐，缺省记 0。返回 { score_total, score_max, score_data } 或全 null。
function computeScoreFields(tid, scores) {
  if (!Array.isArray(scores) || !scores.length) return { scoreTotal: null, scoreMax: null, scoreSnapshot: null };
  const model = scoreModel(tid);
  const byName = {};
  for (const s of scores) if (s && s.name) byName[s.name] = Number(s.score) || 0;
  for (const m of Object.values(model)) {
    if (byName[m.name] != null) m.score = Math.max(0, Math.min(100, byName[m.name]));
  }
  const totals = computeTotals(model);
  return {
    scoreTotal: totals.total,
    scoreMax: totals.max,
    scoreSnapshot: JSON.stringify(Object.fromEntries(Object.values(model).map((m) => [m.name, { score: m.score, weight: m.weight, label: m.label }]))),
  };
}

// 提交检查记录（教务员/教务主任/admin + 教研组长/备课组长；非管理员按作用域限定教师）
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

  const { scoreTotal, scoreMax, scoreSnapshot } = computeScoreFields(tid, scores);

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

// 修改检查记录（与提交同权限；非管理员按作用域限定教师）
router.patch('/:id', roleRequired(...INSPECTION_SUBMIT_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ ok: false, error: '检查记录不存在' });

  const { type_id, template_id, class_id, teacher_id, subject, day_of_week, period_no, lesson_date, cycle_label, data, scores } = req.body || {};
  const tid = type_id != null ? Number(type_id) : (template_id != null ? Number(template_id) : existing.template_id);
  const template = db.prepare('SELECT * FROM inspection_templates WHERE id = ?').get(tid);
  if (!template) return res.status(404).json({ ok: false, error: '检查类型不存在' });

  // 作用域：非管理员只能改本范围内的教师记录
  const nextTeacherId = teacher_id !== undefined ? (teacher_id ? Number(teacher_id) : null) : existing.teacher_id;
  if (!ADMIN_ROLES.includes(req.user.role) && nextTeacherId) {
    const scope = visibleTeacherIds(req.user);
    if (scope && !scope.includes(Number(nextTeacherId))) {
      return res.status(403).json({ ok: false, error: '只能检查本职责范围内的教师' });
    }
  }

  const nextData = data && typeof data === 'object' ? data : (existing.data ? JSON.parse(existing.data) : {});
  const nextScores = scores !== undefined ? scores : (existing.score_data ? Object.values(JSON.parse(existing.score_data)) : null);
  const { scoreTotal, scoreMax, scoreSnapshot } = computeScoreFields(tid, nextScores);

  let cycle = existing.cycle_label;
  if (template.cycle === 'periodic') {
    cycle = cycle_label !== undefined ? String(cycle_label || '').trim() : weekLabel(lesson_date ?? existing.lesson_date);
  } else {
    cycle = null;
  }

  db.prepare(`UPDATE inspections SET
    template_id = ?, class_id = ?, teacher_id = ?, subject = ?, day_of_week = ?, period_no = ?,
    lesson_date = ?, cycle_label = ?, data = ?, score_data = ?, score_total = ?, score_max = ?
    WHERE id = ?`)
    .run(tid,
      class_id !== undefined ? (class_id ? Number(class_id) : null) : existing.class_id,
      teacher_id !== undefined ? (teacher_id ? Number(teacher_id) : null) : existing.teacher_id,
      subject !== undefined ? subject : existing.subject,
      day_of_week !== undefined ? (day_of_week != null ? Number(day_of_week) : null) : existing.day_of_week,
      period_no !== undefined ? (period_no != null ? Number(period_no) : null) : existing.period_no,
      lesson_date !== undefined ? lesson_date : existing.lesson_date,
      cycle,
      JSON.stringify(nextData), scoreSnapshot, scoreTotal, scoreMax,
      id);
  logAudit(req.user.id, 'update_inspection', `inspections:${id}`, `修改检查记录（类型 ${template.name}）`);
  return res.json({ ok: true, data: { id } });
});

// 删除检查记录（与提交同权限；非管理员按作用域限定教师）。级联删除照片文件。
router.delete('/:id', roleRequired(...INSPECTION_SUBMIT_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const inspection = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id);
  if (!inspection) return res.status(404).json({ ok: false, error: '检查记录不存在' });

  if (!ADMIN_ROLES.includes(req.user.role) && inspection.teacher_id) {
    const scope = visibleTeacherIds(req.user);
    if (scope && !scope.includes(Number(inspection.teacher_id))) {
      return res.status(403).json({ ok: false, error: '只能删除本职责范围内的教师记录' });
    }
  }

  // 级联删除照片文件
  const photos = db.prepare('SELECT stored_path FROM inspection_photos WHERE inspection_id = ?').all(id);
  for (const p of photos) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, p.stored_path)); } catch { /* 忽略 */ }
  }
  db.prepare('DELETE FROM inspection_photos WHERE inspection_id = ?').run(id);
  db.prepare('DELETE FROM inspections WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_inspection', `inspections:${id}`, `删除检查记录`);
  return res.json({ ok: true, data: { id } });
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
// autoGroups / manualGroups 已抽到 ../groups.js，此处 import 共用。

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

// ===== 导出常规检查情况报表（Excel 多 sheet） =====
// 权限：管理层 + 组长（EXPORT_ROLES），普通教师不可导出。
// 数据范围：按 from/to/category_id/type_id 过滤 + 作用域（组长限本组/本学科/本年级）。
router.get('/export', roleRequired(...EXPORT_ROLES), (req, res) => {
  const { from, to, category_id, type_id, pass_line } = req.query;
  const passLine = pass_line != null && pass_line !== '' ? Number(pass_line) : passLineConfig();
  const attCov = attentionCoverageConfig();
  const attLimit = attentionLimitConfig();

  // ===== 明细（含打分快照） =====
  let sql = `
    SELECT i.*, t.name AS template_name, t.category, t.category_id, t.cycle,
           c.name AS class_name, c.grade AS class_grade, tc.name AS teacher_name,
           u.name AS checker_name
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_id
    LEFT JOIN classes c ON c.id = i.class_id
    LEFT JOIN teachers tc ON tc.id = i.teacher_id
    LEFT JOIN users u ON u.id = i.checker_id
    WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND i.lesson_date >= ?'; params.push(String(from)); }
  if (to) { sql += ' AND i.lesson_date <= ?'; params.push(String(to)); }
  if (type_id) { sql += ' AND i.template_id = ?'; params.push(Number(type_id)); }
  if (category_id) { sql += ' AND t.category_id = ?'; params.push(Number(category_id)); }
  const scope = visibleTeacherIds(req.user);
  if (scope) {
    sql += ` AND (i.teacher_id IS NULL OR i.teacher_id IN (${scope.map(() => '?').join(',')}))`;
    params.push(...scope);
  }
  sql += ' ORDER BY i.lesson_date DESC, i.id DESC';
  const detailRows = db.prepare(sql).all(...params).map((r) => {
    let data = {}; try { data = JSON.parse(r.data); } catch { data = {}; }
    let scores = {}; try { scores = JSON.parse(r.score_data || 'null') || {}; } catch { scores = {}; }
    return { ...r, data, scores };
  });

  // 维度列：从所有记录的打分快照去重，按首次出现顺序排列
  const dimCols = [];      // [{ name, label }]
  const dimSeen = new Set();
  for (const r of detailRows) {
    for (const [name, v] of Object.entries(r.scores)) {
      if (dimSeen.has(name)) continue;
      dimSeen.add(name);
      dimCols.push({ name, label: (v && v.label) || name });
    }
  }

  // ===== 教师汇总（Σ实得/Σ满分×100） =====
  let tSql = `
    SELECT i.teacher_id, tc.name AS teacher_name, tc.subject,
           COUNT(*) AS cnt,
           COALESCE(SUM(i.score_total), 0) AS sum_total,
           COALESCE(SUM(i.score_max), 0) AS sum_max
    FROM inspections i
    JOIN inspection_templates t ON t.id = i.template_id
    LEFT JOIN teachers tc ON tc.id = i.teacher_id
    WHERE 1=1`;
  const tParams = [];
  if (from) { tSql += ' AND i.lesson_date >= ?'; tParams.push(String(from)); }
  if (to) { tSql += ' AND i.lesson_date <= ?'; tParams.push(String(to)); }
  if (type_id) { tSql += ' AND i.template_id = ?'; tParams.push(Number(type_id)); }
  if (category_id) { tSql += ' AND t.category_id = ?'; tParams.push(Number(category_id)); }
  if (scope) { tSql += ` AND i.teacher_id IN (${scope.map(() => '?').join(',')})`; tParams.push(...scope); }
  tSql += ' GROUP BY i.teacher_id';
  const teacherAgg = db.prepare(tSql).all(...tParams)
    .filter((r) => r.teacher_id != null)
    .map((r) => {
      const avg = r.sum_max > 0 ? Math.round((r.sum_total / r.sum_max) * 1000) / 10 : null;
      return { teacher_id: r.teacher_id, teacher_name: r.teacher_name, subject: r.subject, count: r.cnt, avg_score: avg };
    });

  // ===== 组汇总（复用 stats/groups 口径） =====
  const teacherScoreMap = new Map(teacherAgg.map((r) => [r.teacher_id, r.avg_score]));
  let groups = [...manualGroups(), ...autoGroups()];
  if (scope) {
    const scopeSet = new Set(scope);
    groups = groups.filter((g) => g.members.some((mid) => scopeSet.has(mid)));
  }
  const groupAgg = groups.map((g) => {
    let members = g.members || [];
    if (scope) { const scopeSet = new Set(scope); members = members.filter((mid) => scopeSet.has(mid)); }
    const scored = members.map((tid) => teacherScoreMap.get(tid)).filter((v) => v != null && Number.isFinite(v));
    const avg = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;
    const passed = scored.filter((v) => v >= passLine).length;
    const passRate = scored.length ? Math.round((passed / scored.length) * 1000) / 10 : null;
    const coverage = members.length ? Math.round((scored.length / members.length) * 1000) / 10 : null;
    return {
      name: g.name, type: g.type, subject: g.subject, grade: g.grade,
      leader_name: g.leader_name ?? null, is_auto: g.is_auto,
      teacher_count: members.length, checked_count: scored.length,
      avg_score: avg, pass_rate: passRate, coverage,
    };
  });

  // ===== 概述统计 =====
  const total = detailRows.length;
  const teacherCount = teacherAgg.length;
  const classCount = new Set(detailRows.filter((r) => r.class_id != null).map((r) => r.class_id)).size;
  const categoryIds = new Set(detailRows.map((r) => r.category_id));
  const typeIds = new Set(detailRows.map((r) => r.template_id));
  const allAvg = teacherAgg.filter((r) => r.avg_score != null);
  const avgOfAvg = allAvg.length
    ? Math.round((allAvg.reduce((a, b) => a + b.avg_score, 0) / allAvg.length) * 10) / 10
    : null;
  const scoredGroups = groupAgg.filter((g) => g.pass_rate != null);
  const passRateOverall = scoredGroups.length
    ? Math.round((scoredGroups.reduce((a, b) => a + b.pass_rate, 0) / scoredGroups.length) * 10) / 10
    : null;
  const covGroups = groupAgg.filter((g) => g.coverage != null);
  const coverageOverall = covGroups.length
    ? Math.round((covGroups.reduce((a, b) => a + b.coverage, 0) / covGroups.length) * 10) / 10
    : null;

  // 检查构成（按大类）
  const catCountMap = {};
  for (const r of detailRows) {
    const cname = r.category || '未分类';
    catCountMap[cname] = (catCountMap[cname] || 0) + 1;
  }

  // 需关注事项
  const lowCovGroups = groupAgg.filter((g) => g.coverage != null && g.coverage < attCov)
    .sort((a, b) => a.coverage - b.coverage).slice(0, attLimit);
  const failTeachers = teacherAgg.filter((r) => r.avg_score != null && r.avg_score < passLine)
    .sort((a, b) => a.avg_score - b.avg_score).slice(0, attLimit);
  const failGroups = groupAgg.filter((g) => g.pass_rate != null && g.pass_rate < passLine)
    .sort((a, b) => a.pass_rate - b.pass_rate).slice(0, attLimit);

  // ===== 生成 Excel =====
  const wb = XLSX.utils.book_new();

  // Sheet 1: 基本情况概述
  const genName = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id)?.name || req.user.name || '';
  const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    ['常规检查情况报告'],
    [''],
    [`统计区间：${from || '（不限）'} 至 ${to || '（不限）'}`],
    [`生成时间：${nowStr}`],
    [`生成人：${genName}`],
    [''],
    ['一、基本情况'],
    [`本次共开展常规检查 ${total} 次，覆盖 ${teacherCount} 名教师、${classCount} 个班级，`],
    [`涉及 ${categoryIds.size} 个检查大类、${typeIds.size} 个检查类型。`],
    [`教师个人平均分为 ${avgOfAvg ?? '—'} 分，组达标率 ${passRateOverall ?? '—'}%，覆盖率 ${coverageOverall ?? '—'}%。`],
    [''],
    ['二、检查构成'],
    ...Object.entries(catCountMap).map(([k, v]) => [`- ${k}：${v} 次`]),
    [''],
    ['三、需关注事项'],
    [`1. 覆盖率不足的组：${lowCovGroups.length ? lowCovGroups.map((g) => `${g.name}（${g.coverage}%）`).join('、') : '无'}`],
    [`2. 未达标教师：${failTeachers.length ? failTeachers.map((t) => `${t.teacher_name}（${t.avg_score}分）`).join('、') : '无'}`],
    [`3. 未达标组：${failGroups.length ? failGroups.map((g) => `${g.name}（达标率 ${g.pass_rate}%）`).join('、') : '无'}`],
    [''],
    ['四、关键指标'],
    ['检查次数', total],
    ['覆盖教师', teacherCount],
    ['覆盖班级', classCount],
    ['检查大类数', categoryIds.size],
    ['检查类型数', typeIds.size],
    ['教师平均分', avgOfAvg ?? '—'],
    ['组达标率(%)', passRateOverall ?? '—'],
    ['覆盖率(%)', coverageOverall ?? '—'],
    ['达标线', passLine],
    ['覆盖率关注线', attCov],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(lines);
  ws1['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws1, '基本情况概述');

  // Sheet 2: 检查明细
  const detailHeader = ['日期', '大类', '检查类型', '周期标记', '班级', '教师', '学科', '节次', '实得分', '满分', '检查人', ...dimCols.map((d) => d.label)];
  const detailAoa = [detailHeader];
  for (const r of detailRows) {
    const row = [
      r.lesson_date || '',
      r.category || '',
      r.template_name || '',
      r.cycle_label || '',
      r.class_name || '',
      r.teacher_name || '',
      r.subject || '',
      r.period_no != null ? r.period_no : '',
      r.score_total != null ? r.score_total : '',
      r.score_max != null ? r.score_max : '',
      r.checker_name || '',
    ];
    for (const d of dimCols) {
      const v = r.scores[d.name];
      row.push(v && v.score != null ? v.score : '');
    }
    detailAoa.push(row);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(detailAoa);
  ws2['!cols'] = detailHeader.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  XLSX.utils.book_append_sheet(wb, ws2, '检查明细');

  // Sheet 3: 按教师汇总
  const tHeader = ['教师', '学科', '检查次数', '平均分', '达标状态'];
  const tAoa = [tHeader];
  for (const r of teacherAgg) {
    tAoa.push([r.teacher_name, r.subject || '', r.count, r.avg_score != null ? r.avg_score : '', r.avg_score != null ? (r.avg_score >= passLine ? '达标' : '未达标') : '未检查']);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(tAoa);
  ws3['!cols'] = tHeader.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  XLSX.utils.book_append_sheet(wb, ws3, '按教师汇总');

  // Sheet 4: 按组汇总
  const gHeader = ['组名', '类型', '学科', '年级', '组长', '人数', '已检', '平均分', '达标率(%)', '覆盖率(%)', '需关注'];
  const gAoa = [gHeader];
  for (const g of groupAgg) {
    const needAtt = (g.coverage != null && g.coverage < attCov) || (g.pass_rate != null && g.pass_rate < passLine);
    gAoa.push([g.name, g.type, g.subject || '', g.grade || '', g.leader_name || '', g.teacher_count, g.checked_count, g.avg_score != null ? g.avg_score : '', g.pass_rate != null ? g.pass_rate : '', g.coverage != null ? g.coverage : '', needAtt ? '是' : '']);
  }
  const ws4 = XLSX.utils.aoa_to_sheet(gAoa);
  ws4['!cols'] = gHeader.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  XLSX.utils.book_append_sheet(wb, ws4, '按组汇总');

  // Sheet 5: 口径说明
  const noteAoa = [
    ['常规检查导出口径说明'],
    [''],
    ['统计区间', `${from || '不限'} 至 ${to || '不限'}`],
    ['达标线', passLine],
    ['覆盖率关注线', attCov],
    ['需关注条数上限', attLimit],
    ['学期起始（算周次用）', semesterStart()],
    [''],
    ['口径说明：'],
    ['教师平均分 = Σ(该教师各次实得分) / Σ(该教师各次满分) × 100'],
    ['组平均分 = 组内已检教师个人平均分的均值'],
    ['组达标率 = 组内个人得分 ≥ 达标线的教师占比'],
    ['覆盖率 = 组内已检教师占比'],
    ['需关注 = 覆盖率 < 覆盖率关注线，或 达标率 < 达标线'],
    [''],
    [`生成时间：${nowStr}`],
    [`生成人：${genName}`],
  ];
  const ws5 = XLSX.utils.aoa_to_sheet(noteAoa);
  ws5['!cols'] = [{ wch: 22 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws5, '口径说明');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `常规检查情况_${from || 'all'}_${to || 'all'}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
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
