import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

// 课程申报（课程中心终审）状态：pending 待审 → approved/rejected；审核人可撤回为 withdrawn
const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '', withdrawn: 'info' };

// 手机端课程填报页（分享链接 /course/:token 打开，需登录）。
// 按课程的计酬方式渲染三个固定场景：
//   - 正课折算（心理课）：时间、班级、节次 → 每次固定 1 课时
//   - 按次计酬（一对一）：辅导时间、时长(分钟)、学生姓名、上传辅导资料 → 节数=⌈时长/90⌉
//   - 固定折算（竞赛课）：辅导时间、学生姓名、上课内容 → 老师自填课时数
export default function CourseApply() {
  const { token } = useParams();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const toast = useToast();

  const [date, setDate] = useState(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  // 通用
  const [studentName, setStudentName] = useState(''); // 一对一：学生姓名
  const [values, setValues] = useState({});            // 固定折算：自定义字段值（form_schema 驱动）
  // 心理课（正课折算）
  const [classId, setClassId] = useState('');
  const [periodNo, setPeriodNo] = useState('');
  const [subject, setSubject] = useState('');          // 正课折算学科（任务未预设时选）
  const [classes, setClasses] = useState([]);
  // 一对一（按次计酬）
  const [duration, setDuration] = useState('');        // 时长（分钟）
  const [files, setFiles] = useState([]);              // 辅导资料附件
  // 固定折算（监考/竞赛等）
  const [periodCount, setPeriodCount] = useState(1);   // 自填课时数
  // 竞赛课收费：是否收费 + 学生名单
  const [charging, setCharging] = useState(false);
  const [students, setStudents] = useState('');        // 学生名单（每行一个姓名）
  // 我的申报记录
  const [myRecords, setMyRecords] = useState([]);
  // 一次时长（分钟），一对一按比例折算用
  const [onceDuration, setOnceDuration] = useState(90);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await api.get(`/applications/course/${token}`);
        setCourse(r.data.data);
        setError('');
      } catch (e) { setError(errMsg(e)); }
      setLoading(false);
    })();
  }, [token]);

  // 拉取我的课程申报记录（本人全部课程申报）
  const loadMyRecords = async () => {
    try { setMyRecords((await api.get('/applications/my-course-applications')).data.data); } catch { /* 忽略 */ }
  };
  useEffect(() => { loadMyRecords(); }, []);

  // 拉取一次时长配置（一对一按比例折算用），失败默认 90
  useEffect(() => {
    (async () => {
      try { setOnceDuration((await api.get('/applications/apply-duration-config')).data.data.once_duration_minutes); } catch { /* 默认 90 */ }
    })();
  }, []);

  // 心理课：拉班级列表（按课程年级过滤）
  useEffect(() => {
    if (!course || course.pay_mode !== '正课折算') return;
    (async () => {
      try {
        const r = await api.get('/classes');
        let list = r.data.data || [];
        if (course.grade) list = list.filter((c) => c.grade === course.grade);
        setClasses(list.filter((c) => c.type === '行政班'));
      } catch { setClasses([]); }
    })();
  }, [course]);

  const isPsych = course?.pay_mode === '正课折算';      // 心理课
  const isOneToOne = course?.pay_mode === '按次计酬';    // 一对一
  const isCompetition = course?.pay_mode === '固定折算' || course?.pay_mode === '折算'; // 固定折算（监考/竞赛等）
  const chargeable = !!course?.chargeable;               // 本课程是否支持收费（竞赛课）
  const schema = course?.form_schema || [];

  const setVal = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = async () => {
    if (!date) return toast.error('请选择上课日期');
    const fd = new FormData();
    fd.append('date', date);

    if (isPsych) {
      if (!classId) return toast.error('请选择上课班级');
      if (!periodNo) return toast.error('请选择节次');
      if (!course.subject && !subject) return toast.error('请选择学科');
      fd.append('class_id', classId);
      fd.append('period_no', periodNo);
      if (!course.subject) fd.append('form_data', JSON.stringify({ subject }));
    } else if (isOneToOne) {
      if (!duration || Number(duration) <= 0) return toast.error('请填写辅导时长（分钟）');
      if (!studentName.trim()) return toast.error('请填写学生姓名');
      fd.append('form_data', JSON.stringify({ duration: Number(duration), student_name: studentName.trim() }));
      for (const f of files) fd.append('attachments', f);
    } else if (chargeable) {
      // 收费竞赛课：收费则填学生名单，不收费则填课时数
      if (charging) {
        const studentList = students.split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean);
        if (!studentList.length) return toast.error('请填写学生名单（每行一个姓名）');
        fd.append('is_charge', 'true');
        fd.append('form_data', JSON.stringify({ students: studentList }));
      } else {
        fd.append('period_count', String(periodCount));
        fd.append('form_data', JSON.stringify(values));
      }
    } else {
      // 固定折算（监考/竞赛等）：字段由 form_schema 自定义驱动，必填校验
      for (const f of schema) {
        if (f.required && !String(values[f.key] ?? '').trim()) {
          return toast.error(`请填写「${f.label}」`);
        }
      }
      fd.append('period_count', String(periodCount));
      fd.append('form_data', JSON.stringify(values));
    }

    try {
      await api.post(`/applications/tasks/${course.id}/apply`, fd);
      toast.success('申报已提交，待教务主任审核');
      setStudentName(''); setValues({}); setClassId(''); setPeriodNo(''); setSubject(''); setDuration(''); setFiles([]); setPeriodCount(1); setCharging(false); setStudents('');
      loadMyRecords();
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (loading) return <div className="mapply"><div className="mapply-loading">加载中…</div></div>;
  if (error && !course) return <div className="mapply"><div className="alert error">{error}</div></div>;

  // 一对一：按比例估算次数（时长 ÷ 一次时长，保留 1 位小数）
  const estCount = (() => {
    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return null;
    const p = Number.isFinite(onceDuration) && onceDuration > 0 ? onceDuration : 90;
    return Math.round((d / p) * 10) / 10;
  })();

  return (
    <div className="mapply">
      <header className="mapply-top">
        <div className="mapply-brand">
          <div className="mapply-mark">教</div>
          <div>
            <div className="mapply-title">课程申报</div>
            <div className="mapply-sub">{course?.title || '课程中心'}</div>
          </div>
        </div>
      </header>

      {error && <div className="alert error">{error}</div>}

      {course && (
        <div className="mapply-form">
          {course.deadline && <p className="mapply-form-hint">截止：{course.deadline} 前提交</p>}

          {/* 上课日期（三场景通用） */}
          <div className="mapply-field">
            <label>上课日期 *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {/* ===== 心理课（正课折算）===== */}
          {isPsych && (
            <>
              {!course.subject && (
                <div className="mapply-field">
                  <label>学科 *</label>
                  <select className="mapply-select" value={subject} onChange={(e) => setSubject(e.target.value)}>
                    <option value="">请选择学科</option>
                    {['心理', '中医', '音乐', '美术', '体育', '信息技术', '通用技术'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <div className="mapply-field">
                <label>上课班级 *</label>
                <select className="mapply-select" value={classId} onChange={(e) => setClassId(e.target.value)}>
                  <option value="">请选择班级</option>
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                {classes.length === 0 && <p className="mapply-form-hint">暂无可选班级</p>}
              </div>
              <div className="mapply-field">
                <label>节次 *</label>
                <select className="mapply-select" value={periodNo} onChange={(e) => setPeriodNo(e.target.value)}>
                  <option value="">请选择第几节</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>第{n}节</option>)}
                </select>
              </div>
              <p className="mapply-form-hint">每次固定计 1 课时，按「学科系数 + 班额系数」折算。</p>
            </>
          )}

          {/* ===== 一对一（按次计酬）===== */}
          {isOneToOne && (
            <>
              <div className="mapply-field">
                <label>辅导时长（分钟）*</label>
                <input type="number" min="1" value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="如 90" />
                {estCount != null && <p className="mapply-form-hint">按 1 次 = {onceDuration} 分钟，本次计 {estCount} 次</p>}
              </div>
              <div className="mapply-field">
                <label>辅导学生姓名 *</label>
                <input value={studentName} onChange={(e) => setStudentName(e.target.value)} placeholder="如 张三" />
              </div>
              <div className="mapply-field">
                <label>辅导资料（可多选）</label>
                <input type="file" multiple onChange={(e) => setFiles([...e.target.files])} />
                {files.length > 0 && <p className="mapply-form-hint">已选 {files.length} 个文件</p>}
              </div>
            </>
          )}

          {/* ===== 固定折算（监考/竞赛等，字段由课程自定义）===== */}
          {isCompetition && !chargeable && (
            <>
              {schema.map((f) => (
                <div className="mapply-field" key={f.key}>
                  <label>{f.label}{f.required ? ' *' : ''}</label>
                  {f.type === 'textarea' ? (
                    <textarea rows={3} value={values[f.key] || ''} onChange={(e) => setVal(f.key, e.target.value)} />
                  ) : f.type === 'select' ? (
                    <select className="mapply-select" value={values[f.key] || ''} onChange={(e) => setVal(f.key, e.target.value)}>
                      <option value="">请选择</option>
                      {(String(f.options || '').split(/[,，]/).filter(Boolean)).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.type === 'number' ? (
                    <input type="number" value={values[f.key] || ''} onChange={(e) => setVal(f.key, e.target.value)} />
                  ) : f.type === 'date' ? (
                    <input type="date" value={values[f.key] || ''} onChange={(e) => setVal(f.key, e.target.value)} />
                  ) : (
                    <input value={values[f.key] || ''} onChange={(e) => setVal(f.key, e.target.value)} />
                  )}
                </div>
              ))}
              <div className="mapply-field">
                <label>课时数</label>
                <div className="mapply-stepper">
                  <button type="button" onClick={() => setPeriodCount((n) => Math.max(1, n - 1))}>−</button>
                  <span>{periodCount}</span>
                  <button type="button" onClick={() => setPeriodCount((n) => Math.min(12, n + 1))}>+</button>
                </div>
              </div>
            </>
          )}

          {/* ===== 收费竞赛课：收费/不收费开关 + 学生名单 ===== */}
          {isCompetition && chargeable && (
            <>
              <div className="mapply-field">
                <label>收费类型</label>
                <div className="mapply-chips">
                  <button type="button" className={`mapply-chip ${!charging ? 'on' : ''}`} onClick={() => setCharging(false)}>不收费</button>
                  <button type="button" className={`mapply-chip ${charging ? 'on' : ''}`} onClick={() => setCharging(true)}>收费</button>
                </div>
              </div>
              {!charging ? (
                <div className="mapply-field">
                  <label>课时数</label>
                  <div className="mapply-stepper">
                    <button type="button" onClick={() => setPeriodCount((n) => Math.max(1, n - 1))}>−</button>
                    <span>{periodCount}</span>
                    <button type="button" onClick={() => setPeriodCount((n) => Math.min(12, n + 1))}>+</button>
                  </div>
                  <p className="mapply-form-hint">不收费：按课时数 × 竞赛系数折算，供教学业绩考核。</p>
                </div>
              ) : (
                <div className="mapply-field">
                  <label>学生名单（每行一个姓名）*</label>
                  <textarea rows={5} value={students} onChange={(e) => setStudents(e.target.value)} placeholder={'张三\n李四\n王五'} />
                  <p className="mapply-form-hint">收费：课酬金额由教务主任审核时确定，此处只登记学生名单。</p>
                </div>
              )}
            </>
          )}

          <button className="mapply-submit" onClick={submit}>提交申报</button>
        </div>
      )}

      {course && (
        <div className="mapply-records" style={{ marginTop: 16 }}>
          <div className="mapply-records-head">
            <h3>我的申报记录</h3>
            <span className="mapply-count">{myRecords.length} 条</span>
          </div>
          {myRecords.length === 0 && <p className="mapply-empty">还没有申报记录</p>}
          {myRecords.map((r) => (
            <div key={r.id} className={`mapply-record st-${r.status}`}>
              <div className="mapply-record-body">
                <div className="mapply-record-line1">
                  <span className="mapply-record-title">{r.task_title || '课程申报'}</span>
                </div>
                <div className="mapply-record-line2">
                  {r.date || '-'}{r.pay_mode === '按次计酬'
                    ? (r.unit_count ? ` · ${r.unit_count}次` : '')
                    : (r.period_count ? ` · ${r.period_count}节` : '')}{r.class_name ? ` · ${r.class_name}` : ''}{r.subject ? ` · ${r.subject}` : ''}
                </div>
              </div>
              <div className="mapply-record-side">
                <span className={`badge ${STATUS_CLS[r.status]}`}>{STATUS[r.status]}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
