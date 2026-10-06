import { Router } from 'express';
import { db, logAudit } from '../db.js';
import { authRequired, roleRequired, ADMIN_ROLES } from '../auth.js';

const router = Router();
router.use(authRequired);

const CATEGORIES = ['工作', '会议', '考试', '检查', '活动', '其它'];

// 校验日期格式 YYYY-MM-DD
function validDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// 列表：可按日期范围过滤。返回每条事项（含类别、提醒、完成状态），并附带区间内校历标记。
router.get('/', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM work_plan';
  const params = [];
  const cond = [];
  if (from) { cond.push('date >= ?'); params.push(from); }
  if (to) { cond.push('date <= ?'); params.push(to); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY date, id';
  const items = db.prepare(sql).all(...params);

  // 区间内的校历标记（放假/停课/补课），供日历叠加展示
  let calendar = [];
  if (from && to) {
    calendar = db.prepare(`
      SELECT date, grade, type, note FROM school_calendar
      WHERE date >= ? AND date <= ? ORDER BY date, COALESCE(grade, '')`)
      .all(from, to);
  }

  return res.json({ ok: true, data: { items, calendar, categories: CATEGORIES } });
});

// 新增事项
router.post('/', (req, res) => {
  const { date, title, category, note, remind } = req.body || {};
  if (!validDate(date)) return res.status(400).json({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
  const t = String(title || '').trim();
  if (!t) return res.status(400).json({ ok: false, error: '标题必填' });
  const cat = CATEGORIES.includes(category) ? category : '工作';
  const info = db
    .prepare('INSERT INTO work_plan (date, title, category, note, remind, created_by) VALUES (?,?,?,?,?,?)')
    .run(date, t, cat, note ?? null, remind ? 1 : 0, req.user.id);
  logAudit(req.user.id, 'create_work_plan', `work_plan:${info.lastInsertRowid}`, `新增教务工作 ${date} ${t}`);
  return res.json({ ok: true, data: { id: Number(info.lastInsertRowid) } });
});

// 修改事项
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const w = db.prepare('SELECT * FROM work_plan WHERE id = ?').get(id);
  if (!w) return res.status(404).json({ ok: false, error: '事项不存在' });
  const { date, title, category, note, remind } = req.body || {};
  const nextDate = date !== undefined ? date : w.date;
  if (!validDate(nextDate)) return res.status(400).json({ ok: false, error: '日期格式应为 YYYY-MM-DD' });
  const nextTitle = title !== undefined ? String(title).trim() : w.title;
  if (!nextTitle) return res.status(400).json({ ok: false, error: '标题必填' });
  const nextCat = category !== undefined ? (CATEGORIES.includes(category) ? category : w.category) : w.category;
  const nextRemind = remind !== undefined ? (remind ? 1 : 0) : w.remind;
  const nextNote = note !== undefined ? note : w.note;
  db.prepare('UPDATE work_plan SET date = ?, title = ?, category = ?, note = ?, remind = ? WHERE id = ?')
    .run(nextDate, nextTitle, nextCat, nextNote ?? null, nextRemind, id);
  logAudit(req.user.id, 'update_work_plan', `work_plan:${id}`, `修改教务工作 ${nextDate} ${nextTitle}`);
  return res.json({ ok: true, data: { id } });
});

// 切换完成状态
router.patch('/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const w = db.prepare('SELECT * FROM work_plan WHERE id = ?').get(id);
  if (!w) return res.status(404).json({ ok: false, error: '事项不存在' });
  const next = w.done ? 0 : 1;
  db.prepare('UPDATE work_plan SET done = ? WHERE id = ?').run(next, id);
  return res.json({ ok: true, data: { id, done: !!next } });
});

// 删除事项
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const w = db.prepare('SELECT * FROM work_plan WHERE id = ?').get(id);
  if (!w) return res.status(404).json({ ok: false, error: '事项不存在' });
  db.prepare('DELETE FROM work_plan WHERE id = ?').run(id);
  logAudit(req.user.id, 'delete_work_plan', `work_plan:${id}`, `删除教务工作 ${w.date} ${w.title}`);
  return res.json({ ok: true, data: { id } });
});

export default router;
