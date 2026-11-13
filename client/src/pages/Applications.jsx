import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';
import { DIRECTOR_ROLES } from '../roles.js';
import ImportPreview from '../components/ImportPreview.jsx';
import { downloadShareImage } from '../utils/shareImage.js';

const STATUS = { pending: '待年级组长审核', grade_approved: '待课程中心终审', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', grade_approved: 'info', approved: 'ok', rejected: '', withdrawn: 'info' };

export default function Applications() {
  const [tab, setTab] = useState('qna');
  const [error, setError] = useState('');
  const toast = useToast();

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isAdmin = DIRECTOR_ROLES.includes(user.role); // 教务主任/admin：全权（编辑/删除/撤回/创建课程/终审）
  const isGradeLeader = user.role === '年级组长';
  // 可审核申报的角色：admin/教务主任 + 年级组长（年级组长限本年级，后端已过滤）
  const canReview = isAdmin || isGradeLeader;

  // 课时申报状态（晚自习/答疑/晚练等按次计酬 + 早自习折算）
  const [qnaList, setQnaList] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [typePays, setTypePays] = useState([]); // 按次计酬类型字典
  const [qnaForm, setQnaForm] = useState({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
  const [editingQna, setEditingQna] = useState(null); // 正在编辑的记录 id；null 表示新增
  const [qnaModal, setQnaModal] = useState(false); // 新增/编辑弹窗
  const [listMode, setListMode] = useState('pending'); // pending(待处理) | history(历史记录)
  const [importFile, setImportFile] = useState(null); // 批量导入文件
  const [qnaPreview, setQnaPreview] = useState(null); // 导入预览 { token, rows, summary }
  // 申报列表筛选
  const [qnaFilter, setQnaFilter] = useState({ status: '', period_type: '', grade: '', date: '' });

  // 申报状态
  const [tasks, setTasks] = useState([]);
  const [typeCoefs, setTypeCoefs] = useState([]); // 折算类型字典
  const [grades, setGrades] = useState([]);       // 年级枚举
  // 课程创建/编辑表单
  const [taskForm, setTaskForm] = useState({ title: '', deadline: '', filler_role: '教师', pay_mode: '按次计酬', period_type: '', subject: '', grade: '' });
  const [fieldList, setFieldList] = useState([]); // 自定义字段 [{key,label,type,required,options}]
  const [editingTask, setEditingTask] = useState(null); // 正在编辑的课程；null=新建
  const [taskModal, setTaskModal] = useState(false); // 课程新建/编辑弹窗
  const [openTask, setOpenTask] = useState(null);
  const [apps, setApps] = useState([]);
  const [linkModal, setLinkModal] = useState(null); // 分享弹层
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  // 固定折算课程审核时的档位覆盖（每笔待审记录 → 选中的折算档位名）
  const [appCoefMap, setAppCoefMap] = useState({});
  // 课程填报批量导入
  const [courseImport, setCourseImport] = useState(null); // { task, file }
  const [coursePreview, setCoursePreview] = useState(null); // { token, rows, summary }

  const loadQna = async (filter = qnaFilter) => {
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.period_type) params.period_type = filter.period_type;
      if (filter.grade) params.grade = filter.grade;
      if (filter.date) params.date = filter.date;
      const [q, t, c, tp] = await Promise.all([api.get('/applications', { params }), api.get('/teachers'), api.get('/classes'), api.get('/stats/type-pays')]);
      setQnaList(q.data.data); setTeachers(t.data.data); setClasses(c.data.data); setTypePays(tp.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  const loadTasks = async () => {
    try {
      const [tk, tc, gs] = await Promise.all([api.get('/applications/tasks'), api.get('/stats/type-coefficients'), api.get('/classes')]);
      setTasks(tk.data.data);
      setTypeCoefs(tc.data.data);
      const gradeSet = new Set(gs.data.data.map((c) => c.grade).filter((g) => g && g.trim()));
      setGrades([...gradeSet].sort());
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (canReview) { loadQna(); loadTasks(); } }, []);

  const submitQna = async (e) => {
    e.preventDefault();
    try {
      if (editingQna) {
        await api.patch(`/applications/${editingQna}`, { ...qnaForm, teacher_id: qnaForm.teacher_id || null, class_id: qnaForm.class_id || null, date: qnaForm.date || null });
        toast.success('申报已更新');
      } else {
        await api.post('/applications', { ...qnaForm, teacher_id: qnaForm.teacher_id || null, class_id: qnaForm.class_id || null, date: qnaForm.date || null });
        toast.success('申报已填报，待年级组长审核');
      }
      setQnaForm({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
      setEditingQna(null);
      setQnaModal(false);
      loadQna();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const openQnaModal = (q) => {
    if (q) {
      setEditingQna(q.id);
      setQnaForm({
        grade: q.grade || '', subject: q.subject || '', teacher_id: q.teacher_id ? String(q.teacher_id) : '',
        class_id: q.class_id ? String(q.class_id) : '', day_of_week: q.day_of_week != null ? String(q.day_of_week) : '',
        period_no: q.period_no != null ? String(q.period_no) : '', content: q.content || '',
        date: q.date || '', period_count: q.period_count != null ? String(q.period_count) : '1',
        period_type: q.period_type || '答疑',
      });
    } else {
      setEditingQna(null);
      setQnaForm({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
    }
    setQnaModal(true);
  };

  const cancelEdit = () => {
    setQnaModal(false);
    setEditingQna(null);
    setQnaForm({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
  };

  const reviewQna = async (id, approved) => {
    try { await api.patch(`/applications/${id}/review`, { approved }); toast.success('已审核'); loadQna(); } catch (e) { toast.error(errMsg(e)); }
  };

  // 一键审核：批量通过当前列表中所有待本角色处理的记录
  const reviewAllQna = async () => {
    // 年级组长一审 pending；管理员终审 pending + grade_approved
    const targets = qnaList.filter((q) => (isGradeLeader && !isAdmin) ? q.status === 'pending' : (q.status === 'pending' || q.status === 'grade_approved'));
    if (!targets.length) return toast.warn('没有待审核的记录');
    if (!(await toast.confirm(`确定一键通过全部 ${targets.length} 条待审核申报？`, { danger: true }))) return;
    let ok = 0;
    for (const q of targets) {
      try { await api.patch(`/applications/${q.id}/review`, { approved: true }); ok++; } catch { /* 单条失败继续 */ }
    }
    toast.success(`一键审核完成：通过 ${ok}/${targets.length} 条`);
    loadQna();
  };

  const deleteQna = async (id) => {
    if (!(await toast.confirm('确定删除该申报记录？若已通过，其已生成的上课记录（计酬）将一并删除。', { danger: true }))) return;
    try { await api.delete(`/applications/${id}`); toast.success('已删除'); loadQna(); } catch (e) { toast.error(errMsg(e)); }
  };

  const withdrawQna = async (id) => {
    if (!(await toast.confirm('确定撤回该已通过的申报？其已生成的上课记录（计酬）将一并删除。', { danger: true }))) return;
    try { await api.patch(`/applications/${id}/withdraw`); toast.success('已撤回'); loadQna(); } catch (e) { toast.error(errMsg(e)); }
  };

  // ===== 批量导入 =====
  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('edu_token');
      const r = await fetch('/api/applications/template', { headers: { Authorization: `Bearer ${token}` } });
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '课务申报导入模板.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };
  const importQna = async () => {
    if (!importFile) return toast.error('请先选择申报文件（.xlsx / .csv）');
    const fd = new FormData();
    fd.append('file', importFile);
    try {
      const { token, rows, summary } = (await api.post('/applications/import/preview', fd)).data.data;
      setQnaPreview({ token, rows, summary });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const confirmQnaImport = async (row_ids) => {
    await api.post('/applications/import/confirm', { token: qnaPreview.token, row_ids });
    setImportFile(null);
    setQnaPreview(null);
    loadQna();
  };

  // 打开新建/编辑课程弹窗
  const openTaskModal = (task) => {
    if (task) {
      setEditingTask(task);
      setTaskForm({
        title: task.title || '',
        deadline: task.deadline || '',
        filler_role: task.filler_role || '教师',
        pay_mode: task.pay_mode === '折算' ? '固定折算' : (task.pay_mode || '按次计酬'),
        period_type: task.period_type || '',
        subject: task.subject || '',
        grade: task.grade || '',
      });
      setFieldList((task.form_schema || []).map((f) => ({ key: f.key, label: f.label || '', type: f.type || 'text', required: !!f.required, options: f.options || '' })));
    } else {
      setEditingTask(null);
      setTaskForm({ title: '', deadline: '', filler_role: '教师', pay_mode: '按次计酬', period_type: '', subject: '', grade: '' });
      setFieldList([]);
    }
    setTaskModal(true);
  };
  const closeTaskModal = () => {
    setTaskModal(false);
    setEditingTask(null);
    setTaskForm({ title: '', deadline: '', filler_role: '教师', pay_mode: '按次计酬', period_type: '', subject: '', grade: '' });
    setFieldList([]);
  };

  const submitTask = async (e) => {
    e.preventDefault();
    try {
      if (editingTask) {
        await api.patch(`/applications/tasks/${editingTask.id}`, {
          title: taskForm.title,
          deadline: taskForm.deadline || null,
          filler_role: taskForm.filler_role,
          pay_mode: taskForm.pay_mode,
          period_type: taskForm.period_type,
          subject: taskForm.subject || null,
          grade: taskForm.grade || null,
          form_schema: fieldList.filter((f) => f.label && f.key),
        });
        toast.success('课程已更新');
      } else {
        const res = await api.post('/applications/tasks', {
          title: taskForm.title,
          deadline: taskForm.deadline || null,
          filler_role: taskForm.filler_role,
          pay_mode: taskForm.pay_mode,
          period_type: taskForm.period_type,
          subject: taskForm.subject || null,
          grade: taskForm.grade || null,
          form_schema: fieldList.filter((f) => f.label && f.key),
        });
        const created = res.data.data;
        toast.success('课程已创建');
        // 自动打开分享弹层
        if (created.share_token) openLinkModal(created);
      }
      closeTaskModal();
      loadTasks();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const openApps = async (task) => {
    setOpenTask(task);
    try { setApps((await api.get(`/applications/tasks/${task.id}/applications`)).data.data); } catch (e) { toast.error(errMsg(e)); }
  };

  const reviewApp = async (id, approved, periodType) => {
    try { await api.patch(`/applications/applications/${id}/review`, { approved, period_type: periodType }); toast.success('已审核'); openApps(openTask); } catch (e) { toast.error(errMsg(e)); }
  };

  const withdrawApp = async (id) => {
    if (!(await toast.confirm('确定撤回该已通过的申报？其已生成的上课记录（计酬）将一并删除。', { danger: true }))) return;
    try { await api.patch(`/applications/applications/${id}/withdraw`); toast.success('已撤回'); openApps(openTask); } catch (e) { toast.error(errMsg(e)); }
  };

  const deleteApp = async (id) => {
    if (!(await toast.confirm('确定删除该申报记录？若已通过，其已生成的上课记录（计酬）将一并删除。', { danger: true }))) return;
    try { await api.delete(`/applications/applications/${id}`); toast.success('已删除'); openApps(openTask); } catch (e) { toast.error(errMsg(e)); }
  };

  const deleteTask = async (task) => {
    const n = task.apply_count ?? 0;
    const warn = n > 0 ? `该课程已有 ${n} 条填报记录，删除将一并删除这些填报及其计酬记录。` : '删除后不可恢复。';
    if (!(await toast.confirm(`确定删除课程「${task.title}」？${warn}`, { danger: true }))) return;
    try {
      const r = await api.delete(`/applications/tasks/${task.id}`);
      toast.success(`已删除（填报 ${r.data.data.removed_apps} 条）`);
      loadTasks();
    } catch (e) { toast.error(errMsg(e)); }
  };

  // ===== 字段定义器 =====
  const addField = () => setFieldList([...fieldList, { key: `f${Date.now()}`, label: '', type: 'text', required: false, options: '' }]);
  const setField = (i, k, v) => { const n = [...fieldList]; n[i] = { ...n[i], [k]: v }; setFieldList(n); };
  const delField = (i) => setFieldList(fieldList.filter((_, idx) => idx !== i));

  // ===== 课程填报批量导入 =====
  const downloadCourseTemplate = async (task) => {
    const token = localStorage.getItem('edu_token');
    try {
      const r = await fetch(`/api/applications/tasks/${task.id}/import-template`, { headers: { Authorization: `Bearer ${token}` } });
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `课程填报导入模板_${task.title}.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const previewCourseImport = async () => {
    if (!courseImport?.file) return toast.error('请先选择文件（.xlsx / .csv）');
    const fd = new FormData();
    fd.append('file', courseImport.file);
    try {
      const { token, rows, summary } = (await api.post(`/applications/tasks/${courseImport.task.id}/import/preview`, fd)).data.data;
      setCoursePreview({ token, rows, summary });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const confirmCourseImport = async (row_ids) => {
    await api.post(`/applications/tasks/${courseImport.task.id}/import/confirm`, { token: coursePreview.token, row_ids });
    setCourseImport(null);
    setCoursePreview(null);
    if (openTask?.id === courseImport.task.id) openApps(openTask);
    toast.success('导入完成');
  };

  // ===== 分享二维码 =====
  const copyToClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* 回退 */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  };
  const openLinkModal = async (task) => {
    setLinkModal(task);
    setCopied(false);
    setQrDataUrl('');
    const url = task.share_url || `${window.location.origin}/course/${task.share_token}`;
    try {
      const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      setQrDataUrl(dataUrl);
    } catch { /* 二维码生成失败则隐藏 */ }
  };
  const copyLink = async () => {
    const url = linkModal.share_url || `${window.location.origin}/course/${linkModal.share_token}`;
    const ok = await copyToClipboard(url);
    setCopied(ok);
    if (ok) toast.success('分享链接已复制');
    else toast.error('复制失败，请手动复制链接');
    if (ok) setTimeout(() => setCopied(false), 1500);
  };
  const downloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `课程二维码_${linkModal?.title || '课程'}.png`;
    a.click();
  };
  const downloadShare = () => {
    if (!qrDataUrl) return;
    const url = linkModal.share_url || `${window.location.origin}/course/${linkModal.share_token}`;
    downloadShareImage({
      title: linkModal.title,
      sub: '课程申报 · 老师扫码填报',
      content: '',
      qrDataUrl,
      url,
      filename: `课程分享_${linkModal?.title || '课程'}.png`,
    });
  };

  // 课务申报：admin/教务主任 全权；年级组长仅一审本年级申报
  if (!canReview) {
    return (
      <div>
        <div className="page-head">
          <h2 className="page-title">课务申报</h2>
        </div>
        <div className="alert error">无权限：课务申报仅教务主任/年级组长可用，请使用「自主申报」提交课时申报。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">课务申报</h2>
        <p className="page-sub">课时申报（晚自习/答疑/晚练等按次计酬 + 早自习折算，年级组长一审 → 课程中心终审后进入课表）· 竞赛课/私人定制课申报</p>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="toolbar">
        <button className={`btn ${tab === 'qna' ? 'primary' : ''}`} onClick={() => setTab('qna')}>课时申报</button>
        {isAdmin && <button className={`btn ${tab === 'tasks' ? 'primary' : ''}`} onClick={() => setTab('tasks')}>课程申报</button>}
      </div>

      {/* 课时申报 */}
      {tab === 'qna' && (
        <>
          {isAdmin && <div className="card">
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <h3 style={{ margin: 0 }}>批量导入申报</h3>
              <span className="spacer" />
              <button className="btn primary" onClick={() => openQnaModal(null)}>+ 新增申报</button>
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setImportFile(e.target.files[0])} style={{ width: 'auto' }} />
              <button className="btn primary" onClick={importQna} disabled={!importFile}>预览</button>
              <button className="btn" onClick={downloadTemplate}>下载导入模板</button>
            </div>
            <p className="muted" style={{ margin: 0 }}>表头：年级、学科、类型、教师、班级、发生日期、节数、星期、节次、内容。导入后统一待审核。</p>
          </div>}

          <div className="card">
            <div className="card-head">
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <button className={`btn sm ${listMode === 'pending' ? 'primary' : ''}`} onClick={() => { setListMode('pending'); loadQna({ status: '', period_type: '', grade: '', date: '' }); }}>待处理</button>
                <button className={`btn sm ${listMode === 'history' ? 'primary' : ''}`} onClick={() => { setListMode('history'); loadQna({ status: '', period_type: '', grade: '', date: '' }); }}>历史记录</button>
                {listMode === 'pending' && <button className="btn sm primary" onClick={reviewAllQna}>一键审核</button>}
              </div>
            </div>
            <div className="toolbar">
              <select value={qnaFilter.status} onChange={(e) => setQnaFilter({ ...qnaFilter, status: e.target.value })} style={{ width: 120 }}>
                <option value="">全部状态</option>
                <option value="pending">待年级组长审核</option>
                <option value="grade_approved">待课程中心终审</option>
                <option value="approved">已通过</option>
                <option value="rejected">已驳回</option>
                <option value="withdrawn">已撤回</option>
              </select>
              <select value={qnaFilter.period_type} onChange={(e) => setQnaFilter({ ...qnaFilter, period_type: e.target.value })} style={{ width: 120 }}>
                <option value="">全部类型</option>
                <option value="早自习">早自习</option>
                {typePays.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
              <input value={qnaFilter.grade} onChange={(e) => setQnaFilter({ ...qnaFilter, grade: e.target.value })} placeholder="年级，如 高一" style={{ width: 130 }} />
              <input type="date" value={qnaFilter.date} onChange={(e) => setQnaFilter({ ...qnaFilter, date: e.target.value })} style={{ width: 150 }} />
              <button className="btn" onClick={() => loadQna()}>筛选</button>
              <button className="btn ghost" onClick={() => { const f = { status: '', period_type: '', grade: '', date: '' }; setQnaFilter(f); loadQna(f); }}>重置</button>
              <span className="hint">共 {qnaList.length} 条</span>
            </div>
            <table>
              <thead><tr><th>年级</th><th>学科</th><th>类型</th><th>教师</th><th>班级</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {qnaList.filter((q) => {
                  if (listMode === 'pending') return q.status === 'pending' || q.status === 'grade_approved';
                  return q.status === 'approved' || q.status === 'rejected' || q.status === 'withdrawn';
                }).map((q) => (
                  <tr key={q.id}>
                    <td>{q.grade}</td><td>{q.subject}</td><td><span className={`period-tag period-${q.period_type}`}>{q.period_type}</span></td><td>{q.teacher_name || '-'}</td><td>{q.class_name || '-'}</td>
                    <td>{q.date ? `${q.date} ${q.period_count ? `×${q.period_count}节` : ''}` : (q.day_of_week ? `周${q.day_of_week} 第${q.period_no}节` : '-')}</td>
                    <td><span className={`badge ${STATUS_CLS[q.status]}`}>{STATUS[q.status]}</span>
                      {q.grade_reviewed_by_name && <div className="muted" style={{ fontSize: 11 }}>一审：{q.grade_reviewed_by_name}</div>}
                    </td>
                    <td>
                      <div className="toolbar" style={{ marginBottom: 0 }}>
                        {/* 编辑：仅管理员（年级组长只审不改），历史记录模式不显示 */}
                        {isAdmin && listMode === 'pending' && q.status !== 'withdrawn' && (
                          <button className="btn sm" onClick={() => openQnaModal(q)}>编辑</button>
                        )}
                        {/* 审核：年级组长对 pending 一审；管理员对 pending（兜底）与 grade_approved 终审 */}
                        {listMode === 'pending' && isGradeLeader && !isAdmin && q.status === 'pending' && (
                          <>
                            <button className="btn sm primary" onClick={() => reviewQna(q.id, true)}>一审通过</button>
                            <button className="btn sm danger" onClick={() => reviewQna(q.id, false)}>驳回</button>
                          </>
                        )}
                        {listMode === 'pending' && isAdmin && (q.status === 'pending' || q.status === 'grade_approved') && (
                          <>
                            <button className="btn sm primary" onClick={() => reviewQna(q.id, true)}>终审通过</button>
                            <button className="btn sm danger" onClick={() => reviewQna(q.id, false)}>驳回</button>
                          </>
                        )}
                        {/* 撤回：仅管理员对 approved 记录 */}
                        {isAdmin && q.status === 'approved' && (
                          <button className="btn sm danger" onClick={() => withdrawQna(q.id)}>撤回</button>
                        )}
                        {/* 删除：仅管理员 */}
                        {isAdmin && (
                          <button className="btn sm danger" onClick={() => deleteQna(q.id)}>删除</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {qnaList.filter((q) => {
                  if (listMode === 'pending') return q.status === 'pending' || q.status === 'grade_approved';
                  return q.status === 'approved' || q.status === 'rejected' || q.status === 'withdrawn';
                }).length === 0 && <tr><td colSpan={8} className="muted">{listMode === 'pending' ? '暂无待处理申报' : '暂无历史记录'}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 课程申报 */}
      {tab === 'tasks' && isAdmin && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>课程列表</h3>
              <button className="btn primary sm" onClick={() => openTaskModal(null)}>+ 新建课程</button>
            </div>
            <table>
              <thead><tr><th>标题</th><th>年级</th><th>学科</th><th>计酬</th><th>填报</th><th>截止</th><th>操作</th></tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td className="strong">{t.title}</td>
                    <td>{t.grade || '-'}</td>
                    <td>{t.subject || '-'}</td>
                    <td>{t.pay_mode === '正课折算' ? `${t.subject || '-'}（正课折算）` : t.period_type ? (t.pay_mode === '固定折算' || t.pay_mode === '折算' ? `${t.period_type}（固定折算）` : `${t.period_type}（${t.pay_rate ?? '按字典'}元/节）`) : '-'}</td>
                    <td><span className="badge">{t.apply_count ?? 0} 人</span></td>
                    <td>{t.deadline || '-'}</td>
                    <td>
                      <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
                        <button className="btn sm" onClick={() => openApps(t)}>审核</button>
                        <button className="btn sm" onClick={() => openLinkModal(t)}>分享</button>
                        <button className="btn sm" onClick={() => openTaskModal(t)}>编辑</button>
                        <button className="btn sm danger" onClick={() => deleteTask(t)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {tasks.length === 0 && <tr><td colSpan={7} className="muted">暂无课程，点「新建课程」创建</td></tr>}
              </tbody>
            </table>
          </div>

          {openTask && (
            <div className="card" style={{ borderColor: 'var(--primary)' }}>
              <div className="toolbar">
                <h3 style={{ margin: 0 }}>{openTask.title}</h3>
                <span className="badge">{openTask.pay_mode === '正课折算' ? '正课折算' : (openTask.pay_mode === '固定折算' || openTask.pay_mode === '折算' ? '固定折算' : '按次计酬')}</span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => { setCourseImport({ task: openTask, file: null }); setCoursePreview(null); }}>批量导入</button>
                <button className="btn sm" onClick={() => openLinkModal(openTask)}>分享</button>
                <button className="btn sm" onClick={() => setOpenTask(null)}>关闭</button>
              </div>
              <p className="muted">
                {openTask.grade ? `年级：${openTask.grade} · ` : ''}
                {openTask.subject ? `学科：${openTask.subject} · ` : ''}
                计酬：{openTask.pay_mode === '正课折算' ? `${openTask.subject}（正课折算·学科+班额系数）` : `${openTask.period_type}（${openTask.pay_mode === '折算' || openTask.pay_mode === '固定折算' ? '固定折算·不计钱' : '按次计酬'}）`}
              </p>

              <table className="mt">
                <thead><tr><th>教师</th><th>日期</th><th>课时数</th><th>填报内容</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id}>
                      <td>{a.teacher_name || '-'}</td>
                      <td>{a.date || '-'}</td>
                      <td>{a.period_count || 1} 节</td>
                      <td>{(() => {
                        try { return Object.values(a.form_data || {}).join(' / '); } catch { return '-'; }
                      })()}</td>
                      <td><span className={`badge ${STATUS_CLS[a.status]}`}>{STATUS[a.status]}</span></td>
                      <td>
                        <div className="toolbar" style={{ marginBottom: 0 }}>
                          {isAdmin && a.status === 'pending' && (openTask.pay_mode === '固定折算' || openTask.pay_mode === '折算') && (
                            <select
                              style={{ width: 140, padding: '4px 8px' }}
                              value={appCoefMap[a.id] || openTask.period_type || ''}
                              onChange={(e) => setAppCoefMap({ ...appCoefMap, [a.id]: e.target.value })}
                              title="折算档位（按实际时长手工调整）"
                            >
                              {typeCoefs.map((t) => <option key={t.id} value={t.name}>{t.name}（{t.coefficient}）</option>)}
                            </select>
                          )}
                          {isAdmin && a.status === 'pending' && (
                            <>
                              <button className="btn sm primary" onClick={() => reviewApp(a.id, true, appCoefMap[a.id])}>通过</button>
                              <button className="btn sm danger" onClick={() => reviewApp(a.id, false)}>驳回</button>
                            </>
                          )}
                          {isAdmin && a.status === 'approved' && (
                            <button className="btn sm danger" onClick={() => withdrawApp(a.id)}>撤回</button>
                          )}
                          {isAdmin && (
                            <button className="btn sm danger" onClick={() => deleteApp(a.id)}>删除</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {apps.length === 0 && <tr><td colSpan={6} className="muted">暂无申报记录</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 课程填报批量导入弹窗 */}
      {courseImport && (
        <div className="modal-overlay" onClick={() => { setCourseImport(null); setCoursePreview(null); }}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>批量导入「{courseImport.task.title}」填报</h3>
              <button className="btn ghost" onClick={() => { setCourseImport(null); setCoursePreview(null); }}>关闭</button>
            </div>
            <div className="toolbar">
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setCourseImport({ ...courseImport, file: e.target.files[0] })} style={{ width: 'auto' }} />
              <button className="btn primary" onClick={previewCourseImport} disabled={!courseImport.file}>预览</button>
              <button className="btn" onClick={() => downloadCourseTemplate(courseImport.task)}>下载导入模板</button>
            </div>
            <p className="muted" style={{ margin: '12px 0 0' }}>
              {courseImport.task.pay_mode === '按次计酬' ? '表头：教师、上课日期、学生姓名、时长(分钟)。' :
               courseImport.task.pay_mode === '正课折算' ? '表头：教师、上课日期、班级、节次、学科。' :
               '表头：教师、上课日期、学生姓名、上课内容、课时数。'}
              导入后统一待审核。
            </p>
          </div>
        </div>
      )}

      {coursePreview && (
        <ImportPreview
          title={`批量导入「${courseImport.task.title}」填报`}
          columns={['教师', '上课日期', '学生/班级', '时长/节次', '学科/内容']}
          rows={coursePreview.rows}
          summary={coursePreview.summary}
          onConfirm={confirmCourseImport}
          onClose={() => setCoursePreview(null)}
        />
      )}

      {/* 课程新建/编辑弹窗 */}
      {taskModal && (
        <div className="modal-overlay" onClick={closeTaskModal}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{editingTask ? '编辑课程' : '新建课程'}</h3>
              <button className="btn ghost sm" onClick={closeTaskModal}>关闭</button>
            </div>
            <form onSubmit={submitTask}>
              <div className="form-grid">
                <div><label>课程标题</label><input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} required placeholder="如 2026 秋季竞赛辅导" /></div>
                <div><label>年级</label>
                  <select value={taskForm.grade} onChange={(e) => setTaskForm({ ...taskForm, grade: e.target.value })}>
                    <option value="">请选择</option>
                    {grades.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div><label>学科</label><input value={taskForm.subject} onChange={(e) => setTaskForm({ ...taskForm, subject: e.target.value })} placeholder="如 数学" /></div>
                <div><label>截止日期</label><input type="date" value={taskForm.deadline} onChange={(e) => setTaskForm({ ...taskForm, deadline: e.target.value })} /></div>
                <div><label>计酬方式</label>
                  <select value={taskForm.pay_mode} onChange={(e) => setTaskForm({ ...taskForm, pay_mode: e.target.value, period_type: '' })}>
                    <option value="按次计酬">按次计酬（单价 × 节数）</option>
                    <option value="固定折算">固定折算（节数 × 固定系数）</option>
                    <option value="正课折算">正课折算（节数 ×（学科系数+班额系数））</option>
                  </select>
                </div>
                {taskForm.pay_mode !== '正课折算' && (
                  <div><label>{taskForm.pay_mode === '固定折算' ? '折算类型' : '按次计酬类型'}</label>
                    <select value={taskForm.period_type} onChange={(e) => setTaskForm({ ...taskForm, period_type: e.target.value })}>
                      <option value="">请选择</option>
                      {taskForm.pay_mode === '固定折算'
                        ? typeCoefs.map((t) => <option key={t.id} value={t.name}>{t.name}（系数 {t.coefficient}）</option>)
                        : typePays.map((t) => <option key={t.id} value={t.name}>{t.name}（{t.pay}元/节）</option>)}
                    </select>
                  </div>
                )}
              </div>

              <div className="mt">
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <label style={{ margin: 0 }}>自定义申报字段（教师填报时需填写）</label>
                  <span className="spacer" />
                  <button type="button" className="btn sm" onClick={addField}>+ 添加字段</button>
                </div>
                {fieldList.length === 0 && <p className="muted">尚未添加自定义字段；教师填报时只需填「课时数 + 上课日期」。</p>}
                {fieldList.map((f, i) => (
                  <div key={i} className="form-grid" style={{ marginBottom: 8 }}>
                    <div><label>字段名</label><input value={f.label} onChange={(e) => setField(i, 'label', e.target.value)} placeholder="如 辅导专题" /></div>
                    <div><label>类型</label>
                      <select value={f.type} onChange={(e) => setField(i, 'type', e.target.value)}>
                        <option value="text">文本</option>
                        <option value="textarea">多行文本</option>
                        <option value="number">数字</option>
                        <option value="date">日期</option>
                        <option value="select">下拉</option>
                      </select>
                    </div>
                    {f.type === 'select' && (
                      <div><label>下拉选项（逗号分隔）</label><input value={f.options} onChange={(e) => setField(i, 'options', e.target.value)} placeholder="如 高一,高二,高三" /></div>
                    )}
                    <div><label>必填</label>
                      <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, 'required', e.target.checked)} />
                    </div>
                    <div><button type="button" className="btn sm danger" onClick={() => delField(i)}>删除</button></div>
                  </div>
                ))}
              </div>

              <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 16, marginBottom: 0 }}>
                <button type="button" className="btn" onClick={closeTaskModal}>取消</button>
                <button type="submit" className="btn primary">{editingTask ? '保存修改' : '创建课程并生成分享'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 分享二维码弹层 */}
      {linkModal && (
        <div className="modal-overlay" onClick={() => setLinkModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>分享课程填报</h3>
            <p className="muted">{linkModal.title}</p>
            <div className="share-body">
              <div className="share-qr">
                {qrDataUrl
                  ? <img src={qrDataUrl} alt="课程二维码" className="share-qr-img" />
                  : <div className="share-qr-placeholder">二维码生成中…</div>}
                <div className="share-qr-label">老师手机扫码填报</div>
              </div>
              <div className="share-link-col">
                <label className="share-label">分享链接</label>
                <div className="link-box">{linkModal.share_url || `${window.location.origin}/course/${linkModal.share_token}`}</div>
                <div className="toolbar" style={{ marginTop: 8 }}>
                  <button className="btn primary sm" onClick={copyLink}>{copied ? '已复制' : '复制链接'}</button>
                  <button className="btn sm" onClick={downloadQr} disabled={!qrDataUrl}>下载二维码</button>
                  <button className="btn sm" onClick={downloadShare} disabled={!qrDataUrl}>下载分享图</button>
                </div>
              </div>
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <span className="spacer" />
              <button className="btn" onClick={() => setLinkModal(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 新增/编辑申报弹窗 */}
      {qnaModal && (
        <div className="modal-overlay" onClick={() => setQnaModal(false)}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{editingQna ? '编辑申报' : '新增申报'}</h3>
              <button className="btn ghost" onClick={() => setQnaModal(false)}>关闭</button>
            </div>
            <form onSubmit={submitQna}>
              <div className="form-grid">
                <div><label>年级</label><input value={qnaForm.grade} onChange={(e) => setQnaForm({ ...qnaForm, grade: e.target.value })} placeholder="如 高一" required /></div>
                <div><label>学科</label><input value={qnaForm.subject} onChange={(e) => setQnaForm({ ...qnaForm, subject: e.target.value })} required /></div>
                <div><label>教师</label>
                  <select value={qnaForm.teacher_id} onChange={(e) => setQnaForm({ ...qnaForm, teacher_id: e.target.value })}>
                    <option value="">请选择</option>
                    {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div><label>班级</label>
                  <select value={qnaForm.class_id} onChange={(e) => setQnaForm({ ...qnaForm, class_id: e.target.value })}>
                    <option value="">请选择</option>
                    {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div><label>星期(1-7，固定排班填)</label><input type="number" min="1" max="7" value={qnaForm.day_of_week} onChange={(e) => setQnaForm({ ...qnaForm, day_of_week: e.target.value })} /></div>
                <div><label>节次</label><input type="number" value={qnaForm.period_no} onChange={(e) => setQnaForm({ ...qnaForm, period_no: e.target.value })} /></div>
                <div><label>发生日期（临时填报填）</label><input type="date" value={qnaForm.date} onChange={(e) => setQnaForm({ ...qnaForm, date: e.target.value })} /></div>
                <div><label>节数</label><input type="number" min="1" value={qnaForm.period_count} onChange={(e) => setQnaForm({ ...qnaForm, period_count: e.target.value })} /></div>
                <div><label>类型</label>
                  <select value={qnaForm.period_type} onChange={(e) => setQnaForm({ ...qnaForm, period_type: e.target.value })}>
                    <option value="早自习">早自习（折算型·不计钱）</option>
                    {typePays.map((t) => <option key={t.id} value={t.name}>{t.name}（{t.pay}元/节）</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row" style={{ marginTop: 14 }}><label>内容说明</label><input value={qnaForm.content} onChange={(e) => setQnaForm({ ...qnaForm, content: e.target.value })} placeholder="如 函数专题答疑 / 晚练安排" /></div>
              <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 16, marginBottom: 0 }}>
                <button type="button" className="btn" onClick={cancelEdit}>取消</button>
                <button className="btn primary">{editingQna ? '保存修改' : '提交填报'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {qnaPreview && (
        <ImportPreview
          title="批量导入课务申报"
          columns={['年级', '学科', '类型', '教师', '班级', '发生日期', '节数', '星期', '节次', '内容']}
          rows={qnaPreview.rows}
          summary={qnaPreview.summary}
          onConfirm={confirmQnaImport}
          onClose={() => setQnaPreview(null)}
        />
      )}
    </div>
  );
}
