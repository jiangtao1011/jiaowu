import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';

// 教师业绩档案（只读）：查看自己已固化的学期考核分
export default function MobileAssessment() {
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setError('');
      try {
        const r = await api.get('/assessment/my-record');
        setRecords(r.data.data);
      } catch (e) { setError(errMsg(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const parseDetail = (raw) => {
    try { return JSON.parse(raw); } catch { return null; }
  };

  return (
    <div className="minsp">
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div className="mt-title">我的业绩</div>
        <div className="mt-sub">学期考核分（按备课组）</div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {loading && <div className="mempty">加载中…</div>}

      {!loading && records.length === 0 && (
        <div className="mempty">暂无已固化的业绩档案，请联系教务处固化后查看。</div>
      )}

      {records.map((r) => {
        const d = parseDetail(r.detail);
        return (
          <div className="mcard" key={r.id}>
            <div className="mcard-title">{r.semester}</div>
            <div className="mstat-row" style={{ marginTop: 4 }}>
              <div className="mstat"><div className="mstat-v" style={{ color: 'var(--primary)' }}>{r.score ?? '—'}</div><div className="mstat-l">学期考核分</div></div>
              <div className="mstat"><div className="mstat-v">{d?.group_name || r.group_key}</div><div className="mstat-l">所属备课组</div></div>
            </div>
            {d?.exams?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="mitem-sub" style={{ marginBottom: 6 }}>各考试得分</div>
                {d.exams.map((x, i) => (
                  <div key={i} className="mitem" style={{ padding: '8px 0' }}>
                    <div className="mitem-main">
                      <div className="mitem-title">{x.exam_name || x.exam_type}</div>
                      <div className="mitem-sub">权重 {x.weight} · A率{x.rate_a}% B率{x.rate_b}%</div>
                    </div>
                    <div className="mitem-side"><strong>{x.score}</strong></div>
                  </div>
                ))}
              </div>
            )}
            {r.locked_at && <div className="mitem-sub" style={{ marginTop: 8 }}>固化于 {r.locked_at}</div>}
          </div>
        );
      })}
    </div>
  );
}
