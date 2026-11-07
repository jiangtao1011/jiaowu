import { Router } from 'express';
import * as XLSX from 'xlsx';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, CLERK_ROLES, DIRECTOR_ROLES, RESULT_VIEW_ROLES } from '../auth.js';
import { loadContext, computePay, parsePayStandard } from '../context.js';
import { visibleTeacherIds } from '../scope.js';

const router = Router();
router.use(authRequired);

const CAL_TYPES = ['上课', '放假', '停课', '补课', '调课'];

// 本地日期 YYYY-MM-DD
function localDate() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 本地日期时间 YYYY-MM-DD HH:MM（口径说明/归档快照用）
function localDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 某日期是周几（1=周一 … 7=周日）
function dowOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

// Date -> YYYY-MM-DD
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 校历 =====

// 列出校历，可按日期范围过滤
router.get('/calendar', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM school_calendar';
  const params = [];
  const cond = [];
  if (from) { cond.push('date >= ?'); params.push(from); }
  if (to) { cond.push('date <= ?'); params.push(to); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY date DESC, COALESCE(grade, \'\')';
  return res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// 批量设置/更新校历（按 date+grade upsert）。grade 为空 = 全校，非空 = 仅该年级。
// 每项支持单日（date）或区间（from/to，含两端）批量展开。
router.put('/calendar', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });
  const upsert = db.prepare(`
    INSERT INTO school_calendar (date, grade, type, make_up_for, make_up_set, note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(date, COALESCE(grade, '')) DO UPDATE SET type = excluded.type, make_up_for = excluded.make_up_for, make_up_set = excluded.make_up_set, note = excluded.note`);
  let updated = 0;

  // 把区间展开成日期数组（含两端）
  const expandRange = (from, to) => {
    const out = [];
    const c = new Date(`${from}T00:00:00`);
    const e = new Date(`${to}T00:00:00`);
    while (c <= e) { out.push(fmtDate(c)); c.setDate(c.getDate() + 1); }
    return out;
  };

  for (const it of items) {
    const grade = it.grade ? String(it.grade).trim() : null;
    const type = CAL_TYPES.includes(it.type) ? it.type : '上课';
    const makeUpFor = (type === '补课' || type === '调课') ? (String(it.make_up_for || '').trim() || null) : null;
    const makeUpSet = type === '补课' ? (Number.isFinite(Number(it.make_up_set)) && it.make_up_set !== '' && it.make_up_set != null ? Number(it.make_up_set) : null) : null;

    let dates = [];
    if (it.date && /^\d{4}-\d{2}-\d{2}$/.test(String(it.date).trim())) {
      dates = [String(it.date).trim()];
    } else if (it.from && it.to && /^\d{4}-\d{2}-\d{2}$/.test(String(it.from).trim()) && /^\d{4}-\d{2}-\d{2}$/.test(String(it.to).trim())) {
      const from = String(it.from).trim();
      const to = String(it.to).trim();
      if (from <= to) dates = expandRange(from, to);
    }
    for (const date of dates) {
      upsert.run(date, grade, type, makeUpFor, makeUpSet, it.note ?? null);
      updated++;
    }
  }
  logAudit(req.user.id, 'update_calendar', 'school_calendar', `更新校历 ${updated} 条`);
  return res.json({ ok: true, data: { updated } });
});

