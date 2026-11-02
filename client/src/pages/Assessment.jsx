import React, { useEffect, useMemo, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

const isAdmin = (u) => ['admin', '教务员', '教务处'].includes(u?.role);

// 率输入框：0~100，步进 0.1
function RateInput({ value, onChange, label }) {
  return (
    <label className="rate-field">
      <span className="rate-label">{label}</span>
      <input
        type="number" min="0" max="100" step="0.1"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
      <span className="rate-unit">%</span>
    </label>
  );
}

const RATE_KEYS = [
  { key: 'a', label: 'A率' },
  { key: 'b', label: 'B率' },
  { key: 'c', label: 'C率' },
  { key: 'd', label: 'D率' },
  { key: 'e', label: 'E率' },
];

const GRADE_OPTIONS = ['高一', '高二', '高三', '初一', '初二', '初三'];

export default function Assessment() {
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const admin = isAdmin(user);
  const [tab, setTab] = useState('exams'); // exams | summary | config | records
  const [error, setError] = useState('');
  const toast = useToast();

  // 考试列表
  const [exams, setExams] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [semesterFilter, setSemesterFilter] = useState('');
  const [examForm, setExamForm] = useState({ name: '', semester: '', exam_type: '期末', grade: '', exam_date: '', note: '' });
  const [examTypes, setExamTypes] = useState([]);
  const [groups, setGroups] = useState([]);

  // 当前选中的考试 + 各率录入
  const [curExam, setCurExam] = useState(null);
  const [scores, setScores] = useState([]); // [{group_key, rate_a..e, ...}]
  const [examFiles, setExamFiles] = useState([]); // 当前考试的成绩文件
  const [fileGroupKey, setFileGroupKey] = useState(''); // 上传文件时选择的备课组
  const [expandedGrades, setExpandedGrades] = useState(() => new Set()); // 展开的年级（录入界面折叠用）
  const [config, setConfig] = useState({ rate_weights: { a: 0.6, b: 0.4, c: 0, d: 0, e: 0 }, full_score: 100 });

  // 汇总
  const [summarySemester, setSummarySemester] = useState('');
  const [summary, setSummary] = useState(null);

  const load = async () => {
    setError('');
    try {
      const [e, s, t, g, c] = await Promise.all([
        api.get('/assessment/exams'),
        api.get('/assessment/semesters'),
        api.get('/assessment/exam-types'),
        api.get('/assessment/groups'),
        api.get('/assessment/config'),
      ]);
      setExams(e.data.data);
      setSemesters(s.data.data);
      setExamTypes(t.data.data.filter((x) => x.active !== 0));
      setGroups(g.data.data);
      setConfig(c.data.data);
    } catch (err) { setError(errMsg(err)); }
  };
  useEffect(() => { load(); }, []);

  const filteredExams = semesterFilter ? exams.filter((e) => e.semester === semesterFilter) : exams;

  const createExam = async () => {
    if (!examForm.name.trim()) return toast.error('考试名称必填');
    if (!examForm.semester.trim()) return toast.error('学期必填');
    try {
      await api.post('/assessment/exams', examForm);
      toast.success('考试已创建');
      setExamForm({ name: '', semester: '', exam_type: '期末', grade: '', exam_date: '', note: '' });
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  const deleteExam = async (id) => {
    if (!(await toast.confirm('确认删除该考试及其所有各率、成绩文件？', { danger: true }))) return;
    try { await api.delete(`/assessment/exams/${id}`); load(); } catch (err) { toast.error(errMsg(err)); }
  };

  const openExam = async (exam) => {
    try {
      const r = await api.get(`/assessment/exams/${exam.id}/scores`);
      setCurExam(exam);
      setScores(r.data.data);
      setExamFiles([]);
      setFileGroupKey('');
      // 默认只展开「有数据」的年级（某次月考只有个别年级时，其它年级收起）
      const hasData = new Set();
      for (const s of r.data.data) {
        if ([s.rate_a, s.rate_b, s.rate_c, s.rate_d, s.rate_e].some((v) => v !== '' && v != null && Number(v) !== 0)) hasData.add(s.grade);
      }
      setExpandedGrades(hasData);
      // 拉取该考试已上传的成绩文件
      try { setExamFiles((await api.get(`/assessment/exams/${exam.id}/files`)).data.data); } catch { setExamFiles([]); }
    } catch (err) { toast.error(errMsg(err)); }
  };

  // 当前考试各率缓存（含未保存的编辑）
  const setRate = (gk, key, val) => {
    setScores((prev) => prev.map((r) => (r.group_key === gk ? { ...r, [`rate_${key}`]: val } : r)));
  };

  // 单次考核分预览（第一层加权）
  const singleScore = (r) => {
    const w = config.rate_weights;
    const sumW = w.a + w.b + w.c + w.d + w.e;
    if (!sumW) return 0;
    const raw = (Number(r.rate_a) || 0) * w.a + (Number(r.rate_b) || 0) * w.b + (Number(r.rate_c) || 0) * w.c + (Number(r.rate_d) || 0) * w.d + (Number(r.rate_e) || 0) * w.e;
    return (raw / sumW) * (config.full_score / 100);
  };

  const saveScores = async () => {
    const items = scores
      .filter((r) => [r.rate_a, r.rate_b, r.rate_c, r.rate_d, r.rate_e].some((v) => v !== '' && v != null))
      .map((r) => ({ group_key: r.group_key, rate_a: r.rate_a, rate_b: r.rate_b, rate_c: r.rate_c, rate_d: r.rate_d, rate_e: r.rate_e, total_count: r.total_count, avg_score: r.avg_score }));
    try {
      await api.put(`/assessment/exams/${curExam.id}/scores`, { items });
      toast.success(`已保存 ${items.length} 个备课组各率`);
      openExam(curExam);
    } catch (err) { toast.error(errMsg(err)); }
  };

  // 下载各率导入模板
  const downloadTemplate = async () => {
    setError('');
    try {
      const token = localStorage.getItem('edu_token');
      const r = await fetch(`/api/assessment/exams/${curExam.id}/scores-template`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setError('下载模板失败'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${curExam.name}-各率导入模板.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { setError(errMsg(err)); }
  };

  // 批量导入各率
  const importScores = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const token = localStorage.getItem('edu_token');
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`/api/assessment/exams/${curExam.id}/scores/import`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) { toast.error(j.error || '导入失败'); return; }
      const { imported, errors } = j.data;
      toast.success(`已导入 ${imported} 个备课组各率${errors?.length ? `，${errors.length} 行异常` : ''}`);
      if (errors?.length) toast.error(errors.join('；'));
      openExam(curExam);
    } catch (err) { toast.error(errMsg(err)); }
    finally { e.target.value = ''; }
  };

  // 上传成绩文件（管理员 + 组长）
  const uploadFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!fileGroupKey) { toast.error('请先选择要关联的备课组'); e.target.value = ''; return; }
    try {
      const token = localStorage.getItem('edu_token');
      const fd = new FormData();
      fd.append('file', file);
      fd.append('group_key', fileGroupKey);
      const r = await fetch(`/api/assessment/exams/${curExam.id}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) { toast.error(j.error || '上传失败'); return; }
      toast.success(`已上传 ${j.data.filename}`);
      setExamFiles((await api.get(`/assessment/exams/${curExam.id}/files`)).data.data);
    } catch (err) { toast.error(errMsg(err)); }
    finally { e.target.value = ''; }
  };

  // 下载成绩文件（管理层）
  const downloadFile = (f) => {
    const token = localStorage.getItem('edu_token');
    const a = document.createElement('a');
    a.href = `/api/assessment/files/${f.id}/download`;
    // 用 fetch 带 token 下载，避免直接 a.href 无法带 Authorization
    fetch(a.href, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => { if (!r.ok) throw new Error('下载失败'); return r.blob(); })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = f.filename;
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => setError('下载失败'));
  };

  const loadSummary = async () => {
    if (!summarySemester) return toast.error('请选择学期');
    try {
      const r = await api.get('/assessment/summary', { params: { semester: summarySemester } });
      setSummary(r.data.data);
    } catch (err) { toast.error(errMsg(err)); }
  };

  const saveConfig = async () => {
    try {
      const r = await api.put('/assessment/config', config);
      setConfig(r.data.data);
      toast.success('考核配置已保存');
    } catch (err) { toast.error(errMsg(err)); }
  };

  // 固化 + 档案
  const [records, setRecords] = useState([]);
  const [recordsSemester, setRecordsSemester] = useState('');

  const archiveSemester = async (semester) => {
    if (!semester) return toast.error('请先选择学期');
    if (!(await toast.confirm(`确认固化「${semester}」的教师业绩档案？固化后改率/改权重不影响已归档档案。`, { danger: true }))) return;
    try {
      const r = await api.post(`/assessment/semesters/${encodeURIComponent(semester)}/archive`);
      toast.success(`已固化 ${r.data.data.records} 条档案（${r.data.data.groups} 个备课组）`);
    } catch (err) { toast.error(errMsg(err)); }
  };

  const loadRecords = async () => {
    if (!recordsSemester) return toast.error('请选择学期');
    try {
      const r = await api.get('/assessment/records', { params: { semester: recordsSemester } });
      setRecords(r.data.data);
    } catch (err) { toast.error(errMsg(err)); }
  };

  const setWeight = (key, val) => setConfig((c) => ({ ...c, rate_weights: { ...c.rate_weights, [key]: val } }));

  // 按年级+学科分组展示各率（复用折叠思路的简化版：按年级分组）
  const scoresByGrade = useMemo(() => {
    const order = ['高一', '高二', '高三', '初一', '初二', '初三'];
    const map = new Map();
    for (const s of scores) {
      const g = s.grade || '未分年级';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(s);
    }
    return [...map.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1; if (ib !== -1) return 1;
      return a[0].localeCompare(b[0], 'zh');
    });
  }, [scores]);

  // 年级折叠：切换单个年级；展开/收起全部
  const toggleGrade = (grade) => {
    setExpandedGrades((prev) => {
      const next = new Set(prev);
      if (next.has(grade)) next.delete(grade); else next.add(grade);
      return next;
    });
  };
  const allGrades = scoresByGrade.map(([g]) => g);
  const expandAll = () => setExpandedGrades(new Set(allGrades));
  const collapseAll = () => setExpandedGrades(new Set());
  // 某年级「已录入」的备课组数（率非空且非 0）
  const gradeSavedCount = (list) => list.filter((s) => [s.rate_a, s.rate_b, s.rate_c, s.rate_d, s.rate_e].some((v) => v !== '' && v != null && Number(v) !== 0)).length;

  return (
    <div>
      <div className="page-head">
        <h2>教学业绩</h2>
        <div className="toolbar">
          <button className={`btn sm ${tab === 'exams' ? 'primary' : ''}`} onClick={() => setTab('exams')}>考试与成绩</button>
          <button className={`btn sm ${tab === 'summary' ? 'primary' : ''}`} onClick={() => setTab('summary')}>考核汇总</button>
          {admin && <button className={`btn sm ${tab === 'records' ? 'primary' : ''}`} onClick={() => setTab('records')}>教师档案</button>}
          {admin && <button className={`btn sm ${tab === 'config' ? 'primary' : ''}`} onClick={() => setTab('config')}>考核配置</button>}
        </div>
      </div>
      {error && <div className="alert error">{error}</div>}

      {/* ===== Tab1 考试与成绩 ===== */}
      {tab === 'exams' && !curExam && (
        <div>
          <div className="card">
            <div className="card-head"><h3>新建考试</h3></div>
            <div className="form-grid">
              <div className="field">
                <label>考试名称</label>
                <input className="input" value={examForm.name} onChange={(e) => setExamForm((f) => ({ ...f, name: e.target.value }))} placeholder="如 高一高二期末考试" />
              </div>
              <div className="field">
                <label>学期</label>
                <input className="input" value={examForm.semester} onChange={(e) => setExamForm((f) => ({ ...f, semester: e.target.value }))} placeholder="如 2025-2026 第一学期" />
              </div>
              <div className="field">
                <label>考试类型</label>
                <select className="input" value={examForm.exam_type} onChange={(e) => setExamForm((f) => ({ ...f, exam_type: e.target.value }))}>
                  {examTypes.map((t) => <option key={t.id} value={t.name}>{t.name}{t.weight > 0 ? '（参与考核）' : '（仅留档）'}</option>)}
                </select>
              </div>
              <div className="field">
                <label>考试年级</label>
                <select className="input" value={examForm.grade} onChange={(e) => setExamForm((f) => ({ ...f, grade: e.target.value }))}>
                  <option value="">全校（所有年级）</option>
                  {GRADE_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div className="field">
                <label>考试日期</label>
                <input type="date" className="input" value={examForm.exam_date} onChange={(e) => setExamForm((f) => ({ ...f, exam_date: e.target.value }))} />
              </div>
            </div>
            <div className="field">
              <label>备注</label>
              <input className="input" value={examForm.note} onChange={(e) => setExamForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
            <button className="btn primary" onClick={createExam}>创建考试</button>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>考试列表</h3>
              <select className="input" style={{ width: 220 }} value={semesterFilter} onChange={(e) => setSemesterFilter(e.target.value)}>
                <option value="">全部学期</option>
                {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>名称</th><th>学期</th><th>类型</th><th>年级</th><th>日期</th><th>操作</th></tr></thead>
                <tbody>
                  {filteredExams.map((e) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{e.semester}</td>
                      <td><span className="badge">{e.exam_type}</span></td>
                      <td>{e.grade ? <span className="badge">{e.grade}</span> : '全校'}</td>
                      <td>{e.exam_date || '—'}</td>
                      <td>
                        <button className="btn sm" onClick={() => openExam(e)}>录入各率</button>
                        {admin && <button className="btn sm danger" onClick={() => deleteExam(e.id)}>删除</button>}
                      </td>
                    </tr>
                  ))}
                  {filteredExams.length === 0 && <tr><td colSpan="6" className="muted" style={{ textAlign: 'center' }}>暂无考试</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===== Tab1 考试各率录入 ===== */}
      {tab === 'exams' && curExam && (
        <div>
          <div className="card-head" style={{ marginBottom: 12 }}>
            <button className="btn sm" onClick={() => setCurExam(null)}>← 返回列表</button>
            <h3 style={{ display: 'inline', marginLeft: 8 }}>{curExam.name}（{curExam.exam_type}）{curExam.grade ? <span className="badge" style={{ marginLeft: 8 }}>{curExam.grade}</span> : <span className="badge" style={{ marginLeft: 8 }}>全校</span>}</h3>
          </div>

          {/* 成绩文件留档（管理员 + 组长可传/下载） */}
          <div className="card">
            <div className="card-head"><h3>成绩文件留档</h3></div>
            <div className="toolbar" style={{ marginBottom: 12 }}>
              <select className="input" style={{ width: 240 }} value={fileGroupKey} onChange={(e) => setFileGroupKey(e.target.value)}>
                <option value="">选择关联备课组</option>
                {scores.map((s) => <option key={s.group_key} value={s.group_key}>{s.group_name}</option>)}
              </select>
              <label className="btn sm" style={{ cursor: 'pointer' }}>
                上传成绩文件
                <input type="file" style={{ display: 'none' }} onChange={uploadFile} />
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>备课组</th><th>文件名</th><th>上传人</th><th>时间</th><th>操作</th></tr></thead>
                <tbody>
                  {examFiles.length === 0 && <tr><td colSpan="5" className="muted" style={{ textAlign: 'center' }}>暂无成绩文件</td></tr>}
                  {examFiles.map((f) => {
                    const grp = scores.find((s) => s.group_key === f.group_key);
                    return (
                      <tr key={f.id}>
                        <td>{grp?.group_name || f.group_key}</td>
                        <td>{f.filename}</td>
                        <td>{f.uploader_name || '—'}</td>
                        <td>{f.uploaded_at}</td>
                        <td><button className="btn sm" onClick={() => downloadFile(f)}>下载</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="toolbar" style={{ marginBottom: 12 }}>
            <span className="muted" style={{ fontSize: 13 }}>共 {scores.length} 个备课组，默认展开已录入的年级</span>
            <button className="btn sm" onClick={expandAll}>展开全部</button>
            <button className="btn sm" onClick={collapseAll}>收起全部</button>
          </div>

          {scoresByGrade.map(([grade, list]) => {
            const open = expandedGrades.has(grade);
            const saved = gradeSavedCount(list);
            const hasAny = saved > 0;
            return (
              <div className="card" key={grade}>
                <div className="card-head grade-head" style={{ cursor: 'pointer' }} onClick={() => toggleGrade(grade)}>
                  <h3 style={{ display: 'inline', margin: 0 }}>
                    <span style={{ marginRight: 6 }}>{open ? '▾' : '▸'}</span>
                    {grade}
                    {hasAny && <span className="badge" style={{ marginLeft: 8 }}>{saved}/{list.length} 已录</span>}
                  </h3>
                  <span className="muted" style={{ fontSize: 12 }}>{list.length} 个备课组</span>
                </div>
                {open && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>备课组</th><th>学科</th>
                          {RATE_KEYS.map((r) => <th key={r.key}>{r.label}%</th>)}
                          <th>参考人数</th><th>均分</th><th>考核分(预览)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((s) => (
                          <tr key={s.group_key}>
                            <td>{s.group_name}</td>
                            <td>{s.subject}</td>
                            {RATE_KEYS.map((r) => (
                              <td key={r.key}><input type="number" min="0" max="100" step="0.1" className="input" style={{ width: 74 }} value={s[`rate_${r.key}`] ?? ''} onChange={(e) => setRate(s.group_key, r.key, e.target.value === '' ? '' : Number(e.target.value))} /></td>
                            ))}
                            <td><input type="number" className="input" style={{ width: 74 }} value={s.total_count ?? ''} onChange={(e) => setScores((prev) => prev.map((r) => (r.group_key === s.group_key ? { ...r, total_count: e.target.value === '' ? null : Number(e.target.value) } : r)))} /></td>
                            <td><input type="number" className="input" style={{ width: 74 }} value={s.avg_score ?? ''} onChange={(e) => setScores((prev) => prev.map((r) => (r.group_key === s.group_key ? { ...r, avg_score: e.target.value === '' ? null : Number(e.target.value) } : r)))} /></td>
                            <td><strong>{singleScore(s).toFixed(1)}</strong></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
          <div className="toolbar">
            <button className="btn sm" onClick={downloadTemplate}>下载模板</button>
            <label className="btn sm" style={{ cursor: 'pointer' }}>
              批量导入
              <input type="file" accept=".xlsx,.csv" style={{ display: 'none' }} onChange={importScores} />
            </label>
            <button className="btn primary" onClick={saveScores}>保存各率</button>
          </div>
        </div>
      )}

      {/* ===== Tab2 考核汇总 ===== */}
      {tab === 'summary' && (
        <div>
          <div className="card">
            <div className="card-head">
              <h3>学期考核汇总</h3>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <select className="input" style={{ width: 220 }} value={summarySemester} onChange={(e) => setSummarySemester(e.target.value)}>
                  <option value="">选择学期</option>
                  {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn primary sm" onClick={loadSummary}>查询</button>
                {admin && <button className="btn sm" onClick={() => archiveSemester(summarySemester)}>固化本学期档案</button>}
              </div>
            </div>
          </div>

          {summary && (
            <>
              <div className="card">
                <div className="card-head"><h3>备课组考核</h3></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>备课组</th><th>年级</th><th>学科</th><th>学期考核分</th><th>参与考试</th></tr></thead>
                    <tbody>
                      {summary.groups.map((g) => (
                        <tr key={g.group_key}>
                          <td>{g.group_name}</td>
                          <td>{g.grade}</td>
                          <td>{g.subject}</td>
                          <td><strong>{g.score ?? '—'}</strong></td>
                          <td>{g.exams.map((x) => `${x.exam_type}(${x.score.toFixed(1)})`).join('、')}</td>
                        </tr>
                      ))}
                      {summary.groups.length === 0 && <tr><td colSpan="5" className="muted" style={{ textAlign: 'center' }}>该学期暂无成绩</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <div className="card-head"><h3>教师考核（按所属备课组均值）</h3></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>教师</th><th>学科</th><th>参与组数</th><th>考核分</th></tr></thead>
                    <tbody>
                      {summary.teachers.map((t) => (
                        <tr key={t.teacher_id}><td>{t.teacher_name}</td><td>{t.subject}</td><td>{t.group_count}</td><td><strong>{t.score ?? '—'}</strong></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <div className="card-head"><h3>教研组考核（按备课组均值）</h3></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>学科</th><th>备课组数</th><th>考核分</th></tr></thead>
                    <tbody>
                      {summary.subjects.map((s) => (
                        <tr key={s.subject}><td>{s.subject}</td><td>{s.group_count}</td><td><strong>{s.score ?? '—'}</strong></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== Tab3 考核配置 ===== */}
      {tab === 'config' && admin && (
        <div className="card">
          <div className="card-head"><h3>考核结构配置（率权重）</h3></div>
          <p className="muted" style={{ marginTop: 0 }}>单次考试考核分 = Σ(各率 × 权重) / Σ权重 ×（满分/100）。默认 A率×0.6 + B率×0.4。</p>
          <div className="form-grid" style={{ maxWidth: 520 }}>
            {RATE_KEYS.map((r) => (
              <div className="field" key={r.key}>
                <label>{r.label}权重</label>
                <input type="number" min="0" step="0.1" className="input" value={config.rate_weights[r.key] ?? 0} onChange={(e) => setWeight(r.key, Number(e.target.value))} />
              </div>
            ))}
            <div className="field">
              <label>满分</label>
              <input type="number" min="1" className="input" value={config.full_score} onChange={(e) => setConfig((c) => ({ ...c, full_score: Number(e.target.value) }))} />
            </div>
          </div>
          <button className="btn primary" onClick={saveConfig}>保存配置</button>
          <p className="muted" style={{ marginTop: 12 }}>提示：考试类型权重（期末/学考等）在「考试类型」字典中配置，见考试录入时类型选择。</p>
        </div>
      )}

      {/* ===== Tab3 教师档案 ===== */}
      {tab === 'records' && admin && (
        <div>
          <div className="card">
            <div className="card-head">
              <h3>教师业绩档案</h3>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <select className="input" style={{ width: 220 }} value={recordsSemester} onChange={(e) => setRecordsSemester(e.target.value)}>
                  <option value="">选择学期</option>
                  {semesters.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn primary sm" onClick={loadRecords}>查询</button>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>教师</th><th>学科</th><th>学期</th><th>备课组</th><th>学期考核分</th><th>固化时间</th></tr></thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td>{r.teacher_name}</td>
                      <td>{r.subject}</td>
                      <td>{r.semester}</td>
                      <td>{(() => { try { return JSON.parse(r.detail)?.group_name || r.group_key; } catch { return r.group_key; } })()}</td>
                      <td><strong>{r.score}</strong></td>
                      <td>{r.locked_at || '—'}</td>
                    </tr>
                  ))}
                  {records.length === 0 && <tr><td colSpan="6" className="muted" style={{ textAlign: 'center' }}>该学期暂无已固化档案</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
