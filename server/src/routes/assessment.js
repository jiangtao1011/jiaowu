import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES } from '../auth.js';
import { visibleGroups } from '../scope.js';
import { listGroups, resolveGroup } from '../groups.js';

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

// busboy/multer 默认按 latin1 解码 multipart 文件名，中文需转回 UTF-8
function decodeName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 当前用户可见的组 key 集合（null=全量）
function groupScopeSet(req) {
  const scope = visibleGroups(req.user);
  return scope ? new Set(scope) : null;
}

// 组列表（含 key/name/type/subject/grade/leader/members），供录入界面按组选择。
// 业绩考核只关心「备课组」（type='备课组'），教研组由备课组聚合，故此处只返回备课组。
router.get('/groups', (req, res) => {
  const scope = groupScopeSet(req);
  const groups = listGroups()
    .filter((g) => g.type === '备课组')
    .filter((g) => !scope || scope.has(g.key))
    .map((g) => ({ key: g.key, name: g.name, subject: g.subject, grade: g.grade, is_auto: g.is_auto, leader_name: g.leader_name ?? null, member_count: g.members.length }));
  return res.json({ ok: true, data: groups });
});

// ===== 考试类型字典 =====

router.get('/exam-types', (req, res) => {
  const rows = db.prepare('SELECT id, name, weight, position, active FROM exam_types ORDER BY position, id').all();
  return res.json({ ok: true, data: rows });
});

// 批量保存考试类型（按 id 更新，无 id 新增；name 为空跳过）
router.put('/exam-types', roleRequired(...ADMIN_ROLES), (req, res) => {
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });
  const up = db.prepare('UPDATE exam_types SET name = ?, weight = ?, position = ?, active = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO exam_types (name, weight, position, active) VALUES (?,?,?,?)');
  const existsId = db.prepare('SELECT id FROM exam_types WHERE id = ?');
  for (const it of items) {
    const name = String(it.name || '').trim();
    if (!name) continue;
    const weight = Number(it.weight ?? 0);
    const position = Number(it.position ?? 0);
    const active = it.active === 0 || it.active === false ? 0 : 1;
    if (it.id != null && existsId.get(it.id)) up.run(name, weight, position, active, Number(it.id));
    else {
      const dup = db.prepare('SELECT id FROM exam_types WHERE name = ?').get(name);
      if (dup) up.run(name, weight, position, active, dup.id);
      else ins.run(name, weight, position, active);
    }
  }
  logAudit(req.user.id, 'update_exam_types', 'exam_types', '更新考试类型字典');
  return res.json({ ok: true, data: { updated: true } });
});

// 删除考试类型（已被考试引用则拒绝）
router.delete('/exam-types/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM exam_types WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: '考试类型不存在' });
  const used = db.prepare('SELECT COUNT(*) AS n FROM exams WHERE exam_type = ?').get(row.name).n;
  if (used > 0) return res.status(400).json({ ok: false, error: `「${row.name}」已被 ${used} 场考试引用，无法删除。` });
  db.prepare('DELETE FROM exam_types WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_exam_type', `exam_types:${id}`, `删除考试类型 ${row.name}`);
  return res.json({ ok: true, data: { deleted: true } });
});

// ===== 考试 CRUD =====

// 考试列表（可按学期筛选）
router.get('/exams', (req, res) => {
  const { semester } = req.query;
  const rows = semester
    ? db.prepare('SELECT e.*, u.name AS creator_name FROM exams e LEFT JOIN users u ON u.id = e.created_by WHERE e.semester = ? ORDER BY e.exam_date DESC, e.id DESC').all(semester)
    : db.prepare('SELECT e.*, u.name AS creator_name FROM exams e LEFT JOIN users u ON u.id = e.created_by ORDER BY e.exam_date DESC, e.id DESC').all();
  return res.json({ ok: true, data: rows });
});

// 学期列表（考试表里去重，供下拉）
router.get('/semesters', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT semester FROM exams WHERE semester IS NOT NULL AND semester != '' ORDER BY semester DESC").all();
  return res.json({ ok: true, data: rows.map((r) => r.semester) });
});

