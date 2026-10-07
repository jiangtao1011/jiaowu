import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';

const TERMS = ['常规', '夏令营', '冬令营', '全员夏令营', '全员冬令营', '节假补课'];
const CAL_TYPES = ['上课', '放假', '停课', '补课', '调课'];
const SOURCE_LABEL = { schedule: '课表', adjust: '代课/调课', extra: '加课', qna: '申报' };

// 当月 1 号 ~ 今天，作为按日统计的默认日期范围
function monthRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return [`${y}-${m}-01`, `${y}-${m}-${d}`];
}

// 表格分页：总数 ≤ 每页条数时不渲染控件
const PAGE_SIZE = 20;

function Pagination({ page, total, pageSize = PAGE_SIZE, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="pagination">
      <button type="button" className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span className="pagination-info">第 {page} / {pages} 页 · 共 {total} 条</span>
      <button type="button" className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  );
}

export default function Stats() {
  const [tab, setTab] = useState('payroll'); // payroll | config | other
  const [summary, setSummary] = useState([]);
  const [changes, setChanges] = useState([]);
  const [coefs, setCoefs] = useState({ subjects: [], bands: [], periods: {} });
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // 口径：daily（按日，默认）| current（课表当前）| range（课表按时间段推算）
  const [mode, setMode] = useState('daily');
  const [term, setTerm] = useState('');
  const [defFrom, defTo] = monthRange();
  const [fromDate, setFromDate] = useState(defFrom);
  const [toDate, setToDate] = useState(defTo);

  // 按日统计相关状态
  const [calendar, setCalendar] = useState([]);
  const [instances, setInstances] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [calForm, setCalForm] = useState({ date: '', from: '', to: '', grade: '', type: '上课', make_up_for: '', make_up_set: '', note: '' });
  const [regenerate, setRegenerate] = useState(true); // 生成上课记录时是否先清空区间内课表展开记录
  const [extraForm, setExtraForm] = useState({ class_id: '', teacher_id: '', subject: '', date: '', period_no: '1', period_type: '正课', term: '常规' });
  const [instFilter, setInstFilter] = useState({ date: '', class_id: '', teacher_id: '' });
  const [typePays, setTypePays] = useState([]); // 按次计酬类型字典
  const [typeCoefs, setTypeCoefs] = useState([]); // 折算类型字典
  const [summaryTypes, setSummaryTypes] = useState([]); // 汇总表动态列

  // 分页 + 折叠
  const [summaryPage, setSummaryPage] = useState(1);
  const [instPage, setInstPage] = useState(1);
  const [calPage, setCalPage] = useState(1);
  const [changesPage, setChangesPage] = useState(1);
  const [fold, setFold] = useState({ cal: true, extra: true, inst: true });
  const toggleFold = (k) => setFold((f) => ({ ...f, [k]: !f[k] }));

  const load = async () => {
    setError('');
    setSummaryPage(1); setInstPage(1); setCalPage(1); setChangesPage(1);
    try {
      const params = {};
      if (term) params.term = term;
      if ((mode === 'range') && fromDate && toDate) {
        params.from_date = fromDate;
        params.to_date = toDate;
      }
      const jobs = [api.get('/schedules/changes'), api.get('/schedules/coefficients'), api.get('/teachers'), api.get('/classes'), api.get('/stats/type-pays'), api.get('/stats/type-coefficients')];
      if (mode === 'daily') {
        const instParams = {};
        if (fromDate) instParams.from_date = fromDate;
        if (toDate) instParams.to_date = toDate;
        jobs.push(api.get('/stats/instances', { params: instParams }));
        jobs.push(api.get('/stats/calendar'));
        jobs.push(api.get('/stats/summary', { params: { from_date: fromDate, to_date: toDate, ...(term ? { term } : {}) } }));
      } else {
        jobs.push(api.get('/schedules/summary', { params }));
      }

      const [ch, cf, tc, cc, tp, tco, ...rest] = await Promise.all(jobs);
      setChanges(ch.data.data);
      setCoefs(cf.data.data);
      setTeachers(tc.data.data);
      setClasses(cc.data.data);
      setTypePays(tp.data.data);
      setTypeCoefs(tco.data.data);
      if (mode === 'daily') {
        const [ins, cal, sm] = rest;
        setInstances(ins.data.data);
        setCalendar(cal.data.data);
        setSummary(sm.data.data);
        setSummaryTypes(sm.data.types || []);
      } else {
        setSummary(rest[0].data.data);
        setSummaryTypes(rest[0].data.types || []);
        setInstances([]);
        setCalendar([]);
      }
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, [mode, term, fromDate, toDate]);
  useEffect(() => { setInstPage(1); }, [instFilter]);

  const saveCoefs = async () => {
    setError(''); setMsg('');
    try {
      await api.put('/schedules/coefficients', { subjects: coefs.subjects, bands: coefs.bands, periods: coefs.periods });
      setMsg('系数已保存');
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const setSubj = (i, v) => {
    const next = [...coefs.subjects];
    next[i] = { ...next[i], coefficient: v };
    setCoefs({ ...coefs, subjects: next });
  };
  const addSubj = () => setCoefs({ ...coefs, subjects: [...coefs.subjects, { subject: '', coefficient: 1.0 }] });
  const addBand = () => setCoefs({ ...coefs, bands: [...coefs.bands, { min_size: '', coefficient: 1.0 }] });

  // ===== 按次计酬类型字典 =====
  const setTypePay = (i, field, v) => {
    const next = [...typePays];
    next[i] = { ...next[i], [field]: v };
    setTypePays(next);
  };
  const addTypePay = () => setTypePays([...typePays, { name: '', pay: 0 }]);
  const saveTypePays = async () => {
    setError(''); setMsg('');
    try {
      await api.put('/stats/type-pays', { items: typePays });
      setMsg('类型字典已保存');
      load();
    } catch (e) { setError(errMsg(e)); }
  };
  const delTypePay = async (id) => {
    if (id == null) { setTypePays(typePays.filter((t) => t.id != null || t.name)); return; }
    try { await api.delete(`/stats/type-pays/${id}`); setMsg('已删除该类型'); load(); } catch (e) { setError(errMsg(e)); }
  };

  // ===== 折算类型字典（早自习等，节数×系数） =====
  const setTypeCoef = (i, field, v) => {
    const next = [...typeCoefs];
    next[i] = { ...next[i], [field]: v };
    setTypeCoefs(next);
  };
  const addTypeCoef = () => setTypeCoefs([...typeCoefs, { name: '', coefficient: 0.5 }]);
  const saveTypeCoefs = async () => {
    setError(''); setMsg('');
    try {
      await api.put('/stats/type-coefficients', { items: typeCoefs });
      setMsg('折算类型字典已保存');
      load();
    } catch (e) { setError(errMsg(e)); }
  };
  const delTypeCoef = async (id) => {
    if (id == null) { setTypeCoefs(typeCoefs.filter((t) => t.id != null || t.name)); return; }
    try { await api.delete(`/stats/type-coefficients/${id}`); setMsg('已删除该折算类型'); load(); } catch (e) { setError(errMsg(e)); }
  };

  // ===== 校历 =====
  const addCal = async () => {
    setError(''); setMsg('');
    const hasSingle = !!calForm.date;
    const hasRange = !!calForm.from && !!calForm.to;
    if (!hasSingle && !hasRange) return setError('请选择单日或起止日期区间');
    try {
      const item = { grade: calForm.grade || null, type: calForm.type, make_up_for: calForm.make_up_for || undefined, make_up_set: calForm.make_up_set || undefined, note: calForm.note || undefined };
      if (hasSingle) item.date = calForm.date;
      else { item.from = calForm.from; item.to = calForm.to; }
      await api.put('/stats/calendar', { items: [item] });
      setMsg('校历已更新');
      setCalForm({ date: '', from: '', to: '', grade: '', type: '上课', make_up_for: '', make_up_set: '', note: '' });
      load();
    } catch (e) { setError(errMsg(e)); }
  };
  const delCal = async (date, grade) => {
    try { await api.delete(`/stats/calendar/${date}`, { params: { grade: grade || undefined } }); setMsg('已删除该日校历'); load(); } catch (e) { setError(errMsg(e)); }
  };

  // ===== 生成上课记录 =====
  const generate = async () => {
    setError(''); setMsg('');
    if (!fromDate || !toDate) return setError('请先选择开始和结束日期');
    try {
      const r = await api.post('/stats/generate', { from_date: fromDate, to_date: toDate, replace: regenerate });
      const { created, skipped, deleted } = r.data.data;
      setMsg(`${regenerate ? `已清空 ${deleted} 条旧记录，` : ''}生成 ${created} 条上课记录（跳过 ${skipped} 条已有）`);
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  // ===== 上课记录操作 =====
  const adjustInstance = async (id, changeType, toTeacherId) => {
    try {
      await api.post(`/stats/instance/${id}/adjust`, { change_type: changeType, to_teacher_id: toTeacherId || null });
      setMsg(changeType === '停课' ? '已停课' : '已代课');
      load();
    } catch (e) { setError(errMsg(e)); }
  };
  const restoreInstance = async (id) => {
    try { await api.post(`/stats/instance/${id}/restore`); setMsg('已恢复'); load(); } catch (e) { setError(errMsg(e)); }
  };
  const deleteInstance = async (id) => {
    try { await api.delete(`/stats/instance/${id}`); setMsg('已删除'); load(); } catch (e) { setError(errMsg(e)); }
  };
  const exportExcel = async () => {
    setError('');
    try {
      const token = localStorage.getItem('edu_token');
      const params = new URLSearchParams();
      let url;
      let filename;
      if (mode === 'daily') {
        if (!fromDate || !toDate) return setError('导出需先选择开始和结束日期');
        params.set('from_date', fromDate);
        params.set('to_date', toDate);
        if (term) params.set('term', term);
        url = '/api/stats/export';
        filename = `课酬明细_${fromDate}_${toDate}.xlsx`;
      } else if (mode === 'range') {
        if (!fromDate || !toDate) return setError('导出需先选择开始和结束日期');
        params.set('from_date', fromDate);
        params.set('to_date', toDate);
        if (term) params.set('term', term);
        url = '/api/schedules/export';
        filename = `课表明细_${fromDate}_${toDate}.xlsx`;
      } else {
        if (term) params.set('term', term);
        url = '/api/schedules/export';
        filename = '课表明细.xlsx';
      }
      const r = await fetch(`${url}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setError('导出失败'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };
  const exportFinancialReport = async () => {
    setError('');
    try {
      if (mode !== 'daily') return setError('财务汇总表基于「按日统计」口径，请先切换到按日统计');
      if (!fromDate || !toDate) return setError('导出需先选择开始和结束日期');
      const token = localStorage.getItem('edu_token');
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (term) params.set('term', term);
      const r = await fetch(`/api/stats/financial-report?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setError('导出失败'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `课酬财务汇总表_${fromDate}_${toDate}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };

  // 导出「财务审核包」：单文件多 sheet（汇总 + 明细 + 勾稽 + 口径说明），一键给财务
  const exportFinancialPack = async () => {
    setError('');
    try {
      if (mode !== 'daily') return setError('财务审核包基于「按日统计」口径，请先切换到按日统计');
      if (!fromDate || !toDate) return setError('导出需先选择开始和结束日期');
      const token = localStorage.getItem('edu_token');
      const params = new URLSearchParams({ from_date: fromDate, to_date: toDate });
      if (term) params.set('term', term);
      const r = await fetch(`/api/stats/financial-pack?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setError('导出失败'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `课酬财务审核包_${fromDate}_${toDate}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };

  // 勾稽校验：调 /financial-check 拿对账结果与异常清单，展示给用户
  const [checkResult, setCheckResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const runCheck = async () => {
    setError(''); setCheckResult(null);
    if (mode !== 'daily') return setError('勾稽校验基于「按日统计」口径，请先切换到按日统计');
    if (!fromDate || !toDate) return setError('校验需先选择开始和结束日期');
    setChecking(true);
    try {
      const r = await api.get('/stats/financial-check', { params: { from_date: fromDate, to_date: toDate, ...(term ? { term } : {}) } });
      setCheckResult(r.data.data);
    } catch (e) { setError(errMsg(e)); }
    finally { setChecking(false); }
  };
  const addExtra = async () => {
    setError(''); setMsg('');
    if (!extraForm.class_id || !extraForm.teacher_id || !extraForm.date) return setError('加课需选择班级、教师、日期');
    try {
      await api.post('/stats/instances', extraForm);
      setMsg('加课成功');
      setExtraForm({ class_id: '', teacher_id: '', subject: '', date: '', period_no: '1', period_type: '正课', term: '常规' });
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const totalLessons = summary.reduce((s, r) => s + r.total, 0);
  const totalWeighted = summary.reduce((s, r) => s + r.weighted_total, 0);
  const totalPay = summary.reduce((s, r) => s + (r.pay_total || 0), 0);
  const teacherCount = summary.length;
  const grades = [...new Set(classes.map((c) => c.grade).filter(Boolean))].sort();

  const filteredInstances = instances.filter((r) =>
    (!instFilter.date || r.date === instFilter.date) &&
    (!instFilter.class_id || String(r.class_id) === instFilter.class_id) &&
    (!instFilter.teacher_id || String(r.teacher_id) === instFilter.teacher_id));

  const pagedSummary = summary.slice((summaryPage - 1) * PAGE_SIZE, summaryPage * PAGE_SIZE);
  const pagedInstances = filteredInstances.slice((instPage - 1) * PAGE_SIZE, instPage * PAGE_SIZE);
  const pagedCalendar = calendar.slice((calPage - 1) * PAGE_SIZE, calPage * PAGE_SIZE);
  const pagedChanges = changes.slice((changesPage - 1) * PAGE_SIZE, changesPage * PAGE_SIZE);

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">统计中心</h2>
        <p className="page-sub">课酬统计与统计配置；后续将扩展教学业绩等其它统计口径</p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="toolbar" style={{ marginBottom: 16 }}>
        <button className={`btn ${tab === 'payroll' ? 'primary' : ''}`} onClick={() => setTab('payroll')}>课酬统计</button>
        <button className={`btn ${tab === 'config' ? 'primary' : ''}`} onClick={() => setTab('config')}>统计配置</button>
        <button className={`btn ${tab === 'other' ? 'primary' : ''}`} onClick={() => setTab('other')}>其它统计</button>
      </div>

      {/* ==================== 课酬统计 ==================== */}
      {tab === 'payroll' && (
        <>
          <div className="card">
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <div>
                <label style={{ marginBottom: 2 }}>统计口径</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className={`btn sm ${mode === 'daily' ? 'primary' : ''}`} onClick={() => setMode('daily')}>按日统计</button>
                  <button className={`btn sm ${mode === 'current' ? 'primary' : ''}`} onClick={() => setMode('current')}>课表当前状态</button>
                  <button className={`btn sm ${mode === 'range' ? 'primary' : ''}`} onClick={() => setMode('range')}>课表按时间段推算</button>
                </div>
              </div>
              <div>
                <label style={{ marginBottom: 2 }}>时段</label>
                <select value={term} onChange={(e) => setTerm(e.target.value)} style={{ width: 150 }}>
                  <option value="">全部时段</option>
                  {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={{ marginBottom: 2 }}>开始日期</label>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ width: 160 }} />
              </div>
              <div>
                <label style={{ marginBottom: 2 }}>结束日期</label>
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ width: 160 }} />
              </div>
            </div>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
              {mode === 'daily' && '按日精确统计：先在上课日历标记放假/补课，再「生成上课记录」把固定课表展开到具体日期；单日代课/停课/加课、临时申报直接在记录上操作。'}
              {mode === 'current' && '课表当前状态：按当前生效的课表条目汇总（不展开到日期）。'}
              {mode === 'range' && '课表按时间段推算：按课表每周重复自动折算区间内的实际课时数（不依赖上课日历）。'}
            </p>
          </div>

          <div className="stat-row">
            <div className="stat-card"><div className="v">{totalLessons}</div><div className="l">原始课时</div></div>
            <div className="stat-card"><div className="v">{Math.round(totalWeighted * 100) / 100}</div><div className="l">折算课时</div></div>
            <div className="stat-card"><div className="v">{Math.round(totalPay * 100) / 100}</div><div className="l">课酬合计(元)</div></div>
            <div className="stat-card"><div className="v">{teacherCount}</div><div className="l">有课教师</div></div>
          </div>

          {/* 按日统计：校历 + 生成 + 加课 + 记录管理 */}
          {mode === 'daily' && (
            <>
              <div className="card">
                <div className="card-head"><h3>上课日历（标记放假 / 补课）</h3><div className="toolbar" style={{ marginBottom: 0 }}>
                  <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} /> 重新生成（先清空区间内课表记录）
                  </label>
                  <button className="btn sm primary" onClick={generate}>生成上课记录</button>
                  <button className="btn sm ghost" onClick={() => toggleFold('cal')}>{fold.cal ? '展开 ▾' : '收起 ▴'}</button>
                </div></div>
                {!fold.cal && (
                <>
                <div className="toolbar" style={{ marginBottom: 10 }}>
                  <input type="date" value={calForm.date} onChange={(e) => setCalForm({ ...calForm, date: e.target.value })} style={{ width: 150 }} title="单日" />
                  <span className="hint">或区间</span>
                  <input type="date" value={calForm.from} onChange={(e) => setCalForm({ ...calForm, from: e.target.value })} style={{ width: 150 }} title="起始日" />
                  <input type="date" value={calForm.to} onChange={(e) => setCalForm({ ...calForm, to: e.target.value })} style={{ width: 150 }} title="结束日" />
                  <select value={calForm.grade} onChange={(e) => setCalForm({ ...calForm, grade: e.target.value })} style={{ width: 100 }}>
                    <option value="">全校</option>
                    {grades.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                  <select value={calForm.type} onChange={(e) => setCalForm({ ...calForm, type: e.target.value })} style={{ width: 100 }}>
                    {CAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {(calForm.type === '补课' || calForm.type === '调课') && (
                    <input value={calForm.make_up_for} onChange={(e) => setCalForm({ ...calForm, make_up_for: e.target.value })} placeholder={calForm.type === '调课' ? '调哪天的课：日期 或 周几(1-7)' : '补哪天：日期 或 周几(1-7)'} style={{ width: 220 }} />
                  )}
                  {calForm.type === '补课' && (
                    <input type="number" min="1" step="1" value={calForm.make_up_set} onChange={(e) => setCalForm({ ...calForm, make_up_set: e.target.value })} placeholder="用第几套(可空)" style={{ width: 120 }} title="补课课表套号：多套补课课表轮换时填 1/2/3，留空则按旧用法（区间型补课课表或补某天）" />
                  )}
                  <input value={calForm.note} onChange={(e) => setCalForm({ ...calForm, note: e.target.value })} placeholder="备注（如 中秋放假）" style={{ width: 180 }} />
                  <button className="btn sm" onClick={addCal}>添加</button>
                </div>
                <p className="muted" style={{ margin: '0 0 10px' }}>填「单日」只标一天；填「区间」把起始~结束每天批量标记。放假/停课=当天不排课不计酬；补课=当天补某天（填日期或周几 1-7），有「节假补课」多套课表时可再填「用第几套」按套轮换，课酬一律按节假补课标准；调课=整体上某天的课（如周末上星期X的课），课酬按常规课时计酬。选「全校」整校生效，选某年级仅该年级。改完点「生成上课记录」联动。</p>
                <table>
                  <thead><tr><th>日期</th><th>年级</th><th>类型</th><th>补哪一天</th><th>用第几套</th><th>备注</th><th style={{ width: 90 }}>操作</th></tr></thead>
                  <tbody>
                    {pagedCalendar.map((c) => (
                      <tr key={c.id}>
                        <td>{c.date}</td>
                        <td>{c.grade || '全校'}</td>
                        <td><span className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '补课' ? 'warn' : c.type === '调课' ? 'info' : ''}`}>{c.type}</span></td>
                        <td>{c.make_up_for || '-'}</td>
                        <td>{c.make_up_set ?? '-'}</td>
                        <td>{c.note || '-'}</td>
                        <td><button className="btn sm danger" onClick={() => delCal(c.date, c.grade)}>删除</button></td>
                      </tr>
                    ))}
                    {calendar.length === 0 && <tr><td colSpan={7} className="muted">未设置特殊日期，默认每天上课</td></tr>}
                  </tbody>
                </table>
                <Pagination page={calPage} total={calendar.length} onPage={setCalPage} />
                </>
                )}
              </div>

              <div className="card">
                <div className="card-head"><h3>手工加课（临时课 / 一次性课）</h3>
                  <button className="btn sm ghost" onClick={() => toggleFold('extra')}>{fold.extra ? '展开 ▾' : '收起 ▴'}</button>
                </div>
                {!fold.extra && (
                <div className="toolbar" style={{ marginBottom: 10 }}>
                  <select value={extraForm.class_id} onChange={(e) => setExtraForm({ ...extraForm, class_id: e.target.value })} style={{ width: 160 }}>
                    <option value="">班级</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={extraForm.teacher_id} onChange={(e) => setExtraForm({ ...extraForm, teacher_id: e.target.value })} style={{ width: 120 }}>
                    <option value="">教师</option>
                    {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <input value={extraForm.subject} onChange={(e) => setExtraForm({ ...extraForm, subject: e.target.value })} placeholder="学科" style={{ width: 90 }} />
                  <input type="date" value={extraForm.date} onChange={(e) => setExtraForm({ ...extraForm, date: e.target.value })} style={{ width: 150 }} />
                  <input type="number" value={extraForm.period_no} onChange={(e) => setExtraForm({ ...extraForm, period_no: e.target.value })} placeholder="节次" style={{ width: 70 }} />
                  <select value={extraForm.period_type} onChange={(e) => setExtraForm({ ...extraForm, period_type: e.target.value })} style={{ width: 100 }}>
                    <option>正课</option>
                    {typeCoefs.map((t) => <option key={t.id || t.name} value={t.name}>{t.name}</option>)}
                    {typePays.map((t) => <option key={t.id || t.name} value={t.name}>{t.name}</option>)}
                  </select>
                  <select value={extraForm.term} onChange={(e) => setExtraForm({ ...extraForm, term: e.target.value })} style={{ width: 100 }}>
                    {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button className="btn sm" onClick={addExtra}>加课</button>
                </div>
                )}
              </div>

              <div className="card">
                <div className="card-head"><h3>上课记录（可单日代课 / 停课 / 删除）</h3>
                  <button className="btn sm ghost" onClick={() => toggleFold('inst')}>{fold.inst ? '展开 ▾' : '收起 ▴'}</button>
                </div>
                {!fold.inst && (
                <>
                <div className="toolbar" style={{ marginBottom: 10 }}>
                  <input type="date" value={instFilter.date} onChange={(e) => setInstFilter({ ...instFilter, date: e.target.value })} style={{ width: 150 }} />
                  <select value={instFilter.class_id} onChange={(e) => setInstFilter({ ...instFilter, class_id: e.target.value })} style={{ width: 140 }}>
                    <option value="">全部班级</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={instFilter.teacher_id} onChange={(e) => setInstFilter({ ...instFilter, teacher_id: e.target.value })} style={{ width: 120 }}>
                    <option value="">全部教师</option>
                    {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>日期</th><th>班级</th><th>教师</th><th>学科</th><th>节次</th><th>类型</th><th>时段</th><th>来源</th><th style={{ width: 220 }}>操作</th></tr></thead>
                    <tbody>
                      {pagedInstances.map((r) => (
                        <tr key={r.id} style={r.cancelled ? { opacity: 0.45 } : undefined}>
                          <td>{r.date}</td>
                          <td>{r.class_name}</td>
                          <td>{r.teacher_name}</td>
                          <td>{r.subject || '-'}</td>
                          <td className="num">{r.period_no}</td>
                          <td><span className={`period-tag period-${r.period_type}`}>{r.period_type}</span></td>
                          <td>{r.term !== '常规' ? r.term : ''}</td>
                          <td>{SOURCE_LABEL[r.source] || r.source}</td>
                          <td>
                            {!r.cancelled ? (
                              <div className="toolbar" style={{ marginBottom: 0 }}>
                                <select id={`sub-${r.id}`} defaultValue="" style={{ width: 90 }}>
                                  <option value="" disabled>代课教师</option>
                                  {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                                <button className="btn sm primary" onClick={() => {
                                  const sel = document.getElementById(`sub-${r.id}`).value;
                                  if (sel) adjustInstance(r.id, '代课', Number(sel));
                                }}>代课</button>
                                <button className="btn sm danger" onClick={() => adjustInstance(r.id, '停课')}>停课</button>
                                <button className="btn sm" onClick={() => deleteInstance(r.id)}>删</button>
                              </div>
                            ) : (
                              <button className="btn sm" onClick={() => restoreInstance(r.id)}>恢复</button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {filteredInstances.length === 0 && <tr><td colSpan={9} className="muted">暂无上课记录，请先设置日历并「生成上课记录」</td></tr>}
                    </tbody>
                  </table>
                </div>
                <Pagination page={instPage} total={filteredInstances.length} onPage={setInstPage} />
                </>
                )}
              </div>
            </>
          )}

          {/* 教师课时汇总 */}
          <div className="card">
            <div className="card-head">
              <h3>教师课时汇总</h3>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <button className="btn sm" onClick={runCheck} disabled={checking}>{checking ? '校验中…' : '勾稽校验'}</button>
                <button className="btn primary sm" onClick={exportExcel}>导出明细 Excel</button>
                <button className="btn sm" onClick={exportFinancialReport}>导出财务汇总表</button>
                <button className="btn primary sm" onClick={exportFinancialPack}>导出财务审核包</button>
              </div>
            </div>
            {checkResult && (
              <div className="check-result" style={{ borderTop: '1px solid #eee', paddingTop: 12, marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span className={`badge ${checkResult.balanced ? '' : 'danger'}`}>
                    {checkResult.balanced ? '✓ 金额勾稽一致' : '✗ 金额勾稽不一致'}
                  </span>
                  <span className="muted">明细 {checkResult.detail_pay} 元 = 汇总 {checkResult.summary_pay} 元</span>
                </div>
                {checkResult.issues.length > 0 && (
                  <div className="alert warn" style={{ marginBottom: 8 }}>
                    <strong>发现 {checkResult.issues.length} 项待复核：</strong>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                      {checkResult.issues.map((it, i) => <li key={i}>{it.msg}</li>)}
                    </ul>
                  </div>
                )}
                {checkResult.issues.length === 0 && (
                  <p className="muted" style={{ margin: '0 0 8px' }}>未发现异常，可放心导出审核包。</p>
                )}
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>教师</th>
                    {summaryTypes.map((t) => <th key={t} className="num">{t}</th>)}
                    <th className="num">原始合计</th><th className="num">折算课时</th><th className="num">课酬(元)</th><th>时段分布</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedSummary.map((r) => (
                    <tr key={r.teacher_id}>
                      <td>{r.teacher_name}</td>
                      {summaryTypes.map((t) => <td key={t} className="num">{r[t] || 0}</td>)}
                      <td className="num">{r.total}</td>
                      <td className="num"><span className="strong">{r.weighted_total}</span></td>
                      <td className="num">{r.pay_total || '-'}</td>
                      <td>
                        {Object.entries(r.terms || {}).map(([k, v]) => (
                          <span key={k} className="badge" style={{ marginRight: 4 }} title={`折算 ${v.weighted}`}>
                            {k} {v.count}{v.weighted !== v.count ? `→${v.weighted}` : ''}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                  {summary.length === 0 && <tr><td colSpan={summaryTypes.length + 5} className="muted">暂无统计数据</td></tr>}
                </tbody>
              </table>
            </div>
            <Pagination page={summaryPage} total={summary.length} onPage={setSummaryPage} />
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
              折算课时：正课 = 节数 ×（课时系数 + 班额系数）；折算类型（早自习等）= 节数 × 折算系数；按次计酬类型（晚自习/答疑/晚练/自定义）= 固定单价 × 节数（不计折算课时）；夏/冬令营 = 节数（课酬另按教师课酬标准 × 节数计）。走班班额 = 合班各行政班人数之和。
            </p>
          </div>

          {/* 调课记录（仅课表维度历史） */}
          {mode !== 'daily' && (
            <div className="card">
              <div className="card-head"><h3>调课 / 代课记录</h3></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>类型</th><th>原教师</th><th>新教师</th><th>生效日期</th><th>原因</th><th>操作人</th><th>时间</th></tr></thead>
                  <tbody>
                    {pagedChanges.map((c) => (
                      <tr key={c.id}>
                        <td><span className={`badge ${c.change_type === '代课' ? 'warn' : c.change_type === '停课' ? 'danger' : 'info'}`}>{c.change_type}</span></td>
                        <td>{c.from_teacher_name || '-'}</td>
                        <td>{c.to_teacher_name || '-'}</td>
                        <td>{c.from_date || '-'}</td>
                        <td>{c.reason || '-'}</td>
                        <td>{c.operator_name || '-'}</td>
                        <td>{c.created_at}</td>
                      </tr>
                    ))}
                    {changes.length === 0 && <tr><td colSpan={7} className="muted">暂无调课记录</td></tr>}
                  </tbody>
                </table>
              </div>
              <Pagination page={changesPage} total={changes.length} onPage={setChangesPage} />
            </div>
          )}
        </>
      )}

      {/* ==================== 统计配置 ==================== */}
      {tab === 'config' && (
        <>
          <div className="card">
            <div className="card-head"><h3>折算系数</h3><button className="btn primary sm" onClick={saveCoefs}>保存系数</button></div>
            <div className="form-grid">
              <div>
                <label>课时系数（正课折算用）</label>
                <table className="coef-table">
                  <thead><tr><th>学科</th><th className="num">系数</th></tr></thead>
                  <tbody>
                    {coefs.subjects.map((s, i) => (
                      <tr key={i}>
                        <td><input value={s.subject} onChange={(e) => { const n = [...coefs.subjects]; n[i] = { ...n[i], subject: e.target.value }; setCoefs({ ...coefs, subjects: n }); }} /></td>
                        <td className="num"><input type="number" step="0.1" value={s.coefficient} onChange={(e) => setSubj(i, e.target.value)} style={{ width: 80 }} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={addSubj}>+ 添加学科</button>
              </div>
              <div>
                <label>折算类型（早自习等，节数 × 系数）</label>
                <table className="coef-table">
                  <thead><tr><th>类型名称</th><th className="num">系数</th><th style={{ width: 70 }}>操作</th></tr></thead>
                  <tbody>
                    {typeCoefs.map((t, i) => (
                      <tr key={t.id ?? i}>
                        <td><input value={t.name} onChange={(e) => setTypeCoef(i, 'name', e.target.value)} /></td>
                        <td className="num"><input type="number" step="0.1" value={t.coefficient} onChange={(e) => setTypeCoef(i, 'coefficient', e.target.value)} style={{ width: 80 }} /></td>
                        <td><button className="btn sm danger" onClick={() => delTypeCoef(t.id)}>删除</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={addTypeCoef}>+ 添加折算类型</button>
                <button type="button" className="btn sm" style={{ marginTop: 8, marginLeft: 8 }} onClick={saveTypeCoefs}>保存折算类型</button>
              </div>
            </div>
            <div className="mt">
              <label>班额系数（人数分档，正课折算用）</label>
              <table className="coef-table">
                <thead><tr><th>最低人数</th><th className="num">系数</th></tr></thead>
                <tbody>
                  {coefs.bands.map((b, i) => (
                    <tr key={i}>
                      <td><input type="number" value={b.min_size} onChange={(e) => { const n = [...coefs.bands]; n[i] = { ...n[i], min_size: e.target.value }; setCoefs({ ...coefs, bands: n }); }} /></td>
                      <td className="num"><input type="number" step="0.1" value={b.coefficient} onChange={(e) => { const n = [...coefs.bands]; n[i] = { ...n[i], coefficient: e.target.value }; setCoefs({ ...coefs, bands: n }); }} style={{ width: 80 }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={addBand}>+ 添加分档</button>
            </div>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>班额系数按「统计班额」匹配最高分档：走班取合班人数之和，分层取分层班人数，行政班取本班人数。</p>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>按次计酬类型（晚自习 / 答疑 / 晚练 / 自定义）</h3>
              <button className="btn primary sm" onClick={saveTypePays}>保存类型</button>
            </div>
            <table className="coef-table">
              <thead><tr><th>类型名称</th><th className="num">固定课酬（元/节）</th><th style={{ width: 90 }}>操作</th></tr></thead>
              <tbody>
                {typePays.map((t, i) => (
                  <tr key={t.id ?? i}>
                    <td><input value={t.name} onChange={(e) => setTypePay(i, 'name', e.target.value)} /></td>
                    <td className="num"><input type="number" step="1" value={t.pay} onChange={(e) => setTypePay(i, 'pay', e.target.value)} style={{ width: 90 }} /></td>
                    <td><button className="btn sm danger" onClick={() => delTypePay(t.id)}>删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={addTypePay}>+ 添加类型</button>
            <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
              这些类型用于「课时申报」（晚自习/答疑/晚练等按次计酬）与「手工加课」：每节按此固定课酬计，不参与学科/班额折算。折算类型（早自习等，节数 × 系数）在上方「折算系数」卡片单独维护。已被记录引用的类型无法删除（避免历史计酬突变），可将其单价改为 0 以停用。
            </p>
          </div>
        </>
      )}

      {/* ==================== 其它统计（待开发） ==================== */}
      {tab === 'other' && (
        <div className="card">
          <div className="card-head"><h3>其它统计</h3></div>
          <p className="muted" style={{ marginTop: 0 }}>此处预留用于教学业绩考核等其它统计口径，待后续开发。</p>
        </div>
      )}
    </div>
  );
}
