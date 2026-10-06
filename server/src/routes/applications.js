import { Router } from 'express';
import multer from 'multer';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES } from '../auth.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 可批量申报的角色：教务员/教务处/admin + 年级组长
const BATCH_ROLES = [...ADMIN_ROLES, '年级组长'];
// 可审核申报的角色：admin/教务员/教务处 + 年级组长（年级组长限本年级）
const REVIEW_ROLES = [...ADMIN_ROLES, '年级组长'];

// 校验 period_type 是否在按次计酬类型字典里；否则回退「答疑」
function validPeriodType(t) {
  const name = String(t || '').trim();
  if (!name) return '答疑';
  const hit = db.prepare('SELECT 1 FROM period_type_pays WHERE name = ?').get(name);
  return hit ? name : '答疑';
}

// 查找「活跃」（待审核/已通过）的重复申报，返回命中记录或 null。
// 重复口径：同一教师 + 同一类型 + 同一时间维度 + 同一目标。
//  - 临时（有 date）：teacher + type + date + 目标
//  - 固定排班（有 day_of_week + period_no）：teacher + type + 星期 + 节次 + 班级
// 目标：答疑看年级（年级级）；晚自习看班级（班级级）；其它类型看年级+班级。
// 已驳回 / 已撤回不视为占用，允许重新申报。excludeId 用于编辑时排除自身。
function findDuplicate({ teacher_id, period_type, date, day_of_week, period_no, grade, class_id, excludeId }) {
  if (!teacher_id || !period_type) return null;
  const conds = ["teacher_id = ?", "period_type = ?", "status IN ('pending','approved')"];
  const params = [teacher_id, period_type];
  if (date) {
    conds.push('date = ?'); params.push(date);
    if (period_type === '答疑') { conds.push('grade = ?'); params.push(grade); }
    else if (period_type === '晚自习') { conds.push('class_id = ?'); params.push(class_id); }
    else { conds.push('grade = ?'); params.push(grade); conds.push('class_id = ?'); params.push(class_id); }
  } else if (day_of_week != null && period_no != null) {
    conds.push('day_of_week = ?'); params.push(day_of_week);
    conds.push('period_no = ?'); params.push(period_no);
    conds.push('class_id = ?'); params.push(class_id);
  } else {
    return null; // 缺少时间维度，无法判定重复
  }
  if (excludeId) { conds.push('id != ?'); params.push(excludeId); }
  const sql = `SELECT * FROM qna_lessons WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 1`;
  return db.prepare(sql).get(...params) ?? null;
}

