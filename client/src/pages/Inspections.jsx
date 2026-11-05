import React, { useEffect, useMemo, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';
import { INSPECTION_CONFIG_ROLES, INSPECTION_SUBMIT_ROLES } from '../roles.js';

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const CYCLE_BADGE = { daily: 'ok', periodic: 'info' };
const CYCLE_LABEL = { daily: '日常', periodic: '周期' };

// 本地日期 YYYY-MM-DD
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// 某日期是周几（1=周一 … 7=周日）
function dowOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

// 模板字段渲染（select / text / textarea）
function Field({ item, value, onChange }) {
  if (item.type === 'select') {
    return (
      <select value={value || ''} onChange={(e) => onChange(item.key, e.target.value)}>
        <option value="">请选择</option>
        {(item.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (item.type === 'text' || item.type === 'textarea') {
    return <textarea rows={item.type === 'textarea' ? 4 : 2} value={value || ''} onChange={(e) => onChange(item.key, e.target.value)} />;
  }
  return <input value={value || ''} onChange={(e) => onChange(item.key, e.target.value)} />;
}

// 带鉴权头的图片组件（<img> 无法携带 Authorization header）
function AuthImage({ src, alt }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const token = localStorage.getItem('edu_token');
    fetch(src, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((b) => setUrl(URL.createObjectURL(b)))
      .catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [src]);
  return url ? <img src={url} alt={alt} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} /> : <span className="muted">加载中…</span>;
}

export default function Inspections() {
  const [tab, setTab] = useState('list');
  const [types, setTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [records, setRecords] = useState([]);
  const [classes, setClasses] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');
  const toast = useToast();

  // 列表过滤
  const [fDate, setFDate] = useState('');
  const [fClass, setFClass] = useState('');
  const [fTeacher, setFTeacher] = useState('');
  const [fCategory, setFCategory] = useState('');

  // 提交检查状态
  const [typeId, setTypeId] = useState('');
  const [lessonDate, setLessonDate] = useState(today());
  const [classId, setClassId] = useState('');
  const [periodNo, setPeriodNo] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [subject, setSubject] = useState('');
  const [dayLessons, setDayLessons] = useState([]);
  const [values, setValues] = useState({});
  const [scores, setScores] = useState({});
  const [cycleLabel, setCycleLabel] = useState('');
  const [photos, setPhotos] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editingDetail, setEditingDetail] = useState(false); // 详情弹窗内编辑态
  const [editValues, setEditValues] = useState({});          // 编辑态：检查项
  const [editScores, setEditScores] = useState({});          // 编辑态：打分 name->score
  const [editDate, setEditDate] = useState('');              // 编辑态：检查日期

  // 类型管理状态
  const [catForm, setCatForm] = useState({ name: '' });
  const [typeForm, setTypeForm] = useState({ name: '', category_id: '', cycle: 'daily', schedule_link: 1, description: '', items: [{ key: '', label: '', type: 'select', options: '' }] });
  const [typeEditId, setTypeEditId] = useState(null); // 正在编辑的类型 id（null=新建）
  const [editingType, setEditingType] = useState(null); // 展开编辑维度的类型 id
  const [dimForm, setDimForm] = useState([]); // 编辑某类型维度

  // 检查配置状态（学期起始 + 达标线）
  const [config, setConfig] = useState({ semester_start: '', pass_line: 90 });

  // 统计状态
  const [statMode, setStatMode] = useState('teachers'); // teachers | groups
  const [sFrom, setSFrom] = useState('');
  const [sTo, setSTo] = useState('');
  const [sCategory, setSCategory] = useState('');
  const [sType, setSType] = useState('');
  const [passLine, setPassLine] = useState(90); // 统计页临时覆盖值，初始 = 配置值
  const [statTeachers, setStatTeachers] = useState([]);
  const [statGroups, setStatGroups] = useState([]);
  const [groupExpand, setGroupExpand] = useState(null); // 展开的组 key

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const canConfig = INSPECTION_CONFIG_ROLES.includes(user.role);
  const canSubmit = INSPECTION_SUBMIT_ROLES.includes(user.role);

  const load = async () => {
    try {
      const [t, cat, r, c, tc, cfg] = await Promise.all([
        api.get('/inspections/types'),
        api.get('/inspections/categories'),
        api.get('/inspections'),
        api.get('/classes'),
        api.get('/teachers'),
        api.get('/inspections/config'),
      ]);
      setTypes(t.data.data);
      setCategories(cat.data.data);
      setRecords(r.data.data);
      setClasses(c.data.data);
      setTeachers(tc.data.data);
      setConfig(cfg.data.data);
      setPassLine(cfg.data.data.pass_line);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const currentType = types.find((t) => t.id === Number(typeId));
  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes]);
  const teacherById = useMemo(() => new Map(teachers.map((t) => [t.id, t])), [teachers]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const typeDims = currentType?.dimensions || [];
  const linkType = currentType && currentType.schedule_link !== 0; // 该类型是否需要课表联动
  // 详情编辑用的打分维度（从已固化的 scores 快照还原 name/label/weight）
  const typeDimsOfDetail = useMemo(() => {
    if (!detail?.scores || typeof detail.scores !== 'object') return [];
    return Object.entries(detail.scores).map(([name, v]) => ({ name, label: v?.label || name, weight: Number(v?.weight) || 1 }));
  }, [detail]);
  // 详情对应的检查类型模板（用于编辑态渲染检查项）
  const detailType = useMemo(() => types.find((t) => t.id === Number(detail?.template_id)), [types, detail]);

  // 课表联动：选班 + 日期后拉取当天该班课程
  const loadDayLessons = async (date, cid) => {
    if (!date || !cid) { setDayLessons([]); return; }
    try {
      const res = await api.get('/inspections/lessons', { params: { date, class_id: cid } });
      setDayLessons(res.data.data);
    } catch (e) { setError(errMsg(e)); setDayLessons([]); }
  };
  useEffect(() => { loadDayLessons(lessonDate, classId); }, [lessonDate, classId]);

  // 周期标记：周期类 + 有日期时，向后端取自动周次
  const loadWeekLabel = async () => {
    if (currentType?.cycle !== 'periodic' || !lessonDate) { setCycleLabel(''); return; }
    try {
      const res = await api.get('/inspections/week-label', { params: { date: lessonDate } });
      setCycleLabel(res.data.data.label || '');
    } catch (e) { setCycleLabel(''); }
  };
  useEffect(() => { loadWeekLabel(); }, [currentType?.id, currentType?.cycle, lessonDate]);

  const periods = useMemo(() => [...new Set(dayLessons.map((l) => l.period_no))].filter((p) => p > 0).sort((a, b) => a - b), [dayLessons]);

  const pickPeriod = (p) => {
    setPeriodNo(String(p));
    const matches = dayLessons.filter((l) => l.period_no === p);
    if (matches.length) {
      setTeacherId(String(matches[0].teacher_id));
      setSubject(matches[0].subject || '');
    }
  };

  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));
  const setScore = (name, v) => setScores((prev) => ({ ...prev, [name]: v }));
  const setAllScores = (v) => {
    const next = {};
    typeDims.forEach((d) => { next[d.name] = v; });
    setScores(next);
  };

  const scoreTotal = typeDims.reduce((s, d) => s + (Number(scores[d.name]) || 0) * (Number(d.weight) || 1), 0);
  const scoreMax = typeDims.reduce((s, d) => s + (Number(d.weight) || 1) * 100, 0);

  const resetSubmit = () => {
    setValues({}); setScores({}); setPhotos([]);
    setClassId(''); setPeriodNo(''); setTeacherId(''); setSubject(''); setTypeId(''); setCycleLabel('');
    setDayLessons([]);
  };

  const submit = async () => {
    if (!typeId) return toast.error('请选择检查类型');
    if (!lessonDate) return toast.error('请选择检查日期');
    try {
      const scoreArr = typeDims.map((d) => ({ name: d.name, score: Number(scores[d.name]) || 0 }));
      const payload = {
        type_id: Number(typeId),
        class_id: classId ? Number(classId) : null,
        teacher_id: teacherId ? Number(teacherId) : null,
        subject: subject || null,
        day_of_week: lessonDate ? dowOf(lessonDate) : null,
        period_no: periodNo ? Number(periodNo) : null,
        lesson_date: lessonDate,
        cycle_label: currentType?.cycle === 'periodic' ? cycleLabel : null,
        data: { ...values },
        scores: scoreArr,
      };
      let inspId;
      const res = await api.post('/inspections', payload);
      inspId = res.data.data.id;
      toast.success('检查已提交');
      if (photos.length) {
        const fd = new FormData();
        photos.forEach((p) => fd.append('photos', p));
        await api.post(`/inspections/${inspId}/photos`, fd);
      }
      resetSubmit();
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  // 详情弹窗内编辑：进入编辑态，回填当前记录的检查项与打分
  const beginEdit = () => {
    const d = detail;
    if (!d) return;
    setEditingDetail(true);
    setEditValues(d.data || {});
    setEditDate(d.lesson_date || '');
    const sc = {};
    if (d.scores && typeof d.scores === 'object') {
      Object.values(d.scores).forEach((v) => { if (v && v.name != null) sc[v.name] = v.score; });
    }
    setEditScores(sc);
  };
  const cancelEdit = () => { setEditingDetail(false); setEditValues({}); setEditScores({}); setEditDate(''); };
  const setEditValue = (key, v) => setEditValues((prev) => ({ ...prev, [key]: v }));
  const setEditScore = (name, v) => setEditScores((prev) => ({ ...prev, [name]: v }));
  const setAllEditScores = (v) => {
    const next = {};
    typeDimsOfDetail.forEach((d) => { next[d.name] = v; });
    setEditScores(next);
  };

  // 保存编辑（仅改日期 + 检查项 + 打分，类型/班级/教师不动）
  const saveEdit = async () => {
    if (!detail) return;
    try {
      const scoreArr = typeDimsOfDetail.map((d) => ({ name: d.name, score: Number(editScores[d.name]) || 0 }));
      await api.patch(`/inspections/${detail.id}`, {
        lesson_date: editDate || null,
        day_of_week: editDate ? dowOf(editDate) : null,
        data: { ...editValues },
        scores: scoreArr,
      });
      toast.success('检查记录已修改');
      // 刷新详情
      const refreshed = (await api.get(`/inspections/${detail.id}`)).data.data;
      setDetail(refreshed);
      cancelEdit();
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const removeRecord = async (id) => {
    if (!(await toast.confirm('确定删除这条检查记录？删除后不可恢复。', { danger: true }))) return false;
    try {
      await api.delete(`/inspections/${id}`);
      toast.success('检查记录已删除');
      load();
      return true;
    } catch (e) { toast.error(errMsg(e)); return false; }
  };

  // ===== 类型管理 =====
  const addCat = async () => {
    if (!catForm.name.trim()) return toast.error('分类名称必填');
    try {
      await api.post('/inspections/categories', { name: catForm.name.trim() });
      setCatForm({ name: '' });
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };
  const delCat = async (id) => {
    if (!(await toast.confirm('删除该大类？需先清空其下检查类型。', { danger: true }))) return;
    try { await api.delete(`/inspections/categories/${id}`); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  const setTplItem = (i, field, v) => {
    const items = typeForm.items.map((it, idx) => (idx === i ? { ...it, [field]: v } : it));
    setTypeForm({ ...typeForm, items });
  };
  const addTplItem = () => setTypeForm({ ...typeForm, items: [...typeForm.items, { key: '', label: '', type: 'select', options: '' }] });
  const removeTplItem = (i) => setTypeForm({ ...typeForm, items: typeForm.items.filter((_, idx) => idx !== i) });

  const emptyTypeForm = () => ({ name: '', category_id: '', cycle: 'daily', schedule_link: 1, description: '', items: [{ key: '', label: '', type: 'select', options: '' }] });

  const saveType = async (e) => {
    e.preventDefault();
    try {
      const items = typeForm.items
        .filter((it) => it.label)
        .map((it) => ({ key: it.key || it.label, label: it.label, type: it.type, options: it.type === 'select' ? it.options.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : undefined }));
      if (!items.length) return toast.error('请至少添加一个检查项');
      if (!typeForm.category_id) return toast.error('请选择检查大类');
      const payload = {
        name: typeForm.name.trim(),
        category_id: Number(typeForm.category_id),
        cycle: typeForm.cycle,
        schedule_link: typeForm.schedule_link ? 1 : 0,
        description: typeForm.description || null,
        items,
      };
      if (typeEditId != null) {
        await api.patch(`/inspections/types/${typeEditId}`, payload);
        toast.success('检查类型已更新');
      } else {
        await api.post('/inspections/types', payload);
        toast.success('检查类型已创建');
      }
      setTypeForm(emptyTypeForm());
      setTypeEditId(null);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  // 编辑检查类型：把类型现有字段填进表单
  const openTypeEdit = (t) => {
    setEditingType(null); // 收起维度编辑
    setTypeEditId(t.id);
    setTypeForm({
      name: t.name,
      category_id: t.category_id ?? '',
      cycle: t.cycle || 'daily',
      schedule_link: t.schedule_link === 0 ? 0 : 1,
      description: t.description || '',
      items: (t.items || []).length
        ? t.items.map((it) => ({ key: it.key || '', label: it.label || '', type: it.type || 'select', options: (it.options || []).join(',') }))
        : [{ key: '', label: '', type: 'select', options: '' }],
    });
  };
  const cancelTypeEdit = () => {
    setTypeForm(emptyTypeForm());
    setTypeEditId(null);
  };
  const delType = async (id) => {
    if (!(await toast.confirm('删除该检查类型？已有检查记录则不可删。', { danger: true }))) return;
    try { await api.delete(`/inspections/types/${id}`); if (typeEditId === id) cancelTypeEdit(); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  // 编辑某类型维度
  const openDim = (t) => {
    setEditingType(t.id);
    setDimForm(t.dimensions.length ? t.dimensions.map((d) => ({ name: d.name, label: d.label, weight: d.weight })) : [{ name: '', label: '', weight: 1 }]);
  };
  const setDimItem = (i, field, v) => setDimForm(dimForm.map((it, idx) => (idx === i ? { ...it, [field]: v } : it)));
  const addDimItem = () => setDimForm([...dimForm, { name: '', label: '', weight: 1 }]);
  const removeDimItem = (i) => setDimForm(dimForm.filter((_, idx) => idx !== i));
  const saveDim = async () => {
    try {
      const items = dimForm.filter((it) => it.name && it.label).map((it) => ({ name: it.name.trim(), label: it.label.trim(), weight: Number(it.weight) || 1 }));
      await api.put(`/inspections/types/${editingType}/dimensions`, { items });
      setEditingType(null);
      toast.success('打分维度已保存');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  // 保存检查配置（学期起始 + 达标线）
  const saveConfig = async () => {
    try {
      const res = await api.put('/inspections/config', {
        semester_start: config.semester_start,
        pass_line: Number(config.pass_line),
      });
      setConfig(res.data.data);
      setPassLine(res.data.data.pass_line);
      toast.success('检查配置已保存');
    } catch (e) { toast.error(errMsg(e)); }
  };

  const openDetail = async (id) => {
    try { setDetail((await api.get(`/inspections/${id}`)).data.data); } catch (e) { toast.error(errMsg(e)); }
  };

  // ===== 统计 =====
  const loadStats = async () => {
    setError('');
    try {
      const params = { from: sFrom || undefined, to: sTo || undefined, category_id: sCategory || undefined, type_id: sType || undefined, pass_line: passLine };
      const [tr, gr] = await Promise.all([
        api.get('/inspections/stats/teachers', { params }),
        api.get('/inspections/stats/groups', { params }),
      ]);
      setStatTeachers(tr.data.data);
      setStatGroups(gr.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (tab === 'stats') loadStats(); }, [tab, sFrom, sTo, sCategory, sType, passLine]);

  // 下钻到记录列表
  const drillTeacher = (tid) => { setFTeacher(String(tid)); setTab('list'); };

  // 列表过滤
  const filteredRecords = records.filter((r) =>
    (!fDate || r.lesson_date === fDate) &&
    (!fClass || String(r.class_id) === fClass) &&
    (!fTeacher || String(r.teacher_id) === fTeacher) &&
    (!fCategory || String(r.category_id) === fCategory));

  const categoryBadge = (name) => (name === '课堂常规' ? 'ok' : name === '教学常规' ? 'info' : 'warn');

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">常规检查</h2>
        <p className="page-sub">检查类型两级归类、各自打分维度；周期检查标周次；打分沉淀教师、备课组、教研组评价</p>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="toolbar insp-tabs">
        <button className={`btn ${tab === 'list' ? 'primary' : ''}`} onClick={() => setTab('list')}>检查记录</button>
        {canSubmit && <button className={`btn ${tab === 'submit' ? 'primary' : ''}`} onClick={() => setTab('submit')}>提交检查</button>}
        <button className={`btn ${tab === 'stats' ? 'primary' : ''}`} onClick={() => setTab('stats')}>检查统计</button>
        {canConfig && <button className={`btn ${tab === 'types' ? 'primary' : ''}`} onClick={() => setTab('types')}>检查类型</button>}
      </div>

      {/* ============ 检查记录列表 ============ */}
      {tab === 'list' && (
        <div className="card">
          <div className="toolbar insp-filter">
            <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} title="按日期筛选" />
            <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
              <option value="">全部大类</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={fClass} onChange={(e) => setFClass(e.target.value)}>
              <option value="">全部班级</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={fTeacher} onChange={(e) => setFTeacher(e.target.value)}>
              <option value="">全部教师</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="table-wrap insp-desktop">
            <table>
              <thead><tr><th>检查类型</th><th>大类</th><th>日期</th><th>班级 / 教师 / 课程</th><th>得分</th><th>检查人</th><th style={{ width: 70 }}>操作</th></tr></thead>
              <tbody>
                {filteredRecords.map((r) => (
                  <tr key={r.id}>
                    <td>{r.template_name}{r.cycle_label ? <span className="muted"> · {r.cycle_label}</span> : null}</td>
                    <td><span className={`badge ${categoryBadge(r.category)}`}>{r.category}</span></td>
                    <td>{r.lesson_date || '-'}</td>
                    <td>
                      {[r.class_name, r.teacher_name, r.subject].filter(Boolean).join(' · ') || '-'}
                      {r.period_no ? <span className="muted">（第{r.period_no}节）</span> : null}
                    </td>
                    <td>
                      {r.score_total != null
                        ? <span className="score-chip">{r.score_total}<em> / {r.score_max}</em></span>
                        : <span className="muted">-</span>}
                    </td>
                    <td>{r.checker_name || '-'}</td>
                    <td><button className="btn sm" onClick={() => openDetail(r.id)}>查看</button></td>
                  </tr>
                ))}
                {filteredRecords.length === 0 && <tr><td colSpan={7} className="muted">暂无检查记录</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="insp-mobile">
            {filteredRecords.length === 0 && <p className="muted" style={{ textAlign: 'center', padding: '24px 0' }}>暂无检查记录</p>}
            {filteredRecords.map((r) => (
              <div key={r.id} className="insp-item" onClick={() => openDetail(r.id)}>
                <div className="insp-item-top">
                  <span className="insp-item-title">{r.template_name}{r.cycle_label ? ` · ${r.cycle_label}` : ''}</span>
                  <span className={`badge ${categoryBadge(r.category)}`}>{r.category}</span>
                </div>
                <div className="insp-item-body">
                  {[r.class_name, r.teacher_name, r.subject].filter(Boolean).join(' · ') || '-'}
                  {r.period_no ? <span className="muted">（第{r.period_no}节）</span> : null}
                </div>
                <div className="insp-item-foot">
                  <span className="muted">{r.lesson_date || ''} · {r.checker_name || ''}</span>
                  {r.score_total != null
                    ? <span className="score-chip">{r.score_total}<em> / {r.score_max}</em></span>
                    : <span className="muted">未打分</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ 提交检查 ============ */}
      {tab === 'submit' && (
        <div className="card insp-form">
          <h3>提交检查</h3>

          <div className="form-row">
            <label>检查类型</label>
            <select value={typeId} onChange={(e) => { setTypeId(e.target.value); setValues({}); setScores({}); }}>
              <option value="">请选择类型</option>
              {types.filter((t) => t.active !== 0).map((t) => (
                <option key={t.id} value={t.id}>{t.category_name} · {t.name}{t.cycle === 'periodic' ? '（周期）' : ''}</option>
              ))}
            </select>
          </div>

          {currentType?.cycle === 'periodic' && (
            <div className="form-row">
              <label>周期标记</label>
              <input value={cycleLabel} onChange={(e) => setCycleLabel(e.target.value)} placeholder="如 第6周" />
            </div>
          )}

          <div className="form-row">
            <label>检查日期</label>
            <input type="date" value={lessonDate} onChange={(e) => { setLessonDate(e.target.value); setPeriodNo(''); setTeacherId(''); setSubject(''); }} />
            {lessonDate && <div className="hint mt-xs">{DAYS[dowOf(lessonDate) - 1]}</div>}
          </div>

          {linkType ? (
            <div className="link-section">
              <div className="link-head">课表联动 <span className="muted">（选班级 + 节次，自动带出课程信息）</span></div>
              <div className="form-row">
                <label>班级</label>
                <select value={classId} onChange={(e) => { setClassId(e.target.value); setPeriodNo(''); setTeacherId(''); setSubject(''); }}>
                  <option value="">请选择班级</option>
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {classId && periods.length > 0 && (
                <div className="mt">
                  <label>选择节次（当天该班课程）</label>
                  <div className="period-pills">
                    {periods.map((p) => {
                      const lessons = dayLessons.filter((l) => l.period_no === p);
                      const subj = [...new Set(lessons.map((l) => l.subject).filter(Boolean))].join('/');
                      return (
                        <button key={p} type="button" className={`period-pill ${String(p) === periodNo ? 'on' : ''}`} onClick={() => pickPeriod(p)}>
                          <span className="pp-no">第{p}节</span>
                          {subj && <span className="pp-subj">{subj}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {classId && lessonDate && periods.length === 0 && (
                <p className="muted mt">该班当天暂无课程记录，可手动选择教师与科目。</p>
              )}

              <div className="course-card mt">
                <div className="course-card-title">课程信息</div>
                <div className="course-grid">
                  <div className="course-cell"><span className="k">班级</span><span className="v">{classById.get(Number(classId))?.name || '-'}</span></div>
                  <div className="course-cell"><span className="k">科目</span><span className="v">{subject || '-'}</span></div>
                  <div className="course-cell"><span className="k">节次</span><span className="v">{periodNo ? `第${periodNo}节` : '-'}</span></div>
                  <div className="course-cell"><span className="k">教师</span>
                    <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} className="inline-select">
                      <option value="">请选择教师</option>
                      {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                </div>
                {dayLessons.filter((l) => String(l.period_no) === periodNo).length > 1 && (
                  <p className="hint mt-xs">该节为分层/走班多门课，已取第一门，可手动调整教师。</p>
                )}
              </div>
            </div>
          ) : (
            <div className="link-section">
              <div className="link-head">检查对象 <span className="muted">（该类型无需课表联动，直接选择被检查教师）</span></div>
              <div className="form-grid">
                <div>
                  <label>班级</label>
                  <select value={classId} onChange={(e) => setClassId(e.target.value)}>
                    <option value="">请选择班级</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label>教师</label>
                  <select value={teacherId} onChange={(e) => { setTeacherId(e.target.value); const t = teacherById.get(Number(e.target.value)); if (t?.subject && !subject) setSubject(t.subject); }}>
                    <option value="">请选择教师</option>
                    {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <label>科目</label>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="如 语文" />
              </div>
            </div>
          )}

          {currentType && (
            <div className="mt-lg">
              <div className="sec-label">检查项</div>
              {(currentType.items || []).map((item) => (
                <div className="form-row" key={item.key}>
                  <label>{item.label}{item.type === 'photo' ? '（拍照/上传）' : ''}</label>
                  {item.type === 'photo' ? (
                    <input type="file" accept="image/*" capture="environment" multiple
                      onChange={(e) => setPhotos(Array.from(e.target.files || []))}
                      style={{ padding: 6 }} />
                  ) : (
                    <Field item={item} value={values[item.key]} onChange={setValue} />
                  )}
                </div>
              ))}
              {photos.length > 0 && <p className="muted">已选择 {photos.length} 张照片</p>}
            </div>
          )}

          {typeDims.length > 0 && (
            <div className="mt-lg">
              <div className="sec-label">检查打分</div>
              <div className="score-quick-all">
                <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 100) ? 'on' : ''}`} onClick={() => setAllScores(100)}>全部满分</button>
                <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 90) ? 'on' : ''}`} onClick={() => setAllScores(90)}>全部优秀</button>
                <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 80) ? 'on' : ''}`} onClick={() => setAllScores(80)}>全部良好</button>
                <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 60) ? 'on' : ''}`} onClick={() => setAllScores(60)}>全部及格</button>
              </div>
              {typeDims.map((d) => (
                <div className="score-row" key={d.id ?? d.name}>
                  <div className="score-row-head">
                    <span className="score-label">{d.label}</span>
                    <span className="score-val">{Number(scores[d.name]) || 0}</span>
                  </div>
                  <input type="range" min="0" max="100" step="5"
                    value={Number(scores[d.name]) || 0}
                    onChange={(e) => setScore(d.name, Number(e.target.value))}
                    className="score-range" />
                  <div className="score-quick">
                    {[100, 90, 80, 70, 60].map((v) => (
                      <button key={v} type="button" className={`score-q-btn ${Number(scores[d.name]) === v ? 'on' : ''}`} onClick={() => setScore(d.name, v)}>{v}</button>
                    ))}
                  </div>
                  {Number(d.weight) !== 1 && <span className="score-weight">权重 ×{d.weight}</span>}
                </div>
              ))}
              <div className="score-total">
                得分 <strong>{Math.round(scoreTotal * 10) / 10}</strong>
                <em> / {Math.round(scoreMax * 10) / 10}</em>
              </div>
            </div>
          )}

          <div className="mt-lg insp-submit">
            <button className="btn primary btn-block" onClick={submit}>提交检查</button>
          </div>
        </div>
      )}

      {/* ============ 检查统计 ============ */}
      {tab === 'stats' && (
        <div className="card">
          <div className="toolbar insp-filter">
            <input type="date" value={sFrom} onChange={(e) => setSFrom(e.target.value)} title="起始日期" />
            <input type="date" value={sTo} onChange={(e) => setSTo(e.target.value)} title="结束日期" />
            <select value={sCategory} onChange={(e) => setSCategory(e.target.value)}>
              <option value="">全部大类</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value={sType} onChange={(e) => setSType(e.target.value)}>
              <option value="">全部类型</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="muted">达标线</span>
              <input type="number" min="0" max="100" value={passLine} onChange={(e) => setPassLine(Number(e.target.value))} style={{ width: 60 }} />
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: 10 }}>
            <button className={`btn sm ${statMode === 'teachers' ? 'primary' : ''}`} onClick={() => setStatMode('teachers')}>按教师</button>
            <button className={`btn sm ${statMode === 'groups' ? 'primary' : ''}`} onClick={() => setStatMode('groups')}>按备课组/教研组</button>
          </div>

          {statMode === 'teachers' && (
            <div className="table-wrap mt">
              <table>
                <thead><tr><th>教师</th><th>学科</th><th>检查次数</th><th>平均分</th><th style={{ width: 70 }}>操作</th></tr></thead>
                <tbody>
                  {statTeachers.map((r) => (
                    <tr key={r.teacher_id}>
                      <td>{r.teacher_name}</td>
                      <td>{r.subject || '-'}</td>
                      <td>{r.count}</td>
                      <td>{r.avg_score != null ? <span className="score-chip">{r.avg_score}</span> : <span className="muted">-</span>}</td>
                      <td><button className="btn sm" onClick={() => drillTeacher(r.teacher_id)}>记录</button></td>
                    </tr>
                  ))}
                  {statTeachers.length === 0 && <tr><td colSpan={5} className="muted">暂无数据</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {statMode === 'groups' && (
            <div className="table-wrap mt">
              <table>
                <thead><tr><th>组名</th><th>类型</th><th>人数</th><th>已检</th><th>平均分</th><th>达标率</th><th>覆盖率</th><th style={{ width: 70 }}>操作</th></tr></thead>
                <tbody>
                  {statGroups.map((g) => (
                    <React.Fragment key={g.key}>
                      <tr>
                        <td>{g.name}{g.leader_name ? <span className="muted">（组长 {g.leader_name}）</span> : null}{g.is_auto ? <span className="muted"> 自动</span> : <span className="badge warn">手动</span>}</td>
                        <td>{g.type}</td>
                        <td>{g.teacher_count}</td>
                        <td>{g.checked_count}</td>
                        <td>{g.avg_score != null ? <span className="score-chip">{g.avg_score}</span> : <span className="muted">-</span>}</td>
                        <td>{g.pass_rate != null ? `${g.pass_rate}%` : '-'}</td>
                        <td>{g.coverage != null ? `${g.coverage}%` : '-'}</td>
                        <td><button className="btn sm" onClick={() => setGroupExpand(groupExpand === g.key ? null : g.key)}>成员</button></td>
                      </tr>
                      {groupExpand === g.key && (
                        <tr>
                          <td colSpan={8} className="muted">
                            {(() => {
                              const group = [...statGroups].find((x) => x.key === g.key);
                              const members = (group?.members || []).map((mid) => {
                                const t = teacherById.get(mid);
                                const row = statTeachers.find((x) => x.teacher_id === mid);
                                return { name: t?.name || `#${mid}`, subject: t?.subject, avg: row?.avg_score ?? null, cnt: row?.count ?? 0 };
                              });
                              return members.length ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '6px 0' }}>
                                  {members.map((m, i) => (
                                    <span key={i} className="badge neutral">{m.name} {m.avg != null ? `${m.avg}分(${m.cnt}次)` : '未检'}</span>
                                  ))}
                                </div>
                              ) : '暂无成员';
                            })()}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  {statGroups.length === 0 && <tr><td colSpan={8} className="muted">暂无数据</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ============ 检查类型管理 ============ */}
      {tab === 'types' && canConfig && (
        <div className="card">
          <h3>检查配置</h3>
          <div className="form-grid">
            <div>
              <label>学期起始日期（算周次用）</label>
              <input type="date" value={config.semester_start || ''} onChange={(e) => setConfig({ ...config, semester_start: e.target.value })} />
            </div>
            <div>
              <label>达标线（达标率口径，0-100）</label>
              <input type="number" min="0" max="100" step="1" value={config.pass_line} onChange={(e) => setConfig({ ...config, pass_line: Number(e.target.value) })} />
            </div>
            <div style={{ alignSelf: 'end' }}>
              <button className="btn primary" onClick={saveConfig}>保存配置</button>
            </div>
          </div>

          <h3 className="mt-lg">检查大类</h3>
          <div className="toolbar">
            <input value={catForm.name} onChange={(e) => setCatForm({ name: e.target.value })} placeholder="新大类名称" />
            <button className="btn sm" onClick={addCat}>+ 添加大类</button>
          </div>
          <div className="mt">
            {categories.map((c) => (
              <span key={c.id} className="badge neutral" style={{ marginRight: 8, marginBottom: 6 }}>
                {c.name}
                <button className="btn ghost sm" style={{ marginLeft: 6, padding: '0 4px' }} onClick={() => delCat(c.id)}>×</button>
              </span>
            ))}
          </div>

          <h3 className="mt-lg">检查类型</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>类型名</th><th>大类</th><th>周期</th><th>课表联动</th><th>检查项</th><th>维度</th><th style={{ width: 200 }}>操作</th></tr></thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td><span className={`badge ${categoryBadge(t.category_name)}`}>{t.category_name}</span></td>
                    <td><span className={`badge ${CYCLE_BADGE[t.cycle] || ''}`}>{CYCLE_LABEL[t.cycle] || t.cycle}</span></td>
                    <td>{t.schedule_link === 0 ? <span className="badge neutral">否</span> : <span className="badge ok">是</span>}</td>
                    <td>{t.items.length}</td>
                    <td>{t.dimensions.length}</td>
                    <td>
                      <button className="btn sm" onClick={() => openTypeEdit(t)}>编辑</button>
                      <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => openDim(t)}>维度</button>
                      <button className="btn sm danger" style={{ marginLeft: 6 }} onClick={() => delType(t.id)}>删</button>
                    </td>
                  </tr>
                ))}
                {types.length === 0 && <tr><td colSpan={7} className="muted">暂无检查类型</td></tr>}
              </tbody>
            </table>
          </div>

          {editingType != null && (
            <div className="card mt" style={{ border: '1px solid var(--primary)' }}>
              <h4>编辑打分维度 — {types.find((t) => t.id === editingType)?.name}</h4>
              {dimForm.map((it, i) => (
                <div key={i} className="form-grid tpl-row">
                  <input placeholder="字段名(如 writing)" value={it.name} onChange={(e) => setDimItem(i, 'name', e.target.value)} />
                  <input placeholder="显示名(如 书写规范)" value={it.label} onChange={(e) => setDimItem(i, 'label', e.target.value)} />
                  <input type="number" min="1" step="1" placeholder="权重" value={it.weight} onChange={(e) => setDimItem(i, 'weight', e.target.value)} />
                  <button type="button" className="btn sm danger" onClick={() => removeDimItem(i)}>删</button>
                </div>
              ))}
              <button type="button" className="btn sm" onClick={addDimItem}>+ 添加维度</button>
              <div className="mt">
                <button className="btn primary" onClick={saveDim}>保存维度</button>
                <button className="btn ghost" style={{ marginLeft: 8 }} onClick={() => setEditingType(null)}>取消</button>
              </div>
            </div>
          )}

          <h3 className="mt-lg">{typeEditId != null ? '编辑检查类型' : '新建检查类型'}</h3>
          <form onSubmit={saveType}>
            <div className="form-grid">
              <div><label>类型名称</label><input value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} required /></div>
              <div><label>大类</label>
                <select value={typeForm.category_id} onChange={(e) => setTypeForm({ ...typeForm, category_id: e.target.value })}>
                  <option value="">请选择</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div><label>周期</label>
                <select value={typeForm.cycle} onChange={(e) => setTypeForm({ ...typeForm, cycle: e.target.value })}>
                  <option value="daily">日常</option>
                  <option value="periodic">周期（标周次）</option>
                </select>
              </div>
              <div><label>课表联动</label>
                <select value={typeForm.schedule_link ? 1 : 0} onChange={(e) => setTypeForm({ ...typeForm, schedule_link: Number(e.target.value) })}>
                  <option value={1}>需要（选日期/班级/节次自动带出）</option>
                  <option value={0}>不需要（如备课本/听课本等材料检查）</option>
                </select>
              </div>
            </div>
            <div className="mt form-row">
              <label>描述（选填）</label>
              <input value={typeForm.description || ''} onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })} placeholder="该检查类型的使用说明" />
            </div>
            <div className="mt">
              <label>检查项（type 支持 select / text / textarea / photo）</label>
              {typeForm.items.map((it, i) => (
                <div key={i} className="form-grid tpl-row">
                  <input placeholder="字段名(如 attendance)" value={it.key} onChange={(e) => setTplItem(i, 'key', e.target.value)} />
                  <input placeholder="显示名(如 教师出勤)" value={it.label} onChange={(e) => setTplItem(i, 'label', e.target.value)} />
                  <select value={it.type} onChange={(e) => setTplItem(i, 'type', e.target.value)}>
                    <option value="select">select</option>
                    <option value="text">text</option>
                    <option value="textarea">textarea</option>
                    <option value="photo">photo</option>
                  </select>
                  <input placeholder="选项，逗号分隔(select用)" value={it.options} onChange={(e) => setTplItem(i, 'options', e.target.value)} />
                  <button type="button" className="btn sm danger" onClick={() => removeTplItem(i)}>删</button>
                </div>
              ))}
              <button type="button" className="btn sm" onClick={addTplItem}>+ 添加检查项</button>
            </div>
            <div className="mt">
              <button className="btn primary">{typeEditId != null ? '保存修改' : '保存类型'}</button>
              {typeEditId != null && <button type="button" className="btn ghost" style={{ marginLeft: 8 }} onClick={cancelTypeEdit}>取消</button>}
            </div>
          </form>
        </div>
      )}

      {/* ============ 详情弹层 ============ */}
      {detail && (
        <div className="modal-overlay" onClick={() => { if (!editingDetail) setDetail(null); }}>
          <div className="modal insp-detail" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{detail.template_name}{editingDetail ? '（编辑）' : ''}</h3>
              <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
                {canSubmit && !editingDetail && <button className="btn sm" onClick={beginEdit}>编辑</button>}
                {canSubmit && !editingDetail && <button className="btn sm danger" onClick={async () => { if (await removeRecord(detail.id)) setDetail(null); }}>删除</button>}
                {editingDetail
                  ? <button className="btn ghost" onClick={cancelEdit}>取消</button>
                  : <button className="btn ghost" onClick={() => setDetail(null)}>关闭</button>}
              </div>
            </div>

            {editingDetail ? (
              <div>
                <div className="form-row">
                  <label>检查日期</label>
                  <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>

                {detailType?.items?.length > 0 && (
                  <div className="mt">
                    <div className="sec-label">检查项</div>
                    {detailType.items.map((item) => (
                      <div className="form-row" key={item.key}>
                        <label>{item.label}</label>
                        <Field item={item} value={editValues[item.key]} onChange={setEditValue} />
                      </div>
                    ))}
                  </div>
                )}

                {typeDimsOfDetail.length > 0 && (
                  <div className="mt-lg">
                    <div className="sec-label">检查打分</div>
                    <div className="score-quick-all">
                      <button type="button" className={`score-q-btn ${typeDimsOfDetail.every((d) => (Number(editScores[d.name]) || 0) === 100) ? 'on' : ''}`} onClick={() => setAllEditScores(100)}>全部满分</button>
                      <button type="button" className={`score-q-btn ${typeDimsOfDetail.every((d) => (Number(editScores[d.name]) || 0) === 90) ? 'on' : ''}`} onClick={() => setAllEditScores(90)}>全部优秀</button>
                      <button type="button" className={`score-q-btn ${typeDimsOfDetail.every((d) => (Number(editScores[d.name]) || 0) === 80) ? 'on' : ''}`} onClick={() => setAllEditScores(80)}>全部良好</button>
                      <button type="button" className={`score-q-btn ${typeDimsOfDetail.every((d) => (Number(editScores[d.name]) || 0) === 60) ? 'on' : ''}`} onClick={() => setAllEditScores(60)}>全部及格</button>
                    </div>
                    {typeDimsOfDetail.map((d) => (
                      <div className="score-row" key={d.name}>
                        <div className="score-row-head">
                          <span className="score-label">{d.label}</span>
                          <span className="score-val">{Number(editScores[d.name]) || 0}</span>
                        </div>
                        <input type="range" min="0" max="100" step="5"
                          value={Number(editScores[d.name]) || 0}
                          onChange={(e) => setEditScore(d.name, Number(e.target.value))}
                          className="score-range" />
                        <div className="score-quick">
                          {[100, 90, 80, 70, 60].map((v) => (
                            <button key={v} type="button" className={`score-q-btn ${Number(editScores[d.name]) === v ? 'on' : ''}`} onClick={() => setEditScore(d.name, v)}>{v}</button>
                          ))}
                        </div>
                        {Number(d.weight) !== 1 && <span className="score-weight">权重 ×{d.weight}</span>}
                      </div>
                    ))}
                  </div>
                )}

                <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 16, gap: 8 }}>
                  <button className="btn" onClick={cancelEdit}>取消</button>
                  <button className="btn primary" onClick={saveEdit}>保存修改</button>
                </div>
              </div>
            ) : (
              <div>
                <div className="detail-meta">
                  <span className={`badge ${categoryBadge(detail.category)}`}>{detail.category}</span>
                  {detail.cycle_label && <span className="badge info">{detail.cycle_label}</span>}
                  {detail.lesson_date && <span className="badge">{detail.lesson_date}{detail.period_no ? ` 第${detail.period_no}节` : ''}</span>}
                  <span className="muted">{[detail.class_name, detail.teacher_name, detail.subject].filter(Boolean).join(' · ') || '未关联'} · {detail.checker_name} · {detail.created_at}</span>
                </div>

                {detail.score_total != null && (
                  <div className="detail-score">
                    <div className="detail-score-total">
                      检查得分 <strong>{detail.score_total}</strong><em> / {detail.score_max}</em>
                    </div>
                    {detail.scores && Object.entries(detail.scores).length > 0 && (
                      <div className="detail-score-dims">
                        {Object.entries(detail.scores).map(([k, v]) => (
                          <div key={k} className="dim-item">
                            <span className="dim-label">{v.label || k}</span>
                            <div className="dim-bar"><div className="dim-fill" style={{ width: `${Math.min(100, (v.score / 100) * 100)}%` }} /></div>
                            <span className="dim-score">{v.score}{Number(v.weight) !== 1 ? ` ×${v.weight}` : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="sec-label">检查内容</div>
                <table>
                  <tbody>
                    {Object.entries(detail.data || {}).map(([k, v]) => (
                      <tr key={k}><td style={{ width: 140, color: 'var(--muted)' }}>{k}</td><td>{String(v)}</td></tr>
                    ))}
                    {Object.keys(detail.data || {}).length === 0 && <tr><td className="muted">无</td></tr>}
                  </tbody>
                </table>
                {detail.photos?.length > 0 && (
                  <div className="mt">
                    <div className="sec-label">照片</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {detail.photos.map((p) => (
                        <AuthImage key={p.id} src={`/api/inspections/photos/${p.id}`} alt={p.filename} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
