import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

// 手机端课程填报页（分享链接 /course/:token 打开，需登录）
export default function CourseApply() {
  const { token } = useParams();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const toast = useToast();
  const [values, setValues] = useState({}); // 自定义字段值
  const [date, setDate] = useState(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [periodCount, setPeriodCount] = useState(1);

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

  const setVal = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = async () => {
    // 必填字段校验
    for (const f of course.form_schema || []) {
      if (f.required && !String(values[f.key] ?? '').trim()) {
        return toast.error(`请填写「${f.label}」`);
      }
    }
    if (!date) return toast.error('请选择上课日期');
    try {
      await api.post(`/applications/tasks/${course.id}/apply`, {
        form_data: values,
        period_count: periodCount,
        date,
      });
      toast.success('申报已提交，待教务主任审核');
      setValues({});
    } catch (e) { toast.error(errMsg(e)); }
  };

  if (loading) return <div className="mapply"><div className="mapply-loading">加载中…</div></div>;
  if (error && !course) return <div className="mapply"><div className="alert error">{error}</div></div>;

  const schema = course?.form_schema || [];

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
            <label>上课日期 *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="mapply-field">
            <label>课时数</label>
            <div className="mapply-stepper">
              <button type="button" onClick={() => setPeriodCount((n) => Math.max(1, n - 1))}>−</button>
              <span>{periodCount}</span>
              <button type="button" onClick={() => setPeriodCount((n) => Math.min(12, n + 1))}>+</button>
            </div>
          </div>

          <button className="mapply-submit" onClick={submit}>提交申报</button>
        </div>
      )}
    </div>
  );
}