router.post('/exams', roleRequired(...ADMIN_ROLES), (req, res) => {
  const { name, semester, exam_type, exam_date, note } = req.body || {};
  const n = String(name || '').trim();
  const sem = String(semester || '').trim();
  const type = String(exam_type || '').trim();
  if (!n) return res.status(400).json({ ok: false, error: '考试名称必填' });
  if (!sem) return res.status(400).json({ ok: false, error: '学期必填' });
  if (!type) return res.status(400).json({ ok: false, error: '考试类型必填' });
  const info = db.prepare('INSERT INTO exams (name, semester, exam_type, exam_date, note, created_by) VALUES (?,?,?,?,?,?)')
    .run(n, sem, type, exam_date || null, note ?? null, req.user.id);
  logAudit(req.user.id, 'create_exam', `exams:${info.lastInsertRowid}`, `创建考试 ${n}（${type}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/exams/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ ok: false, error: '考试不存在' });
  const { name, semester, exam_type, exam_date, note } = req.body || {};
  db.prepare('UPDATE exams SET name = ?, semester = ?, exam_type = ?, exam_date = ?, note = ? WHERE id = ?')
    .run(name ? String(name).trim() : e.name,
      semester !== undefined ? String(semester).trim() : e.semester,
      exam_type !== undefined ? String(exam_type).trim() : e.exam_type,
      exam_date !== undefined ? exam_date : e.exam_date,
      note !== undefined ? note : e.note,
      id);
  logAudit(req.user.id, 'update_exam', `exams:${id}`, '更新考试');
  return res.json({ ok: true, data: { id } });
});

router.delete('/exams/:id', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ ok: false, error: '考试不存在' });
  db.prepare('DELETE FROM exam_scores WHERE exam_id = ?').run(id);
  db.prepare('DELETE FROM exam_files WHERE exam_id = ?').run(id);
  db.prepare('DELETE FROM exams WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_exam', `exams:${id}`, `删除考试 ${e.name}`);
  return res.json({ ok: true, data: { id } });
});

// ===== 备课组各率（考试 × 备课组） =====

// 取某考试已录入的各率 + 未录入的备课组（补空，便于录入界面一次性展示全部组）
router.get('/exams/:id/scores', (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });

  const scope = groupScopeSet(req);
  const groups = listGroups()
    .filter((g) => g.type === '备课组')
    .filter((g) => !scope || scope.has(g.key));

  const saved = db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(id);
  const savedMap = new Map(saved.map((s) => [s.group_key, s]));

  const data = groups.map((g) => {
    const s = savedMap.get(g.key);
    return {
      group_key: g.key,
      group_name: g.name,
      subject: g.subject,
      grade: g.grade,
      is_auto: g.is_auto,
      saved: !!s,
      rate_a: s ? s.rate_a : 0,
      rate_b: s ? s.rate_b : 0,
      rate_c: s ? s.rate_c : 0,
      rate_d: s ? s.rate_d : 0,
      rate_e: s ? s.rate_e : 0,
      total_count: s ? s.total_count : null,
      avg_score: s ? s.avg_score : null,
    };
  });
  return res.json({ ok: true, data, exam_type: exam.exam_type, semester: exam.semester });
});

// 批量保存各率（全量替换语义：body 传该考试全部要保存的组率）
// body: [{ group_key, rate_a..rate_e, total_count?, avg_score? }]
router.put('/exams/:id/scores', roleRequired(...ADMIN_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });

  // 校验：group_key 必须能解析为备课组；rate 0~100
  const clampRate = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
  };
  const ins = db.prepare(`INSERT INTO exam_scores (exam_id, group_key, group_name, rate_a, rate_b, rate_c, rate_d, rate_e, total_count, avg_score)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const upd = db.prepare(`UPDATE exam_scores SET group_name = ?, rate_a = ?, rate_b = ?, rate_c = ?, rate_d = ?, rate_e = ?, total_count = ?, avg_score = ?
    WHERE exam_id = ? AND group_key = ?`);
  const existing = new Set(db.prepare('SELECT group_key FROM exam_scores WHERE exam_id = ?').all(id).map((r) => r.group_key));

  const seen = new Set();
  let savedCount = 0;
  for (const it of items) {
    const gk = String(it.group_key || '').trim();
    if (!gk || seen.has(gk)) continue;
    const grp = resolveGroup(gk);
    if (!grp || grp.type !== '备课组') continue;
    seen.add(gk);
    const ra = clampRate(it.rate_a), rb = clampRate(it.rate_b), rc = clampRate(it.rate_c), rd = clampRate(it.rate_d), re = clampRate(it.rate_e);
    const tc = it.total_count != null && it.total_count !== '' ? Number(it.total_count) : null;
    const as = it.avg_score != null && it.avg_score !== '' ? Number(it.avg_score) : null;
    if (existing.has(gk)) upd.run(grp.name, ra, rb, rc, rd, re, tc, as, id, gk);
    else ins.run(id, gk, grp.name, ra, rb, rc, rd, re, tc, as);
    savedCount++;
  }
  logAudit(req.user.id, 'save_exam_scores', `exams:${id}`, `保存 ${savedCount} 个备课组各率`);
  return res.json({ ok: true, data: { saved: savedCount } });
});

// ===== 成绩文件（考试 × 备课组） =====

// 列某考试下的文件（按作用域过滤组）
router.get('/exams/:id/files', (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });
  const scope = groupScopeSet(req);
  let rows = db.prepare('SELECT f.id, f.exam_id, f.group_key, f.filename, f.uploaded_at, u.name AS uploader_name FROM exam_files f LEFT JOIN users u ON u.id = f.uploaded_by WHERE f.exam_id = ? ORDER BY f.id DESC').all(id);
  if (scope) rows = rows.filter((r) => scope.has(r.group_key));
  return res.json({ ok: true, data: rows });
});

