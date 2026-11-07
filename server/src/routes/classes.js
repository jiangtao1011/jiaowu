import { Router } from 'express';
import multer from 'multer';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, CLERK_ROLES } from '../auth.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';
import { createDraft, getDraft, deleteDraft } from '../import-stage.js';

const router = Router();
router.use(authRequired);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const CLASS_TYPES = ['行政班', '分层', '走班'];

// 计算一个班的「统计班额」：走班默认=合班成员班额之和，若手动填了人数则以手动值为准；其余=自身班额
function effectiveSize(cls) {
  if (cls.type === '走班') {
    if (cls.student_count > 0) return cls.student_count;
    const members = db.prepare('SELECT c.student_count FROM class_members cm JOIN classes c ON c.id = cm.member_class_id WHERE cm.class_id = ?').all(cls.id);
    return members.reduce((s, m) => s + (m.student_count || 0), 0);
  }
  return cls.student_count || 0;
}

// 同步走班合班成员
function syncMembers(classId, memberIds) {
  db.prepare('DELETE FROM class_members WHERE class_id = ?').run(classId);
  if (Array.isArray(memberIds)) {
    const ins = db.prepare('INSERT INTO class_members (class_id, member_class_id) VALUES (?,?)');
    for (const mid of memberIds) {
      const m = Number(mid);
      if (Number.isInteger(m)) ins.run(classId, m);
    }
  }
}

router.get('/', (req, res) => {
  const classes = db.prepare('SELECT * FROM classes ORDER BY grade, type, name').all();
  const rows = classes.map((c) => {
    const members = db
      .prepare('SELECT c.id, c.name FROM class_members cm JOIN classes c ON c.id = cm.member_class_id WHERE cm.class_id = ? ORDER BY c.name')
      .all(c.id);
    const children = db
      .prepare('SELECT id, name, type, student_count, subject FROM classes WHERE parent_id = ? ORDER BY name')
      .all(c.id);
    return { ...c, members, children, effective_size: effectiveSize(c) };
  });
  return res.json({ ok: true, data: rows });
});

// 下载班级导入模板
router.get('/template', (req, res) => {
  downloadTemplate(
    res,
    ['班级名称', '类型', '人数', '年级', '所属班级', '学科'],
    [
      ['高一(1)班', '行政班', '45', '高一', '', ''],
      ['高一(1)班数学A层', '分层', '23', '高一', '高一(1)班', '数学'],
      ['高一政治走班', '走班', '', '高一', '高一(1)班,高一(2)班', '政治'],
      ['高一政治走班A层', '分层', '25', '高一', '高一政治走班', '政治'],
    ],
    '班级导入模板.xlsx'
  );
});

