import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { errMsg } from '../api.js';

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export default function MobileTimetable() {
  const [searchParams] = useSearchParams();
  const focusDay = Number(searchParams.get('day')) || 0; // 1-7
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const [rows, setRows] = useState([]);
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      if (!user.teacher_id) return setError('账号尚未绑定教师档案，无法查看我的课表');
      try {
        const [r, c] = await Promise.all([
          api.get('/schedules', { params: { teacher_id: user.teacher_id } }),
          api.get('/classes'),
        ]);
        setRows(r.data.data);
        setClasses(c.data.data);
      } catch (e) { setError(errMsg(e)); }
    })();
  }, []);

  const classById = new Map(classes.map((c) => [c.id, c.name]));

  // 按星期分组，去掉 day_of_week=0 的（补课课表等，不属于固定星期）
  const byDay = {};
  for (const r of rows) {
    if (!r.day_of_week || r.day_of_week < 1 || r.day_of_week > 7) continue;
    if (r.term && r.term !== '常规') continue; // 只看常规课表
    (byDay[r.day_of_week] ||= []).push(r);
  }
  for (const d in byDay) byDay[d].sort((a, b) => a.period_no - b.period_no);

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div className="mt-title">我的课表</div>
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

      {rows.length === 0 && !error && <div className="mempty">暂无课表，或账号未绑定教师档案</div>}
    </div>
  );
}