// 插入一条待审核的按次计酬申报（校验类型 + 防重复 + 写库），返回 { id } 或抛错。
// 供单条填报 POST / 与批量申报 POST /batch 共用。
// opts: { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type }
// gradeRange: 年级组长限定负责年级时传其年级名，非本年级直接抛错。
function insertQnaPending(opts, filledBy, gradeRange) {
  const { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type } = opts;
  if (!grade || !subject) throw new Error('年级和学科必填');
  if (gradeRange && grade !== gradeRange) throw new Error(`仅可申报负责年级「${gradeRange}」的课时`);
  const pt = validPeriodType(period_type);

  const dup = findDuplicate({
    teacher_id, period_type: pt, date: date || null,
    day_of_week: day_of_week != null ? Number(day_of_week) : null,
    period_no: period_no != null ? Number(period_no) : null,
    grade, class_id: class_id ? Number(class_id) : null,
  });
  if (dup) {
    const where = date ? `日期 ${date}` : `周${day_of_week} 第${period_no}节`;
    throw new Error(`已存在重复申报（${dup.status === 'approved' ? '已通过' : '待审核'}）：${pt} ${grade}${class_id ? ' ' : ''}${where}`);
  }

  const info = db
    .prepare(`INSERT INTO qna_lessons
      (grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type, status, filled_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(grade, subject, teacher_id, class_id ? Number(class_id) : null,
      day_of_week != null ? Number(day_of_week) : null, period_no != null ? Number(period_no) : null,
      content ?? null, date ?? null, Math.max(1, Number(period_count) || 1), pt, 'pending', filledBy);
  return Number(info.lastInsertRowid);
}

// 答疑课：填报/列表/审核（审核通过后进入课表展示）
// 注：已泛化为「按次计酬申报」——类型可为晚自习/答疑/晚练/自定义（来自 period_type_pays 字典）

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

  return res.json({ ok: true, data: { teacher, taught_grades: [...taughtGrades], qna_grades, evening_classes, my_records } });
});

router.get('/', authRequired, (req, res) => {
  const { status, period_type, grade, date } = req.query;
  let sql = `
    SELECT q.*, t.name AS teacher_name, c.name AS class_name,
           fu.name AS filled_by_name, ru.name AS reviewed_by_name
    FROM qna_lessons q
    LEFT JOIN teachers t ON t.id = q.teacher_id
    LEFT JOIN classes c ON c.id = q.class_id
    LEFT JOIN users fu ON fu.id = q.filled_by
    LEFT JOIN users ru ON ru.id = q.reviewed_by
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
  ];
  const notes = [
    ['答疑/按次计酬申报导入模板 —— 填写说明'],
    [''],
    ['一、表头（第1行固定，按顺序）：年级 | 学科 | 类型 | 教师 | 班级 | 发生日期 | 节数 | 星期 | 节次 | 内容'],
    [''],
    ['二、各列填写规则：'],
    ['1. 年级：如 高一、高二、高三。'],
    ['2. 学科：课程名称，如 数学、物理。'],
    ['3. 类型：答疑 / 晚自习 / 晚练 / 自定义类型（需与统计中心里维护的类型名完全一致，否则按「答疑」计）。'],
    ['4. 教师：教师姓名，需与「教师信息」里的姓名完全一致。'],
    ['5. 班级：班级名称，需与「班级信息」里的名称完全一致（行政班/分层/走班均可）。'],
    ['6. 发生日期：临时/不定期填报必填，格式 YYYY-MM-DD。'],
    ['7. 节数：本次实际节数，默认 1。'],
    ['8. 星期 / 节次：固定排班填报填（星期 1-7，节次数字）；临时填报这两列留空。'],
    ['9. 内容：答疑内容，可留空。'],
    [''],
    ['三、要点：'],
    ['- 临时填报（填发生日期）审核通过后按「类型单价 × 节数」计酬。'],
    ['- 固定排班（填星期+节次，不填日期）审核通过后进入课表，按班展开计酬。'],
    ['- 导入后统一为「待审核」状态，由教务处逐条审核。'],
    ['- 示例行仅供参考，导入前请删除示例行、只保留真实数据。'],
  ];
  downloadTemplate(res, headers, samples, '答疑申报导入模板.xlsx', [{ name: '填写说明', rows: notes }]);
});

