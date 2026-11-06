import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import api, { errMsg } from '../api.js';

// 当前月份 'YYYY-MM'
function nowYm() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

// 计钱类型：节假补课 + 按次计酬类型（晚自习/答疑/晚练/自定义）
function isMoneyType(t, typePays) {
  if (t === '节假补课') return true;
  return typePays.some((x) => x.name === t);
}

export default function MobileStats() {
  const { canViewDc, isGradeLeader } = useOutletContext();
  const canViewAll = canViewDc || isGradeLeader; // 全体课时：admin/校长/教务主任/教务员 + 年级组长
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const myTeacherId = user.teacher_id;
  const [data, setData] = useState([]);
  const [types, setTypes] = useState([]);
  const [typePays, setTypePays] = useState([]);
  const [coefs, setCoefs] = useState(null);
  const [teachers, setTeachers] = useState([]);

  // 初始视图：有绑定教师→mine；无绑定但可看全体→all；否则 standard
  const [view, setView] = useState(() => (myTeacherId ? 'mine' : (canViewAll ? 'all' : 'standard')));
  const [selTeacher, setSelTeacher] = useState('');
  const [ym, setYm] = useState(nowYm());
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null); // { teacherId, type }
  const [detailRows, setDetailRows] = useState([]);
  const [expandedTeacher, setExpandedTeacher] = useState(null); // 全体视图展开的教师 id

  // 某月份的统计区间：当月到「今天」，历史月份到「月末」
  const rangeOf = () => {
    const [y, m] = ym.split('-').map(Number);
    const from = `${ym}-01`;
    const now = new Date();
    const curYm = nowYm();
    const to = ym === curYm
      ? `${ym}-${String(now.getDate()).padStart(2, '0')}`
      : `${ym}-${new Date(y, m, 0).getDate()}`;
    return { from, to };
  };

  const rangeLabel = () => {
    const { from, to } = rangeOf();
    return `${from} ~ ${to}`;
  };

  // 无绑定教师且非管理级/只读级 → 默认「标准/系数」
  useEffect(() => {
    if (!myTeacherId && !canViewAll) setView('standard');
  }, [myTeacherId, canViewAll]);

  const loadSummary = async (teacherId) => {
    setError('');
    const { from, to } = rangeOf();
    const params = { from_date: from, to_date: to };
    if (teacherId) params.teacher_id = teacherId;
    try {
      const r = await api.get('/stats/summary', { params });
      setData(r.data.data);
      setTypes(r.data.types);
    } catch (e) { setError(errMsg(e)); }
  };

  useEffect(() => {
    (async () => {
      try {
        const [tc, tp, cf] = await Promise.all([
          api.get('/teachers'),
          api.get('/stats/type-pays'),
          api.get('/schedules/coefficients'),
        ]);
        setTeachers(tc.data.data);
        setTypePays(tp.data.data);
        setCoefs(cf.data.data);
      } catch (e) { setError(errMsg(e)); }
    })();
  }, []);

  useEffect(() => {
    if (view === 'mine' && myTeacherId) loadSummary(myTeacherId);
    else if (view === 'all') loadSummary(selTeacher || null);
  }, [view, myTeacherId, selTeacher, ym]);

  const mine = data.length ? data[0] : null;

  // 展开某教师某类型的具体上课记录。
  // 关键：节假补课是「时段(term)」列，其余是「类型(period_type)」列，过滤逻辑必须区分，否则补课明细永远为空。
  const openDetail = async (teacherId, type) => {
    if (detail && detail.teacherId === teacherId && detail.type === type) {
      setDetail(null); setDetailRows([]);
      return;
    }
    setDetail({ teacherId, type });
    setDetailRows([]);
    const { from, to } = rangeOf();
    try {
      const r = await api.get('/stats/instances', { params: { from_date: from, to_date: to, teacher_id: teacherId } });
      const filtered = r.data.data.filter((x) =>
        type === '节假补课'
          ? x.term === '节假补课'
          : (x.period_type === type && x.term !== '节假补课')
      );
      setDetailRows(filtered.sort((a, b) => (a.date + String(a.period_no).padStart(2, '0')).localeCompare(b.date + String(b.period_no).padStart(2, '0'))));
    } catch (e) { setError(errMsg(e)); }
  };

  // 某教师的类型节数行（我的课时 + 全体课时展开复用）
  const renderTypeRows = (e, teacherId) => types
    .filter((t) => e[t])
    .map((t) => {
      const isMoney = isMoneyType(t, typePays);
      const open = detail && detail.teacherId === teacherId && detail.type === t;
      return (
        <div key={t}>
          <button
            className="mitem"
            style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left', padding: '10px 0' }}
            onClick={() => openDetail(teacherId, t)}
          >
            <div className="mitem-main">
              <div className="mitem-title">
                {t}
                {isMoney && <span className="badge warn" style={{ marginLeft: 6, fontSize: 11 }}>计钱</span>}
              </div>
            </div>
            <div className="mitem-side">
              <span className="mitem-title">{e[t]}</span>
              <div className="mitem-sub">节 {open ? '▴' : '▾'}</div>
            </div>
          </button>
          {open && (
            <div style={{ padding: '8px 0 8px 8px' }}>
              {detailRows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>加载中…</div>}
              {detailRows.map((r) => (
                <div key={r.id} className="mitem" style={{ padding: '6px 0' }}>
                  <div className="mitem-main">
                    <div className="mitem-title" style={{ fontSize: 13.5 }}>
                      {r.date} 第{r.period_no}节 · {r.subject || '-'}
                      {r.term === '节假补课' && <span className="badge warn" style={{ marginLeft: 6, fontSize: 11 }}>补课</span>}
                    </div>
                    <div className="mitem-sub">{r.class_name}{r.teacher_name ? ' · ' + r.teacher_name : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    });

  // 全体视图：按课酬降序
  const sortedData = [...data].sort((a, b) => (b.pay_total || 0) - (a.pay_total || 0));

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div className="mt-title">课时查询</div>
      </div>

      <div className="mcard" style={{ padding: 8 }}>
        <div className="mstat-row">
          {myTeacherId && (
            <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: view === 'mine' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setView('mine')}>我的课时</button>
          )}
          {(canViewAll) && (
            <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: view === 'all' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setView('all')}>全体课时</button>
          )}
          <button className="mbtn ghost" style={{ padding: 10, fontSize: 14, background: view === 'standard' ? 'var(--primary-soft)' : 'transparent', border: 'none' }} onClick={() => setView('standard')}>标准/系数</button>
        </div>
      </div>

      {/* 月份切换（统计区间） */}
      {(view === 'mine' || view === 'all') && (
        <div className="mfield" style={{ marginBottom: 10 }}>
          <label>统计月份</label>
          <input type="month" className="minput" value={ym} onChange={(e) => { if (e.target.value) setYm(e.target.value); }} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>区间：{rangeLabel()}</div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {view === 'mine' && mine && (
        <div className="mcard">
          <div className="mcard-title">{mine.teacher_name} · {ym}月</div>
          <div className="mstat-row">
            <div className="mstat"><div className="mstat-v">{mine.total}</div><div className="mstat-l">原始课时</div></div>
            <div className="mstat"><div className="mstat-v">{mine.weighted_total}</div><div className="mstat-l">折算课时</div></div>
            <div className="mstat"><div className="mstat-v">{mine.pay_total}</div><div className="mstat-l">课酬(元)</div></div>
          </div>
          <div style={{ marginTop: 12 }}>
            {renderTypeRows(mine, myTeacherId)}
          </div>
        </div>
      )}
      {view === 'mine' && !mine && <div className="mempty">{ym}月暂无课时记录</div>}

      {view === 'all' && (
        <>
          <div className="mfield">
            <label>选择教师（不选=全体）</label>
            <select className="minput" value={selTeacher} onChange={(e) => { setSelTeacher(e.target.value); loadSummary(e.target.value || null); }}>
              <option value="">全体</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>共 {sortedData.length} 位教师（按课酬降序）</div>
          {sortedData.map((e) => (
            <div key={e.teacher_id} className="mcard">
              <button
                className="mcard-title"
                style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
                onClick={() => setExpandedTeacher(expandedTeacher === e.teacher_id ? null : e.teacher_id)}
              >
                <span>{e.teacher_name}{expandedTeacher === e.teacher_id ? ' ▴' : ' ▾'}</span>
              </button>
              <div className="mstat-row">
                <div className="mstat"><div className="mstat-v">{e.total}</div><div className="mstat-l">课时</div></div>
                <div className="mstat"><div className="mstat-v">{e.weighted_total}</div><div className="mstat-l">折算</div></div>
                <div className="mstat"><div className="mstat-v">{e.pay_total}</div><div className="mstat-l">课酬</div></div>
              </div>
              {expandedTeacher === e.teacher_id && (
                <div style={{ marginTop: 8 }}>
                  {renderTypeRows(e, e.teacher_id)}
                </div>
              )}
            </div>
          ))}
          {data.length === 0 && <div className="mempty">{ym}月暂无课时记录</div>}
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