// 解析 + 规划（不写库）：用「现库 + 本文件」的 name→id 模拟表，逐遍 resolve 跨行引用，
// 返回每行的 { status, reason, record }。record 保留引用名，confirm 阶段用真实 id 再 resolve。
function planClasses(rows) {
  const existing = db.prepare('SELECT id, name FROM classes').all();
  const nameToId = new Map(existing.map((c) => [c.name, c.id]));

  // 第一遍解析结构
  const parsed = rows.map((row, i) => {
    const name = String(keyOf(row, '班级名称', '班级', 'name') ?? '').trim();
    const type = String(keyOf(row, '类型', 'type') ?? '行政班').trim() || '行政班';
    const finalType = CLASS_TYPES.includes(type) ? type : '行政班';
    const student_count = Number(keyOf(row, '人数', 'student_count') ?? 0) || 0;
    const grade = String(keyOf(row, '年级', 'grade') ?? '').trim() || null;
    const subject = String(keyOf(row, '学科', 'subject') ?? '').trim() || null;
    const parentName = String(keyOf(row, '所属班级', 'parent', 'parent_id') ?? '').trim();
    return { row_id: i, line: i + 2, name, finalType, student_count, grade, subject, parentName, status: 'ok', reason: null, record: null };
  });

  const mark = (p, status, reason) => { p.status = status; p.reason = reason; };
  const ok = (p, record) => { p.record = record; };

  // 重名检查 + 空名检查（先统一过一遍，三遍插入前的公共校验）
  for (const p of parsed) {
    if (!p.name) { mark(p, 'error', '缺少班级名称'); continue; }
    if (nameToId.has(p.name)) { mark(p, 'duplicate', '已存在'); continue; }
  }

  // 三遍规划（模拟插入，把本文件新增班名加入 nameToId）
  // 第一遍：行政班
  for (const p of parsed) {
    if (p.status !== 'ok' || p.finalType !== '行政班') continue;
    nameToId.set(p.name, -(p.row_id + 1)); // 占位负数 id，标记为本文件新增
    ok(p, { name: p.name, finalType: p.finalType, student_count: p.student_count, grade: p.grade, subject: p.subject, parentName: null, memberNames: [] });
  }
  // 第二遍：走班
  for (const p of parsed) {
    if (p.status !== 'ok' || p.finalType !== '走班') continue;
    const members = (p.parentName || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const missing = members.filter((m) => !nameToId.has(m));
    if (missing.length) { mark(p, 'error', `合班班级「${missing[0]}」不存在`); continue; }
    if (!members.length) { mark(p, 'error', '缺少合班班级'); continue; }
    nameToId.set(p.name, -(p.row_id + 1));
    ok(p, { name: p.name, finalType: p.finalType, student_count: p.student_count, grade: p.grade, subject: p.subject, parentName: null, memberNames: members });
  }
  // 第三遍：分层
  for (const p of parsed) {
    if (p.status !== 'ok' || p.finalType !== '分层') continue;
    if (!p.parentName) { mark(p, 'error', '缺少所属班级'); continue; }
    if (!nameToId.has(p.parentName)) { mark(p, 'error', `所属班级「${p.parentName}」不存在`); continue; }
    nameToId.set(p.name, -(p.row_id + 1));
    ok(p, { name: p.name, finalType: p.finalType, student_count: p.student_count, grade: p.grade, subject: p.subject, parentName: p.parentName, memberNames: [] });
  }

  return parsed;
}

// 写库（confirm 阶段三遍，用真实 id resolve 跨行引用）
function commitClasses(draftRows) {
  const insert = db.prepare('INSERT INTO classes (name, type, student_count, grade, parent_id, subject) VALUES (?,?,?,?,?,?)');
  const insMember = db.prepare('INSERT INTO class_members (class_id, member_class_id) VALUES (?,?)');
  const nameToId = new Map(db.prepare('SELECT id, name FROM classes').all().map((c) => [c.name, c.id]));

  const stats = { inserted: 0, errors: [] };

  const commitOne = (r) => {
    // 防御：重名再次检查
    if (nameToId.has(r.record.name)) { stats.errors.push(`第 ${r.line} 行「${r.record.name}」已存在`); return; }
    const info = insert.run(r.record.name, r.record.finalType, r.record.student_count, r.record.grade, null, r.record.subject);
    const newId = Number(info.lastInsertRowid);
    nameToId.set(r.record.name, newId);
    stats.inserted++;
    return newId;
  };

  // 第一遍：行政班
  for (const r of draftRows) if (r.record.finalType === '行政班') commitOne(r);
  // 第二遍：走班（此时行政班已插入，memberIds 用真实 id）
  for (const r of draftRows) {
    if (r.record.finalType !== '走班') continue;
    if (nameToId.has(r.record.name)) { stats.errors.push(`第 ${r.line} 行「${r.record.name}」已存在`); continue; }
    const memberIds = [];
    let bad = false;
    for (const m of r.record.memberNames) {
      const mid = nameToId.get(m);
      if (!mid) { stats.errors.push(`第 ${r.line} 行合班班级「${m}」不存在`); bad = true; break; }
      memberIds.push(mid);
    }
    if (bad) continue;
    const newId = commitOne(r);
    if (newId) for (const mid of memberIds) insMember.run(newId, mid);
  }
  // 第三遍：分层
  for (const r of draftRows) {
    if (r.record.finalType !== '分层') continue;
    if (nameToId.has(r.record.name)) { stats.errors.push(`第 ${r.line} 行「${r.record.name}」已存在`); continue; }
    const pid = nameToId.get(r.record.parentName);
    if (!pid) { stats.errors.push(`第 ${r.line} 行所属班级「${r.record.parentName}」不存在`); continue; }
    const info = insert.run(r.record.name, '分层', r.record.student_count, r.record.grade, pid, r.record.subject);
    nameToId.set(r.record.name, Number(info.lastInsertRowid));
    stats.inserted++;
  }
  return stats;
}

// 预览
router.post('/import/preview', roleRequired(...CLERK_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传班级文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const parsed = planClasses(rows);
  const columns = ['班级名称', '类型', '人数', '年级', '所属班级', '学科'];
  const draftRows = parsed.map((p) => ({
    row_id: p.row_id, line: p.line,
    cells: columns.map((c) => String(keyOf(rows[p.row_id], c) ?? '')),
    status: p.status, reason: p.reason, record: p.record,
  }));
  const summary = {
    total: rows.length,
    ok: parsed.filter((p) => p.status === 'ok').length,
    duplicate: parsed.filter((p) => p.status === 'duplicate').length,
    error: parsed.filter((p) => p.status === 'error').length,
  };

  const token = createDraft('classes', req.user.id, { rows: draftRows });
  return res.json({ ok: true, data: { token, rows: draftRows.map(({ record, ...r }) => r), summary } });
});

// 确认入库
router.post('/import/confirm', roleRequired(...CLERK_ROLES), (req, res) => {
  const { token, row_ids } = req.body || {};
  const draft = getDraft(token, req.user.id, 'classes');
  if (!draft) return res.status(400).json({ ok: false, error: '预览已失效，请重新上传' });

  const selected = new Set(Array.isArray(row_ids) ? row_ids.map(Number) : []);
  const targets = draft.payload.rows.filter((r) => r.status === 'ok' && selected.has(r.row_id));
  const { inserted, errors } = commitClasses(targets);

  deleteDraft(token);
  logAudit(req.user.id, 'import_classes', 'classes', `批量导入班级 ${inserted} 条${errors.length ? `，异常 ${errors.length} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, errors } });
});

