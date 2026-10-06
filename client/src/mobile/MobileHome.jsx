import React, { useEffect, useState } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import api from '../api.js';

const ROLE_LABELS = {
  admin: '管理员', 教务员: '教务员', 教务处: '教务处', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '', withdrawn: 'info' };

export default function MobileHome() {
  const { isAdmin } = useOutletContext();
  const [dash, setDash] = useState(null);
  const [mine, setMine] = useState(null);
  const [error, setError] = useState('');

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isTeacher = ['教师', '教研组长', '备课组长'].includes(user.role);
  const isGradeLeader = user.role === '年级组长';

  useEffect(() => {
    (async () => {
      try {
        const reqs = [api.get('/dashboard')];
        if (isGradeLeader) reqs.push(api.get('/dashboard/grade-leader'));
        else if (isTeacher || user.teacher_id) reqs.push(api.get('/dashboard/teacher'));
        const res = await Promise.all(reqs);
        setDash(res[0].data.data);
        if (res[1]) setMine(res[1].data.data);
      } catch (e) { setError(e?.response?.data?.error || e?.message || '加载失败'); }
    })();
  }, []);

  if (error) return <div className="alert error">{error}</div>;
  if (!dash) return <div className="mempty">加载中…</div>;

  // 本周课表按星期分组
  const weekByDay = {};
  (mine?.week_schedule || []).forEach((r) => { (weekByDay[r.day_of_week] ||= []).push(r); });

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div>
          <div className="mt-title">你好，{user?.name}</div>
          <div className="mt-sub">{ROLE_LABELS[user?.role] || user?.role} · {dash.date_str}</div>
        </div>
      </div>

      {/* ===== 教师视角 ===== */}
      {mine?.bound && (
        <>
          {/* 今日课程（时间线） */}
          <div className="mcard mcard-today">
            <div className="mcard-title">今日课程</div>
            {mine.today.length > 0 ? (
              mine.today.map((l) => (
                <div key={l.id} className="tline">
                  <div className="tline-num">{l.period_no}</div>
                  <div className="tline-main">
                    <div className="tline-subj">{l.subject || '-'}</div>
                    <div className="tline-cls">{l.class_name}{l.term && l.term !== '常规' ? ` · ${l.term}` : ''}</div>
                  </div>
                  <div className="tline-side"><span className="badge">{l.period_type}</span></div>
                </div>
              ))
            ) : (
              <div className="mempty">今天没有课</div>
            )}
          </div>

          {/* 本周课表（紧凑星期横排） */}
          {[1, 2, 3, 4, 5].some((d) => (weekByDay[d] || []).length > 0) && (
            <Link to="/m/timetable" className="mcard mcard-week mlist-link">
              <div className="mcard-title">本周课表<span className="mitem-sub">查看全部 ›</span></div>
              <div className="home-week">
                {[1, 2, 3, 4, 5].map((d) => {
                  const list = (weekByDay[d] || []).slice(0, 4);
                  return (
                    <div key={d} className="home-week-col">
                      <div className="home-week-day">{DAYS[d - 1]}</div>
                      {list.length ? list.map((r) => (
                        <div key={r.id} className="home-week-slot" title={`第${r.period_no}节 ${r.subject} ${r.class_name}`}>
                          <span className="hws-subj">{r.subject}</span>
                          <div className="hws-cls">{r.period_no}</div>
                        </div>
                      )) : <div className="home-week-slot" style={{ color: 'var(--muted)' }}>—</div>}
                    </div>
                  );
                })}
              </div>
            </Link>
          )}

          {/* 任教班级 */}
          <div className="mcard mcard-class">
            <div className="mcard-title">任教班级</div>
            {mine.taught_classes.map((c, i) => (
              <div key={i} className="mitem">
                <div className="mitem-main">
                  <div className="mitem-title">{c.name}</div>
                  <div className="mitem-sub">{c.subject || '未设学科'} · {c.lessons} 节/周</div>
                </div>
                <div className="mitem-side"><span className="badge">{c.grade}</span></div>
              </div>
            ))}
            {mine.taught_classes.length === 0 && <div className="mempty">暂未安排任教班级</div>}
          </div>

          {/* 我的申报 */}
          {mine.my_applications.length > 0 && (
            <div className="mcard mcard-apply">
              <div className="mcard-title">我的申报</div>
              {mine.my_applications.map((a) => (
                <div key={a.id} className="mitem">
                  <div className="mitem-main">
                    <div className="mitem-title">{a.period_type} · {a.grade} {a.subject}</div>
                    <div className="mitem-sub">{a.date || ''} {a.period_count ? `×${a.period_count}节` : ''}</div>
                  </div>
                  <div className="mitem-side"><span className={`badge ${STATUS_CLS[a.status]}`}>{STATUS[a.status]}</span></div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ===== 年级组长视角 ===== */}
      {isGradeLeader && mine?.bound && (
        <>
          <div className="mcard">
            <div className="mcard-title">{mine.managed_grade} · 待办</div>
            <div className="mstat-row">
              <Link to="/m/apply" className="mstat" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="mstat-v">{mine.pending_qna}</div><div className="mstat-l">待审申报</div>
              </Link>
              <Link to="/m/notices" className="mstat" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="mstat-v">{mine.unread_notices}</div><div className="mstat-l">未读通知</div>
              </Link>
            </div>
          </div>
          <div className="mcard">
            <div className="mcard-title">{mine.managed_grade} · 本月课时概览</div>
            {mine.teachers.map((t) => (
              <div key={t.teacher_id} className="mitem">
                <div className="mitem-main"><div className="mitem-title">{t.teacher_name}</div></div>
                <div className="mitem-side"><span className="mitem-title">{t.total}</span><div className="mitem-sub">节</div></div>
              </div>
            ))}
            {mine.teachers.length === 0 && <div className="mempty">本月暂无课时记录</div>}
          </div>
        </>
      )}

      {/* ===== 教务员/组长视角 ===== */}
      {isAdmin && (
        <div className="mcard">
          <div className="mcard-title">待办审核</div>
          <div className="mstat-row">
            <Link to="/applications" className="mstat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="mstat-v">{dash.todo.qna}</div><div className="mstat-l">按次计酬申报</div>
            </Link>
            <Link to="/applications" className="mstat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="mstat-v">{dash.todo.applications}</div><div className="mstat-l">课程申报</div>
            </Link>
            <Link to="/notices" className="mstat" style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="mstat-v">{dash.todo.replies}</div><div className="mstat-l">通知回复</div>
            </Link>
          </div>
        </div>
      )}

      {/* 今日校历（所有人） */}
      {dash.today?.calendar?.length > 0 && (
        <div className="mcard">
          <div className="mcard-title">今日校历</div>
          {dash.today.calendar.map((c, i) => (
            <div key={i} className="mitem">
              <div className="mitem-main"><div className="mitem-title">{c.type}</div>{c.note && <div className="mitem-sub">{c.note}</div>}</div>
              <div className="mitem-side"><span className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : 'info'}`}>{c.grade || '全校'}</span></div>
            </div>
          ))}
        </div>
      )}

      {/* 近期通知（所有人） */}
      {dash.recentNotices?.length > 0 && (
        <div className="mcard">
          <div className="mcard-title">近期通知</div>
          {dash.recentNotices.map((n) => (
            <Link key={n.id} to="/m/notices" className="mlist-link">
              <div className="mitem">
                <div className="mitem-main">
                  <div className="mitem-title">{n.title}</div>
                  <div className="mitem-sub">{n.type}{n.published_at ? ` · ${n.published_at.slice(0, 10)}` : ''}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
