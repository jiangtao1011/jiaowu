import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api.js';
import WorkCalendar from '../components/WorkCalendar.jsx';
import { KpiCard, DonutChart, ChartSkeleton, CHART_COLORS } from '../components/charts.jsx';
import { RESULT_VIEW_ROLES } from '../roles.js';

const ROLE_LABELS = {
  admin: '管理员', 校长: '校长', 教务主任: '教务主任', 教务员: '教务员', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};
const CAT_COLORS = {
  工作: '#167d6f', 会议: '#3b5bdb', 考试: '#c0392b', 检查: '#b0731f', 活动: '#7a4fb0', 其它: '#6b7280',
};
// 课务类型构成：大类配色（墨绿主系 + 琥珀金/暖色点缀，避免堆积条同质）
const TYPE_COLORS = {
  core: '#167d6f', early: '#0f5f54', late: '#3b5bdb', drill: '#7a4fb0',
  qa: '#2e8b57', comp: '#c9a24b', custom: '#c0392b', invig: '#5f3dc4', other: '#8894a3',
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

  // 课务类型构成：把 13 种细类归并为 7 个业务大类，做「总览 + 横向指标条」看板
  const typeKind = (t) => {
    if (t === '正课') return { name: '正课', key: 'core' };
    if (t === '早自习') return { name: '早自习', key: 'early' };
    if (t === '晚自习') return { name: '晚自习', key: 'late' };
    if (['晚练', '晚晚练', '午练'].includes(t)) return { name: '早晚练', key: 'drill' };
    if (t === '答疑') return { name: '答疑', key: 'qa' };
    if (t === '竞赛') return { name: '竞赛', key: 'comp' };
    if (t === '一对一' || t === '一对二' || t === '一对多') return { name: '私人定制', key: 'custom' };
    if (t && t.startsWith('监考')) return { name: '监考', key: 'invig' };
    return { name: '其它', key: 'other' };
  };
  const typeRaw = (data.lessonTypeStats || []).map((t) => ({ name: t.type, value: t.count }));
  const typeTotal = typeRaw.reduce((s, d) => s + d.value, 0);
  const typeAgg = new Map();
  for (const d of typeRaw) {
    const k = typeKind(d.name);
    if (!typeAgg.has(k.key)) typeAgg.set(k.key, { ...k, value: 0 });
    typeAgg.get(k.key).value += d.value;
  }
  const TYPE_ORDER = ['core', 'early', 'late', 'drill', 'qa', 'comp', 'custom', 'invig', 'other'];
  const typeChart = TYPE_ORDER
    .map((k) => typeAgg.get(k))
    .filter(Boolean)
    .sort((a, b) => b.value - a.value);

  // 检查达标率：按组类型，分两段展示——① 四档分布概览（一眼看全貌）② 需关注 Top3
  const passLine = 90;
  const inspGroupsOfType = [...inspGroups].filter((g) => g.type === inspType && g.avg_score != null);
  const inspChart = inspGroupsOfType
    .map((g) => ({
      name: g.name,
      subject: g.subject || '',
      grade: g.grade || '',
      leader: g.leader_name || '',
      avg: Math.round(g.avg_score * 10) / 10,
      passRate: g.pass_rate ?? 0,
      pass: (g.pass_rate ?? 0) >= passLine,
      coverage: g.coverage ?? 0,
      checked: g.checked_count ?? 0,
      total: g.teacher_count ?? 0,
    }));
  // 四档达标率分布（严重不达标 <60 / 偏低 60-79 / 接近 80-89 / 达标 ≥90）
  const passBands = [
    { key: 'bad', label: '严重不达标', range: '<60%', min: 0, max: 60 },
    { key: 'low', label: '偏低', range: '60-79%', min: 60, max: 80 },
    { key: 'near', label: '接近', range: '80-89%', min: 80, max: 90 },
    { key: 'ok', label: '达标', range: '≥90%', min: 90, max: Infinity },
  ].map((b) => ({ ...b, count: inspChart.filter((g) => g.passRate >= b.min && g.passRate < b.max).length }));
  // 需关注 Top3（达标率最低，且达标率 < 90 才叫「需关注」；全达标则显示前三名）
  const attention = inspChart
    .filter((g) => !g.pass)
    .sort((a, b) => a.passRate - b.passRate)
    .slice(0, 3);
  const totalGroups = inspChart.length;

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
          {typeChart.length === 0
            ? <div className="chart-empty">暂无课务数据</div>
            : (
              <div className="type-board">
                <div className="type-total">
                  <div className="type-total-num">{typeTotal}</div>
                  <div className="type-total-label">本区间总节数</div>
                </div>
                <div className="type-bars">
                  {typeChart.map((t) => {
                    const pct = typeTotal ? Math.round((t.value / typeTotal) * 100) : 0;
                    return (
                      <div key={t.key} className="type-bar-row">
                        <div className="type-bar-top">
                          <span className="type-bar-name"><span className="type-bar-dot" style={{ background: TYPE_COLORS[t.key] }} />{t.name}</span>
                          <span className="type-bar-val"><b>{t.value}</b><span className="type-bar-pct">{pct}%</span></span>
                        </div>
                        <div className="type-bar-track">
                          <div className="type-bar-fill" style={{ width: `${pct}%`, background: TYPE_COLORS[t.key] }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
        </div>
      </div>

      <div className="dash-charts">
        {/* 检查达标率 */}
        <div className="card">
          <div className="card-head">
            <h3>检查达标率</h3>
            <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
              {['备课组', '教研组'].map((t) => (
                <button key={t} className={`btn sm ${inspType === t ? 'primary' : ''}`} onClick={() => setInspType(t)}>{t}</button>
              ))}
              <Link to="/inspections" style={{ fontSize: 13 }}>常规检查 →</Link>
            </div>
          </div>
          {totalGroups === 0
            ? <div className="chart-empty">暂无{inspType}检查数据</div>
            : (
              <>
                {/* 四档分布概览：一眼看全貌 */}
                <div className="pass-band-track">
                  {passBands.map((b) => (
                    <div key={b.key} className={`pass-band pass-${b.key}`} style={{ width: `${totalGroups ? Math.round((b.count / totalGroups) * 100) : 0}%` }} title={`${b.label}：${b.count} 个组`} />
                  ))}
                </div>
                <div className="pass-band-legend">
                  {passBands.map((b) => (
                    <div key={b.key} className="pass-band-legend-item">
                      <span className={`pass-band-dot pass-${b.key}`} />
                      <span className="pass-band-name">{b.label}</span>
                      <span className="pass-band-range">{b.range}</span>
                      <b className={`pass-band-count pass-${b.key}`}>{b.count}</b>
                    </div>
                  ))}
                </div>

                {/* 需关注 Top3 */}
                <div className="attention-head">
                  <span className="attention-title">需关注</span>
                  <span className="attention-note">达标率最低的前 3 个组</span>
                </div>
                {attention.length === 0 ? (
                  <div className="chart-empty ok">✓ 全部组已达标</div>
                ) : (
                  <div className="attention-list">
                    {attention.map((g, i) => (
                      <div key={g.name} className="attention-item">
                        <span className={`attention-rank ${i === 0 ? 'first' : ''}`}>{i + 1}</span>
                        <div className="attention-main">
                          <div className="attention-name-line">
                            <span className="attention-name">{g.name}</span>
                            {g.subject && <span className="rank-tag">{g.subject}</span>}
                            {g.grade && <span className="rank-tag muted">{g.grade}</span>}
                            {g.leader && <span className="rank-leader">组长 {g.leader}</span>}
                          </div>
                          <div className="attention-meta">
                            <span className="attention-pr">{g.passRate}%</span>
                            <span>平均分 {g.avg}</span>
                            <span>覆盖率 {g.coverage}%</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
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