// 批量导入答疑申报（任意登录用户；导入后统一待审核）
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
  const teacherByName = Object.fromEntries(teachers.map((t) => [t.name, t.id]));
  const classByName = Object.fromEntries(classes.map((c) => [c.name, c.id]));

  const insert = db.prepare(`
    INSERT INTO qna_lessons
      (grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type, status, filled_by)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`);

  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
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

    if (!grade || !subject) { errors.push(`第 ${i + 2} 行缺少年级或学科`); continue; }
    const teacherId = teacherName ? teacherByName[teacherName] : null;
    if (teacherName && !teacherId) { errors.push(`第 ${i + 2} 行教师「${teacherName}」不存在`); continue; }
    const classId = className ? classByName[className] : null;
    if (className && !classId) { errors.push(`第 ${i + 2} 行班级「${className}」不存在`); continue; }
    // 临时填报必须有发生日期；固定排班必须有星期
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
    const dow = Number.isFinite(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 7 ? dayOfWeek : null;
    if (!date && !dow) { errors.push(`第 ${i + 2} 行「发生日期」或「星期」至少填一项`); continue; }

    insert.run(grade, subject, teacherId, classId,
      dow, Number.isFinite(periodNo) ? periodNo : null, content || null, date,
      Number.isFinite(periodCount) && periodCount > 0 ? periodCount : 1, periodType, req.user.id);
    inserted++;
  }

  logAudit(req.user.id, 'import_qna_lessons', 'qna_lessons', `导入答疑申报 ${inserted} 条`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// 批量申报上下文：返回批量申报表格所需的下拉数据，按角色分级。
// 教务员/教务处/admin 可选全部年级；年级组长锁定其负责年级（managed_grade），
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

// 批量申报（教务员/教务处/admin/年级组长）：一次提交多条按次计酬课时，统一待审核。
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

// 审核答疑课（教务处/管理员 + 年级组长，年级组长限本年级）
router.patch('/:id/review', authRequired, roleRequired(...REVIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM qna_lessons WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: '答疑课记录不存在' });
  // 年级组长：只能审本年级的申报
  if (req.user.role === '年级组长') {
    const managed = db.prepare('SELECT managed_grade FROM users WHERE id = ?').get(req.user.id)?.managed_grade || null;
    if (managed && q.grade && q.grade !== managed) {
      return res.status(403).json({ ok: false, error: '只能审核本年级的申报' });
    }
  }
  const { approved } = req.body || {};
  const status = approved ? 'approved' : 'rejected';
  db.prepare('UPDATE qna_lessons SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(status, req.user.id, id);

  // 审核通过后计酬：有日期 → 生成按日上课记录（source=qna）；无日期 → 视为固定排班，走课表展开
  if (approved) {
    if (q.teacher_id && q.class_id) {
      if (q.date) {
        // 临时/不定期：按填报的日期与节数生成上课记录，类型用记录里的 period_type
        const count = Math.max(1, Number(q.period_count) || 1);
        const insert = db.prepare(`
          INSERT INTO lesson_instances (class_id, teacher_id, subject, date, period_no, period_type, term, source, source_id, note)
          VALUES (?,?,?,?,?,?, '常规', 'qna', ?, ?)`);
        for (let i = 0; i < count; i++) {
          insert.run(q.class_id, q.teacher_id, q.subject, q.date, (q.period_no || 1) + i, q.period_type, q.id, q.content ?? null);
        }
      } else {
        // 固定排班：仍进入课表，之后由课表展开到 lesson_instances
        db.prepare(`
          INSERT INTO schedules (class_id, teacher_id, subject, day_of_week, period_no, period_type)
          VALUES (?,?,?,?,?,?)`)
          .run(q.class_id, q.teacher_id, q.subject, q.day_of_week ?? 0, q.period_no ?? 1, q.period_type);
      }
    }
  }
  logAudit(req.user.id, 'review_qna_lesson', `qna_lessons:${id}`, `审核答疑课 ${status}`);
  return res.json({ ok: true, data: { id, status } });
});

// 权限判断：能否编辑/删除某条答疑记录。
// 规则：管理员（教务处/教务员/admin）全权；填报人只能操作自己「待审核」的记录。
function canModifyQna(req, q) {
  if (ADMIN_ROLES.includes(req.user.role)) return true;
  return q.filled_by === req.user.id && q.status === 'pending';
}

