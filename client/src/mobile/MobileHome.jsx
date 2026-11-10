import React, { useEffect, useState } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import api from '../api.js';
import { StackedBar, HBarChart, CHART_COLORS } from '../components/charts.jsx';
import MobileTopBar from './MobileTopBar.jsx';

const ROLE_LABELS = {
  admin: '管理员', 校长: '校长', 教务主任: '教务主任', 教务员: '教务员', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '', withdrawn: 'info' };
const CAT_COLORS = {
  工作: '#167d6f', 会议: '#3b5bdb', 考试: '#c0392b', 检查: '#b0731f', 活动: '#7a4fb0', 其它: '#6b7280',
};

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function MobileHome() {
  const { isAdmin, canViewDc, todo, unread } = useOutletContext();
  const [dash, setDash] = useState(null);
  const [mine, setMine] = useState(null);
  const [dc, setDc] = useState(null); // 数据看板（管理角色）
  const [expandedGroup, setExpandedGroup] = useState(null); // 检查考核展开的组
  const [inspType, setInspType] = useState('备课组'); // 备课组 | 教研组
  const [showAllGroups, setShowAllGroups] = useState(false); // 检查考核是否展开全部组
  const [error, setError] = useState('');

  // 时间范围：month / 7d / term / custom
  const [rangeKey, setRangeKey] = useState('month');
  const [customFrom, setCustomFrom] = useState(todayStr());
  const [customTo, setCustomTo] = useState(todayStr());

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isTeacher = ['教师', '教研组长', '备课组长'].includes(user.role);
  const isGradeLeader = user.role === '年级组长';

  // 由 rangeKey 计算起止日期（供 /dashboard 的 lessonTypeStats）
  const rangeOf = () => {
    const today = todayStr();
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    if (rangeKey === '7d') {
      const s = new Date(); s.setDate(s.getDate() - 6);
      return { from: `${s.getFullYear()}-${p(s.getMonth() + 1)}-${p(s.getDate())}`, to: today };
    }
    if (rangeKey === 'term') {
      // 本学期：简化按 9 月 1 日起（学年上学期），或 2 月 1 日（下学期）
      const m = d.getMonth() + 1;
      const startMonth = m >= 2 && m <= 8 ? '02-01' : '09-01';
      return { from: `${d.getFullYear()}-${startMonth}`, to: today };
    }
    if (rangeKey === 'custom') {
      return { from: customFrom || today, to: customTo || today };
    }
    // 默认本月
    return { from: `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`, to: today };
  };

  useEffect(() => {
    (async () => {
      try {
        const { from, to } = rangeOf();
        const reqs = [api.get('/dashboard', { params: { from_date: from, to_date: to } })];
        if (canViewDc) reqs.push(api.get('/datacenter', { params: { from_date: from, to_date: to } }));
        else if (isGradeLeader) reqs.push(api.get('/dashboard/grade-leader'));
        else if (isTeacher || user.teacher_id) reqs.push(api.get('/dashboard/teacher'));
        const res = await Promise.all(reqs);
        setDash(res[0].data.data);
        if (canViewDc) setDc(res[1].data.data);
        else if (res[1]) setMine(res[1].data.data);
      } catch (e) { setError(e?.response?.data?.error || e?.message || '加载失败'); }
    })();
  }, [rangeKey, customFrom, customTo]);

  if (error) return <div className="alert error">{error}</div>;
  if (!dash) return <div className="mempty">加载中…</div>;

  // 本周课表按星期分组
  const weekByDay = {};
  (mine?.week_schedule || []).forEach((r) => { (weekByDay[r.day_of_week] ||= []).push(r); });

  // 教务日历区块（work = 工作事项，cal = 上课日历），按日期分组展示
  const renderCalendar = (calendar) => {
    if (!calendar || calendar.length === 0) return null;
    const byDate = {};
    for (const c of calendar) {
      (byDate[c.date] ||= []).push(c);
    }
    const dates = Object.keys(byDate).sort();
    return (
      <div className="mcard">
        <div className="mcard-title">教务日历</div>
        {dates.map((d) => (
          <div key={d} style={{ marginBottom: 10 }}>
            <div className="mitem-sub" style={{ fontWeight: 700, marginBottom: 4 }}>{d}</div>
            {byDate[d].map((c, i) => {
              if (c.kind === 'cal') {
                return (
                  <div key={i} className="mitem">
                    <div className="mitem-main">
                      <div className="mitem-title">{c.type}</div>
                      {c.note && <div className="mitem-sub">{c.note}</div>}
                    </div>
                    <div className="mitem-side">
                      <span className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : 'info'}`}>{c.grade || '全校'}</span>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="mitem">
                  <div className="mitem-main">
                    <div className="mitem-title" style={{ textDecoration: c.done ? 'line-through' : 'none', color: c.done ? 'var(--muted)' : undefined }}>
                      {c.remind ? '🔔' : ''}{c.title}
                    </div>
                    {c.note && <div className="mitem-sub">{c.note}</div>}
                  </div>
                  <div className="mitem-side">
                    <span className="badge neutral" style={{ color: CAT_COLORS[c.category] || CAT_COLORS.其它 }}>{c.category}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  // ==================== 结果查看角色（含校长）：数据看板 ====================
  if (canViewDc && dc) {
    const { overview, todo, inspection } = dc;
    // 范围标签：跟随所选时间范围（本月/近7天/本学期/自定义），避免数字变了标签还叫「本月」
    const rangeLabel = { month: '本月', '7d': '近7天', term: '本学期', custom: '自定义' }[rangeKey] || '本月';
    const metrics = [
      { label: '班级', value: overview.classes, to: '/m' },
      { label: '教师', value: overview.teachers, to: '/m' },
      { label: '账号', value: overview.users, to: '/m' },
      { label: `${rangeLabel}课时`, value: overview.month_lessons, to: '/m/stats' },
      { label: '折算课时', value: overview.month_weighted, to: '/m/stats' },
      { label: `${rangeLabel}课酬`, value: overview.month_pay, to: '/m/stats', money: true },
      { label: '检查记录', value: overview.inspections, to: '/m/inspection' },
      { label: '待审申报', value: overview.pending_qna + overview.pending_applications, to: '/m/apply' },
    ];

    return (
      <div>
        <MobileTopBar
          hero={{
            day: dash.date_str.slice(8),
            ym: dash.date_str.slice(0, 7),
            week: '周' + '日一二三四五六'[new Date(`${dash.date_str}T00:00:00`).getDay()],
            stats: [
              { v: dash.today?.lessons ?? 0, l: '今日课节' },
              { v: (dc.todo?.qna ?? 0) + (dc.todo?.applications ?? 0), l: '待审申报' },
              { v: dc.todo?.replies ?? 0, l: '通知回复' },
            ],
            tags: [
              ...(dash.today?.calendar || []).map((c) => ({ text: c.type, tone: c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : 'info' })),
              ...(dash.today?.works || []).slice(0, 3).map((w) => ({ text: `${w.category} · ${w.title}` })),
            ],
          }}
          todo={todo}
          unread={unread}
        />

        {/* 时间范围：快捷 + 自定义 */}
        <div className="mcard" style={{ padding: 10 }}>
          <div className="mapply-chips" style={{ gap: 6 }}>
            {[{ k: 'month', l: '本月' }, { k: '7d', l: '近7天' }, { k: 'term', l: '本学期' }].map((r) => (
              <button key={r.k} className={`mapply-chip ${rangeKey === r.k ? 'on' : ''}`} style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => setRangeKey(r.k)}>{r.l}</button>
            ))}
            <button className={`mapply-chip ${rangeKey === 'custom' ? 'on' : ''}`} style={{ padding: '8px 14px', fontSize: 13 }} onClick={() => setRangeKey('custom')}>自定义</button>
          </div>
          {rangeKey === 'custom' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <input type="date" className="minput" style={{ padding: '8px 10px', fontSize: 14 }} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="muted">至</span>
              <input type="date" className="minput" style={{ padding: '8px 10px', fontSize: 14 }} value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          )}
        </div>

        {/* 核心指标总览 */}
        <div className="mcard">
          <div className="mcard-title">核心指标</div>
          <div className="dc-grid">
            {metrics.map((m) => (
              <Link key={m.label} to={m.to} className="dc-metric">
                <div className={`dc-v${m.money ? ' money' : ''}`}>{m.value}</div>
                <div className="dc-l">{m.label}</div>
              </Link>
            ))}
          </div>
        </div>

        {/* 待办审核构成（堆叠条） */}
        <div className="mcard">
          <div className="mcard-title">待办审核</div>
          {(todo.qna + todo.applications + todo.replies) === 0
            ? <div className="mempty" style={{ color: 'var(--ok)', fontWeight: 600 }}>✓ 待办已清空</div>
            : <StackedBar data={[
                { name: '课时申报', value: todo.qna },
                { name: '课程申报', value: todo.applications },
                { name: '通知回复', value: todo.replies },
              ]} height={120} />}
        </div>

        {/* 课务类型构成 */}
        <div className="mcard">
          <div className="mcard-title">课务类型构成</div>
          <StackedBar data={(dash.lessonTypeStats || []).map((t) => ({ name: t.type, value: t.count }))} height={120} />
        </div>

        {/* 检查与考核 */}
        <div className="mcard">
          <div className="mcard-title">检查与考核<span className="mitem-sub">达标线 {inspection.pass_line} 分</span></div>
          <div className="mapply-chips" style={{ gap: 6, marginBottom: 10 }}>
            {['备课组', '教研组'].map((t) => (
              <button key={t} className={`mapply-chip ${inspType === t ? 'on' : ''}`} style={{ padding: '6px 14px', fontSize: 13 }} onClick={() => { setInspType(t); setShowAllGroups(false); setExpandedGroup(null); }}>{t}</button>
            ))}
          </div>
          {(() => {
            const groups = inspection.groups.filter((g) => g.type === inspType);
            return groups.length === 0 ? <div className="mempty">暂无{inspType}检查数据</div> : null;
          })()}
          {(() => {
            // 不达标组置顶
            const sorted = [...inspection.groups]
              .filter((g) => g.type === inspType && g.avg_score != null)
              .sort((a, b) => (a.pass_rate ?? 0) - (b.pass_rate ?? 0))
              .slice(0, 8);
            const hbar = sorted.map((g) => ({ name: g.name, value: Math.round(g.avg_score * 10) / 10, color: (g.pass_rate ?? 0) >= inspection.pass_line ? 'var(--primary)' : 'var(--danger)' }));
            return hbar.length ? <HBarChart data={hbar} height={Math.max(160, hbar.length * 36)} maxValue={100} /> : null;
          })()}
          <div style={{ marginTop: 8 }}>
            {(() => {
              // 组列表：默认只显示前 5 个组，点「展开全部」显示全部
              const typedGroups = inspection.groups.filter((g) => g.type === inspType);
              const visibleGroups = showAllGroups ? typedGroups : typedGroups.slice(0, 5);
              return visibleGroups.map((g) => {
                const open = expandedGroup === g.key;
                const members = inspection.by_teacher[g.key] || [];
                const lowCoverage = g.coverage != null && g.coverage < 100;
                const lowPass = g.pass_rate != null && g.pass_rate < inspection.pass_line;
                return (
                  <div key={g.key}>
                    <button
                      className="mitem"
                      style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left' }}
                      onClick={() => setExpandedGroup(open ? null : g.key)}
                    >
                      <div className="mitem-main">
                        <div className="mitem-title">
                          {g.name}
                          {(lowCoverage || lowPass) && <span className="badge danger" style={{ marginLeft: 6, fontSize: 11 }}>需关注</span>}
                        </div>
                        <div className="mitem-sub">覆盖率 {g.coverage ?? '—'}% · 平均分 {g.avg_score ?? '—'} · 合格率 {g.pass_rate ?? '—'}%</div>
                      </div>
                      <div className="mitem-side"><span className="mitem-sub">{open ? '▴' : '▾'}</span></div>
                    </button>
                    {open && (
                      <div style={{ padding: '4px 0 8px 8px' }}>
                        {members.map((t) => (
                          <div key={t.teacher_id} className="mitem" style={{ padding: '6px 0' }}>
                            <div className="mitem-main">
                              <div className="mitem-title" style={{ fontSize: 13.5 }}>{t.name}{t.subject ? ` · ${t.subject}` : ''}</div>
                              <div className="mitem-sub">被查 {t.count} 次</div>
                            </div>
                            <div className="mitem-side">
                              <span className={`badge ${t.status === '合格' ? 'ok' : t.status === '未合格' ? 'danger' : ''}`}>{t.status === '未检查' ? '未检查' : `${t.avg_score ?? '—'} 分`}</span>
                            </div>
                          </div>
                        ))}
                        {members.length === 0 && <div className="muted" style={{ fontSize: 13 }}>该组暂无教师</div>}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
            {inspection.groups.filter((g) => g.type === inspType).length > 5 && (
              <button className="mbtn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setShowAllGroups(!showAllGroups)}>
                {showAllGroups ? '收起' : `展开全部（${inspection.groups.filter((g) => g.type === inspType).length} 组）`}
              </button>
            )}
          </div>
        </div>

        {/* 教务日历（教务主任/教务员看全部；校长看除工作外） */}
        {renderCalendar(dash.calendar)}
      </div>
    );
  }

  // ==================== 教师视角 ====================
  return (
    <div>
      <MobileTopBar
        hero={{
          day: dash.date_str.slice(8),
          ym: dash.date_str.slice(0, 7),
          week: '周' + '日一二三四五六'[new Date(`${dash.date_str}T00:00:00`).getDay()],
          stats: [
            { v: (mine?.today || []).length, l: '今日课程' },
            { v: mine?.taught_classes?.length ?? 0, l: '任教班级' },
            { v: mine?.my_applications?.length ?? 0, l: '我的申报' },
          ],
          tags: (dash.today?.calendar || []).map((c) => ({ text: c.type, tone: c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : 'info' })),
        }}
        todo={todo}
        unread={unread}
      />

      {mine?.bound && Array.isArray(mine.today) && (
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

      {/* ==================== 年级组长视角 ==================== */}
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

      {/* 上课日历（教师可见，仅上课日历、不含工作事项） */}
      {renderCalendar(dash.calendar)}

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
