import { Router } from 'express';
import multer from 'multer';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, CLERK_ROLES, DIRECTOR_ROLES, RESULT_VIEW_ROLES } from '../auth.js';
import { loadContext, computePay } from '../context.js';
import { createAdjustNotice } from './notices.js';
import * as XLSX from 'xlsx';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';
import { createDraft, getDraft, deleteDraft } from '../import-stage.js';

const router = Router();
router.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const PERIOD_TYPES = ['早自习', '正课', '晚自习', '答疑'];
const TERMS = ['常规', '夏令营', '冬令营', '全员夏令营', '全员冬令营', '节假补课'];

// 本地日期 YYYY-MM-DD
function localDate() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 返回「某日期生效」的过滤条件。asOf 为空表示只看当前（effective_to IS NULL）。
// 约定：effective_to 为「结束日期」（不含），一条记录在 [effective_from, effective_to) 区间内生效。
function activeClause(alias, asOf, params) {
  if (!asOf) {
    return `${alias}.effective_to IS NULL`;
  }
  params.push(asOf, asOf);
  return `(${alias}.effective_from IS NULL OR ${alias}.effective_from <= ?) AND (${alias}.effective_to IS NULL OR ${alias}.effective_to > ?)`;
}

// 计算 [start, end]（含两端）内某星期几出现的次数。
// day_of_week 用 1=周一 … 7=周日；内部转成 JS getDay() 的 0=周日 … 6=周六。
function weekdayCount(start, end, dayOfWeek) {
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (s > e) return 0;
  const jsDay = dayOfWeek === 7 ? 0 : dayOfWeek;
  const first = new Date(s);
  first.setDate(first.getDate() + ((jsDay - first.getDay() + 7) % 7));
  if (first > e) return 0;
  return Math.floor((e - first) / (7 * 86400000)) + 1;
}

// 把 exclusive 的结束日期转为 inclusive（前一天）
function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 查看课表，可按班级/教师/类型/时段过滤，可指定 as_of 查看历史快照
router.get('/', (req, res) => {
  const { class_id, teacher_id, period_type, term, grade, as_of, include_inactive } = req.query;
  let sql = `
    SELECT s.*, c.name AS class_name, c.type AS class_type, c.parent_id AS class_parent_id,
           c.subject AS class_subject, c.grade AS grade,
           t.name AS teacher_name, t.subject AS teacher_subject
    FROM schedules s
    JOIN classes c ON c.id = s.class_id
    JOIN teachers t ON t.id = s.teacher_id
    WHERE 1=1`;
  const params = [];
  if (class_id) {
    // 选中某班时，带入：自身课表 + 其分层子班课表 + 其参与的走班（合班成员）课表 + 走班内的分层子班课表
    const cid = Number(class_id);
    sql += ` AND s.class_id IN (
      SELECT id FROM classes WHERE id = ? OR parent_id = ?
      UNION
      SELECT class_id FROM class_members WHERE member_class_id = ?
      UNION
      SELECT c.id FROM classes c WHERE c.parent_id IN (
        SELECT class_id FROM class_members WHERE member_class_id = ?
      )
    )`;
    params.push(cid, cid, cid, cid);
  }
  if (teacher_id) { sql += ' AND s.teacher_id = ?'; params.push(Number(teacher_id)); }
  if (period_type) { sql += ' AND s.period_type = ?'; params.push(period_type); }
  if (term) { sql += ' AND s.term = ?'; params.push(term); }
  if (grade) { sql += ' AND c.grade = ?'; params.push(grade); }
  // include_inactive：是否连历史/区间课表（effective_to 非空）一起返回，供补课课表浏览用
  if (include_inactive === '1' || include_inactive === 'true') {
    // 不做生效过滤
  } else {
    sql += ` AND ${activeClause('s', as_of, params)}`;
  }
  sql += ' ORDER BY s.day_of_week, s.period_no, s.class_id';
  const rows = db.prepare(sql).all(...params);
  const ctx = loadContext();
  // 追加导入（带生效日期）会让同一业务槽位留下多个生效版本（旧版本 effective_to 未关闭）。
  // 展示「当前课表」时只保留 effective_from 最新的版本，避免同一节课在格子里重复出现。
  // 补课课表浏览走 include_inactive 分支，各套号（makeup_set）需共存，不做此去重。
  let deduped = rows;
  if (!(include_inactive === '1' || include_inactive === 'true')) {
    const latest = new Map();
    for (const r of rows) {
      const key = `${r.class_id}|${r.day_of_week}|${r.period_no}|${r.period_type}|${r.term}|${r.makeup_set ?? ''}`;
      const prev = latest.get(key);
      if (!prev || (r.effective_from ?? '') > (prev.effective_from ?? '')) latest.set(key, r);
    }
    const keep = new Set([...latest.values()].map((r) => r.id));
    deduped = rows.filter((r) => keep.has(r.id));
  }
  return res.json({
    ok: true,
    data: deduped.map((r) => ({ ...r, form: ctx.formOf(ctx.classMap.get(r.class_id)) })),
  });
});

// 课表版本切换点：按 effective_from 聚合，供前端版本时间轴使用。
// 返回 [{ effective_from, count, grades: { 年级: 记录数 } }]，按日期升序。
// 代课/调课的临时段与换表大版本区分由前端按 count 阈值决定，这里只给原始聚合。
router.get('/versions', (req, res) => {
  const rows = db.prepare(`
    SELECT s.effective_from AS effective_from, COUNT(*) AS count, c.grade AS grade
    FROM schedules s
    JOIN classes c ON c.id = s.class_id
    WHERE s.effective_from IS NOT NULL
    GROUP BY s.effective_from, c.grade
    ORDER BY s.effective_from ASC`).all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.effective_from)) map.set(r.effective_from, { effective_from: r.effective_from, count: 0, grades: {} });
    const e = map.get(r.effective_from);
    e.count += r.count;
    if (r.grade) e.grades[r.grade] = (e.grades[r.grade] || 0) + r.count;
  }
  return res.json({ ok: true, data: [...map.values()] });
});

