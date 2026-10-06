import { Router } from 'express';
import * as XLSX from 'xlsx';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES } from '../auth.js';
import { loadContext, computePay } from '../context.js';
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
router.put('/calendar', roleRequired(...ADMIN_ROLES), (req, res) => {
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
router.delete('/calendar/:date', roleRequired(...ADMIN_ROLES), (req, res) => {
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

router.post('/generate', roleRequired(...ADMIN_ROLES), (req, res) => {
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
  for (const s of formalSchedules) {
    const grade = classGrade.get(s.class_id);
    for (const date of allDates) {
      if (makeupActive.has(`${date}|${grade ?? ''}`)) continue;
      const r = resolveDay(cal, date, grade);
      if (r.action === 'skip') continue;
      if (r.dow !== s.day_of_week) continue;
      if (!activeOn(s, date)) continue;
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
router.post('/instances', roleRequired(...ADMIN_ROLES), (req, res) => {
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
router.delete('/instance/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM lesson_instances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '上课记录不存在' });
  db.prepare('DELETE FROM lesson_instances WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_instance', `lesson_instances:${id}`, `删除上课记录 ${r.date}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// 单日代课/停课
router.post('/instance/:id/adjust', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM lesson_instances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '上课记录不存在' });
  const { change_type, to_teacher_id, note } = req.body || {};

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
router.post('/instance/:id/restore', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM lesson_instances WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '上课记录不存在' });
  db.prepare('UPDATE lesson_instances SET cancelled = 0, note = NULL WHERE id = ?').run(id);
  logAudit(req.user.id, 'restore_instance', `lesson_instances:${id}`, `恢复上课记录 ${r.date}`);
  return res.json({ ok: true, data: { id, cancelled: false } });
});

// ===== 按日统计 =====

// 取区间内未取消的上课记录（含教师名与课酬标准），可按 term / teacher_id 过滤
function queryRows(from_date, to_date, term, teacher_id) {
  let sql = `
    SELECT li.*, t.name AS teacher_name, t.pay_standard, c.name AS class_name
    FROM lesson_instances li
    JOIN teachers t ON t.id = li.teacher_id
    JOIN classes c ON c.id = li.class_id
    WHERE li.cancelled = 0 AND li.date >= ? AND li.date <= ?`;
  const params = [from_date, to_date];
  if (term) { sql += ' AND li.term = ?'; params.push(term); }
  if (teacher_id) { sql += ' AND li.teacher_id = ?'; params.push(Number(teacher_id)); }
  sql += ' ORDER BY li.teacher_id, li.date, li.period_no';
  return db.prepare(sql).all(...params);
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
    e[r.period_type] = (e[r.period_type] || 0) + 1;
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
  // 汇总表列：折算型（早自习、正课）+ 按次计酬类型字典里的所有类型
  const types = ['早自习', '正课', ...[...ctx.periodTypePays.keys()]];
  return res.json({ ok: true, data, types });
});

// ===== 按次计酬类型字典 =====

// 列出类型字典（名称 + 固定课酬单价）
router.get('/type-pays', (req, res) => {
  const rows = db.prepare('SELECT id, name, pay FROM period_type_pays ORDER BY id').all();
  return res.json({ ok: true, data: rows });
});

// 批量保存类型字典（按 id 更新，无 id 新增；name 为空则跳过）
router.put('/type-pays', roleRequired(...ADMIN_ROLES), (req, res) => {
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
router.delete('/type-pays/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
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
  logAudit(req.user.id, 'delete_type_pay', `period_type_pays:${id}`, `删除按次计酬类型 ${row.name}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// 导出课酬明细（Excel）：每节课一行，含折算课时与课酬
router.get('/export', roleRequired(...ADMIN_ROLES), (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id);

  const headers = ['日期', '教师', '班级', '学科', '节次', '类型', '时段', '折算课时', '课酬(元)'];
  const aoa = [headers];
  for (const r of rows) {
    const { weighted, pay } = computePay(ctx, { ...r, count: 1 });
    aoa.push([
      r.date,
      r.teacher_name,
      r.class_name,
      r.subject ?? '',
      r.period_no,
      r.period_type,
      r.term,
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

// 导出财务审核汇总表（Excel）：按教师一行汇总（各类别小计、折算课时、课酬总额），带合计行与签字确认栏。
// 供「上交给财务审核」归档使用，与明细表（每节课一行）互补。
router.get('/financial-report', roleRequired(...ADMIN_ROLES), (req, res) => {
  const { from_date, to_date, term, teacher_id } = req.query;
  if (!from_date || !to_date) return res.status(400).json({ ok: false, error: '请提供 from_date 与 to_date' });
  const ctx = loadContext();
  const rows = queryRows(from_date, to_date, term, teacher_id);

  // 汇总列：折算型固定列（早自习、正课）+ 按次计酬字典里的所有类型（晚自习/答疑/晚读/自定义）
  const typeColumns = ['早自习', '正课', ...[...ctx.periodTypePays.keys()]];

  // 按教师分组：各类型节数、折算课时、课酬
  const map = new Map();
  for (const r of rows) {
    const { weighted, pay } = computePay(ctx, { ...r, count: 1 });
    if (!map.has(r.teacher_id)) {
      const e = { teacher_id: r.teacher_id, teacher_name: r.teacher_name, counts: {}, total: 0, weighted_total: 0, pay_total: 0 };
      for (const t of typeColumns) e.counts[t] = 0;
      map.set(r.teacher_id, e);
    }
    const e = map.get(r.teacher_id);
    if (e.counts[r.period_type] == null) e.counts[r.period_type] = 0;
    e.counts[r.period_type] += 1;
    e.total += 1;
    e.weighted_total += weighted;
    e.pay_total += pay;
  }

  const data = [...map.values()].sort((a, b) => a.teacher_name.localeCompare(b.teacher_name, 'zh'));

  const header = ['序号', '教师姓名', ...typeColumns, '原始课时', '折算课时', '课酬（元）', '备注'];
  const aoa = [header];
  data.forEach((e, i) => {
    aoa.push([
      i + 1,
      e.teacher_name,
      ...typeColumns.map((t) => e.counts[t] || 0),
      e.total,
      Math.round(e.weighted_total * 100) / 100,
      Math.round(e.pay_total * 100) / 100,
      '',
    ]);
  });

  // 合计行
  const sumCount = (t) => data.reduce((s, e) => s + (e.counts[t] || 0), 0);
  const totalLessons = data.reduce((s, e) => s + e.total, 0);
  const totalWeighted = data.reduce((s, e) => s + e.weighted_total, 0);
  const totalPay = data.reduce((s, e) => s + e.pay_total, 0);
  aoa.push([
    '合计', '', ...typeColumns.map(sumCount), totalLessons,
    Math.round(totalWeighted * 100) / 100, Math.round(totalPay * 100) / 100, '',
  ]);

  // 签字确认栏（财务审核归档用）
  aoa.push([]);
  aoa.push([`统计区间：${from_date} ~ ${to_date}${term ? '（时段：' + term + '）' : ''}`]);
  aoa.push([]);
  aoa.push(['制表人（教务员）：', '', '审核人（教务处）：', '', '财务复核：', '']);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = header.map((h) => ({ wch: Math.max(8, String(h).length * 2 + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '财务汇总表');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`课酬财务汇总表_${from_date}_${to_date}.xlsx`)}`);
  res.send(buf);
});

export default router;
