import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, authOptional, roleRequired, CLERK_ROLES, DIRECTOR_ROLES, RESULT_VIEW_ROLES } from '../auth.js';
import { publicBase } from '../share.js';

const router = Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// multer 默认按 latin1 解码 multipart 文件名，中文需转回 UTF-8
function decodeName(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// 当前互动身份：登录用户返回 { user_id }，访客返回 { visitor_name }（需 name 才能记录）
function resolveIdentity(req, name) {
  if (req.user) return { user_id: req.user.id, visitor_name: null };
  const n = (name || '').trim();
  return { user_id: null, visitor_name: n || null };
}

// 取某通知的互动统计
function countsOf(noticeId) {
  const reads = db.prepare('SELECT COUNT(*) n FROM notice_reads WHERE notice_id = ?').get(noticeId).n;
  const likes = db.prepare('SELECT COUNT(*) n FROM notice_likes WHERE notice_id = ?').get(noticeId).n;
  const replies = db.prepare('SELECT COUNT(*) n FROM notice_replies WHERE notice_id = ? AND status = ?').get(noticeId, 'approved').n;
  return { read_count: reads, like_count: likes, reply_count: replies };
}

// 定向通知辅助：写入并直接发布一条通知，targetTeacherIds 非空则仅这些教师可见。
// 供课务调整（代课/调课/停课）自动通知复用。
export function createAdjustNotice({ title, content, targetTeacherIds, operatorId }) {
  const share_token = crypto.randomBytes(12).toString('hex');
  const targets = (targetTeacherIds || []).filter((x) => x != null);
  const info = db.prepare(`
    INSERT INTO notices (title, type, content, share_token, publish_status, target_teacher_ids, created_by, published_at)
    VALUES (?, '课务调整', ?, ?, 'published', ?, ?, ?)`)
    .run(title, content ?? null, share_token, targets.length ? JSON.stringify(targets) : null, operatorId ?? null, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

// ===== 公开分享（免登录） =====

// 分享落地页详情：通知 + 附件 + 计数 + 公开回复 + 当前身份是否已读/已赞
router.get('/share/:token', authOptional, (req, res) => {
  const notice = db
    .prepare(`SELECT n.*, u.name AS creator_name FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE n.share_token = ?`)
    .get(req.params.token);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });

  const attachments = db.prepare('SELECT id, filename, size FROM notice_attachments WHERE notice_id = ? ORDER BY id').all(notice.id);
  const replies = db.prepare(`
    SELECT r.id, r.content, r.author_name, u.name AS user_name, r.created_at
    FROM notice_replies r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.notice_id = ? AND r.status = 'approved' ORDER BY r.id`).all(notice.id);

  let myRead = false, myLike = false;
  if (req.user) {
    myRead = !!db.prepare('SELECT 1 FROM notice_reads WHERE notice_id = ? AND user_id = ?').get(notice.id, req.user.id);
    myLike = !!db.prepare('SELECT 1 FROM notice_likes WHERE notice_id = ? AND user_id = ?').get(notice.id, req.user.id);
  }

  return res.json({
    ok: true,
    data: { ...notice, share_url: `${publicBase(req)}/n/${notice.share_token}`, attachments, replies: replies.map((r) => ({ ...r, author: r.user_name || r.author_name })), ...countsOf(notice.id), my_read: myRead, my_like: myLike },
  });
});

// 记已读（登录自动；访客填姓名）
router.post('/share/:token/read', authOptional, (req, res) => {
  const notice = db.prepare('SELECT id FROM notices WHERE share_token = ?').get(req.params.token);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  const idn = resolveIdentity(req, req.body?.name);
  if (!idn.user_id && !idn.visitor_name) return res.status(400).json({ ok: false, error: '请填写姓名' });
  db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id, visitor_name) VALUES (?,?,?)')
    .run(notice.id, idn.user_id, idn.visitor_name);
  return res.json({ ok: true, data: { read: true } });
});

// 点赞 toggle（同一身份再点取消）
router.post('/share/:token/like', authOptional, (req, res) => {
  const notice = db.prepare('SELECT id FROM notices WHERE share_token = ?').get(req.params.token);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  const idn = resolveIdentity(req, req.body?.name);
  if (!idn.user_id && !idn.visitor_name) return res.status(400).json({ ok: false, error: '请填写姓名' });
  const existing = idn.user_id
    ? db.prepare('SELECT id FROM notice_likes WHERE notice_id = ? AND user_id = ?').get(notice.id, idn.user_id)
    : db.prepare('SELECT id FROM notice_likes WHERE notice_id = ? AND visitor_name = ?').get(notice.id, idn.visitor_name);
  if (existing) {
    db.prepare('DELETE FROM notice_likes WHERE id = ?').run(existing.id);
    return res.json({ ok: true, data: { liked: false } });
  }
  db.prepare('INSERT INTO notice_likes (notice_id, user_id, visitor_name) VALUES (?,?,?)').run(notice.id, idn.user_id, idn.visitor_name);
  return res.json({ ok: true, data: { liked: true } });
});