// 下载课表导入模板
router.get('/template', (req, res) => {
  const headers = ['班级', '星期', '节次', '类型', '时段', '课程名称', '教师'];
  const samples = [
    // 行政班（行政班整班上课）
    ['1201班', '1', '1', '正课', '常规', '语文', '刘丽娟'],
    ['1201班', '1', '5', '正课', '常规', '化学', '姜涛'],
    // 行政班分层（同一班内分 A/B 层，班级填「分层」班名）
    ['1201班数学A层', '1', '2', '正课', '常规', '数学', '顾俊峰'],
    ['1201班数学B层', '1', '2', '正课', '常规', '数学', '靳旭霞'],
    // 走班（多个行政班合班，班级填「走班」班名）
    ['1202/1203/1204政治走班', '1', '4', '正课', '常规', '政治', '陈志红'],
    ['1201/1203生物走班', '1', '4', '正课', '常规', '生物', '胡国胜'],
    // 走班内再分层（走班内部再分 A/B 层，班级填「分层」班名）
    ['1201/1203英语走班A层', '1', '3', '正课', '常规', '英语', '姜建军'],
    ['1201/1203英语走班B层', '1', '3', '正课', '常规', '英语', '胡丽萍'],
    // 早自习 / 晚自习 / 答疑（类型列区分）
    ['1201班', '1', '1', '早自习', '常规', '语文', '刘丽娟'],
    ['1201班', '1', '9', '晚自习', '常规', '数学', '靳旭霞'],
    ['1201班', '1', '8', '答疑', '常规', '物理', '宋恭渝'],
    // 非规时段（时段列区分）
    ['1201班', '1', '1', '正课', '夏令营', '数学', '顾俊峰'],
  ];
  const notes = [
    ['高三课表导入模板 —— 填写说明'],
    [''],
    ['一、表头（第1行固定，按顺序）：班级 | 星期 | 节次 | 类型 | 时段 | 课程名称 | 教师'],
    [''],
    ['二、各列填写规则：'],
    ['1. 班级：填「班级信息」里已建好的班级名称，必须完全一致（含空格/符号）。'],
    ['   - 行政班整班课：填行政班名，如 1201班'],
    ['   - 行政班分层课：填分层班名，如 1201班数学A层'],
    ['   - 走班（合班）课：填走班名，如 1202/1203/1204政治走班'],
    ['   - 走班内再分层课：填分层班名，如 1201/1203英语走班A层'],
    ['2. 星期：1=周一 … 7=周日，填数字。'],
    ['3. 节次：第几节课，填数字（1、2、3…）。'],
    ['4. 类型：正课 / 早自习 / 晚自习 / 答疑（正课默认，可省略）。'],
    ['   另支持「统计配置」里自定义的按次计酬类型（如 晚读、晚练），填对应的类型名即可。'],
    ['5. 时段：常规 / 夏令营 / 冬令营 / 全员夏令营 / 全员冬令营 / 节假补课（常规默认，可省略）。'],
    ['6. 课程名称：这门课的名称，如 语文、数学、政治。'],
    ['7. 教师：任课教师姓名，需与「教师信息」里的姓名完全一致。'],
    [''],
    ['三、要点：'],
    ['- 系统会根据「班级名称」自动识别上课形式（行政班/分层/走班/走班分层），无需额外填形式。'],
    ['- 同一班级、同一星期、同一节次可以有多行（分层 A/B、走班同节不同教室等），会自动合并显示在同一格。'],
    ['- 走班的「星期/节次」填该走班上课的时间；系统会把走班课并入其合班的每个行政班课表。'],
    ['- 导入前请先在「班级信息」建好行政班、分层、走班，在「教师信息」建好教师。'],
    ['- 补课课表轮换：时段填「节假补课」，每个文件=一套，导入时在「套号」填 1/2/3（高一/高二两套、高三三套轮换）。'],
    ['  之后在校历把补课周日标为「补课 + 用第几套」，系统按套号上课并按节假日标准计酬。'],
    ['- 示例行仅供参考，导入前请删除示例行、只保留真实数据。'],
  ];
  downloadTemplate(res, headers, samples, '课表导入模板.xlsx', [{ name: '填写说明', rows: notes }]);
});

// 解析导入选项（scope/effective_from/to/makeup_set/grade/scope_term），供 preview/confirm 共用
function parseImportOptions(body) {
  const effectiveFrom = body.effective_from ? String(body.effective_from).trim() : null;
  const effectiveTo = body.effective_to ? String(body.effective_to).trim() : null;
  const scope = ['append', 'all', 'grade', 'term'].includes(body.scope) ? body.scope : 'append';
  const scopeGrade = body.grade ? String(body.grade).trim() : null;
  const scopeTerm = body.scope_term ? String(body.scope_term).trim() : null;
  const makeupSet = (body.makeup_set !== undefined && body.makeup_set !== null && String(body.makeup_set).trim() !== '')
    ? Number(body.makeup_set)
    : null;
  return { effectiveFrom, effectiveTo, scope, scopeGrade, scopeTerm, makeupSet };
}

// 一个业务槽位（同一节课）的标识：班级+星期+节次+类型+时段+补课套号。
// 追加导入（带生效日期）时，新课表从生效日起接管这些槽位，需关闭同槽位的旧版本。
const slotKeyOf = (record, makeupSet) =>
  `${record.class_id}|${record.day_of_week}|${record.period_no}|${record.period_type}|${record.term}|${makeupSet ?? ''}`;

// 追加带生效日期时，找出本次导入涉及的同槽位、当前仍生效（effective_to IS NULL）的旧版本 id
function findAppendOldIds(slotKeys) {
  if (!slotKeys || !slotKeys.size) return [];
  const sel = db.prepare(`SELECT id FROM schedules WHERE effective_to IS NULL
    AND class_id = ? AND day_of_week = ? AND period_no = ? AND period_type = ? AND term = ?
    AND IFNULL(makeup_set, -1) = ?`);
  const ids = [];
  for (const k of slotKeys) {
    const [class_id, day_of_week, period_no, period_type, term, makeup_set] = k.split('|');
    for (const r of sel.all(Number(class_id), Number(day_of_week), Number(period_no), period_type, term, makeup_set === '' ? -1 : Number(makeup_set))) {
      ids.push(r.id);
    }
  }
  return ids;
}

// 计算「将关闭旧课表 N 条」（只读，不执行 UPDATE）。
// 替换模式：关闭范围内全部旧记录；追加带生效日期：只关闭同槽位旧版本。
function countCloseSchedules(opts, slotKeys) {
  if (!opts.effectiveFrom) return 0;
  if (opts.scope === 'append') return findAppendOldIds(slotKeys).length;
  let sql = 'SELECT COUNT(*) AS n FROM schedules WHERE effective_to IS NULL';
  const params = [opts.effectiveFrom];
  if (opts.scope === 'grade' && opts.scopeGrade) {
    sql += ' AND class_id IN (SELECT id FROM classes WHERE grade = ?)';
    params.push(opts.scopeGrade);
  } else if (opts.scope === 'term' && opts.scopeTerm) {
    sql += ' AND term = ?';
    params.push(opts.scopeTerm);
  }
  return Number(db.prepare(sql).get(...params).n);
}

