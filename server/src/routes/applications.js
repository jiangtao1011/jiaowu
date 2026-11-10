import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES, DIRECTOR_ROLES, CLERK_ROLES } from '../auth.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';
import { publicBase } from '../share.js';
import { createDraft, getDraft, deleteDraft } from '../import-stage.js';

const router = Router();

// 模板/批量导入：内存存储，直接解析
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 附件：磁盘存储（一对一辅导资料等）
const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const uploadAttachment = multer({ storage: attachmentStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// multer 磁盘存储中文名按 latin1 解码，转回 UTF-8
function decodeName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 日期 -> 星期几（1=周一 … 7=周日，与 schedules.day_of_week 约定一致）
function dayOfWeekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

// 可批量申报的角色：录入维护（admin/教务主任/教务员）+ 年级组长
const BATCH_ROLES = [...CLERK_ROLES, '年级组长'];
// 可审核申报的角色：admin + 教务主任（主任专审）+ 年级组长（年级组长限本年级，一审）
const REVIEW_ROLES = ['admin', '教务主任', '年级组长'];

// 校验 period_type 是否合法：早自习为折算型固定类型（不在按次计酬字典里），其余看字典，否则回退「答疑」
function validPeriodType(t) {
  const name = String(t || '').trim();
  if (!name) return '答疑';
  if (name === '早自习') return '早自习';
  const hit = db.prepare('SELECT 1 FROM period_type_pays WHERE name = ?').get(name);
  return hit ? name : '答疑';
}

// 年级级类型（早自习）未指定班级时，回填该年级虚班 id，保证审核通过能生成上课记录。
function virtualClassIdForGrade(grade) {
  if (!grade) return null;
  return db.prepare('SELECT id FROM classes WHERE is_virtual = 1 AND grade = ?').get(grade)?.id ?? null;
}

// 查找「活跃」（待审核/已通过）的重复申报，返回命中记录或 null。
// 重复口径：同一教师 + 同一类型 + 同一时间维度 + 同一目标。
//  - 临时（有 date）：teacher + type + date + 目标
//  - 固定排班（有 day_of_week）：teacher + type + 星期 + 目标
// 目标（与临时分支对称）：答疑/早自习看年级（年级级）；晚自习看班级（班级级）；其它看年级+班级。
// 注：固定排班的答疑/晚自习 period_no 为 0（无意义），故不参与判重。
// 已驳回 / 已撤回不视为占用，允许重新申报。excludeId 用于编辑时排除自身。
function findDuplicate({ teacher_id, period_type, date, day_of_week, period_no, grade, class_id, excludeId }) {
  if (!teacher_id || !period_type) return null;
  const conds = ["teacher_id = ?", "period_type = ?", "status IN ('pending','grade_approved','approved')"];
  const params = [teacher_id, period_type];
  if (date) {
    conds.push('date = ?'); params.push(date);
    if (period_type === '答疑' || period_type === '早自习') { conds.push('grade = ?'); params.push(grade); }
    else if (period_type === '晚自习') { conds.push('class_id = ?'); params.push(class_id); }
    else { conds.push('grade = ?'); params.push(grade); conds.push('class_id = ?'); params.push(class_id); }
  } else if (day_of_week != null) {
    conds.push('day_of_week = ?'); params.push(day_of_week);
    if (period_type === '答疑' || period_type === '早自习') { conds.push('grade = ?'); params.push(grade); }
    else if (period_type === '晚自习') { conds.push('class_id = ?'); params.push(class_id); }
    else { conds.push('grade = ?'); params.push(grade); conds.push('class_id = ?'); params.push(class_id); }
  } else {
    return null; // 缺少时间维度，无法判定重复
  }
  if (excludeId) { conds.push('id != ?'); params.push(excludeId); }
  const sql = `SELECT * FROM qna_lessons WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 1`;
  return db.prepare(sql).get(...params) ?? null;
}

// 插入一条待审核的课时申报（校验类型 + 防重复 + 写库），返回 { id } 或抛错。
// 供单条填报 POST / 与批量申报 POST /batch 共用。
// opts: { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type }
// gradeRange: 年级组长限定负责年级时传其年级名，非本年级直接抛错。
function insertQnaPending(opts, filledBy, gradeRange) {
  const { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type } = opts;
  if (!grade || !subject) throw new Error('年级和学科必填');
  if (gradeRange && grade !== gradeRange) throw new Error(`仅可申报负责年级「${gradeRange}」的课时`);
  const pt = validPeriodType(period_type);

  // 早自习为年级级，未指定班级时回填该年级虚班，保证审核通过能生成上课记录
  let resolvedClassId = class_id ? Number(class_id) : null;
  if (pt === '早自习' && !resolvedClassId) {
    resolvedClassId = virtualClassIdForGrade(grade);
    if (!resolvedClassId) throw new Error(`年级「${grade}」暂无虚拟班，请先在班级管理里生成年级虚班`);
  }

  const dup = findDuplicate({
    teacher_id, period_type: pt, date: date || null,
    day_of_week: day_of_week != null ? Number(day_of_week) : null,
    period_no: period_no != null ? Number(period_no) : null,
    grade, class_id: resolvedClassId,
  });
  if (dup) {
    const where = date ? `日期 ${date}` : `周${day_of_week} 第${period_no}节`;
    throw new Error(`已存在重复申报（${dup.status === 'approved' ? '已通过' : '待审核'}）：${pt} ${grade}${resolvedClassId ? ' ' : ''}${where}`);
  }

  const info = db
    .prepare(`INSERT INTO qna_lessons
      (grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type, status, filled_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(grade, subject, teacher_id, resolvedClassId,
      day_of_week != null ? Number(day_of_week) : null, period_no != null ? Number(period_no) : null,
      content ?? null, date ?? null, Math.max(1, Number(period_count) || 1), pt, 'pending', filledBy);
  return Number(info.lastInsertRowid);
}

// 答疑课：填报/列表/审核（审核通过后进入课表展示）
// 注：已泛化为「课时申报」——按次计酬类型（晚自习/答疑/晚练/自定义，来自 period_type_pays 字典）+ 折算型「早自习」

// 当前登录教师的自主申报聚合数据：身份、学科、可选答疑年级（含年级虚班 id）、
// 可选晚自习班级（代课年级的行政班）、我的申报记录。
router.get('/self', authRequired, (req, res) => {
  const tid = req.user.teacher_id ?? null;

  // 教师身份与学科
  let teacher = null;
  if (tid) teacher = db.prepare('SELECT id, name, subject FROM teachers WHERE id = ?').get(tid);

  // 老师教的年级（从课表推导；teacher_classes 表通常为空，不能依赖）
  const taughtGrades = new Set();
  if (tid) {
    const rows = db.prepare(`
      SELECT DISTINCT c.grade FROM schedules s
      JOIN classes c ON c.id = s.class_id
      WHERE s.teacher_id = ? AND c.grade IS NOT NULL AND c.grade != ''`).all(tid);
    for (const r of rows) taughtGrades.add(r.grade);
  }
  // 全部年级（回退用）
  const allGrades = db.prepare("SELECT DISTINCT grade FROM classes WHERE grade IS NOT NULL AND grade != '' ORDER BY grade").all().map((r) => r.grade);

  // 答疑可选年级：老师教的年级优先，否则全校年级
  const qnaGradeNames = taughtGrades.size ? [...taughtGrades].sort() : allGrades;
  // 年级虚班 id 映射
  const virtualClasses = db.prepare("SELECT id, name, grade FROM classes WHERE is_virtual = 1").all();
  const virtualByGrade = Object.fromEntries(virtualClasses.map((v) => [v.grade, v.id]));
  const qna_grades = qnaGradeNames.map((g) => ({ grade: g, virtual_class_id: virtualByGrade[g] ?? null }));

  // 晚自习可选班级：代课年级的行政班；推导不出年级则回退全校行政班
  let evening_classes;
  if (taughtGrades.size) {
    const placeholders = [...taughtGrades].map(() => '?').join(',');
    evening_classes = db.prepare(
      `SELECT id, name, grade FROM classes WHERE type = '行政班' AND grade IN (${placeholders}) ORDER BY grade, name`
    ).all(...[...taughtGrades]);
  } else {
    evening_classes = db.prepare("SELECT id, name, grade FROM classes WHERE type = '行政班' ORDER BY grade, name").all();
  }

  // 我的申报记录
  let my_records = [];
  if (tid) {
    my_records = db.prepare(`
      SELECT q.*, t.name AS teacher_name, c.name AS class_name
      FROM qna_lessons q
      LEFT JOIN teachers t ON t.id = q.teacher_id
      LEFT JOIN classes c ON c.id = q.class_id
      WHERE q.teacher_id = ?
      ORDER BY q.id DESC`).all(tid);
  }

  // 可选学科（私人定制课等需要选学科）：全部学科去重
  const subjects = db.prepare("SELECT DISTINCT subject FROM teachers WHERE subject IS NOT NULL AND subject != '' ORDER BY subject").all().map((r) => r.subject);

  return res.json({ ok: true, data: { teacher, taught_grades: [...taughtGrades], qna_grades, evening_classes, my_records, subjects } });
});

router.get('/', authRequired, (req, res) => {
  const { status, period_type, grade, date } = req.query;
  let sql = `
    SELECT q.*, t.name AS teacher_name, c.name AS class_name,
           fu.name AS filled_by_name, ru.name AS reviewed_by_name,
           gru.name AS grade_reviewed_by_name
    FROM qna_lessons q
    LEFT JOIN teachers t ON t.id = q.teacher_id
    LEFT JOIN classes c ON c.id = q.class_id
    LEFT JOIN users fu ON fu.id = q.filled_by
    LEFT JOIN users ru ON ru.id = q.reviewed_by
    LEFT JOIN users gru ON gru.id = q.grade_reviewed_by
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND q.status = ?'; params.push(status); }
  if (period_type) { sql += ' AND q.period_type = ?'; params.push(period_type); }
  if (grade) { sql += ' AND q.grade = ?'; params.push(grade); }
  if (date) { sql += ' AND q.date = ?'; params.push(date); }
  // 年级组长只看本年级
  if (req.user.role === '年级组长') {
    const managed = db.prepare('SELECT managed_grade FROM users WHERE id = ?').get(req.user.id)?.managed_grade || null;
    if (managed) { sql += ' AND q.grade = ?'; params.push(managed); }
  }
  sql += ' ORDER BY q.id DESC';
  return res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// 答疑课填报（任意登录教师可填）。临时答疑必填 date（发生日期），period_count 为节数（默认 1）
// 自主申报：teacher_id 优先取当前登录账号绑定的教师档案；无绑定时才用请求里的 teacher_id。
router.post('/', authRequired, (req, res) => {
  const { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type } = req.body || {};
  // 自主申报身份：登录账号绑定的教师优先
  const resolvedTeacherId = req.user.teacher_id ?? (teacher_id ? Number(teacher_id) : null);
  // 自主申报学科：绑定教师有学科时用教师学科
  const resolvedSubject = req.user.teacher_id ? (db.prepare('SELECT subject FROM teachers WHERE id = ?').get(req.user.teacher_id)?.subject || subject) : subject;

  try {
    const id = insertQnaPending({
      grade, subject: resolvedSubject, teacher_id: resolvedTeacherId,
      class_id, day_of_week, period_no, content, date, period_count, period_type,
    }, req.user.id);
    logAudit(req.user.id, 'fill_qna_lesson', `qna_lessons:${id}`, `填报${validPeriodType(period_type)} ${grade}${resolvedSubject}`);
    return res.json({ ok: true, data: { id } });
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message });
  }
});

// 下载答疑申报导入模板
router.get('/template', authRequired, (req, res) => {
  const headers = ['年级', '学科', '类型', '教师', '班级', '发生日期', '节数', '星期', '节次', '内容'];
  const samples = [
    ['高一', '数学', '答疑', '刘丽娟', '1201班', '2026-09-28', '2', '', '', '函数专题答疑'],
    ['高一', '物理', '晚练', '姜涛', '1201班', '2026-09-28', '1', '', '', '晚练'],
    ['高二', '英语', '晚自习', '陈志红', '1202班', '', '', '1', '8', '固定晚自习'],
    ['高一', '语文', '早自习', '刘丽娟', '', '2026-09-29', '1', '', '', '早自习'],
  ];
  const notes = [
    ['课时申报导入模板 —— 填写说明'],
    [''],
    ['一、表头（第1行固定，按顺序）：年级 | 学科 | 类型 | 教师 | 班级 | 发生日期 | 节数 | 星期 | 节次 | 内容'],
    [''],
    ['二、各列填写规则：'],
    ['1. 年级：如 高一、高二、高三。'],
    ['2. 学科：课程名称，如 数学、物理。'],
    ['3. 类型：答疑 / 晚自习 / 晚练 / 早自习 / 自定义类型（自定义需与统计中心里维护的类型名完全一致，否则按「答疑」计；早自习为折算型·不计钱，班级可留空）。'],
    ['4. 教师：教师姓名，需与「教师信息」里的姓名完全一致。'],
    ['5. 班级：班级名称，需与「班级信息」里的名称完全一致（行政班/分层/走班均可）。'],
    ['6. 发生日期：临时/不定期填报必填，格式 YYYY-MM-DD。'],
    ['7. 节数：本次实际节数，默认 1。'],
    ['8. 星期 / 节次：固定排班填报填（星期 1-7，节次数字）；临时填报这两列留空。'],
    ['9. 内容：申报内容，可留空。'],
    [''],
    ['三、要点：'],
    ['- 临时填报（填发生日期）审核通过后，按次计酬类型按「类型单价 × 节数」计酬；早自习按「课时数 × 早自习系数」折算、不计钱。'],
    ['- 固定排班（填星期+节次，不填日期）审核通过后进入课表，按班展开计酬。'],
    ['- 导入后统一为「待审核」状态，由年级组长一审、教务主任终审。'],
    ['- 示例行仅供参考，导入前请删除示例行、只保留真实数据。'],
  ];
  downloadTemplate(res, headers, samples, '课时申报导入模板.xlsx', [{ name: '填写说明', rows: notes }]);
});

// 解析 + 校验单行课务申报（不写库），返回 { ok, record } 或 { ok:false, reason, duplicate }
function buildQnaRecord(row, ctx) {
  const { teacherByName, classByName } = ctx;
  const grade = String(keyOf(row, '年级', 'grade') ?? '').trim();
  const subject = String(keyOf(row, '学科', '科目', 'subject') ?? '').trim();
  const periodType = validPeriodType(keyOf(row, '类型', 'period_type', '课型'));
  const teacherName = String(keyOf(row, '教师', '老师', 'teacher') ?? '').trim();
  const className = String(keyOf(row, '班级', 'class') ?? '').trim();
  const dateRaw = String(keyOf(row, '发生日期', '日期', 'date') ?? '').trim();
  const periodCount = Number(keyOf(row, '节数', 'period_count') ?? '');
  const dayOfWeek = Number(keyOf(row, '星期', '周几', 'day_of_week') ?? '');
  const periodNo = Number(keyOf(row, '节次', 'period_no') ?? '');
  const content = String(keyOf(row, '内容', 'content', '答疑内容') ?? '').trim();

  if (!grade || !subject) return { ok: false, reason: '缺少年级或学科' };
  const teacherId = teacherName ? teacherByName[teacherName] : null;
  if (teacherName && !teacherId) return { ok: false, reason: `教师「${teacherName}」不存在` };
  let classId = className ? classByName[className] : null;
  if (className && !classId) return { ok: false, reason: `班级「${className}」不存在` };
  // 早自习为年级级，未指定班级时回填该年级虚班
  if (periodType === '早自习' && !classId) {
    classId = virtualClassIdForGrade(grade);
    if (!classId) return { ok: false, reason: `年级「${grade}」暂无虚拟班` };
  }
  // 临时填报必须有发生日期；固定排班必须有星期
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
  const dow = Number.isFinite(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 7 ? dayOfWeek : null;
  if (!date && !dow) return { ok: false, reason: '「发生日期」或「星期」至少填一项' };

  // 防重复
  const dup = findDuplicate({
    teacher_id: teacherId, period_type: periodType, date,
    day_of_week: dow, period_no: Number.isFinite(periodNo) ? periodNo : null,
    grade, class_id: classId,
  });
  if (dup) {
    const where = date ? `日期 ${date}` : `周${dow} 第${periodNo}节`;
    return { ok: false, reason: `与现有申报重复（${dup.status === 'approved' ? '已通过' : '待审核'}）：${periodType} ${grade} ${where}`, duplicate: true };
  }

  return {
    ok: true,
    record: {
      grade, subject, teacher_id: teacherId, class_id: classId,
      day_of_week: dow, period_no: Number.isFinite(periodNo) ? periodNo : null,
      content: content || null, date, period_count: Number.isFinite(periodCount) && periodCount > 0 ? periodCount : 1,
      period_type: periodType,
    },
  };
}

function persistQna(record, userId) {
  db.prepare(`
    INSERT INTO qna_lessons
      (grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type, status, filled_by)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`)
    .run(record.grade, record.subject, record.teacher_id, record.class_id,
      record.day_of_week, record.period_no, record.content, record.date,
      record.period_count, record.period_type, userId);
}

// 预览：解析 + 校验，逐行返回状态，暂存草稿
router.post('/import/preview', authRequired, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传申报文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const teachers = db.prepare('SELECT id, name FROM teachers').all();
  const classes = db.prepare('SELECT id, name FROM classes').all();
  const ctx = {
    teacherByName: Object.fromEntries(teachers.map((t) => [t.name, t.id])),
    classByName: Object.fromEntries(classes.map((c) => [c.name, c.id])),
  };
  const columns = ['年级', '学科', '类型', '教师', '班级', '发生日期', '节数', '星期', '节次', '内容'];
  const draftRows = [];
  const summary = { total: rows.length, ok: 0, duplicate: 0, error: 0 };

  for (let i = 0; i < rows.length; i++) {
    const r = buildQnaRecord(rows[i], ctx);
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

  const token = createDraft('qna', req.user.id, { rows: draftRows });
  return res.json({ ok: true, data: { token, rows: draftRows.map(({ record, ...r }) => r), summary } });
});

// 确认入库
router.post('/import/confirm', authRequired, (req, res) => {
  const { token, row_ids } = req.body || {};
  const draft = getDraft(token, req.user.id, 'qna');
  if (!draft) return res.status(400).json({ ok: false, error: '预览已失效，请重新上传' });

  const selected = new Set(Array.isArray(row_ids) ? row_ids.map(Number) : []);
  let inserted = 0;
  const errors = [];

  for (const r of draft.payload.rows) {
    if (r.status !== 'ok' || !selected.has(r.row_id)) continue;
    persistQna(r.record, req.user.id);
    inserted++;
  }

  deleteDraft(token);
  logAudit(req.user.id, 'import_qna_lessons', 'qna_lessons', `导入课务申报 ${inserted} 条`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// 旧接口（已弃用）
router.post('/import', authRequired, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传申报文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const teachers = db.prepare('SELECT id, name FROM teachers').all();
  const classes = db.prepare('SELECT id, name FROM classes').all();
  const ctx = {
    teacherByName: Object.fromEntries(teachers.map((t) => [t.name, t.id])),
    classByName: Object.fromEntries(classes.map((c) => [c.name, c.id])),
  };

  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = buildQnaRecord(rows[i], ctx);
    if (!r.ok) { errors.push(`第 ${i + 2} 行 ${r.reason}`); continue; }
    persistQna(r.record, req.user.id);
    inserted++;
  }

  logAudit(req.user.id, 'import_qna_lessons', 'qna_lessons', `导入课务申报 ${inserted} 条`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// 批量申报上下文：返回批量申报表格所需的下拉数据，按角色分级。
// 教务员/教务主任/admin 可选全部年级；年级组长锁定其负责年级（managed_grade），
// 班级列表也限定为该年级（含年级虚班）。
router.get('/batch-context', authRequired, (req, res) => {
  const typePays = db.prepare('SELECT id, name, pay FROM period_type_pays ORDER BY id').all();
  // 教师 + 任教年级（从课表推导，任课关系在 schedules 里，不依赖 teacher_classes）
  const teachers = db.prepare('SELECT id, name, subject FROM teachers ORDER BY name').all();
  const gradeByTeacher = {};
  db.prepare(`
    SELECT DISTINCT s.teacher_id, c.grade FROM schedules s
    JOIN classes c ON c.id = s.class_id
    WHERE s.teacher_id IS NOT NULL AND c.grade IS NOT NULL AND c.grade != ''`).all()
    .forEach((r) => { (gradeByTeacher[r.teacher_id] ||= []).push(r.grade); });
  for (const t of teachers) t.grades = gradeByTeacher[t.id] || [];
  const allGrades = db.prepare("SELECT DISTINCT grade FROM classes WHERE grade IS NOT NULL AND grade != '' ORDER BY grade").all().map((r) => r.grade);

  if (ADMIN_ROLES.includes(req.user.role)) {
    const classes = db.prepare('SELECT id, name, grade, type, is_virtual FROM classes ORDER BY grade, name').all();
    return res.json({ ok: true, data: { role: req.user.role, grades: allGrades, teachers, classes, typePays } });
  }

  // 年级组长：限定负责年级
  const managed_grade = db.prepare('SELECT managed_grade FROM users WHERE id = ?').get(req.user.id)?.managed_grade || null;
  const grades = managed_grade ? [managed_grade] : allGrades;
  const classes = managed_grade
    ? db.prepare('SELECT id, name, grade, type, is_virtual FROM classes WHERE grade = ? ORDER BY name').all(managed_grade)
    : db.prepare('SELECT id, name, grade, type, is_virtual FROM classes ORDER BY grade, name').all();
  return res.json({ ok: true, data: { role: req.user.role, managed_grade, grades, teachers, classes, typePays } });
});

// 批量申报（教务员/教务主任/admin/年级组长）：一次提交多条课时申报，统一待审核。
// body: { items: [{ grade, subject, teacher_id, class_id, date, period_count, period_type, content }] }
router.post('/batch', authRequired, roleRequired(...BATCH_ROLES), (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: '请至少填写一条申报' });

  // 年级组长：强制本负责年级
  let gradeRange = null;
  if (req.user.role === '年级组长') {
    gradeRange = db.prepare('SELECT managed_grade FROM users WHERE id = ?').get(req.user.id)?.managed_grade || null;
  }

  let inserted = 0;
  const errors = [];
  items.forEach((it, idx) => {
    const line = idx + 1;
    try {
      const id = insertQnaPending({
        grade: it.grade, subject: it.subject,
        teacher_id: it.teacher_id ? Number(it.teacher_id) : null,
        class_id: it.class_id ? Number(it.class_id) : null,
        day_of_week: it.day_of_week != null ? Number(it.day_of_week) : null,
        period_no: it.period_no != null ? Number(it.period_no) : null,
        content: it.content, date: it.date || null,
        period_count: it.period_count, period_type: it.period_type,
      }, req.user.id, gradeRange);
      inserted++;
      logAudit(req.user.id, 'batch_apply_qna', `qna_lessons:${id}`, `批量申报第 ${line} 行`);
    } catch (e) {
      errors.push(`第 ${line} 行：${e.message}`);
    }
  });

  logAudit(req.user.id, 'batch_apply_qna', 'qna_lessons', `批量申报 ${inserted} 条${errors.length ? `，失败 ${errors.length} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// 审核通过后计酬：有日期 → 生成按日上课记录（source=qna）；无日期 → 视为固定排班，走课表展开。
// 返回生成的计酬记录条数（固定排班返回 0，因为要等课表展开）。
function applyQnaPayroll(q) {
  if (!q.teacher_id) return 0;
  // 年级级类型（答疑/早自习/晚练/晚晚练等未挂班级的按次计酬）回填年级虚班，保证生成计酬
  let classId = q.class_id;
  if (!classId && q.grade) {
    classId = virtualClassIdForGrade(q.grade);
    if (!classId) return 0; // 年级无虚班，无法计酬
  }
  if (q.date) {
    // 临时/不定期：按填报的日期与节数生成上课记录，类型用记录里的 period_type。
    // period_no 记 0（无节次）——按次计酬只看条数，不占具体节次，避免与正课第 1 节等冲突。
    const count = Math.max(1, Number(q.period_count) || 1);
    const insert = db.prepare(`
      INSERT INTO lesson_instances (class_id, teacher_id, subject, date, period_no, period_type, term, source, source_id, note)
      VALUES (?,?,?,?,0,?, '常规', 'qna', ?, ?)`);
    for (let i = 0; i < count; i++) {
      insert.run(classId, q.teacher_id, q.subject, q.date, q.period_type, q.id, q.content ?? null);
    }
    return count;
  }
  // 固定排班：仍进入课表，之后由课表展开到 lesson_instances
  // 防重复：若同班同师同科目同星期同类型已有课表，则不重复插入（历史重复数据的审核兜底）
  const dupSch = db.prepare(`
    SELECT id FROM schedules
    WHERE class_id = ? AND teacher_id = ? AND subject = ? AND day_of_week = ? AND period_type = ?
    LIMIT 1`).get(classId, q.teacher_id, q.subject, q.day_of_week ?? 0, q.period_type);
  if (dupSch) return 0;
  db.prepare(`
    INSERT INTO schedules (class_id, teacher_id, subject, day_of_week, period_no, period_type)
    VALUES (?,?,?,?,?,?)`)
    .run(classId, q.teacher_id, q.subject, q.day_of_week ?? 0, q.period_no ?? 1, q.period_type);
  return 0;
}

// 审核课时申报（两级审批）：
//  - 年级组长：一审，pending → grade_approved（待课程中心终审）/ rejected，只审本年级。
//  - 课程中心（admin/教务主任）：终审，pending 或 grade_approved → approved（计酬）/ rejected。
router.patch('/:id/review', authRequired, roleRequired(...REVIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM qna_lessons WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: '课时申报记录不存在' });
  const { approved } = req.body || {};
  const isGradeLeader = req.user.role === '年级组长';

  if (isGradeLeader) {
    // 年级组长一审：只能审本年级的待一审申报
    const managed = db.prepare('SELECT managed_grade FROM users WHERE id = ?').get(req.user.id)?.managed_grade || null;
    if (managed && q.grade && q.grade !== managed) {
      return res.status(403).json({ ok: false, error: '只能审核本年级的申报' });
    }
    if (q.status !== 'pending') return res.status(400).json({ ok: false, error: '该申报已审核，请刷新后查看' });

    if (approved) {
      db.prepare("UPDATE qna_lessons SET status = 'grade_approved', grade_reviewed_by = ?, grade_reviewed_at = datetime('now','localtime') WHERE id = ?")
        .run(req.user.id, id);
    } else {
      db.prepare("UPDATE qna_lessons SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?")
        .run(req.user.id, id);
    }
    const status = approved ? 'grade_approved' : 'rejected';
    logAudit(req.user.id, 'grade_review_qna', `qna_lessons:${id}`, `年级组长一审 ${status}`);
    return res.json({ ok: true, data: { id, status } });
  }

  // 课程中心终审：待一审（兜底，管理员全权）或已过年级组长一审
  if (q.status !== 'pending' && q.status !== 'grade_approved') {
    return res.status(400).json({ ok: false, error: '该申报已终审，请刷新后查看' });
  }
  const status = approved ? 'approved' : 'rejected';
  db.prepare("UPDATE qna_lessons SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?")
    .run(status, req.user.id, id);

  let created = 0;
  if (approved) {
    created = applyQnaPayroll(q);
  }
  logAudit(req.user.id, 'review_qna_lesson', `qna_lessons:${id}`, `课程中心终审 ${status}${created ? `，生成上课记录 ${created} 条` : ''}`);
  return res.json({ ok: true, data: { id, status, created_instances: created } });
});

// 权限判断：能否编辑某条答疑记录。
// 规则：管理员（教务主任/教务员/admin）全权；填报人只能编辑自己「待一审」的记录。
function canEditQna(req, q) {
  if (ADMIN_ROLES.includes(req.user.role)) return true;
  return q.filled_by === req.user.id && q.status === 'pending';
}

// 权限判断：能否删除/撤回某条答疑记录。
// 规则：管理员全权；填报人可删除/撤回自己「未终审」的记录（待一审 或 已过年级组长一审待课程中心终审）。
function canDeleteQna(req, q) {
  if (ADMIN_ROLES.includes(req.user.role)) return true;
  return q.filled_by === req.user.id && (q.status === 'pending' || q.status === 'grade_approved');
}

// 编辑答疑课（待审核可改；管理员可改任意状态）
router.patch('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM qna_lessons WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: '答疑课记录不存在' });
  if (!canEditQna(req, q)) return res.status(403).json({ ok: false, error: '无权限修改该记录' });

  const { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type } = req.body || {};

  // 计算编辑后的最终字段值，用于防重复判定（排除自身）
  const newTeacherId = teacher_id !== undefined ? (teacher_id ? Number(teacher_id) : null) : q.teacher_id;
  const newType = period_type !== undefined ? validPeriodType(period_type) : q.period_type;
  const newGrade = grade ?? q.grade;
  let newClassId = class_id !== undefined ? (class_id ? Number(class_id) : null) : q.class_id;
  // 早自习为年级级，未指定班级时回填该年级虚班
  if (newType === '早自习' && !newClassId) {
    newClassId = virtualClassIdForGrade(newGrade);
    if (!newClassId) return res.status(400).json({ ok: false, error: `年级「${newGrade}」暂无虚拟班，请先在班级管理里生成年级虚班` });
  }
  const newDow = day_of_week !== undefined ? (day_of_week != null && day_of_week !== '' ? Number(day_of_week) : null) : q.day_of_week;
  const newPeriodNo = period_no !== undefined ? (period_no != null && period_no !== '' ? Number(period_no) : null) : q.period_no;
  const newDate = date !== undefined ? (date || null) : q.date;

  const dup = findDuplicate({
    teacher_id: newTeacherId, period_type: newType, date: newDate,
    day_of_week: newDow, period_no: newPeriodNo,
    grade: newGrade, class_id: newClassId, excludeId: id,
  });
  if (dup) {
    const where = newDate ? `日期 ${newDate}` : `周${newDow} 第${newPeriodNo}节`;
    return res.status(409).json({ ok: false, error: `修改后会与现有申报重复（${dup.status === 'approved' ? '已通过' : '待审核'}）：${newType} ${newGrade} ${where}` });
  }

  const upd = db.prepare(`
    UPDATE qna_lessons SET
      grade = ?, subject = ?, teacher_id = ?, class_id = ?, day_of_week = ?,
      period_no = ?, content = ?, date = ?, period_count = ?, period_type = ?
    WHERE id = ?`);
  upd.run(
    newGrade,
    subject ?? q.subject,
    newTeacherId,
    newClassId,
    newDow,
    newPeriodNo,
    content !== undefined ? content : q.content,
    newDate,
    period_count !== undefined ? Math.max(1, Number(period_count) || 1) : q.period_count,
    newType,
    id
  );
  logAudit(req.user.id, 'update_qna_lesson', `qna_lessons:${id}`, `编辑${q.period_type} ${grade ?? q.grade}${subject ?? q.subject}`);
  return res.json({ ok: true, data: { id } });
});

// 删除答疑课：联动删除该答疑已生成的上课记录（source=qna）
router.delete('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM qna_lessons WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: '答疑课记录不存在' });
  if (!canDeleteQna(req, q)) return res.status(403).json({ ok: false, error: '无权限删除该记录' });

  // 删除该答疑生成的上课记录（若有）
  const removed = db.prepare('DELETE FROM lesson_instances WHERE source = ? AND source_id = ?').run('qna', id);
  db.prepare('DELETE FROM qna_lessons WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_qna_lesson', `qna_lessons:${id}`, `删除答疑课（联动删除上课记录 ${removed.changes} 条）`);
  return res.json({ ok: true, data: { id, removed_instances: removed.changes } });
});

// 撤回已通过的答疑：状态置为 withdrawn，并删除已生成的上课记录
router.patch('/:id/withdraw', authRequired, roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM qna_lessons WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: '答疑课记录不存在' });
  if (q.status !== 'approved') return res.status(400).json({ ok: false, error: '仅已通过的记录可撤回' });

  // 删除该答疑已生成的上课记录
  const removed = db.prepare('DELETE FROM lesson_instances WHERE source = ? AND source_id = ?').run('qna', id);
  db.prepare('UPDATE qna_lessons SET status = \'withdrawn\', reviewed_by = ?, reviewed_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(req.user.id, id);
  logAudit(req.user.id, 'withdraw_qna_lesson', `qna_lessons:${id}`, `撤回答疑课（联动删除上课记录 ${removed.changes} 条）`);
  return res.json({ ok: true, data: { id, status: 'withdrawn', removed_instances: removed.changes } });
});

// ===== 课程申报（自定义表单 + 分享填报 + 审核计酬） =====

// 校验课程计酬配置合法，返回 { ok, error }。
// 三种计酬方式：
//  - 按次计酬：period_type 需命中 period_type_pays（单价×节数）
//  - 固定折算：period_type 需命中 period_type_coefficients（节数×固定系数）
//  - 正课折算：学科系数+班额系数（节数×（学科+班额）），period_type 固定记「正课」，需有 subject
function validatePayConfig(pay_mode, period_type, subject) {
  if (pay_mode === '正课折算') {
    if (!subject) return { ok: false, error: '正课折算需设置学科' };
    return { ok: true };
  }
  if (!period_type) return { ok: false, error: '请选择计酬类型' };
  if (pay_mode === '折算' || pay_mode === '固定折算') {
    const hit = db.prepare('SELECT 1 FROM period_type_coefficients WHERE name = ?').get(period_type);
    return hit ? { ok: true } : { ok: false, error: `折算类型「${period_type}」不在折算字典里，请先在统计配置中添加` };
  }
  // 默认按次计酬
  const hit = db.prepare('SELECT 1 FROM period_type_pays WHERE name = ?').get(period_type);
  return hit ? { ok: true } : { ok: false, error: `按次计酬类型「${period_type}」不在类型字典里，请先在统计配置中添加` };
}

// 取年级虚班 id（课程计酬挂虚班，满足 lesson_instances.class_id NOT NULL）
// 注：复用前文早自习申报的 virtualClassIdForGrade（定义于文件头部）

// 通用虚班 id（面向学生个人的课务：一对一/竞赛等，无年级时挂此占位）
function universalVirtualClassId() {
  return db.prepare("SELECT id FROM classes WHERE is_virtual = 1 AND (grade IS NULL OR grade = '')").get()?.id ?? null;
}

// 解析任务/填报里的 JSON 字段，容错
function parseJSON(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// 序列化课程的分享信息（share_url 由 publicBase 拼）
function courseShare(req, task) {
  return {
    share_token: task.share_token,
    share_url: task.share_token ? `${publicBase(req)}/course/${task.share_token}` : '',
  };
}

// 申报任务列表（含填报人数）
router.get('/tasks', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM applications a WHERE a.task_id = t.id) AS apply_count
    FROM application_tasks t ORDER BY t.id DESC`).all();
  return res.json({ ok: true, data: rows.map((t) => ({
    ...t,
    form_schema: parseJSON(t.form_schema, []),
    ...(t.share_token ? { share_url: `${publicBase(req)}/course/${t.share_token}` } : {}),
  })) });
});

// 创建课程（教务主任：自定义字段 + 计酬配置 + 分享）
router.post('/tasks', authRequired, roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { title, deadline, filler_role, form_schema, pay_mode, period_type, subject, grade } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: '课程标题必填' });

  // 归一化 pay_mode：旧「折算」→「固定折算」；未知/空→「按次计酬」
  const mode = pay_mode === '折算' || pay_mode === '固定折算' ? '固定折算'
    : pay_mode === '正课折算' ? '正课折算'
    : '按次计酬';
  const v = validatePayConfig(mode, period_type, subject);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const schema = Array.isArray(form_schema) ? form_schema : [];
  const share_token = crypto.randomBytes(12).toString('hex');
  const info = db.prepare(`
    INSERT INTO application_tasks
      (title, deadline, filler_role, form_schema, pay_mode, period_type, subject, grade, share_token, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(title, deadline ?? null, filler_role ?? '教师', JSON.stringify(schema),
      mode, mode === '正课折算' ? '正课' : String(period_type || '').trim(), subject ?? null, grade ?? null, share_token, req.user.id);

  const task = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(info.lastInsertRowid);
  logAudit(req.user.id, 'create_application_task', `application_tasks:${info.lastInsertRowid}`, `创建课程 ${title}（${mode}·${mode === '正课折算' ? subject : period_type}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid), ...courseShare(req, task) } });
});

// 课程详情（按 id，供桌面端编辑查看）
router.get('/tasks/:taskId', authRequired, (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ ok: false, error: '课程不存在' });
  return res.json({ ok: true, data: { ...task, form_schema: parseJSON(task.form_schema, []), ...courseShare(req, task) } });
});

// 编辑课程（教务主任）：标题/截止/学科/年级/计酬方式/自定义字段
router.patch('/tasks/:taskId', authRequired, roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ ok: false, error: '课程不存在' });

  const { title, deadline, filler_role, form_schema, pay_mode, period_type, subject, grade } = req.body || {};
  const nextTitle = title !== undefined ? String(title).trim() : task.title;
  if (!nextTitle) return res.status(400).json({ ok: false, error: '课程标题必填' });

  const mode = pay_mode === '折算' || pay_mode === '固定折算' ? '固定折算'
    : pay_mode === '正课折算' ? '正课折算'
    : pay_mode !== undefined ? '按次计酬' : task.pay_mode;
  const nextSubject = subject !== undefined ? (subject || null) : task.subject;
  const nextPeriodType = period_type !== undefined ? (mode === '正课折算' ? '正课' : String(period_type || '').trim()) : task.period_type;
  // 校验计酬配置：正课折算允许学科为空（三科合一场景，老师填报时再选学科）
  if (mode !== '正课折算') {
    const v = validatePayConfig(mode, nextPeriodType, nextSubject);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  }

  db.prepare(`
    UPDATE application_tasks SET title = ?, deadline = ?, filler_role = ?, form_schema = ?, pay_mode = ?, period_type = ?, subject = ?, grade = ?
    WHERE id = ?`)
    .run(nextTitle,
      deadline !== undefined ? (deadline || null) : task.deadline,
      filler_role !== undefined ? (filler_role || '教师') : task.filler_role,
      form_schema !== undefined ? JSON.stringify(Array.isArray(form_schema) ? form_schema : []) : task.form_schema,
      mode, nextPeriodType, nextSubject,
      grade !== undefined ? (grade || null) : task.grade,
      taskId);
  logAudit(req.user.id, 'update_application_task', `application_tasks:${taskId}`, `编辑课程 ${nextTitle}`);
  return res.json({ ok: true, data: { id: taskId } });
});

// 课程详情（按分享 token，供手机端分享页；需登录识别身份）
router.get('/course/:token', authRequired, (req, res) => {
  const task = db.prepare('SELECT * FROM application_tasks WHERE share_token = ?').get(req.params.token);
  if (!task) return res.status(404).json({ ok: false, error: '课程不存在或链接已失效' });
  return res.json({ ok: true, data: { ...task, form_schema: parseJSON(task.form_schema, []) } });
});

// 教师填报课程（手机端分享页）。teacher_id 优先取登录账号绑定的教师档案。
// 支持附件（一对一辅导资料等）；按场景字段 + 计酬方式计算「量」。
router.post('/tasks/:taskId/apply', authRequired, uploadAttachment.array('attachments', 5), (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ ok: false, error: '课程不存在' });

  const { form_data, period_count, date, class_id, period_no } = req.body || {};
  const teacherId = req.user.teacher_id ?? null;
  if (!teacherId) return res.status(400).json({ ok: false, error: '你的账号尚未绑定教师档案，无法申报，请联系教务员绑定' });
  if (!date) return res.status(400).json({ ok: false, error: '请填写上课日期' });

  // 解析 form_data（可能已由前端 JSON 序列化）
  let fd = form_data;
  if (typeof fd === 'string') { try { fd = JSON.parse(fd); } catch { fd = {}; } }
  if (fd == null) fd = {};

  // ===== 场景化「量」计算 =====
  let count = 1;
  if (task.pay_mode === '按次计酬') {
    // 一对一：⌈时长(分钟)/90⌉ 节，最小 1 节
    const durationMin = Number(fd.duration ?? fd.时长 ?? 0);
    count = Number.isFinite(durationMin) && durationMin > 0 ? Math.max(1, Math.ceil(durationMin / 90)) : 1;
  } else if (task.pay_mode === '正课折算') {
    // 心理课：每次固定 1 课时
    count = 1;
  } else {
    // 固定折算（竞赛）：老师自填课时数（period_count 优先，其次 form_data 里的课时数）
    const pc = Number(period_count) || Number(fd.period_count ?? fd.课时数) || 1;
    count = Math.max(1, pc);
  }

  // 正课折算：必须选具体班级（班额系数依赖班级）
  let resolvedClassId = class_id ? Number(class_id) : null;
  if (task.pay_mode === '正课折算' && !resolvedClassId) {
    return res.status(400).json({ ok: false, error: '请选择上课班级' });
  }
  // 正课折算学科：任务预设了学科则用任务的；否则老师填报时必选（存快照）
  let resolvedSubject = task.subject || null;
  if (task.pay_mode === '正课折算' && !resolvedSubject) {
    resolvedSubject = String(fd.subject ?? '').trim() || null;
    if (!resolvedSubject) return res.status(400).json({ ok: false, error: '请选择学科' });
  }

  // ===== 正课折算（心理/中医等）重复性检查：班级 + 日期 + 节次不能与现有课表冲突 =====
  if (task.pay_mode === '正课折算' && resolvedClassId && period_no) {
    const pno = Number(period_no);
    const dow = dayOfWeekOf(date);
    // 1) 固定课表：同班同星期同节次是否已有课（含常规/各时段）
    const sch = db.prepare(`
      SELECT s.id, s.subject, t.name AS teacher_name
      FROM schedules s LEFT JOIN teachers t ON t.id = s.teacher_id
      WHERE s.class_id = ? AND s.day_of_week = ? AND s.period_no = ? AND s.effective_to IS NULL
      LIMIT 1`).get(resolvedClassId, dow, pno);
    if (sch) {
      return res.status(409).json({ ok: false, error: `该班周${'一二三四五六日'[dow - 1]}第${pno}节已有课（${sch.subject || '未命名'}，${sch.teacher_name || '未知教师'}），请换节次或班级` });
    }
    // 2) 已生成的上课记录（含已通过的 course/qna/加课等）：同班同日期同节次
    const inst = db.prepare(`
      SELECT li.id, li.subject, t.name AS teacher_name
      FROM lesson_instances li LEFT JOIN teachers t ON t.id = li.teacher_id
      WHERE li.class_id = ? AND li.date = ? AND li.period_no = ? AND li.cancelled = 0
      LIMIT 1`).get(resolvedClassId, date, pno);
    if (inst) {
      return res.status(409).json({ ok: false, error: `该班${date}第${pno}节已有课（${inst.subject || '未命名'}，${inst.teacher_name || '未知教师'}），请换节次或班级` });
    }
  }

  const info = db.prepare(`
    INSERT INTO applications (task_id, teacher_id, form_data, period_count, date, class_id, period_no, subject, status, filled_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, teacherId, JSON.stringify(fd), count, date, resolvedClassId,
      period_no ? Number(period_no) : null, resolvedSubject, 'pending', req.user.id);

  // 附件落盘
  const attId = Number(info.lastInsertRowid);
  for (const f of req.files || []) {
    db.prepare('INSERT INTO application_attachments (application_id, filename, stored_path, size) VALUES (?,?,?,?)')
      .run(attId, decodeName(f.originalname), f.filename, f.size || 0);
  }

  logAudit(req.user.id, 'apply_course', `applications:${attId}`, `申报课程（${task.title}）`);
  return res.json({ ok: true, data: { id: attId } });
});

// 某课程下的填报记录
router.get('/tasks/:taskId/applications', authRequired, (req, res) => {
  const taskId = Number(req.params.taskId);
  const rows = db.prepare(`
    SELECT a.*, t.name AS teacher_name, fu.name AS filled_by_name, ru.name AS reviewed_by_name
    FROM applications a
    LEFT JOIN teachers t ON t.id = a.teacher_id
    LEFT JOIN users fu ON fu.id = a.filled_by
    LEFT JOIN users ru ON ru.id = a.reviewed_by
    WHERE a.task_id = ?
    ORDER BY a.id DESC`).all(taskId);
  const attStmt = db.prepare('SELECT id, filename, size FROM application_attachments WHERE application_id = ?');
  return res.json({ ok: true, data: rows.map((a) => ({
    ...a,
    form_data: parseJSON(a.form_data, {}),
    attachments: attStmt.all(a.id),
  })) });
});

// 附件下载（登录即可，需属本申报的审核人/填报人可看；此处简化为登录可下载）
router.get('/applications/attachments/:attId/download', authRequired, (req, res) => {
  const att = db.prepare('SELECT * FROM application_attachments WHERE id = ?').get(Number(req.params.attId));
  if (!att) return res.status(404).json({ ok: false, error: '附件不存在' });
  res.download(path.join(UPLOAD_DIR, att.stored_path), att.filename);
});

// 审核课程申报：通过后生成 lesson_instances（source='course'），按课程计酬配置进统计中心。
router.patch('/applications/:id/review', authRequired, roleRequired(...REVIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare(`
    SELECT a.*, t.period_type, t.pay_mode, t.subject AS task_subject, t.grade AS task_grade
    FROM applications a JOIN application_tasks t ON t.id = a.task_id
    WHERE a.id = ?`).get(id);
  if (!a) return res.status(404).json({ ok: false, error: '申报记录不存在' });
  const { approved } = req.body || {};
  const status = approved ? 'approved' : 'rejected';

  db.prepare('UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(status, req.user.id, id);

  // 审核通过：生成上课记录计酬
  let created = 0;
  if (approved) {
    if (!a.date) {
      return res.status(400).json({ ok: false, error: '该申报缺少上课日期，无法计酬' });
    }
    const count = Math.max(1, Number(a.period_count) || 1);

    // 正课折算：挂填报的具体班级，period_type='正课'，命中 computePay 兜底（学科+班额系数）
    if (a.pay_mode === '正课折算') {
      const classId = a.class_id ? Number(a.class_id) : null;
      if (!classId) {
        return res.status(400).json({ ok: false, error: '该正课折算申报缺少班级，无法计酬' });
      }
      const pno = a.period_no != null ? Number(a.period_no) : 0; // 心理课填节次则落到第 N 节，否则 0（无节次）
      const insert = db.prepare(`
        INSERT INTO lesson_instances (class_id, teacher_id, subject, date, period_no, period_type, term, source, source_id, note)
        VALUES (?,?,?,?,?, '正课', '常规', 'course', ?, ?)`);
      for (let i = 0; i < count; i++) {
        insert.run(classId, a.teacher_id, a.subject ?? null, a.date, pno + i, a.id, a.course_name ?? null);
      }
      created = count;
    } else {
      // 按次计酬 / 固定折算：挂虚班占位（不读班级的计酬，仅满足 class_id NOT NULL）。
      // 课程设了年级则挂年级虚班（保留分年级覆盖价能力）；否则挂通用虚班（个人课）。
      let classId = a.task_grade ? virtualClassIdForGrade(a.task_grade) : null;
      if (!classId) classId = universalVirtualClassId();
      if (!classId) {
        return res.status(400).json({ ok: false, error: '缺少计酬挂靠的虚班，请联系管理员初始化' });
      }
      const insert = db.prepare(`
        INSERT INTO lesson_instances (class_id, teacher_id, subject, date, period_no, period_type, term, source, source_id, note)
        VALUES (?,?,?,?,0,?, '常规', 'course', ?, ?)`);
      for (let i = 0; i < count; i++) {
        insert.run(classId, a.teacher_id, a.task_subject ?? null, a.date, a.period_type, a.id, a.course_name ?? null);
      }
      created = count;
    }
  }

  logAudit(req.user.id, 'review_application', `applications:${id}`, `审核课程申报 ${status}${created ? `，生成上课记录 ${created} 条` : ''}`);
  return res.json({ ok: true, data: { id, status, created_instances: created } });
});

// 撤回已通过的课程申报：状态置 withdrawn，联动删除已生成上课记录
router.patch('/applications/:id/withdraw', authRequired, roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ ok: false, error: '申报记录不存在' });
  if (a.status !== 'approved') return res.status(400).json({ ok: false, error: '仅已通过的记录可撤回' });

  const removed = db.prepare('DELETE FROM lesson_instances WHERE source = ? AND source_id = ?').run('course', id);
  db.prepare('UPDATE applications SET status = \'withdrawn\', reviewed_by = ?, reviewed_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(req.user.id, id);
  logAudit(req.user.id, 'withdraw_application', `applications:${id}`, `撤回课程申报（联动删除上课记录 ${removed.changes} 条）`);
  return res.json({ ok: true, data: { id, status: 'withdrawn', removed_instances: removed.changes } });
});

// 删除课程申报：联动删除已生成的上课记录 + 附件
router.delete('/applications/:id', authRequired, roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ ok: false, error: '申报记录不存在' });

  const removed = db.prepare('DELETE FROM lesson_instances WHERE source = ? AND source_id = ?').run('course', id);
  // 删除附件文件 + 记录
  const atts = db.prepare('SELECT stored_path FROM application_attachments WHERE application_id = ?').all(id);
  for (const f of atts) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_path)); } catch { /* 忽略 */ } }
  db.prepare('DELETE FROM application_attachments WHERE application_id = ?').run(id);
  db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_application', `applications:${id}`, `删除课程申报（联动删除上课记录 ${removed.changes} 条）`);
  return res.json({ ok: true, data: { id, removed_instances: removed.changes } });
});

