import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import WorkCalendar from '../components/WorkCalendar.jsx';
import { KpiCard, DonutChart, HBarChart, StackedBar, ChartSkeleton, CHART_COLORS } from '../components/charts.jsx';
import { RESULT_VIEW_ROLES } from '../roles.js';

const ROLE_LABELS = {
  admin: '管理员', 分管领导: '分管领导', 教务主任: '教务主任', 教务员: '教务员', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};
const CAT_COLORS = {
  工作: '#167d6f', 会议: '#3b5bdb', 考试: '#c0392b', 检查: '#b0731f', 活动: '#7a4fb0', 其它: '#6b7280',
};
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
  const [range, setRange] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }); // 起始日期，默认本月
  const [rangeTo, setRangeTo] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }); // 结束日期，默认今天
  const [inspGroups, setInspGroups] = useState([]);
  const [inspType, setInspType] = useState('备课组'); // 备课组 | 教研组

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isMgmt = RESULT_VIEW_ROLES.includes(user.role) || user.role === '年级组长';

  const load = async () => {
    try {
      const res = await api.get('/dashboard', { params: { from_date: range, to_date: rangeTo } });
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || '加载失败');
    }
  };

  // 检查达标率（管理角色才拉）
  const loadInsp = async () => {
    if (!isMgmt) return;
    try {
      const r = await api.get('/inspections/stats/groups', { params: { pass_line: 90 } });
      setInspGroups(r.data.data || []);
    } catch { /* 忽略 */ }
  };

  useEffect(() => { load(); }, [range, rangeTo]);
  useEffect(() => { loadInsp(); }, []);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <div className="page-head"><h2 className="page-title">教务工作台</h2><ChartSkeleton height={400} /></div>;

  const today = data.date_str;
  const todayWeek = WEEK[new Date(`${today}T00:00:00`).getDay()];
  const todoTotal = (data.todo.qna || 0) + (data.todo.applications || 0) + (data.todo.replies || 0);

  // 待办构成数据（环形图）
  const todoChart = [
    { name: '课时申报', value: data.todo.qna },
    { name: '课程申报', value: data.todo.applications },
    { name: '通知回复', value: data.todo.replies },
  ].filter((d) => d.value > 0);

  // 课务类型构成（堆积条）
  const typeChart = (data.lessonTypeStats || []).map((t) => ({ name: t.type, value: t.count }));

  // 检查达标率排行：按组类型分开展示，不达标置顶 + 红色
  const passLine = 90;
  const inspChart = [...inspGroups]
    .filter((g) => g.type === inspType && g.avg_score != null)
    .sort((a, b) => (a.pass_rate ?? 0) - (b.pass_rate ?? 0))
    .slice(0, 8)
    .map((g) => ({
      name: g.name,
      value: Math.round(g.avg_score * 10) / 10,
      pass: (g.pass_rate ?? 0) >= passLine,
      coverage: g.coverage,
    }));

  // ===== 个人工作台 =====
  if (!isMgmt) {
    return (
      <div>
        <div className="page-head">
          <h2 className="page-title">你好，{user?.name}</h2>
          <p className="page-sub">{ROLE_LABELS[user?.role] || user?.role} · {today} {todayWeek}</p>
        </div>
        <div className="card">
          <div className="card-head"><h3>今日课程</h3><Link to="/schedules" style={{ fontSize: 13 }}>课表 →</Link></div>
          {data.today.lessons > 0
            ? <div className="today-lesson"><div className="tl-num">{data.today.lessons}</div><div className="tl-l">今日上课节数（未取消）</div></div>
            : <p className="muted">今天没有课。</p>}
          {data.today.calendar.length > 0 && (
            <div className="today-cals">
              {data.today.calendar.map((c, i) => (
                <span key={i} className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : 'info'}`}>{c.type}{c.note ? `：${c.note}` : ''}</span>
              ))}
            </div>
          )}
        </div>
        {data.recentNotices.length > 0 && (
          <div className="card">
            <div className="card-head"><h3>近期通知</h3><Link to="/notices" style={{ fontSize: 13 }}>全部 →</Link></div>
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
        <div className="card">
          <div className="card-head"><h3>教务工作日历</h3></div>
          <WorkCalendar />
        </div>
      </div>
    );
  }

  // ===== 管理工作台 =====
  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">教务工作台</h2>
        <p className="page-sub">{today} {todayWeek} · {ROLE_LABELS[user?.role] || user?.role}</p>
      </div>

      {/* 今日 hero 条 */}
      <div className="hero-today">
        <div className="hero-date">
          <div className="hero-day">{today.slice(8)}</div>
          <div className="hero-ym">{today.slice(0, 7)} · {todayWeek}</div>
        </div>
        <div className="hero-stat">
          <div className="hero-v">{data.today.lessons}</div>
          <div className="hero-l">今日上课节数</div>
        </div>
        <div className="hero-stat">
          <div className="hero-v">{todoTotal}</div>
          <div className="hero-l">待办审核</div>
        </div>
        <div className="hero-tags">
          {data.today.calendar.map((c, i) => (
            <span key={i} className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : c.type === '调课' ? 'info' : 'primary'}`}>{c.type}</span>
          ))}
          {data.today.works.slice(0, 3).map((w) => (
            <span key={w.id} className="badge neutral">{w.category} · {w.title}</span>
          ))}
        </div>
      </div>

      {/* 时间范围 */}
      <div className="range-bar">
        <span className="range-label">统计范围</span>
        <input type="date" value={range} onChange={(e) => setRange(e.target.value)} />
        <span className="muted">至</span>
        <input type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
        <span className="muted hint">{range} ~ {rangeTo}</span>
      </div>

      {/* KPI 指标 */}
      <div className="kpi-grid">
        <KpiCard value={data.overview.classes} label="班级" to="/classes" icon="班" />
        <KpiCard value={data.overview.teachers} label="教师" to="/teachers" icon="师" />
        <KpiCard value={data.overview.notices} label="已发布通知" to="/notices" icon="告" />
        <KpiCard value={data.overview.inspections} label="检查记录" to="/inspections" icon="查" color="var(--info)" />
        <KpiCard value={data.overview.work_plans} label="未来工作事项" to="/stats" icon="事" color="var(--warn)" />
      </div>

      <div className="dash-charts">
        {/* 待办审核构成 */}
        <div className="card">
          <div className="card-head"><h3>待办审核构成</h3><Link to="/applications" style={{ fontSize: 13 }}>去处理 →</Link></div>
          {todoTotal === 0
            ? <div className="chart-empty ok">✓ 待办已清空</div>
            : (
              <div className="donut-split">
                <DonutChart data={todoChart} height={200} />
                <div className="todo-side">
                  <Link to="/applications" className="todo-side-item"><span className="dot" style={{ background: CHART_COLORS[0] }} />课时申报 <b>{data.todo.qna}</b></Link>
                  <Link to="/applications" className="todo-side-item"><span className="dot" style={{ background: CHART_COLORS[1] }} />课程申报 <b>{data.todo.applications}</b></Link>
                  <Link to="/notices" className="todo-side-item"><span className="dot" style={{ background: CHART_COLORS[2] }} />通知回复 <b>{data.todo.replies}</b></Link>
                </div>
              </div>
            )}
        </div>

        {/* 课务类型构成 */}
        <div className="card">
          <div className="card-head"><h3>课务类型构成</h3><Link to="/stats" style={{ fontSize: 13 }}>统计中心 →</Link></div>
          <StackedBar data={typeChart} />
        </div>
      </div>

      <div className="dash-charts">
        {/* 检查达标率排行 */}
        <div className="card">
          <div className="card-head">
            <h3>检查达标率排行</h3>
            <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
              {['备课组', '教研组'].map((t) => (
                <button key={t} className={`btn sm ${inspType === t ? 'primary' : ''}`} onClick={() => setInspType(t)}>{t}</button>
              ))}
              <Link to="/inspections" style={{ fontSize: 13 }}>常规检查 →</Link>
            </div>
          </div>
          {inspChart.length === 0
            ? <div className="chart-empty">暂无{inspType}检查数据</div>
            : <HBarChart data={inspChart.map((g) => ({ name: g.name, value: g.value, color: g.pass ? 'var(--primary)' : 'var(--danger)' }))} height={Math.max(180, inspChart.length * 40)} maxValue={100} />}
        </div>

        {/* 今日课务 */}
        <div className="card">
          <div className="card-head"><h3>今日课务</h3><Link to="/schedules" style={{ fontSize: 13 }}>课表与调课 →</Link></div>
          {data.today.works.length > 0 && (
            <div className="today-works">
              {data.today.works.map((w) => (
                <div key={w.id} className={`tw-item${w.done ? ' done' : ''}`}>
                  <span className="tw-dot" style={{ background: CAT_COLORS[w.category] || CAT_COLORS.其它 }} />
                  <span className="tw-title">{w.title}</span>
                  <span className="tw-cat" style={{ color: CAT_COLORS[w.category] || CAT_COLORS.其它 }}>{w.category}</span>
                </div>
              ))}
            </div>
          )}
          {data.today.works.length === 0 && <p className="muted">今天暂无工作事项。</p>}
        </div>
      </div>

      {/* 工作提醒 + 近期通知 */}
      <div className="dash-charts">
        <div className="card">
          <div className="card-head"><h3>工作提醒</h3><Link to="/stats" style={{ fontSize: 13 }}>日历登记 →</Link></div>
          {data.overdue.length > 0 && (
            <div className="rem-sec">
              <div className="rem-sec-title danger">已逾期</div>
              {data.overdue.slice(0, 5).map((w) => (
                <div key={w.id} className="rem-item"><span className="rem-date">{relDate(w.date)}</span><span className="rem-title">{w.title}</span><span className="rem-cat" style={{ color: CAT_COLORS[w.category] || CAT_COLORS.其它 }}>{w.category}</span></div>
              ))}
            </div>
          )}
          {data.reminders.length > 0 && (
            <div className="rem-sec">
              <div className="rem-sec-title">近期（7 天内）</div>
              {data.reminders.slice(0, 8).map((w) => (
                <div key={w.id} className="rem-item"><span className="rem-date">{relDate(w.date)}</span><span className="rem-title">{w.title}</span><span className="rem-cat" style={{ color: CAT_COLORS[w.category] || CAT_COLORS.其它 }}>{w.category}</span></div>
              ))}
            </div>
          )}
          {data.overdue.length === 0 && data.reminders.length === 0 && <p className="muted">暂无待提醒的工作事项。</p>}
        </div>

        <div className="card">
          <div className="card-head"><h3>近期通知</h3><Link to="/notices" style={{ fontSize: 13 }}>全部 →</Link></div>
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
      </div>

      {/* 工作日历 */}
      <div className="card">
        <div className="card-head"><h3>教务工作日历</h3><span className="muted" style={{ fontSize: 12.5 }}>登记月工作计划，开启提醒后将在工作台提示</span></div>
        <WorkCalendar />
      </div>
    </div>
  );
}
