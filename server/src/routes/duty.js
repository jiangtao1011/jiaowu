import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, DIRECTOR_ROLES, CLERK_ROLES } from '../auth.js';
import { visibleTeacherIds } from '../scope.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';
import { createDraft, getDraft, deleteDraft } from '../import-stage.js';

const router = Router();
router.use(authRequired);

// 内存存储：批量导入直接解析
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 值日：独立类型（不走 period_type_pays/coefs，金额由档位固定，计酬走 manual_pay）
const DUTY_TYPE = '值日';
const DEFAULT_DUTY_TIERS = [60, 65, 120, 130, 200, 300];

// 可安排值日的角色：录入维护（admin/教务主任/教务员）+ 年级组长
const DUTY_ARRANGE_ROLES = [...CLERK_ROLES, '年级组长'];
// 可审核日报的角色：admin + 教务主任（终审）+ 年级组长（一审）
const DUTY_REVIEW_ROLES = ['admin', '教务主任', '年级组长'];

// 读取值日档位金额数组（app_settings key=duty_pay_tiers，与 applications.js 共用同一配置）
function dutyPayTiers() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'duty_pay_tiers'").get();
  if (!row?.value) return [...DEFAULT_DUTY_TIERS];
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [...DEFAULT_DUTY_TIERS];
  } catch { return [...DEFAULT_DUTY_TIERS]; }
}

// 年级虚班 id（值日计酬挂年级虚班）
function virtualClassIdForGrade(grade) {
  if (!grade) return null;
  return db.prepare('SELECT id FROM classes WHERE is_virtual = 1 AND grade = ?').get(grade)?.id ?? null;
}

// 磁盘附件存储（日报截图），复用 applications.js 的模式
const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const uploadAttachment = multer({ storage: attachmentStorage, limits: { fileSize: 20 * 1024 * 1024 } });

function decodeName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 日期 + N 天
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function dayOfWeekOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

// 是否可安排值日
function canArrange(user) {
  return DUTY_ARRANGE_ROLES.includes(user.role);
}
// 是否可审核日报
function canReview(user) {
  return DUTY_REVIEW_ROLES.includes(user.role);
}

