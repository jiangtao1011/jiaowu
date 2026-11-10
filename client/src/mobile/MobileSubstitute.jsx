import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';
import MobileTopBar from './MobileTopBar.jsx';

const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '' };

export default function MobileSubstitute() {
  const toast = useToast();
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const [tab, setTab] = useState('apply'); // apply | mine
  const [myLessons, setMyLessons] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');

  // 表单
  const [scheduleId, setScheduleId] = useState('');
  const [type, setType] = useState('代课');
  const [toTeacherId, setToTeacherId] = useState('');
  const [date, setDate] = useState('');
  const [duration, setDuration] = useState('day'); // day | range | long
  const [toDate, setToDate] = useState('');
  const [reason, setReason] = useState('');

  const load = async () => {
    setError('');
    try {
      const [s, t, r] = await Promise.all([
        api.get('/schedules', { params: { teacher_id: user.teacher_id || undefined } }),
        api.get('/teachers'),
        api.get('/schedules/requests'),
      ]);
      // 只保留常规时段、有效课表
      setMyLessons(s.data.data.filter((x) => x.term === '常规' && x.day_of_week >= 1 && x.day_of_week <= 7));
      setTeachers(t.data.data);
      setRequests(r.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const submit = async () => {
    setError('');
    if (!scheduleId) return toast.error('请选择要代/调的课');
    if (type === '调课' && !toTeacherId) return toast.error('请选择目标教师');
    if (!date) return toast.error('请选择开始日期');
    if (duration === 'range' && !toDate) return toast.error('请选择结束日期');
    if (duration === 'range' && toDate <= date) return toast.error('结束日期须晚于开始日期');
    try {
      const payload = {
        schedule_id: scheduleId, type, to_teacher_id: toTeacherId || null,
        date,
        // to_date 用「结束日次日」：单日=date+1天；区间=toDate+1天；长期=null
        to_date: duration === 'long' ? null : (duration === 'range' ? nextDay(toDate) : nextDay(date)),
        reason: reason || null,
      };
      await api.post('/schedules/requests', payload);
      toast.success('申请已提交，待教务主任审核');
      setScheduleId(''); setToTeacherId(''); setDate(''); setToDate(''); setReason(''); setDuration('day');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const withdraw = async (id) => {
    if (!(await toast.confirm('确定撤回该申请？', { danger: true }))) return;
    try { await api.delete(`/schedules/requests/${id}`); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const selectedLesson = myLessons.find((l) => l.id === Number(scheduleId));

  // 结束日 → 左闭右开区间的「次日」（[from, to) 语义）
  const nextDay = (d) => {
    const t = new Date(`${d}T00:00:00`);
    t.setDate(t.getDate() + 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };
  // 存储的 to_date（次日）→ 显示用结束日（前一天）
  const prevDay = (d) => {
    const t = new Date(`${d}T00:00:00`);
    t.setDate(t.getDate() - 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };

  return (
    <div>
      <MobileTopBar title="代课调课" sub="申请由教务主任审核后生效" />

      {error && <div className="alert error">{error}</div>}

      <div className="mcard" style={{ padding: 10 }}>
        <div className="mstat-row">
          <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: tab === 'apply' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setTab('apply')}>发起申请</button>
          <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: tab === 'mine' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setTab('mine')}>我的申请</button>
        </div>
      </div>

      {tab === 'apply' && (
        <div className="mcard">
          <div className="mcard-title">发起申请</div>
          {!user.teacher_id && <div className="mempty">账号未绑定教师档案，无法申请</div>}

          <div className="mfield">
            <label>选择我的课</label>
            <select className="minput" value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
              <option value="">请选择</option>
              {myLessons.map((l) => (
                <option key={l.id} value={l.id}>{DAYS[l.day_of_week - 1]} 第{l.period_no}节 · {l.subject} · {l.class_name}</option>
              ))}
            </select>
          </div>

          {selectedLesson && (
            <div className="mitem-sub" style={{ marginBottom: 12 }}>
              当前：{selectedLesson.class_name} · {selectedLesson.subject} · {selectedLesson.teacher_name}
            </div>
          )}

          <div className="mfield">
            <label>类型</label>
            <div className="mapply-chips">
              <button type="button" className={`mapply-chip ${type === '代课' ? 'on' : ''}`} onClick={() => setType('代课')}>代课</button>
              <button type="button" className={`mapply-chip ${type === '调课' ? 'on' : ''}`} onClick={() => setType('调课')}>调课</button>
            </div>
          </div>

          <div className="mfield">
            <label>目标教师（代课/调课到谁）</label>
            <select className="minput" value={toTeacherId} onChange={(e) => setToTeacherId(e.target.value)}>
              <option value="">请选择</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.subject || '未设学科'}）</option>)}
            </select>
          </div>

          <div className="mfield">
            <label>时长</label>
            <div className="mapply-chips">
              <button type="button" className={`mapply-chip ${duration === 'day' ? 'on' : ''}`} onClick={() => setDuration('day')}>单日</button>
              <button type="button" className={`mapply-chip ${duration === 'range' ? 'on' : ''}`} onClick={() => setDuration('range')}>日期区间</button>
              <button type="button" className={`mapply-chip ${duration === 'long' ? 'on' : ''}`} onClick={() => setDuration('long')}>长期</button>
            </div>
          </div>

          <div className="mfield">
            <label>开始日期</label>
            <input type="date" className="minput" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {duration === 'range' && (
            <div className="mfield">
              <label>结束日期（含当天，之后自动换回原教师）</label>
              <input type="date" className="minput" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
          )}

          {duration === 'day' && (
            <div className="mitem-sub" style={{ marginBottom: 12 }}>仅当天代课，次日自动换回原教师。</div>
          )}
          {duration === 'long' && (
            <div className="mitem-sub" style={{ marginBottom: 12 }}>长期换教师，不再自动换回。</div>
          )}

          <div className="mfield">
            <label>原因说明（选填）</label>
            <input className="minput" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如 因病请假" />
          </div>

          <button className="mbtn" onClick={submit}>提交申请</button>
        </div>
      )}

      {tab === 'mine' && (
        <div className="mcard">
          <div className="mcard-title">我的申请</div>
          {requests.map((r) => (
            <div key={r.id} className="mitem">
              <div className="mitem-main">
                <div className="mitem-title">{r.type} · {r.class_name} · {r.subject}</div>
                <div className="mitem-sub">
                  周{r.day_of_week} 第{r.period_no}节{r.to_teacher_name ? ` → ${r.to_teacher_name}` : ''}
                  {r.date ? (r.to_date === nextDay(r.date) ? ` · ${r.date}（单日）` : r.to_date ? ` · ${r.date}~${prevDay(r.to_date)}` : ` · ${r.date} 起（长期）`) : ''}
                </div>
              </div>
              <div className="mitem-side">
                <span className={`badge ${STATUS_CLS[r.status]}`}>{STATUS[r.status]}</span>
                {r.status === 'pending' && <button className="mapply-del" onClick={() => withdraw(r.id)}>撤回</button>}
              </div>
            </div>
          ))}
          {requests.length === 0 && <div className="mempty">暂无申请</div>}
        </div>
      )}
    </div>
  );
}
