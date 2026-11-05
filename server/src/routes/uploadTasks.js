import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, logAudit, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired, CLERK_ROLES } from '../auth.js';

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

// 教学计划上传任务列表
router.get('/', (req, res) => {
  const tasks = db
    .prepare('SELECT t.*, u.name AS creator_name FROM upload_tasks t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.id DESC')
    .all();
  return res.json({ ok: true, data: tasks });
});

// 创建上传任务（教务员自定义）
router.post('/', roleRequired(...CLERK_ROLES), (req, res) => {
  const { title, description, target_role, target_user_ids, requirement, deadline, allow_file_types } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: '任务标题必填' });
  const info = db
    .prepare(`INSERT INTO upload_tasks
      (title, description, target_role, target_user_ids, requirement, deadline, allow_file_types, created_by)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(title, description ?? null, target_role ?? null,
      target_user_ids ? JSON.stringify(target_user_ids) : null,
      requirement ?? null, deadline ?? null, allow_file_types ?? null, req.user.id);
  logAudit(req.user.id, 'create_upload_task', `upload_tasks:${info.lastInsertRowid}`, `创建上传任务 ${title}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 查看某任务下的文件
router.get('/:id/files', (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare('SELECT f.*, u.name AS uploader_name FROM uploads f LEFT JOIN users u ON u.id = f.uploader_id WHERE f.task_id = ? ORDER BY f.id DESC')
    .all(id);
  return res.json({ ok: true, data: rows });
});

// 上传文件
router.post('/:id/files', upload.single('file'), (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM upload_tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ ok: false, error: '上传任务不存在' });
  if (!req.file) return res.status(400).json({ ok: false, error: '请选择文件' });

  const info = db
    .prepare('INSERT INTO uploads (task_id, uploader_id, filename, stored_path) VALUES (?,?,?,?)')
    .run(id, req.user.id, decodeName(req.file.originalname), req.file.filename);
  logAudit(req.user.id, 'upload_file', `uploads:${info.lastInsertRowid}`, `上传文件 ${decodeName(req.file.originalname)}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid), filename: decodeName(req.file.originalname) } });
});

// 下载文件
router.get('/files/:fileId/download', (req, res) => {
  const f = db.prepare('SELECT * FROM uploads WHERE id = ?').get(Number(req.params.fileId));
  if (!f) return res.status(404).json({ ok: false, error: '文件不存在' });
  res.download(path.join(UPLOAD_DIR, f.stored_path), f.filename);
});

export default router;