// 提交回复（进入待审核）
router.post('/share/:token/replies', authOptional, (req, res) => {
  const notice = db.prepare('SELECT id FROM notices WHERE share_token = ?').get(req.params.token);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  const idn = resolveIdentity(req, req.body?.name);
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ ok: false, error: '回复内容不能为空' });
  if (!idn.user_id && !idn.visitor_name) return res.status(400).json({ ok: false, error: '请填写姓名' });
  db.prepare('INSERT INTO notice_replies (notice_id, user_id, author_name, content) VALUES (?,?,?,?)')
    .run(notice.id, idn.user_id, idn.visitor_name, content);
  return res.json({ ok: true, data: { pending: true } });
});

// 附件下载（免登录）
router.get('/attachments/:id/download', (req, res) => {
  const f = db.prepare('SELECT * FROM notice_attachments WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ ok: false, error: '附件不存在' });
  res.download(path.join(UPLOAD_DIR, f.stored_path), f.filename);
});

// ===== 管理（需登录） =====
router.use(authRequired);

// 列表（含计数）。publish_status 可选过滤：published / draft（移动端传 published 只看已发布）
router.get('/', (req, res) => {
  const { publish_status } = req.query;
  let sql = 'SELECT n.*, u.name AS creator_name FROM notices n LEFT JOIN users u ON u.id = n.created_by WHERE 1=1';
  const params = [];
  if (publish_status) { sql += ' AND n.publish_status = ?'; params.push(publish_status); }
  // 定向通知过滤：管理员看全部；非管理员仅看「广播 + 定向到自己」的通知
  const isAdmin = RESULT_VIEW_ROLES.includes(req.user.role);
  if (!isAdmin) {
    const tid = req.user.teacher_id ?? null;
    sql += ` AND (n.target_teacher_ids IS NULL OR n.target_teacher_ids = '' OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(n.target_teacher_ids) WHERE CAST(json_each.value AS TEXT) = ?)))`;
    params.push(tid, String(tid));
  }
  sql += ' ORDER BY n.id DESC';
  const rows = db.prepare(sql).all(...params);
  const myReadStmt = db.prepare('SELECT 1 FROM notice_reads WHERE notice_id = ? AND user_id = ?');
  return res.json({
    ok: true,
    data: rows.map((n) => ({
      ...n,
      ...countsOf(n.id),
      my_read: !!myReadStmt.get(n.id, req.user.id),
      share_url: `${publicBase(req)}/n/${n.share_token}`,
    })),
  });
});

// 当前登录用户的未读「已发布」通知数（应用内角标用）
router.get('/unread-count', (req, res) => {
  const n = db.prepare(`
    SELECT COUNT(*) AS n FROM notices n
    WHERE n.publish_status = 'published'
      AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?)
  `).get(req.user.id).n;
  return res.json({ ok: true, data: { unread: n } });
});

// 标记某通知为已读（登录用户）
router.post('/:id/read', (req, res) => {
  const notice = db.prepare('SELECT id FROM notices WHERE id = ?').get(Number(req.params.id));
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  db.prepare('INSERT OR IGNORE INTO notice_reads (notice_id, user_id) VALUES (?,?)').run(notice.id, req.user.id);
  return res.json({ ok: true, data: { read: true } });
});

// 当前登录用户提交过的回复（含审核状态 + 所属通知标题）
router.get('/my-replies', (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.content, r.status, r.created_at, n.id AS notice_id, n.title AS notice_title, n.type AS notice_type
    FROM notice_replies r
    JOIN notices n ON n.id = r.notice_id
    WHERE r.user_id = ?
    ORDER BY r.id DESC`).all(req.user.id);
  return res.json({ ok: true, data: rows });
});

// 详情：已读名单 + 回复（全状态）
router.get('/:id/detail', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  const reads = db.prepare(`
    SELECT r.id, r.user_id, u.name AS user_name, r.visitor_name, r.read_at
    FROM notice_reads r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.notice_id = ? ORDER BY r.id DESC`).all(id);
  const replies = db.prepare(`
    SELECT r.*, u.name AS user_name, ru.name AS reviewer_name
    FROM notice_replies r
    LEFT JOIN users u ON u.id = r.user_id
    LEFT JOIN users ru ON ru.id = r.reviewed_by
    WHERE r.notice_id = ? ORDER BY r.id`).all(id);
  return res.json({
    ok: true,
    data: {
      notice: { ...notice, share_url: `${publicBase(req)}/n/${notice.share_token}` },
      reads: reads.map((r) => ({ ...r, author: r.user_name || r.visitor_name })),
      replies: replies.map((r) => ({ ...r, author: r.user_name || r.author_name })),
      ...countsOf(id),
    },
  });
});

// 新建（支持附件 files[]）
router.post('/', roleRequired(...CLERK_ROLES), upload.array('files', 10), (req, res) => {
  const { title, type, content } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: '标题必填' });
  const share_token = crypto.randomBytes(12).toString('hex');
  const info = db
    .prepare('INSERT INTO notices (title, type, content, share_token, created_by) VALUES (?,?,?,?,?)')
    .run(title, type || '其他', content ?? null, share_token, req.user.id);
  const noticeId = Number(info.lastInsertRowid);
  const attachments = [];
  for (const f of req.files || []) {
    const a = db.prepare('INSERT INTO notice_attachments (notice_id, filename, stored_path, size) VALUES (?,?,?,?)')
      .run(noticeId, decodeName(f.originalname), f.filename, f.size || 0);
    attachments.push({ id: Number(a.lastInsertRowid), filename: decodeName(f.originalname) });
  }
  logAudit(req.user.id, 'create_notice', `notices:${noticeId}`, `创建通知 ${title}（附件 ${attachments.length}）`);
  return res.json({ ok: true, data: { id: noticeId, share_token, share_url: `${publicBase(req)}/n/${share_token}`, attachments } });
});

// 修改通知（标题/类型/正文），需管理员权限
router.patch('/:id', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  const { title, type, content } = req.body || {};
  const nextTitle = title !== undefined ? String(title).trim() : notice.title;
  if (!nextTitle) return res.status(400).json({ ok: false, error: '标题必填' });
  const nextType = type !== undefined ? String(type).trim() : notice.type;
  const nextContent = content !== undefined ? content : notice.content;
  db.prepare('UPDATE notices SET title = ?, type = ?, content = ? WHERE id = ?')
    .run(nextTitle, nextType || '其他', nextContent ?? null, id);
  logAudit(req.user.id, 'update_notice', `notices:${id}`, `修改通知 ${nextTitle}`);
  return res.json({ ok: true, data: { id, title: nextTitle, type: nextType || '其他', content: nextContent } });
});

// 发布 / 下线
router.patch('/:id/publish', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  const status = req.body?.publish_status === 'published' ? 'published' : 'draft';
  db.prepare('UPDATE notices SET publish_status = ?, published_at = ? WHERE id = ?')
    .run(status, status === 'published' ? new Date().toISOString() : null, id);
  logAudit(req.user.id, 'publish_notice', `notices:${id}`, `通知状态 ${status}`);
  return res.json({ ok: true, data: { id, publish_status: status } });
});

// 审核回复
router.patch('/replies/:id/review', roleRequired(...DIRECTOR_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const reply = db.prepare('SELECT * FROM notice_replies WHERE id = ?').get(id);
  if (!reply) return res.status(404).json({ ok: false, error: '回复不存在' });
  const status = ['approved', 'rejected'].includes(req.body?.status) ? req.body.status : 'rejected';
  db.prepare('UPDATE notice_replies SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .run(status, req.user.id, new Date().toISOString(), id);
  logAudit(req.user.id, 'review_reply', `notice_replies:${id}`, `回复审核 ${status}`);
  return res.json({ ok: true, data: { id, status } });
});

// 删除通知（级联删附件文件、已读、回复、点赞）
router.delete('/:id', roleRequired(...CLERK_ROLES), (req, res) => {
  const id = Number(req.params.id);
  const notice = db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  if (!notice) return res.status(404).json({ ok: false, error: '通知不存在' });
  db.prepare('DELETE FROM notice_reads WHERE notice_id = ?').run(id);
  db.prepare('DELETE FROM notice_replies WHERE notice_id = ?').run(id);
  db.prepare('DELETE FROM notice_likes WHERE notice_id = ?').run(id);
  const files = db.prepare('SELECT stored_path FROM notice_attachments WHERE notice_id = ?').all(id);
  for (const f of files) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored_path)); } catch { /* 忽略文件不存在 */ }
  }
  db.prepare('DELETE FROM notice_attachments WHERE notice_id = ?').run(id);
  db.prepare('DELETE FROM notices WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_notice', `notices:${id}`, '删除通知');
  return res.json({ ok: true, data: { id } });
});

export default router;