// 编辑答疑课（待审核可改；管理员可改任意状态）
router.patch('/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare('SELECT * FROM qna_lessons WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ ok: false, error: '答疑课记录不存在' });
  if (!canModifyQna(req, q)) return res.status(403).json({ ok: false, error: '无权限修改该记录' });

  const { grade, subject, teacher_id, class_id, day_of_week, period_no, content, date, period_count, period_type } = req.body || {};

  // 计算编辑后的最终字段值，用于防重复判定（排除自身）
  const newTeacherId = teacher_id !== undefined ? (teacher_id ? Number(teacher_id) : null) : q.teacher_id;
  const newClassId = class_id !== undefined ? (class_id ? Number(class_id) : null) : q.class_id;
  const newDow = day_of_week !== undefined ? (day_of_week != null && day_of_week !== '' ? Number(day_of_week) : null) : q.day_of_week;
  const newPeriodNo = period_no !== undefined ? (period_no != null && period_no !== '' ? Number(period_no) : null) : q.period_no;
  const newDate = date !== undefined ? (date || null) : q.date;
  const newType = period_type !== undefined ? validPeriodType(period_type) : q.period_type;
  const newGrade = grade ?? q.grade;

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
    grade ?? q.grade,
    subject ?? q.subject,
    teacher_id !== undefined ? (teacher_id ? Number(teacher_id) : null) : q.teacher_id,
    class_id !== undefined ? (class_id ? Number(class_id) : null) : q.class_id,
    day_of_week !== undefined ? (day_of_week != null && day_of_week !== '' ? Number(day_of_week) : null) : q.day_of_week,
    period_no !== undefined ? (period_no != null && period_no !== '' ? Number(period_no) : null) : q.period_no,
    content !== undefined ? content : q.content,
    date !== undefined ? (date || null) : q.date,
    period_count !== undefined ? Math.max(1, Number(period_count) || 1) : q.period_count,
    period_type !== undefined ? validPeriodType(period_type) : q.period_type,
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
  if (!canModifyQna(req, q)) return res.status(403).json({ ok: false, error: '无权限删除该记录' });

  // 删除该答疑生成的上课记录（若有）
  const removed = db.prepare('DELETE FROM lesson_instances WHERE source = ? AND source_id = ?').run('qna', id);
  db.prepare('DELETE FROM qna_lessons WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_qna_lesson', `qna_lessons:${id}`, `删除答疑课（联动删除上课记录 ${removed.changes} 条）`);
  return res.json({ ok: true, data: { id, removed_instances: removed.changes } });
});

// 撤回已通过的答疑：状态置为 withdrawn，并删除已生成的上课记录
router.patch('/:id/withdraw', authRequired, roleRequired(...ADMIN_ROLES), (req, res) => {
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

// ===== 课程申报（竞赛课 / 私人定制课） =====

// 申报任务列表
router.get('/tasks', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM application_tasks ORDER BY id DESC').all();
  return res.json({ ok: true, data: rows });
});

// 创建申报任务（教务员设置明细）
router.post('/tasks', authRequired, roleRequired(...ADMIN_ROLES), (req, res) => {
  const { title, type, course_type, time_desc, duration, content_desc, deadline, filler_role } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: '任务标题必填' });
  const info = db
    .prepare(`INSERT INTO application_tasks
      (title, type, course_type, time_desc, duration, content_desc, deadline, filler_role, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(title, type || '私人定制课', course_type ?? null, time_desc ?? null, duration ?? null,
      content_desc ?? null, deadline ?? null, filler_role ?? '教师', req.user.id);
  logAudit(req.user.id, 'create_application_task', `application_tasks:${info.lastInsertRowid}`, `创建申报任务 ${title}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 申报填报（竞赛课由教务处填报，私人定制课由教师填报）
router.post('/tasks/:taskId/apply', authRequired, (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ ok: false, error: '申报任务不存在' });

  const { teacher_id, course_name, course_content, schedule_time, duration, remark } = req.body || {};
  const info = db
    .prepare(`INSERT INTO applications
      (task_id, teacher_id, course_name, course_content, schedule_time, duration, remark, status, filled_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(taskId, teacher_id ? Number(teacher_id) : null, course_name ?? null, course_content ?? null,
      schedule_time ?? null, duration ?? task.duration ?? null, remark ?? null, 'pending', req.user.id);
  logAudit(req.user.id, 'apply_course', `applications:${info.lastInsertRowid}`, `申报课程（任务 ${task.title}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 某任务下的申报记录
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
  return res.json({ ok: true, data: rows });
});

// 审核申报（教务处/管理员 + 年级组长，年级组长限本年级）
router.patch('/applications/:id/review', authRequired, roleRequired(...REVIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ ok: false, error: '申报记录不存在' });
  const { approved } = req.body || {};
  const status = approved ? 'approved' : 'rejected';
  db.prepare('UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(status, req.user.id, id);
  logAudit(req.user.id, 'review_application', `applications:${id}`, `审核申报 ${status}`);
  return res.json({ ok: true, data: { id, status } });
});

export default router;