// ===== 排班列表 =====
// 管理员/组长看全部；教师只看自己。可按日期范围、教师过滤。
router.get('/assignments', (req, res) => {
  const { from, to, teacher_id } = req.query;
  const scope = visibleTeacherIds(req.user);
  let sql = `
    SELECT a.*, t.name AS teacher_name, t.subject AS teacher_subject,
           r.id AS report_id, r.status AS report_status, r.content AS report_content
    FROM duty_assignments a
    JOIN teachers t ON t.id = a.teacher_id
    LEFT JOIN duty_reports r ON r.assignment_id = a.id
    WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND a.duty_date >= ?'; params.push(from); }
  if (to) { sql += ' AND a.duty_date <= ?'; params.push(to); }
  if (teacher_id) { sql += ' AND a.teacher_id = ?'; params.push(Number(teacher_id)); }
  if (scope) {
    const ph = scope.map(() => '?').join(',');
    sql += ` AND a.teacher_id IN (${ph})`;
    params.push(...scope);
  }
  sql += ' ORDER BY a.duty_date, a.teacher_id, a.id';
  return res.json({ ok: true, data: db.prepare(sql).all(...params) });
});

// ===== 安排值日 =====
// 临时单次：duty_date 必填，day_of_week 为空。
// 固定排班：day_of_week + from + to，区间内每个匹配星期几展开成多条。
router.post('/assignments', roleRequired(...DUTY_ARRANGE_ROLES), (req, res) => {
  const { teacher_id, grade, duty_date, day_of_week, from, to, pay_amount, note } = req.body || {};
  const tid = Number(teacher_id);
  const pay = Number(pay_amount);
  if (!Number.isInteger(tid) || tid <= 0) return res.status(400).json({ ok: false, error: '请选择值日教师' });
  if (!db.prepare('SELECT id FROM teachers WHERE id = ?').get(tid)) return res.status(400).json({ ok: false, error: '教师不存在' });
  if (!Number.isFinite(pay) || !dutyPayTiers().includes(pay)) return res.status(400).json({ ok: false, error: '值日档位金额无效' });

  // 生成具体日期列表
  let dates = [];
  if (duty_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(duty_date)) return res.status(400).json({ ok: false, error: '值日日期格式应为 YYYY-MM-DD' });
    dates = [duty_date];
  } else if (day_of_week && from && to) {
    const dow = Number(day_of_week);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7) return res.status(400).json({ ok: false, error: '星期应为 1-7' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ ok: false, error: '起止日期格式应为 YYYY-MM-DD' });
    if (from > to) return res.status(400).json({ ok: false, error: '开始日期不能晚于结束日期' });
    let cur = from;
    while (cur <= to) {
      if (dayOfWeekOf(cur) === dow) dates.push(cur);
      cur = addDays(cur, 1);
    }
    if (!dates.length) return res.status(400).json({ ok: false, error: '该区间内没有匹配的星期' });
  } else {
    return res.status(400).json({ ok: false, error: '临时值日请填日期；固定排班请填星期 + 起止日期' });
  }

  const ins = db.prepare(`
    INSERT INTO duty_assignments (teacher_id, grade, duty_date, pay_amount, note, created_by)
    VALUES (?,?,?,?,?,?)`);
  let inserted = 0;
  for (const d of dates) {
    // 防重复：同教师同日期已存在未删除的排班则跳过
    const dup = db.prepare('SELECT id FROM duty_assignments WHERE teacher_id = ? AND duty_date = ?').get(tid, d);
    if (dup) continue;
    ins.run(tid, grade || null, d, pay, note || null, req.user.id);
    inserted++;
  }
  logAudit(req.user.id, 'arrange_duty', 'duty_assignments', `安排值日 ${dates.length} 天，写入 ${inserted} 条`);
  return res.json({ ok: true, data: { inserted, total: dates.length } });
});

// ===== 值日临时排班批量导入（两阶段 preview/confirm） =====

// 解析单行 → { ok, record } 或 { ok:false, reason }
function buildDutyImportRecord(row, teacherByName) {
  const teacherName = String(keyOf(row, '教师', '老师', 'teacher') ?? '').trim();
  const dateRaw = String(keyOf(row, '日期', '值日日期', 'duty_date', 'date') ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null;
  const grade = String(keyOf(row, '年级', 'grade') ?? '').trim() || null;
  const payRaw = Number(keyOf(row, '档位金额', '金额', 'pay_amount', 'pay') ?? '');
  const note = String(keyOf(row, '备注', '内容', 'note') ?? '').trim() || null;

  if (!teacherName) return { ok: false, reason: '缺少教师姓名' };
  const teacherId = teacherByName[teacherName];
  if (!teacherId) return { ok: false, reason: `教师「${teacherName}」不存在` };
  if (!date) return { ok: false, reason: '日期格式应为 YYYY-MM-DD' };
  if (!Number.isFinite(payRaw) || !dutyPayTiers().includes(payRaw)) return { ok: false, reason: `档位金额无效（可选：${dutyPayTiers().join('、')}）` };
  return { ok: true, record: { teacher_id: teacherId, grade, duty_date: date, pay_amount: payRaw, note } };
}

// 下载值日导入模板
router.get('/assignments/import-template', roleRequired(...DUTY_ARRANGE_ROLES), (req, res) => {
  downloadTemplate(
    res,
    ['教师', '日期', '年级', '档位金额', '备注'],
    [['张三', '2026-12-01', '高一', '120', '值日看班']],
    '值日排班导入模板.xlsx',
    [{ name: '填写说明', rows: [['值日临时排班批量导入说明：'], ['· 教师：教师姓名（须已录入系统）。'], ['· 日期：YYYY-MM-DD 格式。'], ['· 年级：可选，用于挂年级虚班计酬。'], [`· 档位金额：可选 ${dutyPayTiers().join('、')} 元。`], ['· 备注：可选。']] }]
  );
});

// 预览：解析 + 校验 + 暂存草稿
router.post('/assignments/import/preview', roleRequired(...DUTY_ARRANGE_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传值日排班文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const teachers = db.prepare('SELECT id, name FROM teachers').all();
  const teacherByName = Object.fromEntries(teachers.map((t) => [t.name, t.id]));
  const columns = ['教师', '日期', '年级', '档位金额', '备注'];
  const draftRows = [];
  const summary = { total: rows.length, ok: 0, duplicate: 0, error: 0 };

  for (let i = 0; i < rows.length; i++) {
    const r = buildDutyImportRecord(rows[i], teacherByName);
    const cells = columns.map((c) => String(keyOf(rows[i], c) ?? ''));
    if (r.ok) {
      // 重复：同教师同日期已存在排班
      const dup = db.prepare('SELECT id FROM duty_assignments WHERE teacher_id = ? AND duty_date = ?').get(r.record.teacher_id, r.record.duty_date);
      if (dup) {
        summary.duplicate++;
        draftRows.push({ row_id: i, line: i + 2, cells, status: 'duplicate', reason: '该教师该日期已有排班', record: null });
      } else {
        summary.ok++;
        draftRows.push({ row_id: i, line: i + 2, cells, status: 'ok', reason: null, record: r.record });
      }
    } else {
      summary.error++;
      draftRows.push({ row_id: i, line: i + 2, cells, status: 'error', reason: r.reason, record: null });
    }
  }

  const token = createDraft('duty', req.user.id, { rows: draftRows });
  return res.json({ ok: true, data: { token, rows: draftRows.map(({ record, ...r }) => r), summary } });
});

// 确认入库
router.post('/assignments/import/confirm', roleRequired(...DUTY_ARRANGE_ROLES), (req, res) => {
  const { token, row_ids } = req.body || {};
  const draft = getDraft(token, req.user.id, 'duty');
  if (!draft) return res.status(400).json({ ok: false, error: '预览已失效，请重新上传' });

  const selected = new Set(Array.isArray(row_ids) ? row_ids.map(Number) : []);
  let inserted = 0;
  const errors = [];
  const ins = db.prepare('INSERT INTO duty_assignments (teacher_id, grade, duty_date, pay_amount, note, created_by) VALUES (?,?,?,?,?,?)');

  for (const r of draft.payload.rows) {
    if (r.status !== 'ok' || !selected.has(r.row_id)) continue;
    const rec = r.record;
    // 二次防重复（预览后可能已有新排班）
    const dup = db.prepare('SELECT id FROM duty_assignments WHERE teacher_id = ? AND duty_date = ?').get(rec.teacher_id, rec.duty_date);
    if (dup) { errors.push(`第 ${r.line} 行：该教师该日期已有排班`); continue; }
    ins.run(rec.teacher_id, rec.grade, rec.duty_date, rec.pay_amount, rec.note, req.user.id);
    inserted++;
  }

  deleteDraft(token);
  logAudit(req.user.id, 'import_duty', 'duty_assignments', `批量导入值日排班 ${inserted} 条`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// ===== 删除排班（未交日报的） =====
router.delete('/assignments/:id', roleRequired(...DUTY_ARRANGE_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM duty_assignments WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ ok: false, error: '排班不存在' });
  const report = db.prepare('SELECT id FROM duty_reports WHERE assignment_id = ?').get(id);
  if (report) return res.status(400).json({ ok: false, error: '该排班已交日报，不能删除' });
  db.prepare('DELETE FROM duty_assignments WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_duty_assignment', `duty_assignments:${id}`, `删除值日排班 ${a.duty_date}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// ===== 我的值日（值日老师视角） =====
router.get('/my-duties', (req, res) => {
  const tid = req.user.teacher_id ?? null;
  if (!tid) return res.json({ ok: true, data: [] });
  const rows = db.prepare(`
    SELECT a.id, a.teacher_id, a.grade, a.duty_date, a.note,
           r.id AS report_id, r.status AS report_status, r.content AS report_content
    FROM duty_assignments a
    LEFT JOIN duty_reports r ON r.assignment_id = a.id
    WHERE a.teacher_id = ?
    ORDER BY a.duty_date DESC`).all(tid);
  return res.json({ ok: true, data: rows });
});

// ===== 提交日报（值日老师本人，含截图） =====
router.post('/reports', uploadAttachment.array('attachments', 9), (req, res) => {
  const { assignment_id, content } = req.body || {};
  const aid = Number(assignment_id);
  const a = db.prepare('SELECT * FROM duty_assignments WHERE id = ?').get(aid);
  if (!a) return res.status(404).json({ ok: false, error: '值日排班不存在' });
  const tid = req.user.teacher_id ?? null;
  if (!tid || a.teacher_id !== tid) return res.status(403).json({ ok: false, error: '只能提交自己的值日日报' });
  // 已交日报（任意非 rejected 状态）防重复
  const dup = db.prepare("SELECT id FROM duty_reports WHERE assignment_id = ? AND status != 'rejected'").get(aid);
  if (dup) return res.status(400).json({ ok: false, error: '该值日已提交日报，请勿重复提交' });
  // 截图必填（至少一张）
  if (!req.files || req.files.length === 0) return res.status(400).json({ ok: false, error: '请上传日报截图' });

  const info = db.prepare(`
    INSERT INTO duty_reports (assignment_id, teacher_id, duty_date, content, status, filled_by)
    VALUES (?,?,?,?, 'pending', ?)`)
    .run(aid, a.teacher_id, a.duty_date, content || null, req.user.id);
  const reportId = Number(info.lastInsertRowid);

  const insAtt = db.prepare('INSERT INTO duty_report_attachments (report_id, filename, stored_path, size) VALUES (?,?,?,?)');
  for (const f of req.files) {
    insAtt.run(reportId, decodeName(f.originalname), f.filename, f.size || 0);
  }
  logAudit(req.user.id, 'submit_duty_report', `duty_reports:${reportId}`, `提交值日日报 ${a.duty_date}，${req.files.length} 张截图`);
  return res.json({ ok: true, data: { id: reportId } });
});

// ===== 日报列表（审核视角） =====
router.get('/reports', (req, res) => {
  const { status } = req.query;
  const scope = visibleTeacherIds(req.user);
  let sql = `
    SELECT r.*, t.name AS teacher_name, a.grade, a.pay_amount,
           gru.name AS grade_reviewed_by_name, ru.name AS reviewed_by_name
    FROM duty_reports r
    JOIN teachers t ON t.id = r.teacher_id
    JOIN duty_assignments a ON a.id = r.assignment_id
    LEFT JOIN users gru ON gru.id = r.grade_reviewed_by
    LEFT JOIN users ru ON ru.id = r.reviewed_by
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (scope) {
    const ph = scope.map(() => '?').join(',');
    sql += ` AND r.teacher_id IN (${ph})`;
    params.push(...scope);
  }
  sql += ' ORDER BY r.duty_date DESC, r.id DESC';
  const rows = db.prepare(sql).all(...params);
  const attStmt = db.prepare('SELECT id, filename, size FROM duty_report_attachments WHERE report_id = ?');
  return res.json({ ok: true, data: rows.map((r) => ({ ...r, attachments: attStmt.all(r.id) })) });
});

// ===== 日报两级审批 =====
// 年级组长：一审 pending → grade_approved / rejected（限本年级）
// 教务主任/admin：终审 pending 或 grade_approved → approved（计酬）/ rejected
router.patch('/reports/:id/review', roleRequired(...DUTY_REVIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM duty_reports WHERE id = ?').get(id);
  if (!r) return res.status(404).json({ ok: false, error: '日报不存在' });
  const { approved } = req.body || {};
  const user = req.user;
  const isGradeLeader = user.role === '年级组长';
  const isDirector = DIRECTOR_ROLES.includes(user.role);

  if (isGradeLeader) {
    // 年级组长一审：限本年级
    const scope = visibleTeacherIds(user);
    if (scope && !scope.includes(r.teacher_id)) return res.status(403).json({ ok: false, error: '只能审核本年级的值日日报' });
    if (r.status !== 'pending') return res.status(400).json({ ok: false, error: '该日报已审核' });
    if (approved) {
      db.prepare("UPDATE duty_reports SET status = 'grade_approved', grade_reviewed_by = ?, grade_reviewed_at = datetime('now','localtime') WHERE id = ?").run(user.id, id);
    } else {
      db.prepare("UPDATE duty_reports SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?").run(user.id, id);
    }
    logAudit(user.id, 'grade_review_duty', `duty_reports:${id}`, `年级组长一审 ${approved ? 'grade_approved' : 'rejected'}`);
    return res.json({ ok: true, data: { id, status: approved ? 'grade_approved' : 'rejected' } });
  }

  // 教务主任/admin 终审
  if (!isDirector) return res.status(403).json({ ok: false, error: '无审核权限' });
  if (r.status !== 'pending' && r.status !== 'grade_approved') return res.status(400).json({ ok: false, error: '该日报已审核' });
  const status = approved ? 'approved' : 'rejected';
  db.prepare("UPDATE duty_reports SET status = ?, reviewed_by = ?, reviewed_at = datetime('now','localtime') WHERE id = ?").run(status, user.id, id);

  // 通过后计酬：生成 lesson_instances（source='duty'，manual_pay=档位金额，computePay 手工金额分支计酬）
  let created = 0;
  if (approved) {
    const a = db.prepare('SELECT * FROM duty_assignments WHERE id = ?').get(r.assignment_id);
    const classId = virtualClassIdForGrade(a?.grade || null);
    if (classId && Number(a.pay_amount) > 0) {
      db.prepare(`
        INSERT INTO lesson_instances (class_id, teacher_id, subject, date, period_no, period_type, term, source, source_id, note, unit_count, manual_pay)
        VALUES (?,?,?,?,0,?, '常规', 'duty', ?, ?, 1, ?)`)
        .run(classId, r.teacher_id, '值日', r.duty_date, DUTY_TYPE, r.id, r.content ?? null, Number(a.pay_amount));
      created = 1;
    }
  }
  logAudit(user.id, 'review_duty_report', `duty_reports:${id}`, `课程中心终审 ${status}${created ? '，生成计酬记录 1 条' : ''}`);
  return res.json({ ok: true, data: { id, status, created_instances: created } });
});

// ===== 日报截图下载 =====
router.get('/attachments/:attId/download', (req, res) => {
  const att = db.prepare('SELECT * FROM duty_report_attachments WHERE id = ?').get(Number(req.params.attId));
  if (!att) return res.status(404).json({ ok: false, error: '附件不存在' });
  res.download(path.join(UPLOAD_DIR, att.stored_path), att.filename);
});

// ===== 值日档位配置（读取，供桌面端安排时选档位） =====
router.get('/tiers', (req, res) => res.json({ ok: true, data: { tiers: dutyPayTiers() } }));

export default router;