// 删除某天校历（按 date+grade，grade 缺省=全校）
router.delete('/calendar/:date', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const date = String(req.params.date);
  const grade = req.query.grade ? String(req.query.grade) : null;
  if (grade) {
    db.prepare('DELETE FROM school_calendar WHERE date = ? AND COALESCE(grade, \'\') = ?').run(date, grade);
  } else {
    db.prepare('DELETE FROM school_calendar WHERE date = ? AND grade IS NULL').run(date);
  }
  logAudit(req.user.id, 'delete_calendar', 'school_calendar', `删除校历 ${date}${grade ? ' 年级' + grade : ''}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// ===== 展开生成上课记录（幂等） =====

// 校历结构：date -> { all: entry|null, byGrade: Map<grade, entry> }
function loadCalendar() {
  const cal = new Map();
  for (const c of db.prepare('SELECT * FROM school_calendar').all()) {
    if (!cal.has(c.date)) cal.set(c.date, { all: null, byGrade: new Map() });
    const day = cal.get(c.date);
    if (c.grade) day.byGrade.set(c.grade, c);
    else day.all = c;
  }
  return cal;
}

// 某日期对某年级（grade 可空=全校）应上的「状态 + 星期几 + 补课套号」。
// 返回 { action: 'skip' | 'normal' | 'makeup' | 'reschedule', dow, makeUpSet }；skip 表示该日该年级不上课。
// normal=照常上课（当天周几）；makeup=补课（补 make_up_for 指向的周几，按节假补课标准计酬）；
// reschedule=调课（补 make_up_for 指向的周几，但按常规课时计酬）。
function resolveDay(cal, dateStr, grade) {
  const day = cal.get(dateStr);
  const entry = (day && grade && day.byGrade.get(grade)) || (day && day.all);
  if (!entry || entry.type === '上课') return { action: 'normal', dow: dowOf(dateStr), makeUpSet: null };
  if (entry.type === '放假' || entry.type === '停课') return { action: 'skip', dow: null, makeUpSet: null };
  if (entry.type === '补课' || entry.type === '调课') {
    const set = Number.isFinite(Number(entry.make_up_set)) && entry.make_up_set != null && entry.make_up_set !== '' ? Number(entry.make_up_set) : null;
    // 套号型补课：指定了「用第几套」，按当天实际星期几上对应套号课表，make_up_for 可不填。仅「补课」支持套号。
    if (entry.type === '补课' && set != null) return { action: 'makeup', dow: dowOf(dateStr), makeUpSet: set };
    // 旧用法：补/调某天（make_up_for = 周几 1-7 或日期），用正式课表补被补那天的课。
    if (entry.make_up_for) {
      let dow = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.make_up_for)) dow = dowOf(entry.make_up_for);
      else {
        const n = Number(entry.make_up_for);
        if (n >= 1 && n <= 7) dow = n;
      }
      if (dow != null) return { action: entry.type === '调课' ? 'reschedule' : 'makeup', dow, makeUpSet: null };
    }
  }
  return { action: 'skip', dow: null, makeUpSet: null }; // 补课/调课但未填套号/映射 → 视为不上课（数据不完整）
}

// 课表条目在某日期是否生效（[effective_from, effective_to) 区间，字符串比较）
function activeOn(s, dateStr) {
  return (!s.effective_from || s.effective_from <= dateStr) && (!s.effective_to || s.effective_to > dateStr);
}

router.post('/generate', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { from_date, to_date, replace } = req.body || {};
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  if (from_date > to_date) return res.status(400).json({ ok: false, error: '开始日期不能晚于结束日期' });

  const cal = loadCalendar();
  // 班级 -> 年级
  const classGrade = new Map(db.prepare('SELECT id, grade FROM classes').all().map((c) => [c.id, c.grade]));

  // 区间内全部日期序列
  const allDates = [];
  const cursor = new Date(`${from_date}T00:00:00`);
  const end = new Date(`${to_date}T00:00:00`);
  while (cursor <= end) { allDates.push(fmtDate(cursor)); cursor.setDate(cursor.getDate() + 1); }

  // 重新生成：先删区间内课表展开的记录，避免改表/改校历后叠加重复计酬
  let deleted = 0;
  if (replace) {
    deleted = Number(db.prepare('DELETE FROM lesson_instances WHERE date >= ? AND date <= ? AND source = ?')
      .run(from_date, to_date, 'schedule').changes);
  }

  // 全部课表（含已关闭的），按天判定生效，支持「从某时间节点换表」的历史正确展开
  const schedules = db.prepare('SELECT * FROM schedules').all();
  // 补课课表分两类：
  //   1) 套号型（makeup_set != null）：一套独立的每周补课课表，只在被校历指定「补课 + 用第 N 套」的补课日
  //      按「当天实际星期几」展开，并整体取代该年级正式课表。高一/高二两套、高三三套即靠套号区分。
  //   2) 区间型（makeup_set 为空）：旧用法，自带 effective_from/to，在区间内按当天星期几展开并整体取代。
  const makeupSetSchedules = schedules.filter((s) => s.term === '节假补课' && s.makeup_set != null);
  const makeupRangeSchedules = schedules.filter((s) => s.term === '节假补课' && s.makeup_set == null);
  const formalSchedules = schedules.filter((s) => s.term !== '节假补课');

  const exists = db.prepare(`
    SELECT id FROM lesson_instances
    WHERE schedule_id = ? AND date = ? AND period_no = ? AND cancelled = 0`);
  const insert = db.prepare(`
    INSERT INTO lesson_instances (schedule_id, class_id, teacher_id, subject, date, period_no, period_type, term, source)
    VALUES (?,?,?,?,?,?,?,?, 'schedule')`);

  let created = 0, skipped = 0;

  const expandOne = (s, date, termOverride) => {
    if (exists.get(s.id, date, s.period_no)) { skipped++; return; }
    insert.run(s.id, s.class_id, s.teacher_id, s.subject, date, s.period_no, s.period_type, termOverride ?? s.term ?? '常规');
    created++;
  };

  // 先收集哪些 (date|grade) 有活跃补课课表，供正式课表整体让位。
  // 套号型：仅当天校历「补课 + 指定套号」且该年级有对应套号课表时算活跃。
  // 区间型：在其自身生效区间内（非放假/停课/调课日）即活跃。
  const makeupActive = new Set();
  for (const s of makeupSetSchedules) {
    const grade = classGrade.get(s.class_id);
    for (const date of allDates) {
      if (!activeOn(s, date)) continue;
      const r = resolveDay(cal, date, grade);
      if (r.action !== 'makeup') continue;          // 只有「补课」日才用套号课表
      if (r.makeUpSet !== s.makeup_set) continue;   // 套号匹配
      makeupActive.add(`${date}|${grade ?? ''}`);
    }
  }
  for (const s of makeupRangeSchedules) {
    const grade = classGrade.get(s.class_id);
    for (const date of allDates) {
      if (!activeOn(s, date)) continue;
      const r = resolveDay(cal, date, grade);
      if (r.action === 'skip' || r.action === 'reschedule') continue; // 放假/停课/调课日不用区间型补课课表
      makeupActive.add(`${date}|${grade ?? ''}`);
    }
  }

  // 第一遍：补课课表展开
  for (const s of makeupSetSchedules) {
    const grade = classGrade.get(s.class_id);
    for (const date of allDates) {
      if (!activeOn(s, date)) continue;
      const r = resolveDay(cal, date, grade);
      if (r.action !== 'makeup') continue;          // 放假/停课/照常日不用套号补课课表
      if (r.makeUpSet !== s.makeup_set) continue;   // 套号不匹配
      // 套号型补课课表是一套独立完整课表，不属于任何星期：校历指定「用第 N 套」当天整套直接展开，不看星期几。
      expandOne(s, date, '节假补课');
    }
  }
  for (const s of makeupRangeSchedules) {
    const grade = classGrade.get(s.class_id);
    for (const date of allDates) {
      if (!activeOn(s, date)) continue;
      const r = resolveDay(cal, date, grade);
      if (r.action === 'skip' || r.action === 'reschedule') continue; // 放假/停课/调课日不上补课课表
      if (dowOf(date) !== s.day_of_week) continue;  // 按当天实际星期几
      expandOne(s, date, '节假补课');
    }
  }

  // 第二遍：正式课表（term≠节假补课）。当天该年级有活跃补课课表时整体让位。
  // 校历「补课」日若未指定套号（无套号型补课课表），则用正式课表补被补那天的课并标节假补课；
  // 若已指定套号，该日应由套号补课课表接管，正式课表不再补课（套号课表缺失时按数据缺失处理，跳过）。
  // 「调课」日用正式课表补被补那天的课，但按常规课时计酬（不标节假补课）。
  //
  // 关键修正：同一节课（业务键）可能因「换表」留下多个 effective 区间重叠的版本，
  // 展开时必须每天只取「该日生效的 latest effective_from」版本，否则同一天重复计酬。
  // 先按业务键分组，每天为每个业务键选出唯一生效版本。
  const bizKey = (s) => `${s.class_id}|${s.teacher_id}|${s.subject}|${s.day_of_week}|${s.period_no}|${s.period_type}|${s.term}`;
  const byBiz = new Map();
  for (const s of formalSchedules) {
    if (!byBiz.has(bizKey(s))) byBiz.set(bizKey(s), []);
    byBiz.get(bizKey(s)).push(s);
  }
  // 某日期某业务键的「唯一生效版本」：effective_from <= date 且 effective_to > date 中 effective_from 最大者
  const resolveVersion = (list, date) => {
    let best = null;
    for (const s of list) {
      if (!activeOn(s, date)) continue;
      if (!best || (s.effective_from ?? '') > (best.effective_from ?? '')) best = s;
    }
    return best;
  };

  for (const list of byBiz.values()) {
    for (const date of allDates) {
      const s = resolveVersion(list, date);
      if (!s) continue;
      const grade = classGrade.get(s.class_id);
      if (makeupActive.has(`${date}|${grade ?? ''}`)) continue;
      const r = resolveDay(cal, date, grade);
      if (r.action === 'skip') continue;
      if (r.dow !== s.day_of_week) continue;
      if (r.action === 'makeup' && r.makeUpSet == null) {
        expandOne(s, date, '节假补课');
      } else if (r.action === 'normal' || r.action === 'reschedule') {
        expandOne(s, date, null);
      }
    }
  }

  logAudit(req.user.id, 'generate_instances', 'lesson_instances', `展开 ${from_date}~${to_date}，${replace ? `删除 ${deleted} 条，` : ''}新增 ${created} 条，跳过 ${skipped} 条`);
  return res.json({ ok: true, data: { created, skipped, deleted, days: allDates.length } });
});

// ===== 上课记录 CRUD =====

// 列出上课记录（默认只列未取消）
router.get('/instances', (req, res) => {
  const { date, from_date, to_date, class_id, teacher_id, cancelled } = req.query;
  let sql = `
    SELECT li.*, c.name AS class_name, c.type AS class_type, t.name AS teacher_name
    FROM lesson_instances li
    JOIN classes c ON c.id = li.class_id
    JOIN teachers t ON t.id = li.teacher_id
    WHERE 1=1`;
  const params = [];
  if (cancelled === '1') { sql += ' AND li.cancelled = 1'; }
  else if (cancelled === 'all') { /* 不过滤 */ }
  else { sql += ' AND li.cancelled = 0'; }
  if (date) { sql += ' AND li.date = ?'; params.push(date); }
  if (from_date) { sql += ' AND li.date >= ?'; params.push(from_date); }
  if (to_date) { sql += ' AND li.date <= ?'; params.push(to_date); }
  if (class_id) { sql += ' AND li.class_id = ?'; params.push(Number(class_id)); }
  if (teacher_id) { sql += ' AND li.teacher_id = ?'; params.push(Number(teacher_id)); }
  // 作用域：非管理员只看本范围教师（教师=自己、教研组长=本学科、备课组长=本组、年级组长=本年级）
  const scope = visibleTeacherIds(req.user);
  if (scope) {
    sql += ` AND li.teacher_id IN (${scope.map(() => '?').join(',')})`;
    params.push(...scope);
  }
  sql += ' ORDER BY li.date, li.period_no, li.id';
  return res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// 手工加课（source=extra）
router.post('/instances', roleRequired(...CLERK_ROLES), (req, res) => {
  const { class_id, teacher_id, subject, date, period_no, period_type, term } = req.body || {};
  if (!class_id || !teacher_id || !date) return res.status(400).json({ ok: false, error: '班级、教师、日期必填' });
  const info = db.prepare(`
    INSERT INTO lesson_instances (class_id, teacher_id, subject, date, period_no, period_type, term, source, note)
    VALUES (?,?,?,?,?,?,?, 'extra', ?)`)
    .run(Number(class_id), Number(teacher_id), subject ?? null, date,
      Number(period_no) || 1, period_type ?? '正课', term ?? '常规', req.body.note ?? null);
  logAudit(req.user.id, 'add_instance', `lesson_instances:${info.lastInsertRowid}`, `加课 ${date} ${subject ?? ''}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 删除某条上课记录（撤销加课/停课记录）
router.delete('/instance/:id', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM lesson_instances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '上课记录不存在' });
  db.prepare('DELETE FROM lesson_instances WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_instance', `lesson_instances:${id}`, `删除上课记录 ${r.date}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// 单日代课/停课
router.post('/instance/:id/adjust', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM lesson_instances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '上课记录不存在' });
  const { change_type, to_teacher_id, note } = req.body || {};

  // 检查：已停课/已调整的记录不能再调整，防止「停课后还能代课」等误操作
  if (r.cancelled) {
    return res.status(400).json({ ok: false, error: '该课已停课或已调整，无法再次调整' });
  }

  if (change_type === '停课') {
    db.prepare('UPDATE lesson_instances SET cancelled = 1, note = ? WHERE id = ?').run(note ?? '停课', id);
    logAudit(req.user.id, 'cancel_instance', `lesson_instances:${id}`, `停课 ${r.date}`);
    return res.json({ ok: true, data: { id, cancelled: true } });
  }

  if (change_type === '代课' || change_type === '调课') {
    if (!to_teacher_id) return res.status(400).json({ ok: false, error: '请选择目标教师' });
    // 关闭原记录，插入新记录指向目标教师
    db.prepare('UPDATE lesson_instances SET cancelled = 1, note = ? WHERE id = ?').run(note ?? change_type, id);
    const info = db.prepare(`
      INSERT INTO lesson_instances (schedule_id, class_id, teacher_id, subject, date, period_no, period_type, term, source, parent_id, note)
      VALUES (?,?,?,?,?,?,?,?, 'adjust', ?, ?)`)
      .run(r.schedule_id, r.class_id, Number(to_teacher_id), r.subject, r.date, r.period_no, r.period_type, r.term, id, note ?? change_type);
    logAudit(req.user.id, 'adjust_instance', `lesson_instances:${id}`, `${change_type}：教师 ${r.teacher_id} -> ${to_teacher_id}（${r.date}）`);
    return res.json({ ok: true, data: { id: Number(info.lastInsertRowid), parent_id: id } });
  }

  return res.status(400).json({ ok: false, error: '无效的调整类型' });
});

// 撤销停课/代课（恢复原记录）
router.post('/instance/:id/restore', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM lesson_instances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '上课记录不存在' });
  db.prepare('UPDATE lesson_instances SET cancelled = 0, note = NULL WHERE id = ?').run(id);
  logAudit(req.user.id, 'restore_instance', `lesson_instances:${id}`, `恢复上课记录 ${r.date}`);
  return res.json({ ok: true, data: { id, cancelled: false } });
});

// ===== 按日统计 =====

// 取区间内上课记录（含教师名与课酬标准），可按 term / teacher_id 过滤。
// includeCancelled=true 时保留已停课记录（含代课双方），供财务明细/对账看全貌；默认 false 仅计酬记录。
// parent_teacher_name：代课记录回链原教师（parent_id -> 原记录 -> 原 teacher），用于追溯「这笔课被谁代了」。
function queryRows(from_date, to_date, term, teacher_id, includeCancelled = false) {
  let sql = `
    SELECT li.*, t.name AS teacher_name, t.pay_standard, c.name AS class_name, c.grade AS class_grade,
           pt.name AS parent_teacher_name
    FROM lesson_instances li
    JOIN teachers t ON t.id = li.teacher_id
    JOIN classes c ON c.id = li.class_id
    LEFT JOIN lesson_instances pli ON pli.id = li.parent_id
    LEFT JOIN teachers pt ON pt.id = pli.teacher_id
    WHERE li.date >= ? AND li.date <= ?`;
  const params = [from_date, to_date];
  if (!includeCancelled) sql += ' AND li.cancelled = 0';
  if (term) { sql += ' AND li.term = ?'; params.push(term); }
  if (teacher_id) { sql += ' AND li.teacher_id = ?'; params.push(Number(teacher_id)); }
  sql += ' ORDER BY li.teacher_id, li.date, li.period_no';
  return db.prepare(sql).all(...params);
}

// 非规时段（有课酬标准的时段）：pay_standard 的五档 + 节假补课。
// 与 computePay 的分支顺序保持一致：折算类型 → 按次计酬类型 → 非规时段 → 常规正课。
const NON_REGULAR_TERMS = ['夏令营', '冬令营', '全员夏令营', '全员冬令营', '节假补课'];

// 把区间内上课记录聚合成「财务口径」：钱 = 按次计酬类型金额 + 非规时段金额；正课/折算类型只出折算课时不计钱。
// 返回 { teachers, coefColumns, typeColumns, termColumns, totals }，供财务汇总表与勾稽校验共用。
// rows 来自 queryRows（含 pay_standard / parent_teacher_name），cancelled 记录默认跳过（单独统计）。
function buildFinancial(rows, ctx) {
  const coefColumns = [...ctx.periodTypeCoefs.keys()]; // 折算类型（早自习等）
  const typeColumns = [...ctx.periodTypePays.keys()];  // 按次计酬类型
  const termColumns = NON_REGULAR_TERMS;

  const mkEntry = (tid, name) => ({
    teacher_id: tid, teacher_name: name,
    core_count: 0, core_weighted: 0,      // 常规正课（不计钱）
    coefCounts: {}, coefWeighted: {},      // 折算类型：节数 / 折算课时
    typeCounts: {}, typePays: {},          // 按次计酬类型：节数 / 金额
    termCounts: {}, termPays: {},          // 非规时段：节数 / 金额
    weighted_total: 0, pay_total: 0,
  });
  const teachers = new Map();

  for (const r of rows) {
    if (r.cancelled) continue; // 停课不计酬
    const { weighted, pay } = computePay(ctx, { ...r, count: 1 });
    if (!teachers.has(r.teacher_id)) teachers.set(r.teacher_id, mkEntry(r.teacher_id, r.teacher_name));
    const e = teachers.get(r.teacher_id);
    e.weighted_total += weighted;
    e.pay_total += pay;

    if (ctx.periodTypeCoefs.has(r.period_type)) {
      e.coefCounts[r.period_type] = (e.coefCounts[r.period_type] || 0) + 1;
      e.coefWeighted[r.period_type] = (e.coefWeighted[r.period_type] || 0) + weighted;
    } else if (ctx.periodTypePays.has(r.period_type)) {
      e.typeCounts[r.period_type] = (e.typeCounts[r.period_type] || 0) + 1;
      e.typePays[r.period_type] = (e.typePays[r.period_type] || 0) + pay;
    } else if (r.term !== '常规') {
      e.termCounts[r.term] = (e.termCounts[r.term] || 0) + 1;
      e.termPays[r.term] = (e.termPays[r.term] || 0) + pay;
    } else {
      e.core_count += 1; e.core_weighted += weighted;
    }
  }

  const list = [...teachers.values()].sort((a, b) => a.teacher_name.localeCompare(b.teacher_name, 'zh'));
  const sum = (fn) => list.reduce((s, e) => s + (fn(e) || 0), 0);
  const totals = {
    core_count: sum((e) => e.core_count), core_weighted: sum((e) => e.core_weighted),
    coefCounts: Object.fromEntries(coefColumns.map((t) => [t, sum((e) => e.coefCounts[t])])),
    coefWeighted: Object.fromEntries(coefColumns.map((t) => [t, sum((e) => e.coefWeighted[t])])),
    typeCounts: Object.fromEntries(typeColumns.map((t) => [t, sum((e) => e.typeCounts[t])])),
    typePays: Object.fromEntries(typeColumns.map((t) => [t, sum((e) => e.typePays[t])])),
    termCounts: Object.fromEntries(termColumns.map((t) => [t, sum((e) => e.termCounts[t])])),
    termPays: Object.fromEntries(termColumns.map((t) => [t, sum((e) => e.termPays[t])])),
    weighted_total: sum((e) => e.weighted_total),
    pay_total: sum((e) => e.pay_total),
  };
  return { teachers: list, coefColumns, typeColumns, termColumns, totals };
}

router.get('/summary', (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id);
  // 作用域：非管理员只看本范围教师
  const scope = visibleTeacherIds(req.user);
  const scoped = scope
    ? rows.filter((r) => scope.includes(r.teacher_id))
    : rows;

  const map = new Map();
  for (const r of scoped) {
    const { weighted, pay } = computePay(ctx, { ...r, count: 1 });

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
    e[col] = (e[col] || 0) + 1;
    e.total += 1;
    e.weighted_total += weighted;
    e.pay_total += pay;
    if (!e.terms[r.term]) e.terms[r.term] = { count: 0, weighted: 0 };
    e.terms[r.term].count += 1;
    e.terms[r.term].weighted += weighted;
  }

  const data = [...map.values()].map((e) => ({
    ...e,
    weighted_total: Math.round(e.weighted_total * 100) / 100,
    pay_total: Math.round(e.pay_total * 100) / 100,
  }));
  // 汇总表列：折算类型字典 + 正课 + 节假补课 + 按次计酬类型字典
  const types = [...ctx.periodTypeCoefs.keys(), '正课', '节假补课', ...ctx.periodTypePays.keys()];
  return res.json({ ok: true, data, types });
});

// ===== 按次计酬类型字典 =====

// 列出类型字典（名称 + 固定课酬单价）
router.get('/type-pays', (req, res) => {
  const rows = db.prepare('SELECT id, name, pay FROM period_type_pays ORDER BY id').all();
  return res.json({ ok: true, data: rows });
});

// 批量保存类型字典（按 id 更新，无 id 新增；name 为空则跳过）
router.put('/type-pays', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });
  const up = db.prepare('UPDATE period_type_pays SET name = ?, pay = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO period_type_pays (name, pay) VALUES (?,?)');
  const existsId = db.prepare('SELECT id FROM period_type_pays WHERE id = ?');
  for (const it of items) {
    const name = String(it.name || '').trim();
    const pay = Number(it.pay);
    if (!name || !Number.isFinite(pay)) continue;
    if (it.id != null && existsId.get(it.id)) up.run(name, pay, Number(it.id));
    else {
      // 同名则更新（避免重复）
      const dup = db.prepare('SELECT id FROM period_type_pays WHERE name = ?').get(name);
      if (dup) up.run(name, pay, dup.id);
      else ins.run(name, pay);
    }
  }
  logAudit(req.user.id, 'update_type_pays', 'period_type_pays', '更新按次计酬类型字典');
  return res.json({ ok: true, data: { updated: true } });
});

// 删除某类型（仅删除字典项；若已被上课记录/课表引用则拒绝，避免历史计酬突变）
router.delete('/type-pays/:id', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM period_type_pays WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '类型不存在' });

  const inst = db.prepare('SELECT COUNT(*) AS n FROM lesson_instances WHERE period_type = ?').get(row.name);
  const sched = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE period_type = ?').get(row.name);
  const qna = db.prepare('SELECT COUNT(*) AS n FROM qna_lessons WHERE period_type = ?').get(row.name);
  const used = inst.n + sched.n + qna.n;
  if (used > 0) {
    return res.status(400).json({
      ok: false,
      error: `「${row.name}」已被 ${used} 条记录引用（上课记录 ${inst.n}、课表 ${sched.n}、申报 ${qna.n}），无法删除。请先处理这些记录，或将类型单价改为 0 以停用。`,
    });
  }
  db.prepare('DELETE FROM period_type_pays WHERE id = ?').run(id);
  db.prepare('DELETE FROM period_type_grade_pays WHERE period_type = ?').run(row.name);
  logAudit(req.user.id, 'delete_type_pay', `period_type_pays:${id}`, `删除按次计酬类型 ${row.name}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// ===== 按次计酬类型的分年级覆盖价（如晚自习按年级分价） =====

// 列出所有分年级覆盖价（含类型基准价，供前端展示「覆盖后实际单价」）
router.get('/type-pays/grade-pays', (req, res) => {
  const rows = db.prepare('SELECT id, period_type, grade, pay FROM period_type_grade_pays ORDER BY period_type, grade').all();
  const base = Object.fromEntries(
    db.prepare('SELECT name, pay FROM period_type_pays').all().map((r) => [r.name, r.pay])
  );
  return res.json({ ok: true, data: rows.map((r) => ({ ...r, base_pay: base[r.period_type] ?? null })) });
});

// 批量保存分年级覆盖价（按 id 更新，无 id 新增；period_type/grade 为空则跳过）
router.put('/type-pays/grade-pays', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });
  const up = db.prepare('UPDATE period_type_grade_pays SET period_type = ?, grade = ?, pay = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO period_type_grade_pays (period_type, grade, pay) VALUES (?,?,?)');
  const existsId = db.prepare('SELECT id FROM period_type_grade_pays WHERE id = ?');
  for (const it of items) {
    const periodType = String(it.period_type || '').trim();
    const grade = String(it.grade || '').trim();
    const pay = Number(it.pay);
    if (!periodType || !grade || !Number.isFinite(pay)) continue;
    if (it.id != null && existsId.get(it.id)) up.run(periodType, grade, pay, Number(it.id));
    else {
      // 同类型+同年级则更新（避免重复）
      const dup = db.prepare('SELECT id FROM period_type_grade_pays WHERE period_type = ? AND grade = ?').get(periodType, grade);
      if (dup) up.run(periodType, grade, pay, dup.id);
      else ins.run(periodType, grade, pay);
    }
  }
  logAudit(req.user.id, 'update_grade_pays', 'period_type_grade_pays', '更新按次计酬分年级覆盖价');
  return res.json({ ok: true, data: { updated: true } });
});