// 解析 + 校验单行课表（不写库），返回 { ok, record } 或 { ok:false, reason, duplicate }
function buildScheduleRecord(row, ctx) {
  const { classByName, teacherByName, typePayNames, existsMakeup, makeupSet, scope } = ctx;
  const className = String(keyOf(row, '班级', 'class', '班级名称') ?? '').trim();
  const teacherName = String(keyOf(row, '教师', '老师', 'teacher', '任课教师') ?? '').trim();
  const subject = String(keyOf(row, '课程名称', '科目', '学科', 'subject') ?? '').trim();
  const dayOfWeek = Number(keyOf(row, '星期', '周几', 'day_of_week', '星期几') ?? '');
  const periodNo = Number(keyOf(row, '节次', 'period_no', '课节') ?? '');
  const periodType = String(keyOf(row, '类型', 'period_type', '课型') ?? '正课').trim() || '正课';
  const term = String(keyOf(row, '时段', 'term', '课时段') ?? '常规').trim() || '常规';

  if (!className || !teacherName) return { ok: false, reason: '缺少班级或教师' };
  const classId = classByName[className];
  const teacherId = teacherByName[teacherName];
  if (!classId) return { ok: false, reason: `班级「${className}」不存在，请先在基本信息中创建` };
  if (!teacherId) return { ok: false, reason: `教师「${teacherName}」不存在，请先创建教师` };

  const finalType = PERIOD_TYPES.includes(periodType) ? periodType : (typePayNames.has(periodType) ? periodType : '正课');
  const finalTerm = TERMS.includes(term) ? term : '常规';

  // 补课课表幂等去重（替换模式会先关旧表，故不判定）
  if (finalTerm === '节假补课' && existsMakeup && existsMakeup.get(makeupSet, classId, periodNo) && scope === 'append') {
    return { ok: false, reason: '补课课表已存在', duplicate: true };
  }

  return {
    ok: true,
    record: {
      class_id: classId, teacher_id: teacherId, subject: subject || null,
      day_of_week: Number.isFinite(dayOfWeek) ? dayOfWeek : 0,
      period_no: Number.isFinite(periodNo) ? periodNo : 1,
      period_type: finalType, term: finalTerm,
    },
  };
}

