import React, { useEffect, useMemo, useState } from 'react';
import api, { errMsg } from '../api.js';

export default function MobileInspection() {
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isAdmin = ['admin', '教务员', '教务处'].includes(user.role);
  const [types, setTypes] = useState([]);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // 表单
  const [typeId, setTypeId] = useState('');
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState('');
  const [periodNo, setPeriodNo] = useState('');
  const [lesson, setLesson] = useState(null); // 课表联动结果
  const [scores, setScores] = useState({}); // name -> score
  const [cycleLabel, setCycleLabel] = useState('');
  const [photos, setPhotos] = useState([]); // 待上传文件

  const load = async () => {
    setError('');
    try {
      const [t, c] = await Promise.all([
        api.get('/inspections/types'),
        api.get('/classes'),
      ]);
      setTypes(t.data.data.filter((x) => x.active !== 0));
      setClasses(c.data.data);
      setTypeId(t.data.data[0]?.id || '');
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const currentType = types.find((t) => t.id === Number(typeId));
  const typeDims = currentType?.dimensions || [];

  // 周期标记：周期类 + 有日期时，向后端取自动周次
  useEffect(() => {
    if (currentType?.cycle !== 'periodic' || !date) { setCycleLabel(''); return; }
    api.get('/inspections/week-label', { params: { date } })
      .then((r) => setCycleLabel(r.data.data.label || ''))
      .catch(() => setCycleLabel(''));
  }, [currentType?.id, currentType?.cycle, date]);

  // 课表联动：选日期+班级+节次后自动带出教师/科目
  const lookup = async () => {
    if (!date || !classId || !periodNo) return;
    try {
      const r = await api.get('/inspections/schedule-lookup', { params: { date, class_id: classId, period_no: periodNo } });
      setLesson(r.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (date && classId && periodNo) lookup(); }, [date, classId, periodNo]);

  const setScore = (name, v) => setScores((s) => ({ ...s, [name]: v }));

  const onFiles = (e) => setPhotos([...e.target.files]);

  if (!isAdmin) {
    return (
      <div>
        <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
          <div className="mt-title">常规检查</div>
        </div>
        <div className="alert error">无权限：常规检查仅教务员可用。</div>
      </div>
    );
  }

  const submit = async () => {
    setError(''); setMsg('');
    if (!typeId) return setError('请选择检查类型');
    if (!classId) return setError('请选择班级');
    if (!date) return setError('请选择日期');
    if (!periodNo) return setError('请选择节次');

    const scoreArr = typeDims.map((d) => ({ name: d.name, score: scores[d.name] ?? 0 }));

    try {
      const res = await api.post('/inspections', {
        type_id: Number(typeId), class_id: Number(classId),
        teacher_id: lesson?.teacher_id || null, subject: lesson?.subject || '',
        period_no: Number(periodNo), lesson_date: date,
        cycle_label: currentType?.cycle === 'periodic' ? cycleLabel : null,
        data: { class_id: Number(classId), teacher_id: lesson?.teacher_id || null, subject: lesson?.subject || '', period_no: Number(periodNo) },
        scores: scoreArr,
      });
      const id = res.data.data.id;

      // 上传照片（若有）
      if (photos.length) {
        const fd = new FormData();
        for (const f of photos) fd.append('photos', f);
        await api.post(`/inspections/${id}/photos`, fd);
      }

      setMsg('检查已提交');
      setClassId(''); setDate(''); setPeriodNo(''); setLesson(null); setScores({}); setPhotos([]); setCycleLabel('');
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div>
          <div className="mt-title">常规检查</div>
          <div className="mt-sub">选课打分、拍照上传</div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="mcard">
        <div className="mfield">
          <label>检查类型</label>
          <select className="minput" value={typeId} onChange={(e) => { setTypeId(e.target.value); setScores({}); }}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.category_name} · {t.name}{t.cycle === 'periodic' ? '（周期）' : ''}</option>)}
          </select>
        </div>

        <div className="mfield">
          <label>日期</label>
          <input type="date" className="minput" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        {currentType?.cycle === 'periodic' && (
          <div className="mfield">
            <label>周期标记</label>
            <input className="minput" value={cycleLabel} onChange={(e) => setCycleLabel(e.target.value)} placeholder="如 第6周" />
          </div>
        )}

        <div className="mfield">
          <label>班级</label>
          <select className="minput" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">请选择</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="mfield">
          <label>节次</label>
          <select className="minput" value={periodNo} onChange={(e) => setPeriodNo(e.target.value)}>
            <option value="">请选择</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((p) => <option key={p} value={p}>第{p}节</option>)}
          </select>
        </div>

        {lesson ? (
          <div className="mitem" style={{ background: 'var(--primary-soft)', borderRadius: 10, padding: '10px 12px' }}>
            <div className="mitem-main">
              <div className="mitem-title">{lesson.subject} · {lesson.teacher_name}</div>
              <div className="mitem-sub">{lesson.class_name} · 第{lesson.period_no}节</div>
            </div>
          </div>
        ) : (
          date && classId && periodNo && <div className="mitem-sub">该班该节暂无课程</div>
        )}
      </div>

      {/* 打分 */}
      {typeDims.length > 0 && (
        <div className="mcard">
          <div className="mcard-title">打分（0-100）</div>
          {typeDims.map((d) => (
            <div key={d.id ?? d.name} className="mfield">
              <label>{d.label}（权重 {d.weight}）</label>
              <input
                type="range" min="0" max="100" step="5"
                value={scores[d.name] ?? 0}
                onChange={(e) => setScore(d.name, Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div className="mitem-sub">{scores[d.name] ?? 0} 分</div>
            </div>
          ))}
        </div>
      )}

      {/* 照片 */}
      <div className="mcard">
        <div className="mcard-title">拍照上传</div>
        <input type="file" accept="image/*" multiple onChange={onFiles} />
        {photos.length > 0 && <div className="mitem-sub">已选 {photos.length} 张</div>}
      </div>

      <button className="mbtn" onClick={submit}>提交检查</button>
    </div>
  );
}