// 删除某条分年级覆盖价
router.delete('/type-pays/grade-pays/:id', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM period_type_grade_pays WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '分年级价记录不存在' });
  db.prepare('DELETE FROM period_type_grade_pays WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_grade_pay', `period_type_grade_pays:${id}`, `删除 ${row.period_type} ${row.grade} 分年级价`);
  return res.json({ ok: true, data: { deleted: true } });
});

// ===== 折算类型字典（早自习等，节数 × 折算系数，不计钱） =====

// 列出折算类型字典（名称 + 折算系数）
router.get('/type-coefficients', (req, res) => {
  const rows = db.prepare('SELECT id, name, coefficient FROM period_type_coefficients ORDER BY id').all();
  return res.json({ ok: true, data: rows });
});

// 批量保存折算类型字典（按 id 更新，无 id 新增；name 为空则跳过）
router.put('/type-coefficients', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });
  const up = db.prepare('UPDATE period_type_coefficients SET name = ?, coefficient = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO period_type_coefficients (name, coefficient) VALUES (?,?)');
  const existsId = db.prepare('SELECT id FROM period_type_coefficients WHERE id = ?');
  for (const it of items) {
    const name = String(it.name || '').trim();
    const coefficient = Number(it.coefficient);
    if (!name || !Number.isFinite(coefficient)) continue;
    if (it.id != null && existsId.get(it.id)) up.run(name, coefficient, Number(it.id));
    else {
      // 同名则更新（避免重复）
      const dup = db.prepare('SELECT id FROM period_type_coefficients WHERE name = ?').get(name);
      if (dup) up.run(name, coefficient, dup.id);
      else ins.run(name, coefficient);
    }
  }
  logAudit(req.user.id, 'update_type_coefficients', 'period_type_coefficients', '更新折算类型字典');
  return res.json({ ok: true, data: { updated: true } });
});

