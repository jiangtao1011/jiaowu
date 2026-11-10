import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'edu.db');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 应用管理员上传的「待恢复备份」（恢复操作写入 edu.db.restore，重启后在此生效）。
// 先校验其确为含 users 表的有效 SQLite 库，通过后把当前库另存为 pre-restore 备份再替换。
const RESTORE_PENDING = path.join(DATA_DIR, 'edu.db.restore');
if (fs.existsSync(RESTORE_PENDING)) {
  try {
    const probe = new DatabaseSync(RESTORE_PENDING, { readOnly: true });
    const ok = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    probe.close();
    if (ok) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(DB_PATH, path.join(DATA_DIR, `edu.db.pre-restore-${stamp}`));
      fs.copyFileSync(RESTORE_PENDING, DB_PATH);
    }
  } catch { /* 无效文件则忽略，不动当前库 */ }
  fs.rmSync(RESTORE_PENDING, { force: true });
}

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

// 迁移：为已存在的 schedules 表补充「时段」列（若缺失）
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

// 初始化表结构（IF NOT EXISTS，幂等）
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'teacher',
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT '行政班',
  student_count INTEGER NOT NULL DEFAULT 0,
  grade TEXT,
  parent_id INTEGER,
  subject TEXT,
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS class_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  member_class_id INTEGER NOT NULL REFERENCES classes(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS subject_coefficients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  coefficient REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS size_bands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  min_size INTEGER NOT NULL DEFAULT 0,
  coefficient REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS period_settings (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  subject TEXT,
  pay_standard TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS teacher_classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  subject TEXT,
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  subject TEXT,
  course_type TEXT NOT NULL DEFAULT '行政班',
  day_of_week INTEGER NOT NULL,
  period_no INTEGER NOT NULL,
  period_type TEXT NOT NULL DEFAULT '正课',
  term TEXT NOT NULL DEFAULT '常规',
  effective_from TEXT,
  effective_to TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS schedule_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES schedules(id),
  change_type TEXT NOT NULL,
  from_teacher_id INTEGER,
  to_teacher_id INTEGER,
  from_date TEXT,
  to_date TEXT,
  reason TEXT,
  operator_id INTEGER REFERENCES users(id),
  inserted_schedule_ids TEXT,
  prev_effective_to TEXT,
  reverted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS substitute_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id),
  type TEXT NOT NULL DEFAULT '代课',
  from_teacher_id INTEGER,
  to_teacher_id INTEGER,
  date TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '其他',
  content TEXT,
  share_token TEXT NOT NULL UNIQUE,
  publish_status TEXT NOT NULL DEFAULT 'draft',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS notice_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notices(id),
  user_id INTEGER REFERENCES users(id),
  visitor_name TEXT,
  visitor_phone TEXT,
  read_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notice_reads_notice ON notice_reads(notice_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notice_reads_user ON notice_reads(notice_id, COALESCE(user_id, 0), COALESCE(visitor_name, ''));

CREATE TABLE IF NOT EXISTS notice_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notices(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notice_attachments_notice ON notice_attachments(notice_id);

-- 通知正文图片（图文混排用）：独立于通知，正文 Markdown 里以 /api/notices/images/:id 引用
CREATE TABLE IF NOT EXISTS notice_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notice_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notices(id),
  user_id INTEGER REFERENCES users(id),
  author_name TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notice_replies_notice ON notice_replies(notice_id);

CREATE TABLE IF NOT EXISTS notice_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notices(id),
  user_id INTEGER REFERENCES users(id),
  visitor_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notice_likes_notice ON notice_likes(notice_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notice_likes_user ON notice_likes(notice_id, COALESCE(user_id, 0), COALESCE(visitor_name, ''));

CREATE TABLE IF NOT EXISTS upload_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  target_role TEXT,
  target_user_ids TEXT,
  requirement TEXT,
  deadline TEXT,
  allow_file_types TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES upload_tasks(id),
  uploader_id INTEGER REFERENCES users(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inspection_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '课堂常规',
  items TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES inspection_templates(id),
  class_id INTEGER REFERENCES classes(id),
  teacher_id INTEGER REFERENCES teachers(id),
  subject TEXT,
  day_of_week INTEGER,
  period_no INTEGER,
  data TEXT NOT NULL,
  checker_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inspection_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER NOT NULL REFERENCES inspections(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS inspection_score_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS qna_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grade TEXT,
  subject TEXT,
  teacher_id INTEGER REFERENCES teachers(id),
  class_id INTEGER REFERENCES classes(id),
  day_of_week INTEGER,
  period_no INTEGER,
  content TEXT,
  date TEXT,
  period_count INTEGER NOT NULL DEFAULT 1,
  period_type TEXT NOT NULL DEFAULT '答疑',
  status TEXT NOT NULL DEFAULT 'pending',
  filled_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS period_type_pays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pay REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS period_type_coefficients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  coefficient REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 按次计酬类型的分年级覆盖价：某类型（如晚自习）在不同年级可用不同单价。
-- 无覆盖价时回退 period_type_pays.pay 基准价。grade 为空表示全局覆盖（当前主要用「按年级」维度）。
CREATE TABLE IF NOT EXISTS period_type_grade_pays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL,
  grade TEXT NOT NULL,
  pay REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_type_grade_pays ON period_type_grade_pays(period_type, grade);

CREATE TABLE IF NOT EXISTS application_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '私人定制课',
  course_type TEXT,
  time_desc TEXT,
  duration TEXT,
  content_desc TEXT,
  deadline TEXT,
  filler_role TEXT NOT NULL DEFAULT '教师',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES application_tasks(id),
  teacher_id INTEGER REFERENCES teachers(id),
  course_name TEXT,
  course_content TEXT,
  schedule_time TEXT,
  duration TEXT,
  remark TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  filled_by INTEGER REFERENCES users(id),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS application_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_application_attachments_app ON application_attachments(application_id);

CREATE TABLE IF NOT EXISTS work_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '工作',
  note TEXT,
  remind INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_work_plan_date ON work_plan(date);

CREATE TABLE IF NOT EXISTS school_calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  grade TEXT,
  type TEXT NOT NULL DEFAULT '上课',
  make_up_for TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS lesson_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES schedules(id),
  class_id INTEGER NOT NULL REFERENCES classes(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  subject TEXT,
  date TEXT NOT NULL,
  period_no INTEGER NOT NULL,
  period_type TEXT NOT NULL DEFAULT '正课',
  term TEXT NOT NULL DEFAULT '常规',
  source TEXT NOT NULL DEFAULT 'schedule',
  source_id INTEGER,
  parent_id INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_lesson_instances_date ON lesson_instances(date);
CREATE INDEX IF NOT EXISTS idx_lesson_instances_teacher ON lesson_instances(teacher_id);
`);

// 迁移：为旧库补充 schedules.term 列
ensureColumn('schedules', 'term', "TEXT NOT NULL DEFAULT '常规'");
// 迁移：为旧库补充 schedules.course_type 列，并按班级类型回填走班
ensureColumn('schedules', 'course_type', "TEXT NOT NULL DEFAULT '行政班'");
db.exec(`
  UPDATE schedules
  SET course_type = CASE
    WHEN subject LIKE '%层' THEN '分层'
    WHEN (SELECT type FROM classes WHERE classes.id = schedules.class_id) = '走班' THEN '走班'
    ELSE '行政班'
  END
  WHERE course_type = '行政班'
    AND (subject LIKE '%层' OR class_id IN (SELECT id FROM classes WHERE type = '走班'));
`);

// 迁移：classes 增加 parent_id / subject（分层归属、走班学科）
ensureColumn('classes', 'parent_id', 'INTEGER');
ensureColumn('classes', 'subject', 'TEXT');

// 迁移：qna_lessons 增加 date / period_count（按日答疑填报）
ensureColumn('qna_lessons', 'date', 'TEXT');
ensureColumn('qna_lessons', 'period_count', 'INTEGER NOT NULL DEFAULT 1');
// 迁移：qna_lessons 增加 period_type（按次计酬类型，默认答疑）
ensureColumn('qna_lessons', 'period_type', "TEXT NOT NULL DEFAULT '答疑'");
// 迁移：qna_lessons 两级审批——年级组长一审人与时间（pending→grade_approved 由年级组长操作）
ensureColumn('qna_lessons', 'grade_reviewed_by', 'INTEGER REFERENCES users(id)');
ensureColumn('qna_lessons', 'grade_reviewed_at', 'TEXT');
// 迁移：schedules 增加 makeup_set（补课课表套号，用于多套补课课表轮换；NULL=普通课表或旧补课课表）
ensureColumn('schedules', 'makeup_set', 'INTEGER');
// 迁移：school_calendar 增加 make_up_set（补课日指定用第几套补课课表）
ensureColumn('school_calendar', 'make_up_set', 'INTEGER');

// 迁移：inspections 增加 lesson_date（被检查课的日期，课表联动定位用）
ensureColumn('inspections', 'lesson_date', 'TEXT');
// 迁移：inspections 增加 score_total / score_max / score_data（检查打分：实得/满分/维度快照）
ensureColumn('inspections', 'score_total', 'INTEGER');
ensureColumn('inspections', 'score_max', 'INTEGER');
ensureColumn('inspections', 'score_data', 'TEXT');

// 迁移：lesson_instances 增加 cancelled（停课软标记）
ensureColumn('lesson_instances', 'cancelled', 'INTEGER NOT NULL DEFAULT 0');
// 迁移：lesson_instances 增加 source_id（回链来源业务记录，如 qna_lessons.id）
ensureColumn('lesson_instances', 'source_id', 'INTEGER');

// 迁移：users 增加 teacher_id（账号↔教师档案绑定，自主申报的身份前提）
ensureColumn('users', 'teacher_id', 'INTEGER REFERENCES teachers(id)');
// 迁移：users 增加 managed_grade（负责年级，仅「年级组长」角色使用，用于批量申报年级范围限定）
ensureColumn('users', 'managed_grade', 'TEXT');
// 迁移：substitute_requests 增加 to_date（临时代课结束日期，左闭右开；空=长期）
ensureColumn('substitute_requests', 'to_date', 'TEXT');
// 迁移：schedule_changes 增加 inserted_schedule_ids / reverted（课务调整撤回支持）
ensureColumn('schedule_changes', 'inserted_schedule_ids', 'TEXT');
ensureColumn('schedule_changes', 'reverted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('schedule_changes', 'prev_effective_to', 'TEXT');
// 迁移：classes 增加 is_virtual（年级虚拟班标记，答疑「年级级计酬」用）
ensureColumn('classes', 'is_virtual', 'INTEGER NOT NULL DEFAULT 0');
// 迁移：notices 增加 target_teacher_ids（定向通知：JSON 教师 id 数组字符串，空=全校广播）
ensureColumn('notices', 'target_teacher_ids', 'TEXT');

// 迁移：课程申报改造（自定义表单 + 分享填报 + 审核计酬）
ensureColumn('application_tasks', 'form_schema', 'TEXT');           // JSON 自定义字段定义 [{key,label,type,required,options}]
ensureColumn('application_tasks', 'pay_mode', "TEXT NOT NULL DEFAULT '按次计酬'"); // 按次计酬 | 折算
ensureColumn('application_tasks', 'pay_rate', 'REAL');             // 按次计酬=单价(元/节)，折算=系数（冗余快照，实际以字典为准）
ensureColumn('application_tasks', 'period_type', 'TEXT');          // 计酬类型名（命中 period_type_pays 或 period_type_coefficients）
ensureColumn('application_tasks', 'subject', 'TEXT');              // 学科
ensureColumn('application_tasks', 'grade', 'TEXT');                // 年级（计酬挂年级虚班 + 统计归类）
ensureColumn('application_tasks', 'share_token', 'TEXT');          // 分享 token
ensureColumn('applications', 'form_data', 'TEXT');                 // JSON 教师填报值
ensureColumn('applications', 'period_count', 'INTEGER NOT NULL DEFAULT 1'); // 课时数
ensureColumn('applications', 'date', 'TEXT');                      // 上课日期（计酬必需）
ensureColumn('applications', 'class_id', 'INTEGER REFERENCES classes(id)'); // 正课折算挂班（心理/音乐等非周期课）
ensureColumn('applications', 'period_no', 'INTEGER');              // 节次（心理课记录第几节，不参与量）
ensureColumn('applications', 'subject', 'TEXT');                   // 正课折算学科快照（任务未预设时由老师填报选）

// 迁移：school_calendar 支持「年级级停课」——加 grade 列，并把唯一约束从 date 改为 (date, grade)。
// 旧表是 date UNIQUE，需重建（该表本次会话刚建、生产无真实数据，重建安全）。
if (!db.prepare(`PRAGMA table_info(school_calendar)`).all().some((c) => c.name === 'grade')) {
  db.exec(`
    ALTER TABLE school_calendar RENAME TO school_calendar_old;
    CREATE TABLE school_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      grade TEXT,
      type TEXT NOT NULL DEFAULT '上课',
      make_up_for TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE UNIQUE INDEX idx_school_calendar_date_grade ON school_calendar(date, COALESCE(grade, ''));
    INSERT INTO school_calendar (id, date, grade, type, make_up_for, note, created_at)
      SELECT id, date, NULL, type, make_up_for, note, created_at FROM school_calendar_old;
    DROP TABLE school_calendar_old;
  `);
}
// 唯一索引兜底（幂等）：旧库/新库都保证 (date, grade) 唯一
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_school_calendar_date_grade ON school_calendar(date, COALESCE(grade, ''));`);

// 迁移：角色岗位制重构（2026-11-05）——「教务处」正名为「教务主任」，现有账号自动继承。
// 幂等：已迁移过的库无「教务处」角色，不会重复执行。
db.prepare("UPDATE users SET role = '教务主任' WHERE role = '教务处'").run();

// 迁移（2026-11-06）：角色「分管领导」改名为「校长」，现有账号自动继承。
db.prepare("UPDATE users SET role = '校长' WHERE role = '分管领导'").run();

// 迁移（2026-11-09）：按次计酬课务（qna/course）生成的上课记录，节次统一记 0（无节次），
// 不再从第 1 节起递增——避免与正课第 1 节等冲突。幂等回填历史记录（仅 source IN qna/course 且 period_no>0 的置 0）。
db.prepare("UPDATE lesson_instances SET period_no = 0 WHERE source IN ('qna','course') AND period_no > 0").run();

// 初始化系数表：课时系数、班额系数（仅常规时段使用）
function seedIfEmpty(table, insert) {
  if (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0) insert();
}
seedIfEmpty('subject_coefficients', () => {
  const st = db.prepare('INSERT INTO subject_coefficients (subject, coefficient) VALUES (?,?)');
  for (const [s, c] of [['语文', 1.2], ['数学', 1.2], ['英语', 1.2], ['物理', 1.1], ['化学', 1.1], ['生物', 1.1], ['政治', 1.0], ['历史', 1.0], ['地理', 1.0], ['体育', 0.9], ['音乐', 0.9], ['美术', 0.9], ['通用技术', 0.9], ['信息技术', 0.9]]) {
    st.run(s, c);
  }
});
seedIfEmpty('size_bands', () => {
  const st = db.prepare('INSERT INTO size_bands (min_size, coefficient) VALUES (?,?)');
  // 加数语义：折算 = 节数 ×（学科系数 + 班额系数），班额系数为小增量（可负，小班减算）
  for (const [m, c] of [[0, 0], [46, 0.1], [56, 0.2]]) st.run(m, c);
});

// 课时类型设置：早自习系数、晚自习固定课酬（默认值，可在统计中心改）
function seedPeriodSetting(key, value) {
  if (!db.prepare('SELECT 1 FROM period_settings WHERE key = ?').get(key)) {
    db.prepare('INSERT INTO period_settings (key, value) VALUES (?,?)').run(key, value);
  }
}
seedPeriodSetting('early_coefficient', 0.5);   // 早自习折算系数
seedPeriodSetting('late_pay', 40);             // 晚自习固定课酬（元/节）
seedPeriodSetting('qa_pay', 30);               // 答疑固定课酬（元/节）

// 按次计酬类型字典：把 period_settings 里的晚自习/答疑固定课酬迁移进来（幂等）
function seedPeriodTypePay(name, key, fallback) {
  if (db.prepare('SELECT 1 FROM period_type_pays WHERE name = ?').get(name)) return;
  const v = Number(db.prepare('SELECT value FROM period_settings WHERE key = ?').get(key)?.value ?? fallback);
  db.prepare('INSERT INTO period_type_pays (name, pay) VALUES (?,?)').run(name, Number.isFinite(v) ? v : fallback);
}
seedPeriodTypePay('晚自习', 'late_pay', 40);
seedPeriodTypePay('答疑', 'qa_pay', 30);

// 私人定制课（一对一/一对二/一对多）：按次计酬，单价为默认值，可在「统计中心」修改。
// 幂等：已存在则不重复插入。
function seedCustomType(name, fallback) {
  if (db.prepare('SELECT 1 FROM period_type_pays WHERE name = ?').get(name)) return;
  db.prepare('INSERT INTO period_type_pays (name, pay) VALUES (?,?)').run(name, fallback);
}
seedCustomType('一对一', 100);
seedCustomType('一对二', 150);
seedCustomType('一对多', 200);

// 折算类型字典：把 period_settings 里的早自习折算系数迁移进来（幂等）
function seedPeriodTypeCoef(name, key, fallback) {
  if (db.prepare('SELECT 1 FROM period_type_coefficients WHERE name = ?').get(name)) return;
  const v = Number(db.prepare('SELECT value FROM period_settings WHERE key = ?').get(key)?.value ?? fallback);
  db.prepare('INSERT INTO period_type_coefficients (name, coefficient) VALUES (?,?)').run(name, Number.isFinite(v) ? v : fallback);
}
seedPeriodTypeCoef('早自习', 'early_coefficient', 0.5);

// 年级虚拟班：为每个年级建一个「走班」虚班（is_virtual=1），成员挂该年级所有行政班。
// 用途：答疑「针对年级、不针对班」，而 lesson_instances.class_id 是 NOT NULL，答疑计酬挂到年级虚班，
//       使统计/导出的 JOIN classes 不丢记录。按次计酬类型在 computePay 短路「单价×节数」，不吃班额系数，
//       故虚班班额不影响答疑课酬。幂等：按 name 是否已存在判断。
function seedGradeVirtualClasses() {
  const grades = db.prepare("SELECT DISTINCT grade FROM classes WHERE grade IS NOT NULL AND grade != '' ORDER BY grade").all();
  const existsName = db.prepare('SELECT id FROM classes WHERE name = ?');
  const insertCls = db.prepare('INSERT INTO classes (name, type, student_count, grade, parent_id, subject, is_virtual) VALUES (?,?,?,?,?,?,1)');
  const insertMem = db.prepare('INSERT INTO class_members (class_id, member_class_id) VALUES (?,?)');
  for (const { grade } of grades) {
    const name = `${grade}年级`;
    const existing = existsName.get(name);
    let vid;
    if (existing) {
      vid = existing.id;
      db.prepare('UPDATE classes SET is_virtual = 1 WHERE id = ?').run(vid);
    } else {
      const info = insertCls.run(name, '走班', 0, grade, null, null);
      vid = Number(info.lastInsertRowid);
    }
    // 同步成员：该年级全部行政班
    const adminClasses = db.prepare("SELECT id FROM classes WHERE type = '行政班' AND grade = ? ORDER BY id").all(grade);
    db.prepare('DELETE FROM class_members WHERE class_id = ?').run(vid);
    for (const ac of adminClasses) insertMem.run(vid, ac.id);
  }
}
seedGradeVirtualClasses();

// 通用虚班：面向「学生个人」的课务（一对一/竞赛等），不依赖年级班级。
// lesson_instances.class_id 是 NOT NULL，个人课务挂此通用虚班占位；computePay 对按次计酬/固定折算
// 不读班级（仅分年级覆盖价读 gradeOf，通用虚班 grade 为空 → 回退基准价），故不影响计酬。
function seedUniversalVirtualClass() {
  const name = '个人课务';
  const existing = db.prepare('SELECT id FROM classes WHERE name = ?').get(name);
  if (!existing) {
    db.prepare("INSERT INTO classes (name, type, student_count, grade, parent_id, subject, is_virtual) VALUES (?, '走班', 0, NULL, NULL, NULL, 1)")
      .run(name);
  } else {
    db.prepare('UPDATE classes SET is_virtual = 1 WHERE id = ?').run(existing.id);
  }
}
seedUniversalVirtualClass();

// ===== 常规检查重构（2026-10-06）：两级归类 + 按类型维度 + 周期标记 + 备课组/教研组建模 =====
db.exec(`
CREATE TABLE IF NOT EXISTS inspection_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS teacher_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '备课组',
  subject TEXT,
  grade TEXT,
  leader_id INTEGER REFERENCES teachers(id),
  is_auto INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS teacher_group_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES teacher_groups(id),
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// 课酬财务快照：财务审核通过后固化区间数据，之后重新生成上课记录/改课表/改单价均不影响已归档月份。
// snapshot JSON 存 { from_date, to_date, term, teachers, totals, typeColumns, termColumns, checked_at, checked_by }
db.exec(`
CREATE TABLE IF NOT EXISTS payroll_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  term TEXT,
  label TEXT,
  snapshot TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_snapshots_range ON payroll_snapshots(from_date, to_date);
`);

// ===== 教学业绩考核（2026-10-07）：考试类型字典 + 考试 + 备课组各率 + 成绩文件 + 教师档案 =====
db.exec(`
CREATE TABLE IF NOT EXISTS exam_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  weight REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  semester TEXT NOT NULL,
  exam_type TEXT NOT NULL,
  grade TEXT,
  exam_date TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS exam_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  group_key TEXT NOT NULL,
  group_name TEXT NOT NULL,
  rate_a REAL NOT NULL DEFAULT 0,
  rate_b REAL NOT NULL DEFAULT 0,
  rate_c REAL NOT NULL DEFAULT 0,
  rate_d REAL NOT NULL DEFAULT 0,
  rate_e REAL NOT NULL DEFAULT 0,
  total_count INTEGER,
  avg_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(exam_id, group_key)
);
CREATE INDEX IF NOT EXISTS idx_exam_scores_exam ON exam_scores(exam_id);

CREATE TABLE IF NOT EXISTS exam_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  group_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_exam_files_exam ON exam_files(exam_id);

CREATE TABLE IF NOT EXISTS teacher_assessment_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id),
  group_key TEXT NOT NULL,
  semester TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  detail TEXT,
  locked_by INTEGER REFERENCES users(id),
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(teacher_id, semester, group_key)
);
CREATE INDEX IF NOT EXISTS idx_tar_semester ON teacher_assessment_records(semester);
`);

// 预置考试类型（幂等按 name；weight 为学期考核归一化权重，0=仅留档不参与考核）
function seedExamType(name, weight, position) {
  if (!db.prepare('SELECT 1 FROM exam_types WHERE name = ?').get(name)) {
    db.prepare('INSERT INTO exam_types (name, weight, position) VALUES (?,?,?)').run(name, weight, position);
  }
}
seedExamType('期末', 1.0, 0);
seedExamType('期中', 0, 1);
seedExamType('月考', 0, 2);
seedExamType('学考', 0.5, 3);

// 迁移：exams 增加 grade（考试限定年级；空=全校）
ensureColumn('exams', 'grade', 'TEXT');

// 检查模板升格为「检查类型」：增列大类 category_id、周期属性 cycle
ensureColumn('inspection_templates', 'category_id', 'INTEGER');
ensureColumn('inspection_templates', 'cycle', "TEXT NOT NULL DEFAULT 'daily'");
// 检查类型是否启用「课表联动」（选日期/班级/节次自动带出课程信息）；材料类检查（备课本/听课本）无需联动，默认 1=需要
ensureColumn('inspection_templates', 'schedule_link', 'INTEGER NOT NULL DEFAULT 1');
// 打分维度按类型：增列 type_id
ensureColumn('inspection_score_settings', 'type_id', 'INTEGER');
// 检查记录增列周期标记 cycle_label（如「第 5 周」）
ensureColumn('inspections', 'cycle_label', 'TEXT');

// 预置检查大类（幂等按 name）
function seedInspectionCategory(name, position) {
  if (!db.prepare('SELECT 1 FROM inspection_categories WHERE name = ?').get(name)) {
    db.prepare('INSERT INTO inspection_categories (name, position) VALUES (?,?)').run(name, position);
  }
}
seedInspectionCategory('课堂常规', 0);
seedInspectionCategory('教学常规', 1);

// 归一化旧模板 name（去尾随空格），便于按 name 幂等复用
db.prepare('UPDATE inspection_templates SET name = TRIM(name)').run();

// 迁移旧模板 category 文本 -> category_id（课堂常规/先听后上 -> 课堂常规；教学常规 -> 教学常规）
{
  const cats = {};
  for (const c of db.prepare('SELECT id, name FROM inspection_categories').all()) cats[c.name] = c.id;
  const map = { 课堂常规: cats['课堂常规'], 先听后上: cats['课堂常规'], 教学常规: cats['教学常规'] };
  for (const r of db.prepare('SELECT id, category, category_id FROM inspection_templates').all()) {
    if (r.category_id == null) {
      db.prepare('UPDATE inspection_templates SET category_id = ? WHERE id = ?').run(map[r.category] ?? cats['课堂常规'], r.id);
    }
  }
}

// 迁移旧全局维度 -> 挂到「课堂常规检查」类型（旧维度语义=课堂纪律/教学准备，属课堂常规巡查）
{
  const globals = db.prepare('SELECT id FROM inspection_score_settings WHERE type_id IS NULL').all();
  if (globals.length) {
    const type = db.prepare("SELECT id FROM inspection_templates WHERE name = '课堂常规检查'").get()
      || db.prepare("SELECT id FROM inspection_templates WHERE category_id = (SELECT id FROM inspection_categories WHERE name='课堂常规') ORDER BY id LIMIT 1").get();
    if (type) db.prepare('UPDATE inspection_score_settings SET type_id = ? WHERE type_id IS NULL').run(type.id);
  }
}

// 预置检查类型 + 各自打分维度（幂等按 name；existing 只补缺失维度）
function seedInspectionType(name, categoryName, cycle, items, dims, scheduleLink = 1) {
  const cat = db.prepare('SELECT id FROM inspection_categories WHERE name = ?').get(categoryName);
  if (!cat) return;
  let type = db.prepare('SELECT id, cycle, schedule_link FROM inspection_templates WHERE name = ?').get(name);
  let typeId;
  if (type) {
    typeId = type.id;
    if (type.cycle !== cycle) db.prepare('UPDATE inspection_templates SET cycle = ? WHERE id = ?').run(cycle, typeId);
    // 材料类检查（scheduleLink=0）强制无需课表联动；联动类默认 1，可自由关闭，不强制覆盖
    if (!scheduleLink && type.schedule_link !== 0) db.prepare('UPDATE inspection_templates SET schedule_link = 0 WHERE id = ?').run(typeId);
  } else {
    const info = db.prepare('INSERT INTO inspection_templates (name, category, category_id, cycle, items, schedule_link) VALUES (?,?,?,?,?,?)')
      .run(name, categoryName, cat.id, cycle, JSON.stringify(items), scheduleLink ? 1 : 0);
    typeId = Number(info.lastInsertRowid);
  }
  const hasDim = db.prepare('SELECT 1 FROM inspection_score_settings WHERE type_id = ? LIMIT 1').get(typeId);
  if (!hasDim) {
    const ins = db.prepare('INSERT INTO inspection_score_settings (name, label, weight, position, type_id) VALUES (?,?,?,?,?)');
    dims.forEach((d, i) => ins.run(d.name, d.label, d.weight, i, typeId));
  }
}
seedInspectionType('课堂常规检查', '课堂常规', 'daily', [{ key: 'discipline', label: '课堂纪律', type: 'select', options: ['好', '良', '一般', '差'] }], [
  { name: 'discipline', label: '课堂纪律', weight: 1 },
  { name: 'teaching', label: '教学准备', weight: 2 },
]);
seedInspectionType('先听后上', '课堂常规', 'daily', [{ key: 'objective', label: '教学目标', type: 'text' }], [
  { name: 'objective', label: '教学目标', weight: 1 },
  { name: 'process', label: '教学过程', weight: 2 },
  { name: 'effect', label: '教学效果', weight: 2 },
  { name: 'quality', label: '教师素养', weight: 1 },
]);
seedInspectionType('备课本检查', '教学常规', 'periodic', [{ key: 'notes', label: '检查说明', type: 'textarea' }], [
  { name: 'writing', label: '书写规范', weight: 1 },
  { name: 'complete', label: '内容完整', weight: 1 },
  { name: 'reflect', label: '教学反思', weight: 1 },
  { name: 'schedule', label: '进度匹配', weight: 1 },
], 0);
seedInspectionType('听课本检查', '教学常规', 'periodic', [{ key: 'notes', label: '检查说明', type: 'textarea' }], [
  { name: 'record', label: '记录完整', weight: 1 },
  { name: 'comment', label: '评析质量', weight: 1 },
  { name: 'advice', label: '建议价值', weight: 1 },
], 0);

export function logAudit(userId, action, target, detail) {
  db.prepare(
    'INSERT INTO audit_logs (user_id, action, target, detail) VALUES (?,?,?,?)'
  ).run(userId ?? null, action, target ?? null, detail ?? null);
}

// 导入草稿暂存表（预览确认两阶段）：token 关联一批「已解析+已校验」的归一化行。
// confirm 阶段直接读快照写库，不重解析、不重校验。TTL 由 import-stage.js 控制清理。
db.exec(`
CREATE TABLE IF NOT EXISTS import_drafts (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id INTEGER,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_drafts_expires ON import_drafts(expires_at);
`);

export { UPLOAD_DIR, DB_PATH, DATA_DIR };
