import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, CLERK_ROLES, DIRECTOR_ROLES, RESULT_VIEW_ROLES } from '../auth.js';
import { visibleGroups } from '../scope.js';
import { listGroups, resolveGroup } from '../groups.js';
import { parseSheet, keyOf, downloadTemplate } from '../template.js';

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
// 导入解析用（内存缓冲，不落盘）
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// busboy/multer 默认按 latin1 解码 multipart 文件名，中文需转回 UTF-8
function decodeName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 当前用户可见的组 key 集合（null=全量）
function groupScopeSet(req) {
  const scope = visibleGroups(req.user);
  return scope ? new Set(scope) : null;
}

// 率值收敛到 0~100，保留两位小数
function clampRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

// 按考试年级过滤备课组（grade 空=全校，不过滤）；传入已含 type/scope 过滤的组列表
function filterByExamGrade(groups, examGrade) {
  if (!examGrade) return groups;
  return groups.filter((g) => g.grade === examGrade);
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
router.put('/exam-types', roleRequired(...CLERK_ROLES), (req, res) => {
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
router.delete('/exam-types/:id', roleRequired(...CLERK_ROLES), (req, res) => {
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

router.post('/exams', roleRequired(...CLERK_ROLES), (req, res) => {
  const { name, semester, exam_type, grade, exam_date, note } = req.body || {};
  const n = String(name || '').trim();
  const sem = String(semester || '').trim();
  const type = String(exam_type || '').trim();
  const g = grade ? String(grade).trim() : null;
  if (!n) return res.status(400).json({ ok: false, error: '考试名称必填' });
  if (!sem) return res.status(400).json({ ok: false, error: '学期必填' });
  if (!type) return res.status(400).json({ ok: false, error: '考试类型必填' });
  const info = db.prepare('INSERT INTO exams (name, semester, exam_type, grade, exam_date, note, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(n, sem, type, g, exam_date || null, note ?? null, req.user.id);
  logAudit(req.user.id, 'create_exam', `exams:${info.lastInsertRowid}`, `创建考试 ${n}（${type}${g ? `，${g}` : ''}）`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

router.patch('/exams/:id', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const e = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!e) return res.status(404).json({ ok: false, error: '考试不存在' });
  const { name, semester, exam_type, grade, exam_date, note } = req.body || {};
  db.prepare('UPDATE exams SET name = ?, semester = ?, exam_type = ?, grade = ?, exam_date = ?, note = ? WHERE id = ?')
    .run(name ? String(name).trim() : e.name,
      semester !== undefined ? String(semester).trim() : e.semester,
      exam_type !== undefined ? String(exam_type).trim() : e.exam_type,
      grade !== undefined ? (grade ? String(grade).trim() : null) : e.grade,
      exam_date !== undefined ? exam_date : e.exam_date,
      note !== undefined ? note : e.note,
      id);
  logAudit(req.user.id, 'update_exam', `exams:${id}`, '更新考试');
  return res.json({ ok: true, data: { id } });
});

router.delete('/exams/:id', roleRequired(...CLERK_ROLES), (req, res) => {
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
  const groups = filterByExamGrade(
    listGroups().filter((g) => g.type === '备课组').filter((g) => !scope || scope.has(g.key)),
    exam.grade
  );

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
  return res.json({ ok: true, data, exam_type: exam.exam_type, semester: exam.semester, grade: exam.grade || null });
});

// 批量保存各率（全量替换语义：body 传该考试全部要保存的组率）
// body: [{ group_key, rate_a..rate_e, total_count?, avg_score? }]
router.put('/exams/:id/scores', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });
  const { items = [] } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items 需为数组' });

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

// 下载各率导入模板（含当前考试全部备课组 + 已录率预填）
router.get('/exams/:id/scores-template', (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });

  const scope = groupScopeSet(req);
  const groups = filterByExamGrade(
    listGroups().filter((g) => g.type === '备课组').filter((g) => !scope || scope.has(g.key)),
    exam.grade
  );
  const savedMap = new Map(db.prepare('SELECT * FROM exam_scores WHERE exam_id = ?').all(id).map((s) => [s.group_key, s]));

  const headers = ['备课组', 'A率%', 'B率%', 'C率%', 'D率%', 'E率%', '参考人数', '均分'];
  const sampleRows = groups.map((g) => {
    const s = savedMap.get(g.key);
    return [
      g.name,
      s ? s.rate_a : '',
      s ? s.rate_b : '',
      s ? s.rate_c : '',
      s ? s.rate_d : '',
      s ? s.rate_e : '',
      s ? s.total_count : '',
      s ? s.avg_score : '',
    ];
  });
  downloadTemplate(
    res,
    headers,
    sampleRows,
    `${exam.name}-各率导入模板.xlsx`,
    [{ name: '填写说明', rows: [['「备课组」列需与系统备课组名一致（如「高一化学备课组」）；各率为百分数 0~100；只导入文件中出现的行，未出现的备课组保持不变。']] }]
  );
});

// 批量导入各率（按备课组名匹配 upsert，不影响文件中未出现的组）
router.post('/exams/:id/scores/import', roleRequired(...CLERK_ROLES), uploadMem.single('file'), (req, res) => {
  const id = Number(req.params.id);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(id);
  if (!exam) return res.status(404).json({ ok: false, error: '考试不存在' });
  if (!req.file) return res.status(400).json({ ok: false, error: '请上传文件' });

  let rows;
  try { rows = parseSheet(req.file.buffer, req.file.originalname); } catch {
    return res.status(400).json({ ok: false, error: '无法解析文件，请使用模板的 .xlsx / .csv 格式' });
  }
  if (!rows.length) return res.status(400).json({ ok: false, error: '文件中没有数据' });

  // 组名 → 组 key（备课组；按考试年级过滤，避免其它年级组名混入）
  const groupByName = new Map();
  for (const g of filterByExamGrade(listGroups().filter((x) => x.type === '备课组'), exam.grade)) groupByName.set(g.name, g.key);

  const ins = db.prepare(`INSERT INTO exam_scores (exam_id, group_key, group_name, rate_a, rate_b, rate_c, rate_d, rate_e, total_count, avg_score)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const upd = db.prepare(`UPDATE exam_scores SET group_name = ?, rate_a = ?, rate_b = ?, rate_c = ?, rate_d = ?, rate_e = ?, total_count = ?, avg_score = ?
    WHERE exam_id = ? AND group_key = ?`);
  const existing = new Set(db.prepare('SELECT group_key FROM exam_scores WHERE exam_id = ?').all(id).map((r) => r.group_key));

  let imported = 0;
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const gname = String(keyOf(row, '备课组', '备课组名', 'group_name', '组名') ?? '').trim();
    if (!gname) { errors.push(`第 ${i + 2} 行缺少备课组名`); continue; }
    const gk = groupByName.get(gname);
    if (!gk) { errors.push(`第 ${i + 2} 行「${gname}」不是有效备课组`); continue; }
    if (seen.has(gk)) { errors.push(`第 ${i + 2} 行「${gname}」重复`); continue; }
    seen.add(gk);

    const ra = clampRate(keyOf(row, 'A率%', 'A率', 'a率') ?? 0);
    const rb = clampRate(keyOf(row, 'B率%', 'B率', 'b率') ?? 0);
    const rc = clampRate(keyOf(row, 'C率%', 'C率', 'c率') ?? 0);
    const rd = clampRate(keyOf(row, 'D率%', 'D率', 'd率') ?? 0);
    const re = clampRate(keyOf(row, 'E率%', 'E率', 'e率') ?? 0);
    const tcRaw = keyOf(row, '参考人数', '人数');
    const tc = tcRaw !== '' && tcRaw != null ? Number(tcRaw) : null;
    const asRaw = keyOf(row, '均分', '平均分');
    const as = asRaw !== '' && asRaw != null ? Number(asRaw) : null;

    if (existing.has(gk)) upd.run(gname, ra, rb, rc, rd, re, tc, as, id, gk);
    else ins.run(id, gk, gname, ra, rb, rc, rd, re, tc, as);
    imported++;
  }
  logAudit(req.user.id, 'import_exam_scores', `exams:${id}`, `批量导入各率 ${imported} 条${errors.length ? `，异常 ${errors.length} 条` : ''}`);
  return res.json({ ok: true, data: { imported, errors } });
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
  if (exam.grade && grp.grade !== exam.grade) return res.status(400).json({ ok: false, error: `该考试限定 ${exam.grade}，此备课组不属于该年级` });

  // 权限：仅管理员级或组长（教研组长=本学科、备课组长=本组）；普通教师不可上传
  const role = req.user.role;
  if (!CLERK_ROLES.includes(role) && role !== '教研组长' && role !== '备课组长') {
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
  if (!RESULT_VIEW_ROLES.includes(role) && role !== '教研组长' && role !== '备课组长') {
    return res.status(403).json({ ok: false, error: '无权限下载成绩文件' });
  }
  const scope = groupScopeSet(req);
  if (scope && !scope.has(f.group_key)) return res.status(403).json({ ok: false, error: '该文件不在您的权限范围内' });
  res.download(path.join(UPLOAD_DIR, f.stored_path), f.filename);
});

// ===== 考核结构配置（率权重）=====
// 存 app_settings，key=assessment_config，JSON: { rate_weights:{a,b,c,d,e}, full_score }
function assessmentConfig() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'assessment_config'").get();
  let cfg = null;
  try { cfg = row?.value ? JSON.parse(row.value) : null; } catch { cfg = null; }
  const weights = cfg?.rate_weights || {};
  const fullScore = Number(cfg?.full_score ?? 100);
  return {
    rate_weights: {
      a: Number(weights.a ?? 0.6),
      b: Number(weights.b ?? 0.4),
      c: Number(weights.c ?? 0),
      d: Number(weights.d ?? 0),
      e: Number(weights.e ?? 0),
    },
    full_score: Number.isFinite(fullScore) && fullScore > 0 ? fullScore : 100,
  };
}

router.get('/config', (req, res) => res.json({ ok: true, data: assessmentConfig() }));

router.put('/config', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const { rate_weights, full_score } = req.body || {};
  const cfg = assessmentConfig();
  const w = rate_weights || {};
  const next = {
    rate_weights: {
      a: w.a !== undefined ? Number(w.a) : cfg.rate_weights.a,
      b: w.b !== undefined ? Number(w.b) : cfg.rate_weights.b,
      c: w.c !== undefined ? Number(w.c) : cfg.rate_weights.c,
      d: w.d !== undefined ? Number(w.d) : cfg.rate_weights.d,
      e: w.e !== undefined ? Number(w.e) : cfg.rate_weights.e,
    },
    full_score: full_score !== undefined ? Number(full_score) : cfg.full_score,
  };
  if ([next.rate_weights.a, next.rate_weights.b, next.rate_weights.c, next.rate_weights.d, next.rate_weights.e].some((v) => !Number.isFinite(v) || v < 0)) {
    return res.status(400).json({ ok: false, error: '权重需为非负数值' });
  }
  if (!Number.isFinite(next.full_score) || next.full_score <= 0) {
    return res.status(400).json({ ok: false, error: '满分需为正数' });
  }
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('assessment_config', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`).run(JSON.stringify(next));
  logAudit(req.user.id, 'update_assessment_config', 'app_settings', '更新考核率权重配置');
  return res.json({ ok: true, data: next });
});

// ===== 两层加权计算 =====

// 第一层：各率 → 单次考试考核分（rate 0~100，权重可配）
function singleExamScore(rate, cfg) {
  const w = cfg.rate_weights;
  const sumW = w.a + w.b + w.c + w.d + w.e;
  if (sumW <= 0) return 0;
  const raw = (rate.a * w.a) + (rate.b * w.b) + (rate.c * w.c) + (rate.d * w.d) + (rate.e * w.e);
  // raw 已是 0~100 的量纲（rate 为 0~100），除以权重和得加权平均分，再按 full_score 缩放
  return (raw / sumW) * (cfg.full_score / 100);
}

// 第二层：单次分 × 类型权重 归一化 → 学期考核分
// types: 该组该学期参与考核的考试类型列表，各 { weight, score }
function semesterScore(entries, cfg) {
  const active = entries.filter((e) => e.weight > 0);
  const sumW = active.reduce((s, e) => s + e.weight, 0);
  if (sumW <= 0) return null; // 无参与类型 → 无学期分
  const sum = active.reduce((s, e) => s + e.score * e.weight, 0);
  return sum / sumW;
}

// 某学期某组的学期考核分：遍历该组该学期所有考试的率 + 对应类型权重
function groupSemesterScore(groupKey, semester, cfg) {
  const scores = db.prepare(`
    SELECT es.rate_a, es.rate_b, es.rate_c, es.rate_d, es.rate_e, et.weight
    FROM exam_scores es
    JOIN exams e ON e.id = es.exam_id
    LEFT JOIN exam_types et ON et.name = e.exam_type
    WHERE es.group_key = ? AND e.semester = ?`).all(groupKey, semester);
  if (!scores.length) return null;
  const entries = scores.map((s) => ({ weight: Number(s.weight ?? 0), score: singleExamScore({ a: s.rate_a, b: s.rate_b, c: s.rate_c, d: s.rate_d, e: s.rate_e }, cfg) }));
  return semesterScore(entries, cfg);
}

// ===== 考核汇总（备课组 / 教师 / 教研组 三层）=====

router.get('/summary', (req, res) => {
  const { semester } = req.query;
  if (!semester) return res.status(400).json({ ok: false, error: '请提供 semester' });
  const cfg = assessmentConfig();
  const scope = groupScopeSet(req);

  // 备课组层：该学期有成绩、且在本作用域内的备课组
  const groups = listGroups()
    .filter((g) => g.type === '备课组')
    .filter((g) => !scope || scope.has(g.key));
  const groupRows = groups.map((g) => {
    const score = groupSemesterScore(g.key, semester, cfg);
    // 参与考试详情（各类型单次分）
    const detail = db.prepare(`
      SELECT e.exam_type, e.name AS exam_name, es.rate_a, es.rate_b, es.rate_c, es.rate_d, es.rate_e, et.weight
      FROM exam_scores es
      JOIN exams e ON e.id = es.exam_id
      LEFT JOIN exam_types et ON et.name = e.exam_type
      WHERE es.group_key = ? AND e.semester = ? ORDER BY et.position, e.exam_date`).all(g.key, semester);
    const examDetail = detail.map((d) => ({
      exam_type: d.exam_type, exam_name: d.exam_name, weight: Number(d.weight ?? 0),
      score: singleExamScore({ a: d.rate_a, b: d.rate_b, c: d.rate_c, d: d.rate_d, e: d.rate_e }, cfg),
    }));
    return {
      group_key: g.key, group_name: g.name, subject: g.subject, grade: g.grade,
      score: score == null ? null : Math.round(score * 100) / 100,
      exams: examDetail,
      member_count: g.members.length,
    };
  }).filter((r) => r.exams.length > 0);

  // 教研组层：该学科下各备课组学期分的均值
  const subjectMap = new Map();
  for (const r of groupRows) {
    if (!subjectMap.has(r.subject)) subjectMap.set(r.subject, []);
    subjectMap.get(r.subject).push(r.score);
  }
  const subjectRows = [...subjectMap.entries()].map(([subject, scores]) => {
    const valid = scores.filter((v) => v != null);
    return { subject, group_count: scores.length, score: valid.length ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100 : null };
  });

  // 教师层：教师所属各备课组学期分的均值
  const teacherMap = new Map();
  for (const g of groupRows) {
    const grp = resolveGroup(g.group_key);
    for (const tid of grp?.members || []) {
      if (!teacherMap.has(tid)) teacherMap.set(tid, { teacher_id: tid, scores: [] });
      if (g.score != null) teacherMap.get(tid).scores.push(g.score);
    }
  }
  const teacherRows = [...teacherMap.values()].map((t) => {
    const tinfo = db.prepare('SELECT name, subject FROM teachers WHERE id = ?').get(t.teacher_id);
    return {
      teacher_id: t.teacher_id, teacher_name: tinfo?.name ?? '未知', subject: tinfo?.subject ?? null,
      group_count: t.scores.length,
      score: t.scores.length ? Math.round((t.scores.reduce((a, b) => a + b, 0) / t.scores.length) * 100) / 100 : null,
    };
  });

  return res.json({ ok: true, data: { groups: groupRows, teachers: teacherRows, subjects: subjectRows, config: cfg } });
});

// ===== 教师档案固化（学期级，手动）=====

// 某学期某组的完整快照（学期分 + 各考试类型原始率 + 固化时配置），供固化与追溯复用
function groupSemesterSnapshot(groupKey, semester, cfg) {
  const detail = db.prepare(`
    SELECT e.exam_type, e.name AS exam_name, es.rate_a, es.rate_b, es.rate_c, es.rate_d, es.rate_e, et.weight
    FROM exam_scores es
    JOIN exams e ON e.id = es.exam_id
    LEFT JOIN exam_types et ON et.name = e.exam_type
    WHERE es.group_key = ? AND e.semester = ? ORDER BY et.position, e.exam_date`).all(groupKey, semester);
  if (!detail.length) return null;
  const exams = detail.map((d) => ({
    exam_type: d.exam_type, exam_name: d.exam_name, weight: Number(d.weight ?? 0),
    score: Math.round(singleExamScore({ a: d.rate_a, b: d.rate_b, c: d.rate_c, d: d.rate_d, e: d.rate_e }, cfg) * 100) / 100,
    rate_a: d.rate_a, rate_b: d.rate_b, rate_c: d.rate_c, rate_d: d.rate_d, rate_e: d.rate_e,
  }));
  const entries = exams.map((e) => ({ weight: e.weight, score: e.score }));
  const score = semesterScore(entries, cfg);
  const grp = resolveGroup(groupKey);
  return {
    group_key: groupKey,
    group_name: grp?.name ?? groupKey,
    subject: grp?.subject ?? null,
    grade: grp?.grade ?? null,
    score: score == null ? null : Math.round(score * 100) / 100,
    exams,
    members: grp?.members ?? [],
    config: { rate_weights: cfg.rate_weights, full_score: cfg.full_score },
  };
}

// 列出某学期已固化的教师档案（管理员/教务主任/教务员/校长）
router.get('/records', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const { semester } = req.query;
  if (!semester) return res.status(400).json({ ok: false, error: '请提供 semester' });
  const rows = db.prepare(`
    SELECT r.*, t.name AS teacher_name, t.subject
    FROM teacher_assessment_records r
    JOIN teachers t ON t.id = r.teacher_id
    WHERE r.semester = ? ORDER BY t.subject, r.group_key, t.name`).all(semester);
  return res.json({ ok: true, data: rows });
});

// 教师查看自己的业绩档案（可按学期筛选；无 teacher_id 绑定则空）
router.get('/my-record', (req, res) => {
  const { semester } = req.query;
  const tid = req.user.teacher_id ? Number(req.user.teacher_id) : null;
  if (!tid) return res.json({ ok: true, data: [] });
  const rows = semester
    ? db.prepare('SELECT * FROM teacher_assessment_records WHERE teacher_id = ? AND semester = ? ORDER BY id DESC').all(tid, semester)
    : db.prepare('SELECT * FROM teacher_assessment_records WHERE teacher_id = ? ORDER BY semester DESC, id DESC').all(tid);
  return res.json({ ok: true, data: rows });
});

// 固化某学期档案：按当前数据算两层加权，把每位教师（所属各备课组）的学期分快照进档案
function doArchive(semester, userId) {
  const cfg = assessmentConfig();
  const groupKeys = db.prepare(`
    SELECT DISTINCT es.group_key FROM exam_scores es
    JOIN exams e ON e.id = es.exam_id WHERE e.semester = ?`).all(semester).map((r) => r.group_key);
  if (!groupKeys.length) return { error: '该学期还没有录入任何成绩，无法固化' };

  db.prepare('DELETE FROM teacher_assessment_records WHERE semester = ?').run(semester);
  const ins = db.prepare(`INSERT INTO teacher_assessment_records (teacher_id, group_key, semester, score, detail, locked_by, locked_at)
    VALUES (?,?,?,?,?,?,datetime('now','localtime'))`);
  let count = 0;
  for (const gk of groupKeys) {
    const snap = groupSemesterSnapshot(gk, semester, cfg);
    if (!snap || snap.score == null) continue;
    for (const tid of snap.members) {
      ins.run(tid, gk, semester, snap.score, JSON.stringify(snap), userId);
      count++;
    }
  }
  return { records: count, groups: groupKeys.length };
}

router.post('/semesters/:semester/archive', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const semester = String(req.params.semester || '').trim();
  if (!semester) return res.status(400).json({ ok: false, error: '请提供学期' });
  const r = doArchive(semester, req.user.id);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  logAudit(req.user.id, 'archive_assessment', `semester:${semester}`, `固化教学业绩档案 ${r.records} 条（${r.groups} 个备课组）`);
  return res.json({ ok: true, data: r });
});

// 重新固化 = 删旧重建（与 archive 同逻辑，供录错后重来）
router.post('/semesters/:semester/rearchive', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const semester = String(req.params.semester || '').trim();
  if (!semester) return res.status(400).json({ ok: false, error: '请提供学期' });
  const r = doArchive(semester, req.user.id);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  logAudit(req.user.id, 'rearchive_assessment', `semester:${semester}`, `重固化教学业绩档案 ${r.records} 条`);
  return res.json({ ok: true, data: r });
});

export default router;