// 旧接口（已弃用）
router.post('/import', roleRequired(...CLERK_ROLES), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传班级文件' });
  let rows;
  try {
    rows = parseSheet(req.file.buffer, req.file.originalname);
  } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  const parsed = planClasses(rows);
  const draftRows = parsed.map((p) => ({
    row_id: p.row_id, line: p.line, status: p.status, reason: p.reason, record: p.record,
  }));
  const targets = draftRows.filter((r) => r.status === 'ok');
  const { inserted, errors } = commitClasses(targets);

  logAudit(req.user.id, 'import_classes', 'classes', `批量导入班级 ${inserted} 条${errors.length ? `，异常 ${errors.length} 条` : ''}`);
  return res.json({ ok: true, data: { inserted, skipped: 0, errors } });
});

router.post('/', roleRequired(...CLERK_ROLES), (req, res) => {
  const { name, type, student_count, grade, parent_id, subject, member_ids } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: '班级名称必填' });
  const exists = db.prepare('SELECT id FROM classes WHERE name = ?').get(name);
  if (exists) return res.status(409).json({ ok: false, error: '班级已存在' });

  const finalType = CLASS_TYPES.includes(type) ? type : '行政班';
  const info = db
    .prepare('INSERT INTO classes (name, type, student_count, grade, parent_id, subject) VALUES (?,?,?,?,?,?)')
    .run(name, finalType, Number(student_count) || 0, grade ?? null, parent_id ? Number(parent_id) : null, subject ?? null);
  const newId = Number(info.lastInsertRowid);
  if (finalType === '走班') syncMembers(newId, member_ids);
  logAudit(req.user.id, 'create_class', `classes:${newId}`, `创建班级 ${name}（${finalType}）`);
  return res.json({ ok: true, data: { id: newId } });
});

router.patch('/:id', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ ok: false, error: '班级不存在' });

  const { name, type, student_count, grade, parent_id, subject, member_ids } = req.body || {};
  const finalType = type ?? target.type;
  db.prepare('UPDATE classes SET name = ?, type = ?, student_count = ?, grade = ?, parent_id = ?, subject = ? WHERE id = ?')
    .run(name ?? target.name, finalType, Number(student_count ?? target.student_count), grade ?? target.grade,
      parent_id !== undefined ? (parent_id ? Number(parent_id) : null) : target.parent_id, subject ?? target.subject, id);
  if (finalType === '走班') {
    // 仅当请求显式携带 member_ids 时同步合班成员；否则保持原成员不变（避免只改人数时误清空）
    if (Array.isArray(member_ids)) syncMembers(id, member_ids);
  } else if (target.type === '走班' && finalType !== '走班') db.prepare('DELETE FROM class_members WHERE class_id = ?').run(id);
  logAudit(req.user.id, 'update_class', `classes:${id}`, `更新班级 ${name ?? target.name}`);
  return res.json({ ok: true, data: { id } });
});

// 删除班级（仅管理员）。有业务引用时拒绝（避免历史课表/计酬/申报突变），
// 无引用时清理其作为走班的合班成员记录后删除。
router.delete('/:id', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ ok: false, error: '班级不存在' });

  const sched = db.prepare('SELECT COUNT(*) n FROM schedules WHERE class_id = ?').get(id).n;
  const inst = db.prepare('SELECT COUNT(*) n FROM lesson_instances WHERE class_id = ?').get(id).n;
  const qna = db.prepare('SELECT COUNT(*) n FROM qna_lessons WHERE class_id = ?').get(id).n;
  const child = db.prepare('SELECT COUNT(*) n FROM classes WHERE parent_id = ?').get(id).n;
  // 作为「走班合班成员」被引用（删除会导致合班缺班）
  const memberRef = db.prepare('SELECT COUNT(*) n FROM class_members WHERE member_class_id = ?').get(id).n;
  const used = sched + inst + qna + child + memberRef;
  if (used > 0) {
    return res.status(400).json({
      ok: false,
      error: `「${target.name}」已被 ${used} 条记录引用（课表 ${sched}、上课记录 ${inst}、申报 ${qna}、子分层 ${child}、合班成员 ${memberRef}），无法删除。请先处理这些引用，或改名为「停用」标记。`,
    });
  }
  // 清理该班作为走班时的合班成员（无业务副作用，仅结构数据）
  db.prepare('DELETE FROM class_members WHERE class_id = ?').run(id);
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_class', `classes:${id}`, `删除班级 ${target.name}`);
  return res.json({ ok: true, data: { id } });
});

export default router;