// 删除某折算类型（仅删除字典项；若已被上课记录/课表/申报引用则拒绝，避免历史计酬突变）
router.delete('/type-coefficients/:id', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM period_type_coefficients WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '折算类型不存在' });

  const inst = db.prepare('SELECT COUNT(*) AS n FROM lesson_instances WHERE period_type = ?').get(row.name);
  const sched = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE period_type = ?').get(row.name);
  const qna = db.prepare('SELECT COUNT(*) AS n FROM qna_lessons WHERE period_type = ?').get(row.name);
  const used = inst.n + sched.n + qna.n;
  if (used > 0) {
    return res.status(400).json({
      ok: false,
      error: `「${row.name}」已被 ${used} 条记录引用（上课记录 ${inst.n}、课表 ${sched.n}、申报 ${qna.n}），无法删除。请先处理这些记录，或将系数改为 0 以停用。`,
    });
  }
  db.prepare('DELETE FROM period_type_coefficients WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_type_coefficient', `period_type_coefficients:${id}`, `删除折算类型 ${row.name}`);
  return res.json({ ok: true, data: { deleted: true } });
});
// 财务口径：保留已停课/代课双方全貌（includeCancelled），停课课酬计 0 并标「已停课」，
// 代课记录标来源与原教师，便于财务把每笔钱对应到原始课务动作。
router.get('/export', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id, true);

  const srcLabel = { schedule: '课表', adjust: '代课/调课', extra: '加课', qna: '申报' };
  const headers = ['日期', '教师', '班级', '学科', '节次', '类型', '时段', '来源', '原教师', '状态', '折算课时', '课酬(元)'];
  const aoa = [headers];
  for (const r of rows) {
    // 停课不计酬，但仍保留行（标「已停课」），财务才能对全貌
    const { weighted, pay } = r.cancelled ? { weighted: 0, pay: 0 } : computePay(ctx, { ...r, count: 1 });
    aoa.push([
      r.date,
      r.teacher_name,
      r.class_name,
      r.subject ?? '',
      r.period_no,
      r.period_type,
      r.term,
      srcLabel[r.source] || r.source,
      (r.source === 'adjust' ? r.parent_teacher_name : '') || '',
      r.cancelled ? '已停课' : '',
      Math.round(weighted * 100) / 100,
      Math.round(pay * 100) / 100,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '课酬明细');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`课酬明细_${from_date}_${to_date}.xlsx`)}`);
  res.send(buf);
});

// 导出财务审核汇总表（Excel）：按教师一行，金额按「钱的来源」分列——
// 按次计酬各类型(元) + 非规时段各档(元) + 课酬合计；正课/早自习折算课时单列并标注「不计钱」。
// 附「口径说明」sheet（单价/系数快照/生成人），供财务审核归档。
router.get('/financial-report', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id);
  const { teachers, coefColumns, typeColumns, termColumns, totals } = buildFinancial(rows, ctx);

  const round2 = (v) => Math.round((v || 0) * 100) / 100;

  const header = [
    '序号', '教师姓名',
    '正课节数', '正课折算课时(不计钱)',
    ...coefColumns.flatMap((t) => [`${t}节数`, `${t}折算课时(不计钱)`]),
    ...typeColumns.flatMap((t) => [`${t}节数`, `${t}金额(元)`]),
    ...termColumns.flatMap((t) => [`${t}节数`, `${t}金额(元)`]),
    '折算课时合计', '课酬合计(元)', '备注',
  ];
  const aoa = [header];
  teachers.forEach((e, i) => {
    aoa.push([
      i + 1, e.teacher_name,
      e.core_count, round2(e.core_weighted),
      ...coefColumns.flatMap((t) => [e.coefCounts[t] || 0, round2(e.coefWeighted[t])]),
      ...typeColumns.flatMap((t) => [e.typeCounts[t] || 0, round2(e.typePays[t])]),
      ...termColumns.flatMap((t) => [e.termCounts[t] || 0, round2(e.termPays[t])]),
      round2(e.weighted_total), round2(e.pay_total), '',
    ]);
  });

  // 合计行
  aoa.push([
    '合计', '',
    totals.core_count, round2(totals.core_weighted),
    ...coefColumns.flatMap((t) => [totals.coefCounts[t] || 0, round2(totals.coefWeighted[t])]),
    ...typeColumns.flatMap((t) => [totals.typeCounts[t] || 0, round2(totals.typePays[t])]),
    ...termColumns.flatMap((t) => [totals.termCounts[t] || 0, round2(totals.termPays[t])]),
    round2(totals.weighted_total), round2(totals.pay_total), '',
  ]);

  // 签字确认栏
  aoa.push([]);
  aoa.push([`统计区间：${from_date} ~ ${to_date}${term ? '（时段：' + term + '）' : ''}`]);
  aoa.push([]);
  aoa.push(['制表人（教务员）：', '', '审核人（教务主任）：', '', '财务复核：', '', '校长审批：', '']);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '财务汇总表');

  // 口径说明 sheet：审核的前提是「按什么价算的」要白纸黑字
  const notes = [
    ['课酬财务汇总表 —— 统计口径说明'],
    [],
    [`统计区间：${from_date} ~ ${to_date}${term ? '（时段：' + term + '）' : ''}`],
    [`生成时间：${localDateTime()}`],
    [`生成人：${req.user?.name || req.user?.username || '-'}`],
    [],
    ['一、课酬（钱）口径'],
    ['· 课酬合计 = 按次计酬类型金额 + 非规时段金额。'],
    ['· 常规正课、折算类型（早自习等）只出「折算课时」，不计钱（供教学业绩考核用）。'],
    [],
    ['二、按次计酬类型（元 = 单价 × 节数）'],
    ...typeColumns.map((t) => [`· ${t}：${ctx.periodTypePays.get(t) ?? 0} 元/节`]),
    ...typeColumns.flatMap((t) => {
      const gp = ctx.periodTypeGradePays.get(t);
      return gp && gp.size ? [[`· ${t} 分年级：` + [...gp.entries()].map(([g, p]) => `${g}${p}元`).join('，')]] : [];
    }),
    [],
    ['三、非规时段课酬（元 = 节数 × 教师课酬标准）'],
    ['· 各教师课酬标准见「教师信息」模块的 pay_standard 字段（按时段分档）。'],
    ['· 时段：' + termColumns.join(' / ')],
    [],
    ['四、折算课时系数（仅正课/折算类型，不计钱）'],
    [`· 正课折算 = 节数 ×（学科系数 + 班额系数）。`],
    ...coefColumns.map((t) => [`· ${t}折算 = 节数 × 折算系数(${ctx.periodTypeCoefs.get(t) ?? 0.5})。`]),
    ['· 学科系数：' + [...ctx.subjCoef.entries()].map(([s, c]) => `${s}${c}`).join('，')],
    ['· 班额分档系数：' + ctx.sizeBands.map((b) => `≥${b.min_size}人×${b.coefficient}`).join('，')],
    [],
    ['五、本表金额由系统按上述口径自动计算，财务审核以本表「课酬合计(元)」列为准。'],
  ];
  const ns = XLSX.utils.aoa_to_sheet(notes);
  ns['!cols'] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, ns, '口径说明');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`课酬财务汇总表_${from_date}_${to_date}.xlsx`)}`);
  res.send(buf);
});

