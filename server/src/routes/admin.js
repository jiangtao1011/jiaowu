import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { db, logAudit, DB_PATH, DATA_DIR, UPLOAD_DIR } from '../db.js';
import { authRequired, roleRequired } from '../auth.js';

const router = Router();

// ===== 仅管理员（admin）可访问，全部接口需登录 + 角色校验 =====
router.use(authRequired, roleRequired('admin'));

function userTables() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

// ===== 元数据 =====
// 数据库信息（含文件大小、表数量、PRAGMA 状态）
router.get('/meta', (req, res) => {
  let size = 0;
  try { size = fs.statSync(DB_PATH).size; } catch { /* 忽略 */ }
  const tables = userTables();
  const integrity = db.prepare('PRAGMA quick_check').all();
  const fk = db.prepare('PRAGMA foreign_keys').get();
  const journal = db.prepare('PRAGMA journal_mode').get();
  return res.json({
    ok: true,
    data: {
      dbPath: DB_PATH,
      sizeBytes: size,
      tableCount: tables.length,
      integrity: integrity,
      foreignKeys: fk?.foreign_keys,
      journalMode: journal?.journal_mode,
    },
  });
});

// 表清单（表名 + 行数），供「概览」页
router.get('/tables', (req, res) => {
  const rows = userTables().map((name) => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
    return { name, count };
  });
  return res.json({ ok: true, data: rows });
});

// 单表详情：列结构 + 分页数据 + 总数
router.get('/tables/:name', (req, res) => {
  const name = req.params.name;
  const list = userTables();
  if (!list.includes(name)) return res.status(404).json({ ok: false, error: '表不存在' });

  const cols = db.prepare(`PRAGMA table_info(${name})`).all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const orderCol = cols.some((c) => c.name === 'id') ? 'id' : cols[0]?.name;
  const rows = db
    .prepare(`SELECT * FROM ${name} ORDER BY ${orderCol} DESC LIMIT ? OFFSET ?`)
    .all(pageSize, offset);

  return res.json({
    ok: true,
    data: { name, columns: cols, total, page, pageSize, rows },
  });
});

// ===== 备份管理 =====
const BACKUP_DIR = path.join(DATA_DIR, '..', 'backups');

// 创建备份（VACUUM INTO 生成一致性快照；写入成功后清理多余备份）
router.post('/backup', (req, res) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `edu-${stamp}.db`;
  const target = path.join(BACKUP_DIR, filename);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  logAudit(req.user.id, 'db_backup', `backup:${filename}`, '手动备份数据库');
  pruneBackups();
  return res.json({ ok: true, data: { filename, size: fs.statSync(target).size } });
});

// 备份列表（文件名 + 大小 + 修改时间）
router.get('/backups', (req, res) => {
  if (!fs.existsSync(BACKUP_DIR)) return res.json({ ok: true, data: [] });
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const s = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: s.size, mtime: s.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return res.json({ ok: true, data: files });
});

// 下载备份
router.get('/backups/:filename/download', (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: '备份不存在' });
  return res.download(fp, filename);
});

// 删除备份
router.delete('/backups/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(BACKUP_DIR, filename);
  if (!filename.endsWith('.db') || !fp.startsWith(BACKUP_DIR)) {
    return res.status(400).json({ ok: false, error: '非法文件名' });
  }
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: '备份不存在' });
  fs.unlinkSync(fp);
  logAudit(req.user.id, 'db_backup_delete', `backup:${filename}`, '删除备份');
  return res.json({ ok: true, data: { filename } });
});

// 恢复备份：把目标备份复制为 edu.db.restore，提示用户重启后端生效
router.post('/backups/:filename/restore', (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: '备份不存在' });
  // 校验目标确为有效 SQLite 库且含 users 表
  try {
    const probe = new DatabaseSync(fp, { readOnly: true });
    const ok = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    probe.close();
    if (!ok) return res.status(400).json({ ok: false, error: '该文件不是有效的教务数据库备份' });
  } catch {
    return res.status(400).json({ ok: false, error: '该文件不是有效的 SQLite 数据库' });
  }
  fs.copyFileSync(fp, path.join(DATA_DIR, 'edu.db.restore'));
  logAudit(req.user.id, 'db_restore', `backup:${filename}`, '标记恢复备份（待重启生效）');
  return res.json({ ok: true, data: { filename, restartRequired: true } });
});

// 上传备份文件（供导入外部 .db 后恢复）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
router.post('/backups/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '未收到文件' });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `edu-upload-${stamp}.db`;
  const target = path.join(BACKUP_DIR, filename);
  // 校验为有效 SQLite 且含 users 表
  try {
    const tmp = path.join(DATA_DIR, '..', 'backups', `.tmp-${crypto.randomBytes(6).toString('hex')}.db`);
    fs.writeFileSync(tmp, req.file.buffer);
    const probe = new DatabaseSync(tmp, { readOnly: true });
    const hasUsers = !!probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    probe.close();
    if (!hasUsers) {
      fs.unlinkSync(tmp);
      return res.status(400).json({ ok: false, error: '文件不是有效的教务数据库（缺 users 表）' });
    }
    fs.renameSync(tmp, target);
  } catch (e) {
    return res.status(400).json({ ok: false, error: '文件不是有效的 SQLite 数据库' });
  }
  logAudit(req.user.id, 'db_backup_upload', `backup:${filename}`, '上传数据库备份');
  return res.json({ ok: true, data: { filename, size: req.file.size } });
});

// 清理多余备份，只保留最近 MAX_BACKUPS 份
function pruneBackups() {
  const MAX_BACKUPS = 30;
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const item of files.slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, item.f)); } catch { /* 忽略 */ }
  }
}

// 记录待恢复标记存在与否（供前端提示「重启后生效」）
router.get('/restore-pending', (req, res) => {
  const pending = fs.existsSync(path.join(DATA_DIR, 'edu.db.restore'));
  return res.json({ ok: true, data: { pending } });
});

// ===== 维护操作 =====
// 完整性检查（quick_check，只读不锁写）
router.post('/integrity-check', (req, res) => {
  const r = db.prepare('PRAGMA quick_check').all();
  const ok = r.length === 1 && String(r[0].quick_check) === 'ok';
  return res.json({ ok: true, data: { ok, detail: r } });
});

// 压缩整理（VACUUM，回收空间；执行前自动备份一次）
router.post('/vacuum', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, `edu-vacuum-${stamp}.db`).replace(/'/g, "''")}'`);
  } catch { /* 备份失败不阻断 VACUUM */ }
  db.exec('VACUUM');
  const after = fs.statSync(DB_PATH).size;
  logAudit(req.user.id, 'db_vacuum', 'db:vacuum', '压缩整理数据库');
  return res.json({ ok: true, data: { sizeBytes: after } });
});

export default router;