// 上传成绩文件（multipart，字段 group_key 必填；管理员 + 组长，组需在本作用域内）
router.post('/exams/:id/files', upload.single('file'), (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });
  const gk = String(req.body?.group_key || '').trim();
  const grp = resolveGroup(gk);
  if (!grp || grp.type !== '备课组') return res.status(400).json({ ok: false, error: '请选择有效的备课组' });

  // 权限：仅管理员级或组长（教研组长=本学科、备课组长=本组）；普通教师不可上传
  const role = req.user.role;
  if (!ADMIN_ROLES.includes(role) && role !== '教研组长' && role !== '备课组长') {
    return res.status(403).json({ ok: false, error: '无权限上传成绩文件' });
  }
  const scope = groupScopeSet(req);
  if (scope && !scope.has(gk)) return res.status(403).json({ ok: false, error: '该备课组不在您的权限范围内' });

  if (!req.file) return res.status(400).json({ ok: false, error: '请选择文件' });
  const filename = decodeName(req.file.originalname);
  const info = db.prepare('INSERT INTO exam_files (exam_id, group_key, filename, stored_path, uploaded_by) VALUES (?,?,?,?,?)')
    .run(id, gk, filename, req.file.filename, req.user.id);
  logAudit(req.user.id, 'upload_exam_file', `exam_files:${info.lastInsertRowid}`, `上传成绩文件 ${filename}（${grp.name}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid), filename } });
});

// 下载成绩文件（管理员 + 组长；教师不可下载，只能在线查看）
router.get('/files/:fileId/download', (req, res) => {
  const f = db.prepare('SELECT * FROM exam_files WHERE id = ?').get(Number(req.params.fileId));
  if (!f) return res.status(404).json({ ok: false, error: '文件不存在' });
  const role = req.user.role;
  if (!ADMIN_ROLES.includes(role) && role !== '教研组长' && role !== '备课组长') {
    return res.status(403).json({ ok: false, error: '无权限下载成绩文件' });
  }
  const scope = groupScopeSet(req);
  if (scope && !scope.has(f.group_key)) return res.status(403).json({ ok: false, error: '该文件不在您的权限范围内' });
  res.download(path.join(UPLOAD_DIR, f.stored_path), f.filename);
});

export default router;