// ===== 勾稽校验报告 =====
// 财务「快速、准确审核」的关键：自动对账，不让财务手工算。
// 返回 { ok, data: { period, balanced, detail_pay, summary_pay, issues, by_type, by_grade, by_subject, totals } }
//   balanced: 明细逐条课酬之和 是否等于 汇总课酬合计（金额勾稽）
//   issues: 异常清单（无价类型 / 非规时段缺标准 / 代课计数异常 / 单人偏高）
router.get('/financial-check', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id, true); // 含停课，用于代课成对校验

  const round2 = (v) => Math.round((v || 0) * 100) / 100;
  const issues = [];

  // 1) 明细口径：逐条 active 记录课酬之和（与汇总口径一致，用于勾稽）
  let detailPay = 0;
  for (const r of rows) {
    if (r.cancelled) continue;
    detailPay += computePay(ctx, { ...r, count: 1 }).pay;
  }
  detailPay = round2(detailPay);

  // 2) 汇总口径：buildFinancial 的课酬合计
  const fin = buildFinancial(rows, ctx);
  const summaryPay = round2(fin.totals.pay_total);

  // 3) 异常清单
  // 3a) 无价类型：period_type 既非正课/折算类型，也不在按次计酬字典，且非非规时段（这类 computePay 会当正课算，金额 0，可能是类型名打错）
  const untyped = new Set();
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.period_type !== '正课' && !ctx.periodTypeCoefs.has(r.period_type) && !ctx.periodTypePays.has(r.period_type) && r.term === '常规') {
      untyped.add(r.period_type);
    }
  }
  for (const t of [...untyped]) issues.push({ code: 'unpriced_type', level: 'error', msg: `「${t}」不在按次计酬类型字典里，按常规正课处理（不计钱）。若应计酬，请在「统计配置」添加该类型。` });

  // 3b) 非规时段缺课酬标准
  const missStd = new Map();
  for (const r of rows) {
    if (r.cancelled) continue;
    if (NON_REGULAR_TERMS.includes(r.term) && r.term !== '节假补课') {
      const p = parsePayStandard(r.pay_standard);
      if (!Number(p[r.term])) {
        const key = `${r.teacher_id}|${r.term}`;
        if (!missStd.has(key)) missStd.set(key, { teacher_name: r.teacher_name, term: r.term });
      }
    }
  }
  for (const v of missStd.values()) issues.push({ code: 'missing_pay_standard', level: 'warn', msg: `教师「${v.teacher_name}」在「${v.term}」时段缺少课酬标准，该时段课酬按 0 计。请在教师信息补该时段标准。` });

  // 3c) 代课计数异常：同一天同一班级同一节次，被停课的「原记录」与「代课记录」应成对出现。
  // 若只有代课记录而无对应停课原记录（或反之），提示可能数据不完整。
  const activeKey = (r) => `${r.date}|${r.class_id}|${r.period_no}`;
  const cancelledKeys = new Set();
  const adjustKeys = new Set();
  for (const r of rows) {
    const k = activeKey(r);
    if (r.cancelled) cancelledKeys.add(k);
    if (r.source === 'adjust') adjustKeys.add(k);
  }
  const orphanAdjust = [...adjustKeys].filter((k) => !cancelledKeys.has(k));
  const orphanCancel = [...cancelledKeys].filter((k) => !adjustKeys.has(k));
  if (orphanAdjust.length) issues.push({ code: 'orphan_adjust', level: 'warn', msg: `${orphanAdjust.length} 处代课记录找不到对应停课原记录，可能是手工加课时直接记了代课。请核对明细表。` });
  if (orphanCancel.length) issues.push({ code: 'orphan_cancel', level: 'warn', msg: `${orphanCancel.length} 处停课记录找不到对应代课记录，可能漏记了代课教师。请核对明细表。` });

  // 3d) 单人课酬偏高：超过整体均值 2 倍（至少 200 元才告警，避免小样本误报）
  const teacherPays = fin.teachers.map((e) => ({ name: e.teacher_name, pay: round2(e.pay_total) }));
  const positive = teacherPays.filter((e) => e.pay > 0);
  if (positive.length >= 2) {
    const avg = positive.reduce((s, e) => s + e.pay, 0) / positive.length;
    for (const e of positive) {
      if (e.pay > avg * 2 && e.pay >= 200) {
        issues.push({ code: 'high_pay', level: 'warn', msg: `教师「${e.name}」课酬 ${e.pay} 元，高于整体均值(${round2(avg)}元)的 2 倍，请人工复核是否有重复计酬。` });
      }
    }
  }

  // 4) 交叉汇总（按类型 / 年级 / 学科），金额与总合计对平
  const byType = {};
  for (const t of fin.typeColumns) byType[t] = round2(fin.totals.typePays[t]);
  for (const t of fin.termColumns) byType[`时段·${t}`] = round2(fin.totals.termPays[t]);

  const byGrade = {};
  const bySubject = {};
  for (const r of rows) {
    if (r.cancelled) continue;
    const { pay } = computePay(ctx, { ...r, count: 1 });
    if (!pay) continue;
    const g = r.class_grade || '未分年级';
    const s = r.subject || '未填学科';
    byGrade[g] = round2((byGrade[g] || 0) + pay);
    bySubject[s] = round2((bySubject[s] || 0) + pay);
  }

  return res.json({
    ok: true,
    data: {
      period: { from_date, to_date, term: term || null },
      balanced: detailPay === summaryPay,
      detail_pay: detailPay,
      summary_pay: summaryPay,
      issues,
      by_type: byType,
      by_grade: byGrade,
      by_subject: bySubject,
      totals: fin.totals,
    },
  });
});

