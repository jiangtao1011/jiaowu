import { Router } from 'express';
import { db } from '../db.js';
import { authRequired, RESULT_VIEW_ROLES } from '../auth.js';

const router = Router();
router.use(authRequired);

function localDate() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 本地日期加天数，返回 YYYY-MM-DD
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 本月最后一天 YYYY-MM-DD
function monthEnd() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(last).padStart(2, '0')}`;
}

function count(sql, ...params) {
  return Number(db.prepare(sql).get(...params).n);
}

// 通知定向可见性 SQL 片段：返回 { sql, params } 追加到 WHERE 后。
// 管理层看全部；非管理层仅看「广播 + 定向到自己」的通知。
function noticeScopeClause(user) {
  if (RESULT_VIEW_ROLES.includes(user.role)) return { sql: '', params: [] };
  const tid = user.teacher_id ?? null;
  return {
    sql: ` AND (n.target_teacher_ids IS NULL OR n.target_teacher_ids = '' OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(n.target_teacher_ids) WHERE CAST(json_each.value AS TEXT) = ?)))`,
    params: [tid, String(tid)],
  };
}

// 工作台聚合：概览计数 + 今日课务 + 待办审核 + 近期通知 + 工作提醒 + 课务类型构成
router.get('/', (req, res) => {
  const today = localDate();
  const in7 = addDays(today, 7);

  // 课务类型构成：时间范围（默认本月 1 号 ~ 今天），按 period_type 聚合节数
  const { from_date, to_date } = req.query;
  const defaultFrom = `${today.slice(0, 7)}-01`;
  const lFrom = typeof from_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from_date) ? from_date : defaultFrom;
  const lTo = typeof to_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to_date) ? to_date : today;

  const overview = {
    classes: count('SELECT COUNT(*) n FROM classes'),
    teachers: count('SELECT COUNT(*) n FROM teachers WHERE active = 1'),
    notices: count("SELECT COUNT(*) n FROM notices WHERE publish_status = 'published'"),
    inspections: count('SELECT COUNT(*) n FROM inspections'),
    work_plans: count('SELECT COUNT(*) n FROM work_plan WHERE date >= ?', today),
  };

  // 今日课务：当天未取消的上课记录 + 当天校历状态
  const todayLessons = count('SELECT COUNT(*) n FROM lesson_instances WHERE date = ? AND cancelled = 0', today);
  const todayCalendar = db.prepare('SELECT date, grade, type, note FROM school_calendar WHERE date = ? ORDER BY COALESCE(grade, \'\')').all(today);
  const todayWorks = db.prepare('SELECT * FROM work_plan WHERE date = ? ORDER BY done, id').all(today);

  // 待办审核（课程中心终审口径：待一审 + 已过年级组长一审待终审）
  const todo = {
    qna: count("SELECT COUNT(*) n FROM qna_lessons WHERE status IN ('pending','grade_approved')"),
    applications: count("SELECT COUNT(*) n FROM applications WHERE status = 'pending'"),
    replies: count("SELECT COUNT(*) n FROM notice_replies WHERE status = 'pending'"),
  };

  // 课务类型构成：时间范围内按 period_type 聚合节数（只统计未取消的记录，不含金额）
  const lessonTypeStats = db.prepare(`
    SELECT COALESCE(NULLIF(period_type, ''), '正课') AS type, COUNT(*) AS count
    FROM lesson_instances
    WHERE cancelled = 0 AND date >= ? AND date <= ?
    GROUP BY COALESCE(NULLIF(period_type, ''), '正课')
    ORDER BY count DESC`).all(lFrom, lTo);

  // 近期通知（已发布，按发布时间倒序）——定向通知仅目标教师/管理层可见
  const scope = noticeScopeClause(req.user);
  const recentNotices = db.prepare(`
    SELECT n.id, n.title, n.type, n.published_at
    FROM notices n
    WHERE n.publish_status = 'published'${scope.sql}
    ORDER BY n.published_at DESC, n.id DESC
    LIMIT 6`).all(...scope.params);

  // 工作提醒：未完成、开启提醒的事项——逾期（今天前）+ 未来 7 天
  const reminders = db.prepare(`
    SELECT * FROM work_plan
    WHERE remind = 1 AND done = 0 AND date >= ? AND date <= ?
    ORDER BY date, id`).all(today, in7);
  const overdue = db.prepare(`
    SELECT * FROM work_plan
    WHERE remind = 1 AND done = 0 AND date < ?
    ORDER BY date, id`).all(today);

  // 上传任务截止提醒（截止日 >= 今天，按截止日升序）
  const deadlines = db.prepare(`
    SELECT id, title, deadline
    FROM upload_tasks
    WHERE deadline IS NOT NULL AND deadline >= ?
    ORDER BY deadline LIMIT 5`).all(today);

  // ===== 教务日历（按角色过滤，合并工作事项 + 上课日历） =====
  // 规则：教务主任/教务员/admin 看全部；校长看「除工作类别外」的全部；教学层只看上课日历。
  // 范围：只显示「本周」（周一 ~ 周日）。
  const role = req.user.role;
  const isClerk = ['admin', '教务主任', '教务员'].includes(role);
  const isPrincipal = role === '校长';
  const isTeachingLayer = !isClerk && !isPrincipal; // 教师/教研组长/备课组长/年级组长

  // 本周范围：周一 ~ 周日
  const mondayOffset = (new Date().getDay() + 6) % 7;
  const weekStart = addDays(today, -mondayOffset);
  const weekEnd = addDays(today, 6 - mondayOffset);

  // 上课日历（校历：上课/放假/停课/补课/调课）
  // 管理层看全部；教学层只看「全校（grade 空）+ 自己任课年级」。
  let calendarCals = [];
  if (isTeachingLayer) {
    const tid = req.user.teacher_id ?? null;
    // 任课年级：从课表推导（teacher_classes 表通常为空，不能依赖）
    const taughtGrades = tid
      ? db.prepare(`
          SELECT DISTINCT c.grade FROM schedules s
          JOIN classes c ON c.id = s.class_id
          WHERE s.teacher_id = ? AND c.grade IS NOT NULL AND c.grade != ''`).all(tid).map((r) => r.grade)
      : [];
    if (taughtGrades.length === 0) {
      // 无任课年级：仅看全校校历
      calendarCals = db.prepare(`
        SELECT date, grade, type, note FROM school_calendar
        WHERE date >= ? AND date <= ? AND (grade IS NULL OR grade = '')
        ORDER BY date, COALESCE(grade, '')`).all(weekStart, weekEnd);
    } else {
      const ph = taughtGrades.map(() => '?').join(',');
      calendarCals = db.prepare(`
        SELECT date, grade, type, note FROM school_calendar
        WHERE date >= ? AND date <= ?
          AND (grade IS NULL OR grade = '' OR grade IN (${ph}))
        ORDER BY date, COALESCE(grade, '')`).all(weekStart, weekEnd, ...taughtGrades);
    }
  } else {
    calendarCals = db.prepare(`
      SELECT date, grade, type, note FROM school_calendar
      WHERE date >= ? AND date <= ? ORDER BY date, COALESCE(grade, '')`).all(weekStart, weekEnd);
  }

  // 工作事项：教务主任/教务员/admin 看全部；校长看除「工作」外；教学层不看
  let calendarWorks = [];
  if (isClerk) {
    calendarWorks = db.prepare(`
      SELECT date, title, category, note, remind, done FROM work_plan
      WHERE date >= ? AND date <= ? ORDER BY date, id`).all(weekStart, weekEnd);
  } else if (isPrincipal) {
    calendarWorks = db.prepare(`
      SELECT date, title, category, note, remind, done FROM work_plan
      WHERE date >= ? AND date <= ? AND category != '工作' ORDER BY date, id`).all(weekStart, weekEnd);
  }

  // 合并为统一日历（kind 区分来源），按日期排序
  const calendar = [
    ...calendarCals.map((c) => ({ kind: 'cal', date: c.date, type: c.type, grade: c.grade, note: c.note })),
    ...calendarWorks.map((w) => ({ kind: 'work', date: w.date, title: w.title, category: w.category, note: w.note, remind: w.remind, done: w.done })),
  ].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));

  return res.json({
    ok: true,
    data: {
      date_str: today,
      overview,
      today: { lessons: todayLessons, calendar: todayCalendar, works: todayWorks },
      todo,
      lessonTypeStats,
      recentNotices,
      reminders,
      overdue,
      deadlines,
      calendar,
    },
  });
});

// 教师个人课务聚合：今日课程、任教班级、本周课表、待审申报、未读通知数。
// 供移动端「首页」与「我的」页面使用；未绑定教师档案时返回空。
router.get('/teacher', (req, res) => {
  const tid = req.user.teacher_id ?? null;
  if (!tid) {
    return res.json({ ok: true, data: { bound: false } });
  }

  const teacher = db.prepare('SELECT id, name, subject, phone, pay_standard FROM teachers WHERE id = ?').get(tid);
  if (!teacher) return res.json({ ok: true, data: { bound: false } });

  const today = localDate();
  const in7 = addDays(today, 7);

  // 今日课程（未取消），按节次排序，带班级名/类型/时段
  const todayLessons = db.prepare(`
    SELECT li.id, li.date, li.period_no, li.subject, li.period_type, li.term, c.name AS class_name
    FROM lesson_instances li JOIN classes c ON c.id = li.class_id
    WHERE li.teacher_id = ? AND li.date = ? AND li.cancelled = 0
    ORDER BY li.period_no`).all(tid, today);

  // 任教班级：从课表（常规时段）推导，去重；含每班的学科与课时节数
  const taughtClasses = db.prepare(`
    SELECT c.id, c.name, c.grade, c.type, s.subject, COUNT(*) AS lessons
    FROM schedules s JOIN classes c ON c.id = s.class_id
    WHERE s.teacher_id = ? AND s.term = '常规' AND s.effective_to IS NULL
    GROUP BY c.id, s.subject
    ORDER BY c.grade, c.name, s.subject`).all(tid);

  // 本周课表（day_of_week 1-7），仅常规时段
  const weekSchedule = db.prepare(`
    SELECT s.id, s.day_of_week, s.period_no, s.subject, s.period_type, c.name AS class_name
    FROM schedules s JOIN classes c ON c.id = s.class_id
    WHERE s.teacher_id = ? AND s.term = '常规' AND s.effective_to IS NULL
      AND s.day_of_week BETWEEN 1 AND 7
    ORDER BY s.day_of_week, s.period_no, c.name`).all(tid);

  // 我的申报：待审核 + 已通过（近期）
  const myApplications = db.prepare(`
    SELECT q.id, q.grade, q.subject, q.period_type, q.date, q.period_count, q.status, c.name AS class_name
    FROM qna_lessons q LEFT JOIN classes c ON c.id = q.class_id
    WHERE q.teacher_id = ? AND q.status IN ('pending', 'grade_approved', 'approved')
    ORDER BY q.id DESC LIMIT 10`).all(tid);

  // 未读通知数（定向通知仅目标教师计数）
  const unreadNotices = Number(db.prepare(`
    SELECT COUNT(*) n FROM notices n
    WHERE n.publish_status = 'published'
      AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?)
      ${noticeScopeClause(req.user).sql}
  `).get(req.user.id, ...noticeScopeClause(req.user).params).n);

  return res.json({
    ok: true,
    data: {
      bound: true,
      teacher,
      today: todayLessons,
      taught_classes: taughtClasses,
      week_schedule: weekSchedule,
      my_applications: myApplications,
      unread_notices: unreadNotices,
    },
  });
});

// 年级组长视角聚合：本年级待审申报数、本年级教师本月课时概览、未读通知数。
router.get('/grade-leader', (req, res) => {
  const managedGrade = db.prepare('SELECT managed_grade FROM users WHERE id = ?').get(req.user.id)?.managed_grade || null;
  if (!managedGrade) {
    return res.json({ ok: true, data: { bound: false } });
  }

  const today = localDate();
  const fromDate = `${today.slice(0, 7)}-01`; // 本月 1 号

  // 本年级待审申报数（按次计酬）
  const pendingQna = count("SELECT COUNT(*) n FROM qna_lessons WHERE status = 'pending' AND grade = ?", managedGrade);

  // 本年级教师本月课时概览（按教师汇总，只统计该年级班级的上课记录）
  const rows = db.prepare(`
    SELECT li.teacher_id, t.name AS teacher_name, COUNT(*) AS total
    FROM lesson_instances li
    JOIN teachers t ON t.id = li.teacher_id
    JOIN classes c ON c.id = li.class_id
    WHERE li.cancelled = 0 AND c.grade = ? AND li.date >= ? AND li.date <= ?
    GROUP BY li.teacher_id
    ORDER BY total DESC`).all(managedGrade, fromDate, today);

  // 未读通知数（定向通知仅目标教师计数）
  const unreadNotices = count(`
    SELECT COUNT(*) n FROM notices n
    WHERE n.publish_status = 'published'
      AND NOT EXISTS (SELECT 1 FROM notice_reads r WHERE r.notice_id = n.id AND r.user_id = ?)
      ${noticeScopeClause(req.user).sql}
  `, req.user.id, ...noticeScopeClause(req.user).params);

  return res.json({
    ok: true,
    data: { bound: true, managed_grade: managedGrade, pending_qna: pendingQna, teachers: rows, unread_notices: unreadNotices },
  });
});

export default router;