// 删除课程任务：级联删除该课程下所有填报记录、其生成的上课记录、附件，再删课程本身。
router.delete('/tasks/:taskId', authRequired, roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ ok: false, error: '课程不存在' });

  // 该课程下所有填报记录
  const apps = db.prepare('SELECT id FROM applications WHERE task_id = ?').all(taskId);
  let removedInstances = 0;
  let removedAtts = 0;
  for (const a of apps) {
    // 删生成的上课记录
    removedInstances += db.prepare('DELETE FROM lesson_instances WHERE source = ? AND source_id = ?').run('course', a.id).changes;
    // 删附件文件 + 记录
    const atts = db.prepare('SELECT stored_path FROM application_attachments WHERE application_id = ?').all(a.id);
    for (const f of atts) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_path)); } catch { /* 忽略 */ } }
    removedAtts += db.prepare('DELETE FROM application_attachments WHERE application_id = ?').run(a.id).changes;
  }
  const removedApps = db.prepare('DELETE FROM applications WHERE task_id = ?').run(taskId).changes;
  db.prepare('DELETE FROM application_tasks WHERE id = ?').run(taskId);

  logAudit(req.user.id, 'delete_application_task', `application_tasks:${taskId}`, `删除课程「${task.title}」（联动删除填报 ${removedApps} 条、上课记录 ${removedInstances} 条、附件 ${removedAtts} 个）`);
  return res.json({ ok: true, data: { id: taskId, removed_apps: removedApps, removed_instances: removedInstances, removed_attachments: removedAtts } });
});

export default router;
