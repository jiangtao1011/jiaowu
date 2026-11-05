import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, roleRequired, RESULT_VIEW_ROLES } from '../auth.js';
import { listGroups } from '../groups.js';
import { loadContext, computePay } from '../context.js';

const router = Router();

router.use(authRequired);

// 本地日期 YYYY-MM-DD
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function count(sql, ...params) {
  return Number(db.prepare(sql).get(...params).n);
}

// 达标线（组达标率口径，默认 90，与常规检查一致）
function passLineConfig() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'pass_line'").get();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 90;
}

// 手机端「数据看板」聚合接口（管理员/教务主任/教务员 + 分管领导只读）。
// 一次返回：核心指标总览 + 待办聚合 + 检查考核（组级排行 + 组内教师下钻）。
router.get('/', roleRequired(...RESULT_VIEW_ROLES), (req, res) => {
  const today = localDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const in7 = addDays(today, 7);

  // ===== 核心指标总览 =====
  const overview = {
    classes: count('SELECT COUNT(*) n FROM classes'),
    teachers: count('SELECT COUNT(*) n FROM teachers WHERE active = 1'),
    users: count('SELECT COUNT(*) n FROM users WHERE active = 1'),
    month_lessons: count('SELECT COUNT(*) n FROM lesson_instances WHERE cancelled = 0 AND date >= ? AND date <= ?', monthStart, today),
    month_weighted: 0,
    month_pay: 0,
    inspections: count('SELECT COUNT(*) n FROM inspections'),
    pending_qna: count("SELECT COUNT(*) n FROM qna_lessons WHERE status IN ('pending','grade_approved')"),
    pending_applications: count("SELECT COUNT(*) n FROM applications WHERE status = 'pending'"),
    pending_replies: count("SELECT COUNT(*) n FROM notice_replies WHERE status = 'pending'"),
  };

  // 本月折算课时与课酬（复用 computePay，口径与统计中心一致）
  {
    const ctx = loadContext();
    const rows = db.prepare(`
      SELECT li.*, t.pay_standard
      FROM lesson_instances li JOIN teachers t ON t.id = li.teacher_id
      WHERE li.cancelled = 0 AND li.date >= ? AND li.date <= ?`).all(monthStart, today);
    let w = 0, p = 0;
    for (const r of rows) {
      const { weighted, pay } = computePay(ctx, { ...r, count: 1 });
      w += weighted;
      p += pay;
    }
    overview.month_weighted = Math.round(w * 100) / 100;
    overview.month_pay = Math.round(p * 100) / 100;
  }

  // ===== 待办聚合 =====
  const todo = {
    qna: overview.pending_qna,
    applications: overview.pending_applications,
    replies: overview.pending_replies,
    overdue_uploads: count('SELECT COUNT(*) n FROM upload_tasks WHERE deadline IS NOT NULL AND deadline < ?', today),
    reminders: db.prepare(`
      SELECT id, title, category, date, done
      FROM work_plan WHERE remind = 1 AND done = 0 AND date >= ? AND date <= ?
      ORDER BY date, id LIMIT 8`).all(today, in7),
  };

  // ===== 检查与考核 =====
  const passLine = passLineConfig();

  // 每教师得分（范围内全部检查），复用常规检查「Σ实得/Σ满分×100」口径
  const teacherRows = db.prepare(`
    SELECT i.teacher_id, t.name AS teacher_name, t.subject,
           COUNT(*) AS cnt,
           COALESCE(SUM(i.score_total), 0) AS sum_total,
           COALESCE(SUM(i.score_max), 0) AS sum_max
    FROM inspections i
    LEFT JOIN teachers t ON t.id = i.teacher_id
    WHERE i.teacher_id IS NOT NULL
    GROUP BY i.teacher_id`).all();
  const teacherScore = new Map();
  const teacherCount = new Map();
  for (const r of teacherRows) {
    teacherCount.set(r.teacher_id, r.cnt);
    teacherScore.set(r.teacher_id, r.sum_max > 0 ? (r.sum_total / r.sum_max) * 100 : null);
  }

  // 全量教师信息（含未检查教师，供组内明细显示姓名/学科）
  const teacherMeta = new Map(
    db.prepare('SELECT id, name, subject FROM teachers').all().map((t) => [t.id, t])
  );

  const groups = listGroups();
  const groupRows = groups.map((g) => {
    const members = g.members || [];
    const scored = members
      .map((tid) => teacherScore.get(tid))
      .filter((v) => v != null && Number.isFinite(v));
    const avg = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10 : null;
    const passed = scored.filter((v) => v >= passLine).length;
    const passRate = scored.length ? Math.round((passed / scored.length) * 1000) / 10 : null;
    const coverage = members.length ? Math.round((scored.length / members.length) * 1000) / 10 : null;
    return {
      key: g.key, name: g.name, type: g.type, subject: g.subject, grade: g.grade,
      teacher_count: members.length, checked_count: scored.length,
      avg_score: avg, pass_rate: passRate, coverage,
    };
  }).sort((a, b) => {
    // 先按覆盖率升序（未查满的排前面），再按平均分升序
    if ((a.coverage ?? 100) !== (b.coverage ?? 100)) return (a.coverage ?? 100) - (b.coverage ?? 100);
    return (a.avg_score ?? 100) - (b.avg_score ?? 100);
  });

  // 组内教师下钻（含未检查教师，标 status）
  const byTeacher = {};
  for (const g of groups) {
    const members = g.members || [];
    byTeacher[g.key] = members.map((tid) => {
      const score = teacherScore.get(tid);
      const meta = teacherMeta.get(tid) || {};
      let status;
      if (score == null) status = '未检查';
      else if (score >= passLine) status = '合格';
      else status = '未合格';
      return {
        teacher_id: tid,
        name: meta.name ?? `教师#${tid}`,
        subject: meta.subject ?? null,
        count: score == null ? 0 : (teacherCount.get(tid) ?? 0),
        avg_score: score == null ? null : Math.round(score * 10) / 10,
        status,
      };
    });
  }

  return res.json({
    ok: true,
    data: { overview, todo, inspection: { pass_line: passLine, groups: groupRows, by_teacher: byTeacher } },
  });
});

export default router;
