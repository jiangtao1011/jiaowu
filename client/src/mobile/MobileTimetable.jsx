import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { errMsg } from '../api.js';
import { RESULT_VIEW_ROLES } from '../roles.js';

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function MobileTimetable() {
  const [searchParams] = useSearchParams();
  const focusDay = Number(searchParams.get('day')) || 0; // 1-7
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isManager = RESULT_VIEW_ROLES.includes(user.role) || user.role === '年级组长';

  const [rows, setRows] = useState([]);
  const [classes, setClasses] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');

  // 管理角色：全校课表筛选
  const [mode, setMode] = useState(isManager ? 'school' : 'mine'); // mine | school
  const [dim, setDim] = useState('class'); // class | teacher | time
  const [timeMode, setTimeMode] = useState('date'); // date | week
  const [fDate, setFDate] = useState(todayStr());
  const [fDay, setFDay] = useState(''); // 星期 1-7，'' = 全部
  const [fTeacher, setFTeacher] = useState('');
  const [fClass, setFClass] = useState('');
  const [teacherQuery, setTeacherQuery] = useState('');
  const [dayInstances, setDayInstances] = useState([]); // 具体日期上课记录

  useEffect(() => {
    (async () => {
      try {
        const [r, c, t] = await Promise.all([
          api.get('/schedules', { params: isManager ? {} : { teacher_id: user.teacher_id } }),
          api.get('/classes'),
          api.get('/teachers'),
        ]);
        setRows(r.data.data);
        setClasses(c.data.data);
        setTeachers(t.data.data);
      } catch (e) { setError(errMsg(e)); }
    })();
  }, [isManager]);

  // 管理角色：按具体日期查上课记录
  useEffect(() => {
    if (!isManager) return;
    (async () => {
      try {
        const r = await api.get('/stats/instances', { params: { date: fDate } });
        setDayInstances(r.data.data);
      } catch (e) { setDayInstances([]); }
    })();
  }, [isManager, fDate]);

  const classById = new Map(classes.map((c) => [c.id, c.name]));

  // ===== 全校课表模式（管理角色） =====
  if (isManager && mode === 'school') {
    // 三维度：class | teacher | time
    const grades = [...new Set(classes.map((c) => c.grade).filter(Boolean))].sort();

    // 某班/某师的课（按日期 or 星期）
    const rowsFor = (filterFn) => {
      const source = timeMode === 'week'
        ? rows.filter((r) => r.day_of_week >= 1 && r.day_of_week <= 7 && (!r.term || r.term === '常规'))
        : dayInstances;
      return source.filter((r) => filterFn(r) && (!fDay || timeMode !== 'week' || String(r.day_of_week) === fDay));
    };

    return (
      <div>
        <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
          <div className="mt-title">课表查询</div>
          <div className="mapply-chips" style={{ gap: 4 }}>
            <button className={`mapply-chip ${mode === 'school' ? 'on' : ''}`} style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setMode('school')}>全校</button>
            {user.teacher_id && <button className={`mapply-chip ${mode === 'mine' ? 'on' : ''}`} style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setMode('mine')}>我的课表</button>}
          </div>
        </div>

        {error && <div className="alert error">{error}</div>}

        {/* 维度切换 */}
        <div className="mcard" style={{ padding: 10 }}>
          <div className="mapply-chips" style={{ gap: 6 }}>
            {[{ k: 'class', l: '按班级' }, { k: 'teacher', l: '按教师' }, { k: 'time', l: '按时间' }].map((x) => (
              <button key={x.k} className={`mapply-chip ${dim === x.k ? 'on' : ''}`} style={{ padding: '8px 16px', fontSize: 14 }} onClick={() => setDim(x.k)}>{x.l}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
            <button className={`mapply-chip ${timeMode === 'date' ? 'on' : ''}`} style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setTimeMode('date')}>按日期</button>
            <button className={`mapply-chip ${timeMode === 'week' ? 'on' : ''}`} style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setTimeMode('week')}>按星期</button>
            {timeMode === 'week' && (
              <select className="mapply-select" style={{ padding: '6px 10px', fontSize: 13, flex: 1 }} value={fDay} onChange={(e) => setFDay(e.target.value)}>
                <option value="">全部星期</option>
                {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{DAYS[d - 1]}</option>)}
              </select>
            )}
            {timeMode === 'date' && (
              <input type="date" className="minput" style={{ padding: '6px 10px', fontSize: 14, flex: 1 }} value={fDate} onChange={(e) => setFDate(e.target.value)} />
            )}
          </div>
        </div>

        {/* 按班级 */}
        {dim === 'class' && (
          <div className="mcard">
            <div className="mcard-title">选择班级</div>
            {grades.map((g) => (
              <div key={g} style={{ marginBottom: 10 }}>
                <div className="mitem-sub" style={{ fontWeight: 700, marginBottom: 4 }}>{g}</div>
                <div className="mapply-chips" style={{ gap: 6 }}>
                  {classes.filter((c) => c.grade === g && c.type === '行政班').sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true })).map((c) => (
                    <button key={c.id} className={`mapply-chip ${fClass === String(c.id) ? 'on' : ''}`} style={{ padding: '8px 14px', fontSize: 14 }} onClick={() => setFClass(String(c.id))}>{c.name}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 按教师 */}
        {dim === 'teacher' && (
          <div className="mcard">
            <div className="mcard-title">选择教师</div>
            <input className="minput" placeholder="搜索教师姓名" value={teacherQuery} onChange={(e) => setTeacherQuery(e.target.value)} style={{ marginBottom: 10 }} />
            <div className="mapply-teacher-list" style={{ maxHeight: 'none', border: 'none', padding: 0 }}>
              {teachers.filter((t) => !teacherQuery || t.name.includes(teacherQuery)).map((t) => (
                <button key={t.id} className={`mapply-teacher-item ${fTeacher === String(t.id) ? 'on' : ''}`} onClick={() => setFTeacher(String(t.id))}>
                  <span className="mapply-teacher-name">{t.name}</span>
                  <span className="mapply-teacher-subj">{t.subject || '未设学科'}</span>
                  <span className="mapply-teacher-check">{fTeacher === String(t.id) ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 结果列表 */}
        {(fClass || fTeacher || dim === 'time') && (
          <div className="mcard">
            <div className="mcard-title">
              {(() => {
                if (fClass) return `${classById.get(Number(fClass)) || ''} · ${timeMode === 'date' ? fDate : (fDay ? DAYS[fDay - 1] : '全部星期')}`;
                if (fTeacher) return `${teachers.find((t) => String(t.id) === fTeacher)?.name || ''} · ${timeMode === 'date' ? fDate : (fDay ? DAYS[fDay - 1] : '全部星期')}`;
                return `${timeMode === 'date' ? fDate : (fDay ? DAYS[fDay - 1] : '全部星期')} 全校课务`;
              })()}
            </div>
            {(() => {
              let list;
              if (fClass) list = rowsFor((r) => String(r.class_id) === fClass);
              else if (fTeacher) list = rowsFor((r) => String(r.teacher_id) === fTeacher);
              else list = rowsFor(() => true);
              list = list.sort((a, b) => (a.period_no - b.period_no) || (a.class_name || '').localeCompare(b.class_name || ''));
              if (list.length === 0) return <div className="mempty">暂无课程记录</div>;
              return list.map((r) => (
                <div key={r.id} className="mitem">
                  <div className="mitem-main">
                    <div className="mitem-title">第{r.period_no}节 · {r.subject || '-'}</div>
                    <div className="mitem-sub">{r.class_name} · {r.teacher_name}{r.cancelled ? ' · 已停' : ''}</div>
                  </div>
                  <div className="mitem-side"><span className="badge">{r.period_type}</span></div>
                </div>
              ));
            })()}
          </div>
        )}
      </div>
    );
  }

  // ===== 我的课表模式（教师本人 / 管理角色点「我的课表」） =====
  // 管理角色点「我的课表」时，按自己绑定的教师档案过滤
  const myRows = user.teacher_id ? rows.filter((r) => r.teacher_id === user.teacher_id) : rows;
  const byDay = {};
  for (const r of myRows) {
    if (!r.day_of_week || r.day_of_week < 1 || r.day_of_week > 7) continue;
    if (r.term && r.term !== '常规') continue;
    (byDay[r.day_of_week] ||= []).push(r);
  }
  for (const d in byDay) byDay[d].sort((a, b) => a.period_no - b.period_no);

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div className="mt-title">我的课表</div>
        {isManager && (
          <div className="mapply-chips" style={{ gap: 4 }}>
            <button className={`mapply-chip ${mode === 'school' ? 'on' : ''}`} style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setMode('school')}>全校</button>
            <button className={`mapply-chip ${mode === 'mine' ? 'on' : ''}`} style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => setMode('mine')}>我的课表</button>
          </div>
        )}
      </div>

      {error && <div className="alert error">{error}</div>}

      {[1, 2, 3, 4, 5, 6, 7].map((d) => {
        const list = byDay[d] || [];
        if (!list.length) return null;
        return (
          <div key={d} className="mcard" style={focusDay === d ? { borderColor: 'var(--primary)' } : undefined}>
            <div className="mcard-title">{DAYS[d - 1]}</div>
            {list.map((r) => (
              <div key={r.id} className="mitem">
                <div className="mitem-main">
                  <div className="mitem-title">第{r.period_no}节 · {r.subject || '-'}</div>
                  <div className="mitem-sub">{classById.get(r.class_id) || '-'}</div>
                </div>
                <div className="mitem-side"><span className="badge">{r.period_type}</span></div>
              </div>
            ))}
          </div>
        );
      })}

      {myRows.length === 0 && !error && <div className="mempty">暂无课表，或账号未绑定教师档案</div>}
    </div>
  );
}