// ===== 归档固化 =====
// 财务审核通过后，把区间数据固化成快照。之后重新生成上课记录/改课表/改单价都不影响已归档月份。

// 列出归档快照
router.get('/snapshots', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.from_date, s.to_date, s.term, s.label, s.created_at, u.name AS created_by_name
    FROM payroll_snapshots s
    LEFT JOIN users u ON u.id = s.created_by
    ORDER BY s.id DESC`).all();
  return res.json({ ok: true, data: rows });
});

// 读取某归档快照详情（还原当时的 teachers/totals，供复核）
router.get('/snapshots/:id', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM payroll_snapshots WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '归档快照不存在' });
  let snap = null;
  try { snap = JSON.parse(row.snapshot); } catch { /* 快照损坏 */ }
  return res.json({ ok: true, data: { id: row.id, from_date: row.from_date, to_date: row.to_date, term: row.term, label: row.label, created_at: row.created_at, snapshot: snap } });
});

// 固化快照。body 可选 label；term 与区间来自查询参数（与导出/对账同口径）。
router.post('/snapshots', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { from_date, to_date, term } = req.query;
  const { label } = req.body || {};
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term);
  const fin = buildFinancial(rows, ctx);
  const round2 = (v) => Math.round((v || 0) * 100) / 100;

  const snapshot = {
    from_date, to_date, term: term || null,
    checked_at: localDateTime(),
    checked_by: req.user?.name || req.user?.username || null,
    teachers: fin.teachers.map((e) => ({
      teacher_id: e.teacher_id, teacher_name: e.teacher_name,
      core_count: e.core_count, core_weighted: round2(e.core_weighted),
      coefCounts: Object.fromEntries(fin.coefColumns.map((t) => [t, e.coefCounts[t] || 0])),
      coefWeighted: Object.fromEntries(fin.coefColumns.map((t) => [t, round2(e.coefWeighted[t])])),
      typePays: Object.fromEntries(fin.typeColumns.map((t) => [t, round2(e.typePays[t])])),
      termPays: Object.fromEntries(fin.termColumns.map((t) => [t, round2(e.termPays[t])])),
      weighted_total: round2(e.weighted_total), pay_total: round2(e.pay_total),
    })),
    totals: {
      pay_total: round2(fin.totals.pay_total),
      weighted_total: round2(fin.totals.weighted_total),
      typePays: Object.fromEntries(fin.typeColumns.map((t) => [t, round2(fin.totals.typePays[t])])),
      termPays: Object.fromEntries(fin.termColumns.map((t) => [t, round2(fin.totals.termPays[t])])),
    },
    coefColumns: fin.coefColumns,
    typeColumns: fin.typeColumns,
    termColumns: fin.termColumns,
  };

  const info = db.prepare('INSERT INTO payroll_snapshots (from_date, to_date, term, label, snapshot, created_by) VALUES (?,?,?,?,?,?)')
    .run(from_date, to_date, term || null, label ?? null, JSON.stringify(snapshot), req.user?.id ?? null);
  logAudit(req.user.id, 'archive_payroll', `payroll_snapshots:${info.lastInsertRowid}`, `固化课酬快照 ${from_date}~${to_date}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid), pay_total: snapshot.totals.pay_total } });
});

