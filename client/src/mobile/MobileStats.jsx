import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import api, { errMsg } from '../api.js';

const TYPE_LABELS = { 早自习: '早自习', 正课: '正课' };

export default function MobileStats() {
  const { isAdmin, isGradeLeader } = useOutletContext();
  const [data, setData] = useState(null);
  const [types, setTypes] = useState([]);
  const [typePays, setTypePays] = useState([]);
  const [coefs, setCoefs] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [view, setView] = useState('mine'); // mine | all | standard
  const [selTeacher, setSelTeacher] = useState('');
  const [error, setError] = useState('');
  const [detailType, setDetailType] = useState(null); // 展开明细的类型
  const [detailRows, setDetailRows] = useState([]);

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const myTeacherId = user.teacher_id;

  const monthRange = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return { from: `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`, to: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` };
  };

  const loadSummary = async (teacherId) => {
    setError('');
    const { from, to } = monthRange();
    const params = { from_date: from, to_date: to };
    if (teacherId) params.teacher_id = teacherId;
    try {
      const r = await api.get('/stats/summary', { params });
      setData(r.data.data);
      setTypes(r.data.types);
    } catch (e) { setError(errMsg(e)); }
  };

  const loadStandard = async () => {
    setError('');
    try {
      const [tp, cf] = await Promise.all([api.get('/stats/type-pays'), api.get('/schedules/coefficients')]);
      setTypePays(tp.data.data);
      setCoefs(cf.data.data);
    } catch (e) { setError(errMsg(e)); }
  };

  useEffect(() => {
    (async () => {
      try { setTeachers((await api.get('/teachers')).data.data); } catch (e) { setError(errMsg(e)); }
    })();
  }, []);

  useEffect(() => {
    if (view === 'mine' && myTeacherId) loadSummary(myTeacherId);
    else if (view === 'all') loadSummary(selTeacher || null);
    else if (view === 'standard') loadStandard();
  }, [view, myTeacherId, selTeacher]);

  const mine = (data && data.length) ? data[0] : null;

  // 展开某类型的明细（日期/班级/科目/节次）
  const openDetail = async (type) => {
    if (detailType === type) { setDetailType(null); setDetailRows([]); return; }
    setDetailType(type);
    setDetailRows([]);
    const { from, to } = monthRange();
    try {
      const params = { from_date: from, to_date: to };
      if (myTeacherId) params.teacher_id = myTeacherId;
      const r = await api.get('/stats/instances', { params });
      const filtered = r.data.data.filter((x) => x.period_type === type);
      setDetailRows(filtered.sort((a, b) => (a.date + a.period_no).localeCompare(b.date + b.period_no)));
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div className="mt-title">课时查询</div>
      </div>

      <div className="mcard" style={{ padding: 8 }}>
        <div className="mstat-row">
          {myTeacherId && <button className={`mbtn ghost ${view === 'mine' ? '' : ''}`} style={{ padding: 10, fontSize: 14, background: view === 'mine' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setView('mine')}>我的课时</button>}
          {(isAdmin || isGradeLeader) && <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: view === 'all' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setView('all')}>全体课时</button>}
          <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: view === 'standard' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setView('standard')}>标准/系数</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {view === 'mine' && mine && (
        <div className="mcard">
          <div className="mcard-title">{mine.teacher_name} · 本月</div>
          <div className="mstat-row">
            <div className="mstat"><div className="mstat-v">{mine.total}</div><div className="mstat-l">原始课时</div></div>
            <div className="mstat"><div className="mstat-v">{mine.weighted_total}</div><div className="mstat-l">折算课时</div></div>
            <div className="mstat"><div className="mstat-v">{mine.pay_total}</div><div className="mstat-l">课酬(元)</div></div>
          </div>
          <div style={{ marginTop: 12 }}>
            {types.map((t) => mine[t] ? (
              <div key={t}>
                <button className="mitem" style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left' }} onClick={() => openDetail(t)}>
                  <div className="mitem-main"><div className="mitem-title">{TYPE_LABELS[t] || t}</div></div>
                  <div className="mitem-side"><span className="mitem-title">{mine[t]}</span><div className="mitem-sub">节 {detailType === t ? '▴' : '▾'}</div></div>
                </button>
                {detailType === t && (
                  <div style={{ padding: '8px 0 8px 8px' }}>
                    {detailRows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>加载中…</div>}
                    {detailRows.map((r) => (
                      <div key={r.id} className="mitem" style={{ padding: '6px 0' }}>
                        <div className="mitem-main">
                          <div className="mitem-title" style={{ fontSize: 13.5 }}>{r.date} 第{r.period_no}节 · {r.subject || '-'}</div>
                          <div className="mitem-sub">{r.class_name}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null)}
          </div>
        </div>
      )}
      {view === 'mine' && !mine && <div className="mempty">本月暂无课时记录</div>}

      {view === 'all' && (
        <>
          <div className="mfield">
            <label>选择教师（不选=全体）</label>
            <select className="minput" value={selTeacher} onChange={(e) => { setSelTeacher(e.target.value); loadSummary(e.target.value || null); }}>
              <option value="">全体</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {data?.map((e) => (
            <div key={e.teacher_id} className="mcard">
              <div className="mcard-title">{e.teacher_name}</div>
              <div className="mstat-row">
                <div className="mstat"><div className="mstat-v">{e.total}</div><div className="mstat-l">课时</div></div>
                <div className="mstat"><div className="mstat-v">{e.weighted_total}</div><div className="mstat-l">折算</div></div>
                <div className="mstat"><div className="mstat-v">{e.pay_total}</div><div className="mstat-l">课酬</div></div>
              </div>
            </div>
          ))}
          {data?.length === 0 && <div className="mempty">本月暂无课时记录</div>}
        </>
      )}

      {view === 'standard' && coefs && (
        <>
          <div className="mcard">
            <div className="mcard-title">学科系数</div>
            {coefs.subjects.map((s) => (
              <div key={s.id} className="mitem">
                <div className="mitem-main"><div className="mitem-title">{s.subject}</div></div>
                <div className="mitem-side"><span className="mitem-title">{s.coefficient}</span></div>
              </div>
            ))}
          </div>
          <div className="mcard">
            <div className="mcard-title">班额系数</div>
            {coefs.bands.map((b) => (
              <div key={b.id} className="mitem">
                <div className="mitem-main"><div className="mitem-title">≥{b.min_size} 人</div></div>
                <div className="mitem-side"><span className="mitem-title">{b.coefficient}</span></div>
              </div>
            ))}
          </div>
          <div className="mcard">
            <div className="mcard-title">按次计酬单价（元/节）</div>
            {typePays.map((t) => (
              <div key={t.id} className="mitem">
                <div className="mitem-main"><div className="mitem-title">{t.name}</div></div>
                <div className="mitem-side"><span className="mitem-title">{t.pay}</span></div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