function persistSchedule(record, opts) {
  db.prepare(`
    INSERT INTO schedules (class_id, teacher_id, subject, day_of_week, period_no, period_type, term, effective_from, effective_to, makeup_set)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(record.class_id, record.teacher_id, record.subject, record.day_of_week, record.period_no, record.period_type, record.term, opts.effectiveFrom, opts.effectiveTo, opts.makeupSet);
}

// 关闭旧表（confirm 阶段执行）：
//   替换模式（scope≠append）：关闭范围内的全部旧记录；
//   追加带生效日期（scope=append + effectiveFrom）：只关闭本次导入涉及的同槽位旧版本，实现「按时间节点换表」。
function closeOldSchedules(opts, slotKeys) {
  if (!opts.effectiveFrom) return 0;
  if (opts.scope === 'append') {
    const ids = findAppendOldIds(slotKeys);
    if (!ids.length) return 0;
    const upd = db.prepare('UPDATE schedules SET effective_to = ? WHERE id = ?');
    for (const id of ids) upd.run(opts.effectiveFrom, id);
    return ids.length;
  }
  let sql = 'UPDATE schedules SET effective_to = ? WHERE effective_to IS NULL';
  const params = [opts.effectiveFrom];
  if (opts.scope === 'grade' && opts.scopeGrade) {
    sql += ' AND class_id IN (SELECT id FROM classes WHERE grade = ?)';
    params.push(opts.scopeGrade);
  } else if (opts.scope === 'term' && opts.scopeTerm) {
    sql += ' AND term = ?';
    params.push(opts.scopeTerm);
  }
  return db.prepare(sql).run(...params).changes;
}

// 预览
router.post('/import/preview', roleRequired(...CLERK_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传课表文件' });

  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const opts = parseImportOptions(req.body || {});
  if (opts.makeupSet != null && (!Number.isInteger(opts.makeupSet) || opts.makeupSet < 1)) {
    return res.status(400).json({ ok: false, error: '补课课表套号应为正整数（1/2/3…）' });
  }
  if (opts.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(opts.effectiveFrom)) {
    return res.status(400).json({ ok: false, error: '生效日期格式应为 YYYY-MM-DD' });
  }
  if (opts.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(opts.effectiveTo)) {
    return res.status(400).json({ ok: false, error: '结束日期格式应为 YYYY-MM-DD' });
  }
  if (opts.effectiveFrom && opts.effectiveTo && opts.effectiveFrom > opts.effectiveTo) {
    return res.status(400).json({ ok: false, error: '生效日期不能晚于结束日期' });
  }

  const classes = db.prepare('SELECT id, name, type FROM classes').all();
  const teachers = db.prepare('SELECT id, name FROM teachers').all();
  const typePayNames = new Set(db.prepare('SELECT name FROM period_type_pays').all().map((r) => r.name));
  const existsMakeup = opts.makeupSet != null
    ? db.prepare(`SELECT id FROM schedules WHERE term = '节假补课' AND makeup_set = ? AND class_id = ? AND period_no = ? AND effective_to IS NULL`)
    : null;
  const ctx = {
    classByName: Object.fromEntries(classes.map((c) => [c.name, c.id])),
    teacherByName: Object.fromEntries(teachers.map((t) => [t.name, t.id])),
    typePayNames, existsMakeup, makeupSet: opts.makeupSet, scope: opts.scope,
  };

  const columns = ['班级', '星期', '节次', '类型', '时段', '课程名称', '教师'];
  const draftRows = [];

  for (let i = 0; i < rows.length; i++) {
    const r = buildScheduleRecord(rows[i], ctx);
    const cells = columns.map((c) => String(keyOf(rows[i], c) ?? ''));
    if (r.ok) {
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'ok', reason: null, record: r.record });
    } else if (r.duplicate) {
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'duplicate', reason: r.reason, record: null });
    } else {
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'error', reason: r.reason, record: null });
    }
  }

  // 追加带生效日期时，收集本次涉及的业务槽位，用于计算将关闭的同槽位旧版本数
  const slotKeys = new Set(draftRows.filter((r) => r.status === 'ok').map((r) => slotKeyOf(r.record, opts.makeupSet)));
  const summary = {
    total: rows.length,
    ok: draftRows.filter((r) => r.status === 'ok').length,
    duplicate: draftRows.filter((r) => r.status === 'duplicate').length,
    error: draftRows.filter((r) => r.status === 'error').length,
    close_count: countCloseSchedules(opts, slotKeys),
  };

  const token = createDraft('schedules', req.user.id, { rows: draftRows, options: opts });
  return res.json({ ok: true, data: { token, rows: draftRows.map(({ record, ...r }) => r), summary } });
});

// 确认入库
router.post('/import/confirm', roleRequired(...CLERK_ROLES), (req, res) => {
  const { token, row_ids } = req.body || {};
  const draft = getDraft(token, req.user.id, 'schedules');
  if (!draft) return res.status(400).json({ ok: false, error: '预览已失效，请重新上传' });

  const opts = draft.payload.options || {};
  const selected = new Set(Array.isArray(row_ids) ? row_ids.map(Number) : []);
  const targets = draft.payload.rows.filter((r) => r.status === 'ok' && selected.has(r.row_id));

  // 先执行「关旧表」（替换模式关全部；追加带生效日期关同槽位旧版本）
  const slotKeys = new Set(targets.map((r) => slotKeyOf(r.record, opts.makeupSet)));
  const closed = closeOldSchedules(opts, slotKeys);

  let inserted = 0;
  const errors = [];
  const existsMakeup = opts.makeupSet != null
    ? db.prepare(`SELECT id FROM schedules WHERE term = '节假补课' AND makeup_set = ? AND class_id = ? AND period_no = ? AND effective_to IS NULL`)
    : null;
  for (const r of targets) {
    if (r.record.term === '节假补课' && existsMakeup && existsMakeup.get(opts.makeupSet, r.record.class_id, r.record.period_no)) {
      errors.push(`第 ${r.line} 行补课课表已存在`); continue;
    }
    persistSchedule(r.record, opts);
    inserted++;
  }

  deleteDraft(token);
  const modeDesc = opts.scope === 'append'
    ? (opts.effectiveFrom ? `（追加，${opts.effectiveFrom} 起接管同槽位，关闭旧版本 ${closed} 条）` : '（追加）')
    : `（${opts.effectiveFrom} 起生效，范围 ${opts.scope}，关闭旧表 ${closed} 条）`;
  logAudit(req.user.id, 'import_schedules', 'schedules', `导入课表 ${inserted} 条${modeDesc}`);
  return res.json({ ok: true, data: { inserted, errors, closed } });
});

// 旧接口（已弃用）
router.post('/import', roleRequired(...CLERK_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传课表文件' });

  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const opts = parseImportOptions(req.body || {});
  if (opts.makeupSet != null && (!Number.isInteger(opts.makeupSet) || opts.makeupSet < 1)) {
    return res.status(400).json({ ok: false, error: '补课课表套号应为正整数（1/2/3…）' });
  }
  if (opts.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(opts.effectiveFrom)) {
    return res.status(400).json({ ok: false, error: '生效日期格式应为 YYYY-MM-DD' });
  }
  if (opts.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(opts.effectiveTo)) {
    return res.status(400).json({ ok: false, error: '结束日期格式应为 YYYY-MM-DD' });
  }
  if (opts.effectiveFrom && opts.effectiveTo && opts.effectiveFrom > opts.effectiveTo) {
    return res.status(400).json({ ok: false, error: '生效日期不能晚于结束日期' });
  }

  const classes = db.prepare('SELECT id, name, type FROM classes').all();
  const teachers = db.prepare('SELECT id, name FROM teachers').all();
  const typePayNames = new Set(db.prepare('SELECT name FROM period_type_pays').all().map((r) => r.name));
  const existsMakeup = opts.makeupSet != null
    ? db.prepare(`SELECT id FROM schedules WHERE term = '节假补课' AND makeup_set = ? AND class_id = ? AND period_no = ? AND effective_to IS NULL`)
    : null;
  const ctx = {
    classByName: Object.fromEntries(classes.map((c) => [c.name, c.id])),
    teacherByName: Object.fromEntries(teachers.map((t) => [t.name, t.id])),
    typePayNames, existsMakeup, makeupSet: opts.makeupSet, scope: opts.scope,
  };

  const closed = closeOldSchedules(opts);
  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = buildScheduleRecord(rows[i], ctx);
    if (!r.ok) { if (!r.duplicate) errors.push(`第 ${i + 2} 行 ${r.reason}`); continue; }
    persistSchedule(r.record, opts);
    inserted++;
  }

  logAudit(req.user.id, 'import_schedules', 'schedules', `导入课表 ${inserted} 条${opts.scope === 'append' ? '（追加）' : `（${opts.effectiveFrom} 起生效，范围 ${opts.scope}）`}`);
  return res.json({ ok: true, data: { inserted, errors, effective_from: opts.effectiveFrom, effective_to: opts.effectiveTo, scope: opts.scope } });
});

// 删除补课课表（仅管理员）。按套号 + 可选年级删除整套「节假补课」课表。
// 同时删除这些课表已展开的上课记录（lesson_instances），避免残留孤儿计酬。
router.delete('/makeup', roleRequired(...CLERK_ROLES), (req, res) => {
  const { makeup_set, grade } = req.body || {};
  const setNum = Number(makeup_set);
  if (!Number.isInteger(setNum) || setNum < 1) {
    return res.status(400).json({ ok: false, error: '请指定要删除的补课课表套号（正整数）' });
  }

  // 定位该套号（+可选年级）下的补课课表记录
  let sql = `SELECT s.id FROM schedules s JOIN classes c ON c.id = s.class_id
             WHERE s.term = '节假补课' AND s.makeup_set = ?`;
  const params = [setNum];
  if (grade) {
    sql += ' AND c.grade = ?';
    params.push(grade);
  }
  const schedIds = db.prepare(sql).all(...params).map((r) => r.id);
  if (!schedIds.length) {
    return res.status(404).json({ ok: false, error: grade ? `第 ${setNum} 套「${grade}」无补课课表` : `第 ${setNum} 套无补课课表` });
  }

  // 统计受影响范围，供确认信息展示
  let countSql = `SELECT COUNT(DISTINCT s.class_id) AS classes FROM schedules s JOIN classes c ON c.id = s.class_id
                  WHERE s.term = '节假补课' AND s.makeup_set = ?`;
  const countParams = [setNum];
  if (grade) { countSql += ' AND c.grade = ?'; countParams.push(grade); }
  const classCount = db.prepare(countSql).get(...countParams).classes;
  const instCount = db.prepare(`SELECT COUNT(*) AS n FROM lesson_instances WHERE schedule_id IN (${schedIds.map(() => '?').join(',')})`).get(...schedIds).n;

  db.prepare('BEGIN').run();
  try {
    // 1. 删除已展开的上课记录
    for (const sid of schedIds) {
      db.prepare('DELETE FROM lesson_instances WHERE schedule_id = ?').run(sid);
    }
    // 2. 删除课表记录
    for (const sid of schedIds) {
      db.prepare('DELETE FROM schedules WHERE id = ?').run(sid);
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    return res.status(500).json({ ok: false, error: '删除失败：' + e.message });
  }

  logAudit(req.user.id, 'delete_makeup_schedule', 'schedules', `删除第 ${setNum} 套补课课表${grade ? '（' + grade + '）' : ''}，共 ${schedIds.length} 条课表、${instCount} 条上课记录`);
  return res.json({ ok: true, data: { deleted: schedIds.length, classes: classCount, instances: instCount } });
});

// 执行一次调课/代课/停课（快照模式）：关闭旧记录 + 插入新记录。返回新 change_id。
// 供管理员直接 adjust 与代课申请审核通过共用。
// 临时（to_date 非空）：三段式——原教师 [旧起, from_date) + 代课教师 [from_date, to_date) + 原教师 [to_date, 起) 自动恢复。
// 长期（to_date 空）：原教师 [旧起, from_date) + 代课教师 [from_date, 永久)，不恢复。
function applyAdjust({ schedule_id, change_type, to_teacher_id, from_date, to_date, reason, operator_id }) {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(schedule_id));
  if (!schedule) return { error: '课表条目不存在' };

  // 检查：该课是否已停课/已调整（effective_to 已非空 = 已关闭）。防止「停课后还能代课」等误操作。
  if (schedule.effective_to != null) {
    return { error: '该课已停课或已调整，请刷新课表后重试' };
  }

  const effectiveDate = from_date || localDate();
  const endDate = to_date || null; // 左闭右开
  const prevEffectiveTo = schedule.effective_to; // 撤销用：恢复原 effective_to
  const insertedIds = [];

  if (change_type === '代课' || change_type === '调课') {
    if (!to_teacher_id) return { error: '请选择目标教师' };
    // 1. 关闭原教师记录：生效到 effectiveDate 为止
    db.prepare('UPDATE schedules SET effective_to = ? WHERE id = ?').run(effectiveDate, Number(schedule_id));
    // 2. 插入代课教师记录：[effectiveDate, endDate)
    const r2 = db.prepare(`
      INSERT INTO schedules (class_id, teacher_id, subject, course_type, day_of_week, period_no, period_type, term, effective_from, effective_to, version)
      VALUES (?,?,?,?,?,?,?,?,?, ?, ?)`)
      .run(schedule.class_id, Number(to_teacher_id), schedule.subject, schedule.course_type ?? '行政班', schedule.day_of_week,
        schedule.period_no, schedule.period_type, schedule.term ?? '常规', effectiveDate, endDate, schedule.version + 1);
    insertedIds.push(Number(r2.lastInsertRowid));
    // 3. 临时代课：再插入原教师「恢复段」记录 [endDate, 起)，版本再 +1
    if (endDate && endDate > effectiveDate) {
      const r3 = db.prepare(`
        INSERT INTO schedules (class_id, teacher_id, subject, course_type, day_of_week, period_no, period_type, term, effective_from, effective_to, version)
        VALUES (?,?,?,?,?,?,?,?,?, NULL, ?)`)
        .run(schedule.class_id, schedule.teacher_id, schedule.subject, schedule.course_type ?? '行政班', schedule.day_of_week,
          schedule.period_no, schedule.period_type, schedule.term ?? '常规', endDate, schedule.version + 2);
      insertedIds.push(Number(r3.lastInsertRowid));
    }
  } else if (change_type === '停课') {
    db.prepare('UPDATE schedules SET effective_to = ? WHERE id = ?').run(effectiveDate, Number(schedule_id));
  }

  const info = db
    .prepare(`INSERT INTO schedule_changes
      (schedule_id, change_type, from_teacher_id, to_teacher_id, from_date, to_date, reason, operator_id, inserted_schedule_ids, prev_effective_to)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(Number(schedule_id), change_type, schedule.teacher_id, to_teacher_id ?? null, effectiveDate, endDate,
      reason ?? null, operator_id, insertedIds.length ? JSON.stringify(insertedIds) : null, prevEffectiveTo ?? null);
  logAudit(operator_id, 'adjust_schedule', `schedules:${schedule_id}`, `${change_type}：${schedule.teacher_id} -> ${to_teacher_id ?? null}（${effectiveDate}${endDate ? '~' + endDate : ' 起'}）`);

  // 定向通知相关教师（失败不影响调整本身）
  notifyAdjust({ schedule, change_type, to_teacher_id, effectiveDate, endDate, reason, operator_id });
  return { change_id: Number(info.lastInsertRowid) };
}

// 课务调整后给相关教师发定向手机通知（原+新教师都通知；停课只通知原教师）
function notifyAdjust({ schedule, change_type, to_teacher_id, effectiveDate, endDate, reason, operator_id }) {
  try {
    const cls = db.prepare('SELECT id, name FROM classes WHERE id = ?').get(schedule.class_id);
    const className = cls?.name ?? '未知班级';
    const fromName = db.prepare('SELECT name FROM teachers WHERE id = ?').get(schedule.teacher_id)?.name ?? '未知教师';
    const toName = to_teacher_id ? (db.prepare('SELECT name FROM teachers WHERE id = ?').get(to_teacher_id)?.name ?? '未知教师') : null;
    const operatorName = db.prepare('SELECT name FROM users WHERE id = ?').get(operator_id)?.name ?? '';
    const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const dow = (schedule.day_of_week >= 1 && schedule.day_of_week <= 7) ? DAYS[schedule.day_of_week - 1] : '';
    const period = schedule.period_no ? `第${schedule.period_no}节` : '';
    const range = endDate ? `${effectiveDate} ~ ${dayBefore(endDate)}` : `${effectiveDate} 起`;

    let title, content, targets;
    if (change_type === '停课') {
      title = `停课通知：${effectiveDate} ${className} ${schedule.subject || ''}`.trim();
      content = [
        `**停课通知**`,
        ``,
        `- 班级：${className}`,
        `- 课程：${schedule.subject || '—'}`,
        `- 时间：${dow} ${period}`.trim(),
        `- 原教师：${fromName}`,
        `- 停课日期：${effectiveDate}`,
        reason ? `- 原因：${reason}` : '',
        operatorName ? `\n签发：${operatorName}` : '',
      ].filter((l) => l !== '').join('\n');
      targets = [schedule.teacher_id];
    } else {
      title = `${change_type}通知：${effectiveDate} ${className} ${schedule.subject || ''}`.trim();
      content = [
        `**${change_type}通知**`,
        ``,
        `- 班级：${className}`,
        `- 课程：${schedule.subject || '—'}`,
        `- 时间：${dow} ${period}`.trim(),
        `- 原教师：${fromName}`,
        `- ${change_type === '调课' ? '调换至' : '代课教师'}：${toName}`,
        `- 生效：${range}`,
        reason ? `- 原因：${reason}` : '',
        operatorName ? `\n签发：${operatorName}` : '',
      ].filter((l) => l !== '').join('\n');
      targets = [...new Set([schedule.teacher_id, Number(to_teacher_id)].filter((x) => x != null))];
    }

    if (targets.length) createAdjustNotice({ title, content, targetTeacherIds: targets, operatorId: operator_id });
  } catch (e) {
    console.error('[notifyAdjust] 通知发送失败', e);
  }
}

// 调课/代课/停课 —— 快照模式：关闭旧记录 + 插入新记录，变化前统计不受影响
router.post('/adjust', roleRequired(...CLERK_ROLES), (req, res) => {
  const { schedule_id, change_type, from_teacher_id, to_teacher_id, from_date, to_date, reason } = req.body || {};
  if (!schedule_id || !change_type) {
    return res.status(400).json({ ok: false, error: '缺少 schedule_id 或 change_type' });
  }
  if (!['调课', '代课', '停课'].includes(change_type)) {
    return res.status(400).json({ ok: false, error: '无效的调整类型' });
  }
  const result = applyAdjust({ schedule_id, change_type, to_teacher_id, from_date, to_date, reason, operator_id: req.user.id });
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  return res.json({ ok: true, data: { change_id: result.change_id } });
});

// 撤回一条课务调整（撤销误操作）：恢复原课表的 effective_to，删除本次插入的代课/恢复段记录。
router.post('/changes/:id/revert', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const ch = db.prepare('SELECT * FROM schedule_changes WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ ok: false, error: '调整记录不存在' });
  if (ch.reverted) return res.status(400).json({ ok: false, error: '该调整已撤回，不能重复撤回' });

  const t = db.prepare('BEGIN'); t.run();
  try {
    // 1. 恢复原课表记录（把 effective_to 改回调整前的值）
    db.prepare('UPDATE schedules SET effective_to = ? WHERE id = ?').run(ch.prev_effective_to ?? null, Number(ch.schedule_id));
    // 2. 删除本次插入的段记录（代课段 + 恢复段）
    if (ch.inserted_schedule_ids) {
      const ids = JSON.parse(ch.inserted_schedule_ids);
      const del = db.prepare('DELETE FROM schedules WHERE id = ?');
      for (const sid of ids) del.run(Number(sid));
    }
    // 3. 标记已撤回
    db.prepare('UPDATE schedule_changes SET reverted = 1 WHERE id = ?').run(id);
    db.prepare('COMMIT').run();
    logAudit(req.user.id, 'revert_schedule_change', `schedule_changes:${id}`, `撤回${ch.change_type}（原课 ${ch.schedule_id}）`);
    return res.json({ ok: true, data: { id, reverted: true } });
  } catch (e) {
    db.prepare('ROLLBACK').run();
    return res.status(500).json({ ok: false, error: '撤回失败：' + e.message });
  }
});

// 汇总统计：按教师统计课时数，含早/晚自习。
// 口径一（as_of 快照）：统计某日期生效的课表条目数
// 口径二（from_date~to_date 时间段）：按每周重复统计区间内实际出现次数
// 折算规则：
//   常规时段  折算课时 = 节数 ×（课时系数 + 班额系数）（系数可在统计中心配置）
//   非规时段（夏/冬令营等）折算课时 = 节数；课酬 = 节数 × 教师课酬标准

// 取课表明细（含 count：区间内实际出现次数），供 summary 与 export 共用
function fetchScheduleRows(asOf, term, fromDate, toDate) {
  const params = [];
  const SELECT = `
    SELECT s.id, s.teacher_id, t.name AS teacher_name, s.class_id, s.subject,
           s.period_type, s.term, s.day_of_week, s.effective_from, s.effective_to,
           s.makeup_set, c.grade AS class_grade,
           t.pay_standard
    FROM schedules s JOIN teachers t ON t.id = s.teacher_id
    JOIN classes c ON c.id = s.class_id`;
  let base;
  if (fromDate && toDate) {
    base = db.prepare(`${SELECT} WHERE s.effective_to IS NULL`).all();
    if (term) base = base.filter((r) => r.term === term);
  } else {
    const clauses = [activeClause('s', asOf, params)];
    if (term) { clauses.push('s.term = ?'); params.push(term); }
    base = db.prepare(`${SELECT} WHERE ${clauses.join(' AND ')}`).all(...params);
  }

  // 套号型补课课表（term=节假补课 + makeup_set 非空）的 day_of_week=0 是「哨兵值」，
  // 表示一整套独立课表、不看星期，只在被校历指定「补课 + 用第 N 套」的补课日上课。
  // 因此在 range 口径下不能按星期重复推算，而应按校历补课日精确计数。
  let makeupCal = null;
  if (fromDate && toDate) {
    makeupCal = db.prepare(
      `SELECT date, make_up_set, grade FROM school_calendar WHERE type = '补课' AND make_up_set IS NOT NULL`
    ).all();
  }

  return base.map((r) => {
    let count;
    if (fromDate && toDate) {
      const segStart = r.effective_from && r.effective_from > fromDate ? r.effective_from : fromDate;
      const segEnd = r.effective_to && r.effective_to <= toDate ? dayBefore(r.effective_to) : toDate;
      if (segStart > segEnd) {
        count = 0;
      } else if (r.term === '节假补课' && r.makeup_set != null) {
        // 套号型补课：统计区间内该套号（+该年级）的补课日数
        count = 0;
        for (const c of makeupCal) {
          if (Number(c.make_up_set) !== Number(r.makeup_set)) continue;
          if (c.date < segStart || c.date > segEnd) continue;
          // 年级级补课日只对该年级生效；全校级（grade 空）对所有年级生效
          if (c.grade == null || c.grade === r.class_grade) count++;
        }
      } else {
        count = weekdayCount(segStart, segEnd, r.day_of_week);
      }
    } else {
      count = 1;
    }
    return { ...r, count };
  });
}

// 单条课表条目的折算（含 count 乘数）。与 stats.js 的按日折算规则一致。
// 统一走 context.js 的 computePay。

router.get('/summary', (req, res) => {
  const { as_of, term, from_date, to_date } = req.query;
  const ctx = loadContext();
  const rows = fetchScheduleRows(as_of, term, from_date, to_date);

  const map = new Map();
  for (const r of rows) {
    if (r.count <= 0) continue;
    const { weighted, pay } = computePay(ctx, r);

    if (!map.has(r.teacher_id)) {
      map.set(r.teacher_id, {
        teacher_id: r.teacher_id, teacher_name: r.teacher_name,
        total: 0, weighted_total: 0, pay_total: 0,
        terms: {},
      });
    }
    const e = map.get(r.teacher_id);
    // 节假补课正课单独成列（按课酬标准计酬），与周一至周五正课（按系数折算）分开展示
    const col = r.term === '节假补课' ? '节假补课' : r.period_type;
    e[col] = (e[col] || 0) + r.count;
    e.total += r.count;
    e.weighted_total += weighted;
    e.pay_total += pay;
    if (!e.terms[r.term]) e.terms[r.term] = { count: 0, weighted: 0 };
    e.terms[r.term].count += r.count;
    e.terms[r.term].weighted += weighted;
  }

  const data = [...map.values()].map((e) => ({ ...e, weighted_total: Math.round(e.weighted_total * 100) / 100, pay_total: Math.round(e.pay_total * 100) / 100 }));
  const types = ['早自习', '正课', '节假补课', ...[...ctx.periodTypePays.keys()]];
  return res.json({ ok: true, data, types });
});

// 导出课表明细（Excel）：课表当前状态或按时间段推算，每行含 count/折算课时/课酬
router.get('/export', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const { as_of, term, from_date, to_date } = req.query;
  const ctx = loadContext();
  const rows = fetchScheduleRows(as_of, term, from_date, to_date).filter((r) => r.count > 0);

  const classNames = new Map(db.prepare('SELECT id, name FROM classes').all().map((c) => [c.id, c.name]));
  const headers = ['教师', '班级', '学科', '类型', '时段', '星期', '节次', '次数', '折算课时', '课酬(元)'];
  const aoa = [headers];
  for (const r of rows) {
    const { weighted, pay } = computePay(ctx, r);
    aoa.push([
      r.teacher_name,
      classNames.get(r.class_id) || '',
      r.subject ?? '',
      r.period_type,
      r.term,
      r.day_of_week,
      r.period_no,
      r.count,
      Math.round(weighted * 100) / 100,
      Math.round(pay * 100) / 100,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '课表明细');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('课表明细.xlsx')}`);
  res.send(buf);
});

// 系数配置：学科系数 + 班额系数 + 课时类型设置
router.get('/coefficients', (req, res) => {
  const subjects = db.prepare('SELECT id, subject, coefficient FROM subject_coefficients ORDER BY subject').all();
  const bands = db.prepare('SELECT id, min_size, coefficient FROM size_bands ORDER BY min_size').all();
  const periodSettings = {};
  for (const p of db.prepare('SELECT key, value FROM period_settings').all()) periodSettings[p.key] = p.value;
  return res.json({ ok: true, data: { subjects, bands, periods: periodSettings } });
});

router.put('/coefficients', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { subjects = [], bands = [], periods = {} } = req.body || {};
  // 按 id 匹配更新（改名/改档位时不产生重复）；无 id 的新记录才插入。
  // 全量同步：请求里没带的 id 视为「已删除」，从库中移除。
  const upSubj = db.prepare('UPDATE subject_coefficients SET subject = ?, coefficient = ? WHERE id = ?');
  const insSubj = db.prepare('INSERT INTO subject_coefficients (subject, coefficient) VALUES (?,?)');
  const existsSubjId = db.prepare('SELECT id FROM subject_coefficients WHERE id = ?');
  const seenSubj = new Set();
  for (const s of subjects) {
    const name = String(s.subject || '').trim();
    const coef = Number(s.coefficient);
    if (!name || !Number.isFinite(coef)) continue;
    if (s.id != null && existsSubjId.get(s.id)) { upSubj.run(name, coef, Number(s.id)); seenSubj.add(Number(s.id)); }
    else { const info = insSubj.run(name, coef); seenSubj.add(Number(info.lastInsertRowid)); }
  }
  // 删除未出现在请求中的学科系数（含重复科目清理后的残留）
  const existingSubj = db.prepare('SELECT id FROM subject_coefficients').all().map((r) => r.id);
  for (const id of existingSubj) {
    if (!seenSubj.has(id)) db.prepare('DELETE FROM subject_coefficients WHERE id = ?').run(id);
  }

  const upBand = db.prepare('UPDATE size_bands SET min_size = ?, coefficient = ? WHERE id = ?');
  const insBand = db.prepare('INSERT INTO size_bands (min_size, coefficient) VALUES (?,?)');
  const existsBandId = db.prepare('SELECT id FROM size_bands WHERE id = ?');
  const seenBand = new Set();
  for (const b of bands) {
    const min = Number(b.min_size);
    const coef = Number(b.coefficient);
    if (!Number.isFinite(min) || !Number.isFinite(coef)) continue;
    if (b.id != null && existsBandId.get(b.id)) { upBand.run(min, coef, Number(b.id)); seenBand.add(Number(b.id)); }
    else { const info = insBand.run(min, coef); seenBand.add(Number(info.lastInsertRowid)); }
  }
  const existingBand = db.prepare('SELECT id FROM size_bands').all().map((r) => r.id);
  for (const id of existingBand) {
    if (!seenBand.has(id)) db.prepare('DELETE FROM size_bands WHERE id = ?').run(id);
  }

  const upPeriod = db.prepare(`UPDATE period_settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = ?`);
  const insPeriod = db.prepare('INSERT INTO period_settings (key, value) VALUES (?,?)');
  for (const [key, value] of Object.entries(periods)) {
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    if (db.prepare('SELECT 1 FROM period_settings WHERE key = ?').get(key)) upPeriod.run(v, key);
    else insPeriod.run(key, v);
  }
  logAudit(req.user.id, 'update_coefficients', 'coefficients', '更新统计系数与课时类型设置');
  return res.json({ ok: true, data: { updated: true } });
});

// ===== 代课/调课申请（教师发起，教务员审核） =====

// 教师提交代课/调课申请（任意登录用户；teacher_id 优先取绑定档案）
router.post('/requests', (req, res) => {
  const { schedule_id, type, to_teacher_id, date, to_date, reason } = req.body || {};
  if (!schedule_id) return res.status(400).json({ ok: false, error: '请选择要代/调的课' });
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(schedule_id));
  if (!schedule) return res.status(404).json({ ok: false, error: '课表条目不存在' });
  const finalType = type === '调课' ? '调课' : '代课';
  if (finalType === '调课') {
    if (!to_teacher_id) return res.status(400).json({ ok: false, error: '请选择目标教师' });
  }
  const fromTeacherId = req.user.teacher_id ?? schedule.teacher_id ?? null;

  const info = db.prepare(`
    INSERT INTO substitute_requests (schedule_id, type, from_teacher_id, to_teacher_id, date, to_date, reason, status, requested_by)
    VALUES (?,?,?,?,?,?,?, 'pending', ?)`)
    .run(Number(schedule_id), finalType, fromTeacherId, to_teacher_id ? Number(to_teacher_id) : null, date ?? null, to_date ?? null, reason ?? null, req.user.id);
  logAudit(req.user.id, 'request_substitute', `substitute_requests:${info.lastInsertRowid}`, `申请${finalType}（schedule ${schedule_id}${to_date ? '，临时到 ' + to_date : ''}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 代课/调课申请列表：管理员看全部；教师看自己发起的
router.get('/requests', (req, res) => {
  const isAdmin = RESULT_VIEW_ROLES.includes(req.user.role);
  let sql = `
    SELECT sr.*, c.name AS class_name, s.subject, s.day_of_week, s.period_no,
           ft.name AS from_teacher_name, tt.name AS to_teacher_name,
           ru.name AS requested_by_name
    FROM substitute_requests sr
    JOIN schedules s ON s.id = sr.schedule_id
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN teachers ft ON ft.id = sr.from_teacher_id
    LEFT JOIN teachers tt ON tt.id = sr.to_teacher_id
    LEFT JOIN users ru ON ru.id = sr.requested_by`;
  const params = [];
  if (!isAdmin) { sql += ' WHERE sr.requested_by = ?'; params.push(req.user.id); }
  sql += ' ORDER BY sr.id DESC';
  return res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// 审核代课/调课申请（管理员）：通过才执行 adjust
router.patch('/requests/:id/review', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM substitute_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '申请不存在' });
  if (r.status !== 'pending') return res.status(400).json({ ok: false, error: '该申请已处理' });
  const { approved } = req.body || {};
  const status = approved ? 'approved' : 'rejected';

  if (approved) {
    const result = applyAdjust({
      schedule_id: r.schedule_id, change_type: r.type, to_teacher_id: r.to_teacher_id,
      from_date: r.date, to_date: r.to_date, reason: r.reason, operator_id: req.user.id,
    });
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
  }
  db.prepare("UPDATE substitute_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?")
    .run(status, req.user.id, id);
  logAudit(req.user.id, 'review_substitute_request', `substitute_requests:${id}`, `审核代课申请 ${status}`);
  return res.json({ ok: true, data: { id, status } });
});

// 教师撤回自己的待审申请
router.delete('/requests/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM substitute_requests WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '申请不存在' });
  if (r.status !== 'pending') return res.status(400).json({ ok: false, error: '仅待审核的申请可撤回' });
  if (r.requested_by !== req.user.id && !DIRECTOR_ROLES.includes(req.user.role)) {
    return res.status(403).json({ ok: false, error: '无权限操作该申请' });
  }
  db.prepare('DELETE FROM substitute_requests WHERE id = ?').run(id);
  return res.json({ ok: true, data: { id } });
});

// 课务调整列表（统一两类来源，供课务调整列表与打印通知单）：
//  A) 课表级快照调整（schedule_changes）：代课/调课/停课，长期或区间。
//  B) 按日上课记录的调整（lesson_instances）：source='adjust'=代课/调课；cancelled=1 AND note='停课'=停课。
// 统一字段：{ id, source, change_type, class_name, class_grade, subject, date, day_of_week, period_no,
//              from_teacher_name, to_teacher_name, reason, operator_name, created_at }。
router.get('/changes', (req, res) => {
  // A) 课表级调整
  const scheduleRows = db.prepare(`
    SELECT sc.id, 'schedule' AS source, sc.change_type, sc.reverted,
           c.name AS class_name, c.grade AS class_grade, s.subject,
           sc.from_date AS date, s.day_of_week, s.period_no,
           ft.name AS from_teacher_name, tt.name AS to_teacher_name,
           sc.reason, u.name AS operator_name, sc.created_at
    FROM schedule_changes sc
    LEFT JOIN schedules s ON s.id = sc.schedule_id
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN users u ON u.id = sc.operator_id
    LEFT JOIN teachers ft ON ft.id = sc.from_teacher_id
    LEFT JOIN teachers tt ON tt.id = sc.to_teacher_id`).all();

  // B) 按日上课记录调整
  // 代课/调课：source='adjust'，原教师从 schedule_id → schedules.teacher_id 回查（parent 记录可能已被删）。
  // 停课：cancelled=1 且 note 标记为停课。
  const instanceRows = db.prepare(`
    SELECT li.id, 'instance' AS source,
           CASE WHEN li.cancelled = 1 THEN '停课'
                WHEN li.note = '调课' THEN '调课'
                ELSE '代课' END AS change_type,
           c.name AS class_name, c.grade AS class_grade, li.subject,
           li.date, s.day_of_week, li.period_no,
           ot.name AS from_teacher_name, nt.name AS to_teacher_name,
           li.note AS reason, NULL AS operator_name, li.created_at
    FROM lesson_instances li
    JOIN classes c ON c.id = li.class_id
    LEFT JOIN schedules s ON s.id = li.schedule_id
    LEFT JOIN teachers ot ON ot.id = s.teacher_id
    LEFT JOIN teachers nt ON nt.id = li.teacher_id
    WHERE li.source = 'adjust' OR (li.cancelled = 1 AND li.note LIKE '%停课%')`).all();

  // 合并并按时间倒序 + 年级排序
  const rows = [...scheduleRows, ...instanceRows].sort((a, b) => {
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    if (ta !== tb) return tb.localeCompare(ta);
    const ga = a.class_grade || '';
    const gb = b.class_grade || '';
    return ga.localeCompare(gb, 'zh');
  });

  return res.json({ ok: true, data: rows });
});

export default router;