// 导出「财务审核包」：单文件多 sheet（汇总 + 明细 + 勾稽校验 + 口径说明）。
// 供 MCP/WorkBuddy 一键出包，也供前端「导出财务审核包」按钮直接下载。
router.get('/financial-pack', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id);
  const fin = buildFinancial(rows, ctx);
  const allRows = queryRows(from_date, to_date, term, teacher_id, true);
  const round2 = (v) => Math.round((v || 0) * 100) / 100;

  const wb = XLSX.utils.book_new();

  // Sheet1 财务汇总表（复用 L1 结构）
  const header = [
    '序号', '教师姓名',
    '正课节数', '正课折算课时(不计钱)',
    ...fin.coefColumns.flatMap((t) => [`${t}节数`, `${t}折算课时(不计钱)`]),
    ...fin.typeColumns.flatMap((t) => [`${t}节数`, `${t}金额(元)`]),
    ...fin.termColumns.flatMap((t) => [`${t}节数`, `${t}金额(元)`]),
    '折算课时合计', '课酬合计(元)', '备注',
  ];
  const aoa = [header];
  fin.teachers.forEach((e, i) => {
    aoa.push([
      i + 1, e.teacher_name,
      e.core_count, round2(e.core_weighted),
      ...fin.coefColumns.flatMap((t) => [e.coefCounts[t] || 0, round2(e.coefWeighted[t])]),
      ...fin.typeColumns.flatMap((t) => [e.typeCounts[t] || 0, round2(e.typePays[t])]),
      ...fin.termColumns.flatMap((t) => [e.termCounts[t] || 0, round2(e.termPays[t])]),
      round2(e.weighted_total), round2(e.pay_total), '',
    ]);
  });
  aoa.push([
    '合计', '',
    fin.totals.core_count, round2(fin.totals.core_weighted),
    ...fin.coefColumns.flatMap((t) => [fin.totals.coefCounts[t] || 0, round2(fin.totals.coefWeighted[t])]),
    ...fin.typeColumns.flatMap((t) => [fin.totals.typeCounts[t] || 0, round2(fin.totals.typePays[t])]),
    ...fin.termColumns.flatMap((t) => [fin.totals.termCounts[t] || 0, round2(fin.totals.termPays[t])]),
    round2(fin.totals.weighted_total), round2(fin.totals.pay_total), '',
  ]);
  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  ws1['!cols'] = header.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  XLSX.utils.book_append_sheet(wb, ws1, '财务汇总表');

  // Sheet2 课酬明细（每节一行，含停课/代课全貌）
  const srcLabel = { schedule: '课表', adjust: '代课/调课', extra: '加课', qna: '申报' };
  const detailHeader = ['日期', '教师', '班级', '学科', '节次', '类型', '时段', '来源', '原教师', '状态', '折算课时', '课酬(元)'];
  const detailAoa = [detailHeader];
  for (const r of allRows) {
    const { weighted, pay } = r.cancelled ? { weighted: 0, pay: 0 } : computePay(ctx, { ...r, count: 1 });
    detailAoa.push([
      r.date, r.teacher_name, r.class_name, r.subject ?? '', r.period_no, r.period_type, r.term,
      srcLabel[r.source] || r.source, (r.source === 'adjust' ? r.parent_teacher_name : '') || '',
      r.cancelled ? '已停课' : '', round2(weighted), round2(pay),
    ]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(detailAoa);
  ws2['!cols'] = detailHeader.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  XLSX.utils.book_append_sheet(wb, ws2, '课酬明细');

  // Sheet3 勾稽校验（金额勾稽 + 交叉汇总）
  let detailPay = 0;
  for (const r of allRows) if (!r.cancelled) detailPay += computePay(ctx, { ...r, count: 1 }).pay;
  detailPay = round2(detailPay);
  const byGrade = {};
  const bySubject = {};
  for (const r of allRows) {
    if (r.cancelled) continue;
    const { pay } = computePay(ctx, { ...r, count: 1 });
    if (!pay) continue;
    byGrade[r.class_grade || '未分年级'] = round2((byGrade[r.class_grade || '未分年级'] || 0) + pay);
    bySubject[r.subject || '未填学科'] = round2((bySubject[r.subject || '未填学科'] || 0) + pay);
  }
  const checkAoa = [
    ['财务勾稽校验报告'],
    [],
    ['一、金额勾稽'],
    ['明细逐条课酬之和(元)', detailPay],
    ['汇总表课酬合计(元)', round2(fin.totals.pay_total)],
    ['勾稽结果', detailPay === round2(fin.totals.pay_total) ? '✓ 一致' : '✗ 不一致，请核查'],
    [],
    ['二、按课酬类型金额小计'],
    ...fin.typeColumns.map((t) => [`按次计酬·${t}(元)`, round2(fin.totals.typePays[t])]),
    ...fin.termColumns.map((t) => [`时段·${t}(元)`, round2(fin.totals.termPays[t])]),
    [],
    ['三、按年级金额小计'],
    ...Object.entries(byGrade).map(([k, v]) => [k, v]),
    [],
    ['四、按学科金额小计'],
    ...Object.entries(bySubject).map(([k, v]) => [k, v]),
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(checkAoa);
  ws3['!cols'] = [{ wch: 36 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws3, '勾稽校验');

  // Sheet4 口径说明
  const notes = [
    ['课酬财务审核包 —— 统计口径说明'],
    [],
    [`统计区间：${from_date} ~ ${to_date}${term ? '（时段：' + term + '）' : ''}`],
    [`生成时间：${localDateTime()}`],
    [`生成人：${req.user?.name || req.user?.username || '-'}`],
    [],
    ['一、课酬（钱）口径'],
    ['· 课酬合计 = 按次计酬类型金额 + 非规时段金额。'],
    ['· 常规正课、折算类型（早自习等）只出「折算课时」，不计钱（供教学业绩考核用）。'],
    [],
    ['二、按次计酬类型（元 = 单价 × 节数）'],
    ...fin.typeColumns.map((t) => [`· ${t}：${ctx.periodTypePays.get(t) ?? 0} 元/节`]),
    ...fin.typeColumns.flatMap((t) => {
      const gp = ctx.periodTypeGradePays.get(t);
      return gp && gp.size ? [[`· ${t} 分年级：` + [...gp.entries()].map(([g, p]) => `${g}${p}元`).join('，')]] : [];
    }),
    [],
    ['三、非规时段课酬（元 = 节数 × 教师课酬标准）'],
    ['· 各教师课酬标准见「教师信息」模块（按时段分档）。'],
    ['· 时段：' + fin.termColumns.join(' / ')],
    [],
    ['四、折算课时系数（仅正课/折算类型，不计钱）'],
    [`· 正课折算 = 节数 ×（学科系数 + 班额系数）。`],
    ...fin.coefColumns.map((t) => [`· ${t}折算 = 节数 × 折算系数(${ctx.periodTypeCoefs.get(t) ?? 0.5})。`]),
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(notes);
  ws4['!cols'] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, ws4, '口径说明');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`课酬财务审核包_${from_date}_${to_date}.xlsx`)}`);
  res.send(buf);
});

export default router;
