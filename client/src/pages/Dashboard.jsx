import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import WorkCalendar from '../components/WorkCalendar.jsx';

const ROLE_LABELS = {
  admin: '管理员', 教务员: '教务员', 教务处: '教务处', 教研组长: '教研组长', 备课组长: '备课组长', 教师: '教师',
};
const CAT_COLORS = {
  工作: '#167d6f', 会议: '#3b5bdb', 考试: '#c0392b', 检查: '#b0731f', 活动: '#7a4fb0', 其它: '#6b7280',
};

// 相对日期文案
function relDate(dateStr) {
  if (!dateStr) return '';
  const today = new Date();
  const t0 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (dateStr === t0) return '今天';
  const d = new Date(`${dateStr}T00:00:00`);
  const diff = Math.round((d - new Date(`${t0}T00:00:00`)) / 86400000);
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff > 1 && diff <= 7) return `${diff} 天后`;
  if (diff < -1 && diff >= -7) return `${-diff} 天前`;
  return dateStr;
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/dashboard');
        setData(res.data.data);
      } catch (e) {
        setError(e?.response?.data?.error || e?.message || '加载失败');
      }
    })();
  }, []);

  if (error) return <div className="alert error">{error}</div>;

  const loading = !data;

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">教务工作台</h2>
        <p className="page-sub">
          {loading ? '加载中…' : `${data.date_str} · 今日课程 ${data.today.lessons} 节`}
        </p>
      </div>

      {/* 概览卡片 */}
      <div className="ov-grid">
        <Link to="/classes" className="ov-card">
          <div className="ov-v">{loading ? '—' : data.overview.classes}</div>
          <div className="ov-l">班级</div>
        </Link>
        <Link to="/teachers" className="ov-card">
          <div className="ov-v">{loading ? '—' : data.overview.teachers}</div>
          <div className="ov-l">教师</div>
        </Link>
        <Link to="/notices" className="ov-card">
          <div className="ov-v">{loading ? '—' : data.overview.notices}</div>
          <div className="ov-l">已发布通知</div>
        </Link>
        <Link to="/inspections" className="ov-card">
          <div className="ov-v">{loading ? '—' : data.overview.inspections}</div>
          <div className="ov-l">检查记录</div>
        </Link>
      </div>

      {!loading && (
        <div className="dash-grid">
          {/* 左列：今日课务 + 待办审核 */}
          <div className="dash-col">
            {/* 今日课务 */}
            <div className="card">
              <div className="card-head">
                <h3>今日课务</h3>
                <Link to="/schedules" style={{ fontSize: 13 }}>课表与调课 →</Link>
              </div>
              {data.today.calendar.length > 0 && (
                <div className="today-cals">
                  {data.today.calendar.map((c, i) => (
                    <span key={i} className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : c.type === '调课' ? 'info' : 'primary'}`}>
                      {c.type}{c.note ? `：${c.note}` : ''}
                    </span>
                  ))}
                </div>
              )}
              <div className="today-lesson">
                <div className="tl-num">{data.today.lessons}</div>
                <div className="tl-l">今日上课节数（未取消）</div>
              </div>
              {data.today.works.length > 0 && (
                <div className="today-works">
                  <div className="sec-label">今日工作事项</div>
                  {data.today.works.map((w) => (
                    <div key={w.id} className={`tw-item${w.done ? ' done' : ''}`}>
                      <span className="tw-dot" style={{ background: CAT_COLORS[w.category] || CAT_COLORS.其它 }} />
                      <span className="tw-title">{w.title}</span>
                      <span className="tw-cat" style={{ color: CAT_COLORS[w.category] || CAT_COLORS.其它 }}>{w.category}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 待办审核 */}
            <div className="card">
              <div className="card-head">
                <h3>待办审核</h3>
                <Link to="/applications" style={{ fontSize: 13 }}>课务申报 →</Link>
              </div>
              <div className="todo-list">
                <Link to="/applications" className="todo-item">
                  <span className="todo-name">课时申报</span>
                  <span className={`todo-num${data.todo.qna ? ' on' : ''}`}>{data.todo.qna}</span>
                </Link>
                <Link to="/applications" className="todo-item">
                  <span className="todo-name">课程申报</span>
                  <span className={`todo-num${data.todo.applications ? ' on' : ''}`}>{data.todo.applications}</span>
                </Link>
                <Link to="/notices" className="todo-item">
                  <span className="todo-name">通知回复</span>
                  <span className={`todo-num${data.todo.replies ? ' on' : ''}`}>{data.todo.replies}</span>
                </Link>
              </div>
            </div>
          </div>

          {/* 右列：工作提醒 + 截止 */}
          <div className="dash-col">
            <div className="card">
              <div className="card-head">
                <h3>工作提醒</h3>
                <Link to="/stats" style={{ fontSize: 13 }}>日历登记 →</Link>
              </div>
              {data.overdue.length > 0 && (
                <div className="rem-sec">
                  <div className="rem-sec-title danger">已逾期</div>
                  {data.overdue.slice(0, 5).map((w) => (
                    <div key={w.id} className="rem-item">
                      <span className="rem-date">{relDate(w.date)}</span>
                      <span className="rem-title">{w.title}</span>
                      <span className="rem-cat" style={{ color: CAT_COLORS[w.category] || CAT_COLORS.其它 }}>{w.category}</span>
                    </div>
                  ))}
                </div>
              )}
              {data.reminders.length > 0 && (
                <div className="rem-sec">
                  <div className="rem-sec-title">近期（7 天内）</div>
                  {data.reminders.slice(0, 8).map((w) => (
                    <div key={w.id} className="rem-item">
                      <span className="rem-date">{relDate(w.date)}</span>
                      <span className="rem-title">{w.title}</span>
                      <span className="rem-cat" style={{ color: CAT_COLORS[w.category] || CAT_COLORS.其它 }}>{w.category}</span>
                    </div>
                  ))}
                </div>
              )}
              {data.overdue.length === 0 && data.reminders.length === 0 && (
                <p className="muted">暂无待提醒的工作事项。</p>
              )}
              {data.deadlines.length > 0 && (
                <div className="rem-sec">
                  <div className="rem-sec-title">资料上传截止</div>
                  {data.deadlines.map((t) => (
                    <Link key={t.id} to="/uploads" className="rem-item">
                      <span className="rem-date">{relDate(t.deadline)}</span>
                      <span className="rem-title">{t.title}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 近期通知 */}
      {!loading && data.recentNotices.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>近期通知</h3>
            <Link to="/notices" style={{ fontSize: 13 }}>全部通知 →</Link>
          </div>
          <div className="notice-list">
            {data.recentNotices.map((n) => (
              <Link key={n.id} to="/notices" className="notice-row">
                <span className="badge">{n.type}</span>
                <span className="notice-row-title">{n.title}</span>
                <span className="muted">{n.published_at ? n.published_at.slice(0, 10) : ''}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 教务工作日历 */}
      <div className="card">
        <div className="card-head">
          <h3>教务工作日历</h3>
          <span className="muted" style={{ fontSize: 12.5 }}>登记月工作计划，开启提醒后将在工作台提示</span>
        </div>
        <WorkCalendar />
      </div>
    </div>
  );
}
