import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '', withdrawn: 'info' };

export default function Applications() {
  const [tab, setTab] = useState('qna');
  const [error, setError] = useState('');
  const toast = useToast();

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isAdmin = ['admin', '教务员', '教务处'].includes(user.role);
  const isGradeLeader = user.role === '年级组长';
  // 可审核申报的角色：admin/教务员/教务处 + 年级组长（年级组长限本年级，后端已过滤）
  const canReview = isAdmin || isGradeLeader;

  // 课时申报状态（晚自习/答疑/晚练等按次计酬 + 早自习折算）
  const [qnaList, setQnaList] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [classes, setClasses] = useState([]);
  const [typePays, setTypePays] = useState([]); // 按次计酬类型字典
  const [qnaForm, setQnaForm] = useState({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
  const [editingQna, setEditingQna] = useState(null); // 正在编辑的记录 id；null 表示新增
  const [importFile, setImportFile] = useState(null); // 批量导入文件
  // 申报列表筛选
  const [qnaFilter, setQnaFilter] = useState({ status: '', period_type: '', grade: '', date: '' });

  // 申报状态
  const [tasks, setTasks] = useState([]);
  const [typeCoefs, setTypeCoefs] = useState([]); // 折算类型字典
  const [grades, setGrades] = useState([]);       // 年级枚举
  // 课程创建表单
  const [taskForm, setTaskForm] = useState({ title: '', deadline: '', filler_role: '教师', pay_mode: '按次计酬', period_type: '', subject: '', grade: '' });
  const [fieldList, setFieldList] = useState([]); // 自定义字段 [{key,label,type,required,options}]
  const [openTask, setOpenTask] = useState(null);
  const [apps, setApps] = useState([]);
  const [linkModal, setLinkModal] = useState(null); // 分享弹层
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

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
        toast.success('申报已填报，待教务处审核');
      }
      setQnaForm({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
      setEditingQna(null);
      loadQna();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const startEditQna = (q) => {
    setEditingQna(q.id);
    setQnaForm({
      grade: q.grade || '', subject: q.subject || '', teacher_id: q.teacher_id ? String(q.teacher_id) : '',
      class_id: q.class_id ? String(q.class_id) : '', day_of_week: q.day_of_week != null ? String(q.day_of_week) : '',
      period_no: q.period_no != null ? String(q.period_no) : '', content: q.content || '',
      date: q.date || '', period_count: q.period_count != null ? String(q.period_count) : '1',
      period_type: q.period_type || '答疑',
    });
  };

  const cancelEdit = () => {
    setEditingQna(null);
    setQnaForm({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
  };

  const reviewQna = async (id, approved) => {
    try { await api.patch(`/applications/${id}/review`, { approved }); toast.success('已审核'); loadQna(); } catch (e) { toast.error(errMsg(e)); }
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
      const res = await api.post('/applications/import', fd);
      const { inserted, errors } = res.data.data;
      if (inserted === 0 && errors.length) {
        toast.error(`未导入任何记录，${errors.length} 条失败：\n${errors.join('\n')}`);
      } else {
        toast.success(`导入成功 ${inserted} 条${errors.length ? `，${errors.length} 条未导入` : ''}`);
        if (errors.length) toast.error(errors.join('\n'));
      }
      setImportFile(null);
      loadQna();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const submitTask = async (e) => {
    e.preventDefault();
    try {
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
      setTaskForm({ title: '', deadline: '', filler_role: '教师', pay_mode: '按次计酬', period_type: '', subject: '', grade: '' });
      setFieldList([]);
      toast.success('课程已创建');
      loadTasks();
      // 自动打开分享弹层
      if (created.share_token) openLinkModal(created);
    } catch (e) { toast.error(errMsg(e)); }
  };

  const openApps = async (task) => {
    setOpenTask(task);
    try { setApps((await api.get(`/applications/tasks/${task.id}/applications`)).data.data); } catch (e) { toast.error(errMsg(e)); }
  };

  const reviewApp = async (id, approved) => {
    try { await api.patch(`/applications/applications/${id}/review`, { approved }); toast.success('已审核'); openApps(openTask); } catch (e) { toast.error(errMsg(e)); }
  };

  const withdrawApp = async (id) => {
    if (!(await toast.confirm('确定撤回该已通过的申报？其已生成的上课记录（计酬）将一并删除。', { danger: true }))) return;
    try { await api.patch(`/applications/applications/${id}/withdraw`); toast.success('已撤回'); openApps(openTask); } catch (e) { toast.error(errMsg(e)); }
  };

  const deleteApp = async (id) => {
    if (!(await toast.confirm('确定删除该申报记录？若已通过，其已生成的上课记录（计酬）将一并删除。', { danger: true }))) return;
    try { await api.delete(`/applications/applications/${id}`); toast.success('已删除'); openApps(openTask); } catch (e) { toast.error(errMsg(e)); }
  };

  // ===== 字段定义器 =====
  const addField = () => setFieldList([...fieldList, { key: `f${Date.now()}`, label: '', type: 'text', required: false, options: '' }]);
  const setField = (i, k, v) => { const n = [...fieldList]; n[i] = { ...n[i], [k]: v }; setFieldList(n); };
  const delField = (i) => setFieldList(fieldList.filter((_, idx) => idx !== i));

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

  // 课务申报：admin/教务员/教务处 全权；年级组长仅审核本年级申报
  if (!canReview) {
    return (
      <div>
        <div className="page-head">
          <h2 className="page-title">课务申报</h2>
        </div>
        <div className="alert error">无权限：课务申报仅教务员/教务处/年级组长可用，请使用「自主申报」提交课时申报。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">课务申报</h2>
        <p className="page-sub">课时申报（晚自习/答疑/晚练等按次计酬 + 早自习折算，审核后进入课表）· 竞赛课/私人定制课申报</p>
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
            <h3>批量导入申报</h3>
            <div className="toolbar">
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setImportFile(e.target.files[0])} style={{ width: 'auto' }} />
              <button className="btn primary" onClick={importQna} disabled={!importFile}>导入</button>
              <button className="btn" onClick={downloadTemplate}>下载导入模板</button>
            </div>
            <p className="muted" style={{ margin: 0 }}>表头：年级、学科、类型、教师、班级、发生日期、节数、星期、节次、内容。临时填报填「发生日期」，固定排班填「星期+节次」；早自习填「类型=早自习」且班级可留空（按年级折算）；导入后统一待审核。</p>
          </div>}

          {isAdmin && <div className="card">
            <h3>{editingQna ? '编辑申报' : '填报申报'}</h3>
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
              <p className="muted" style={{ marginBottom: 0 }}>说明：临时/不定期填报填「发生日期 + 节数」，审核通过后按所选类型的固定单价计酬（早自习除外，按「课时数 × 早自习系数」折算、不计钱）；固定排班填报填「星期 + 节次」，审核通过后进入课表按班展开计酬。按次计酬类型（晚自习/答疑/晚练/自定义）在统计中心维护，早自习为固定折算型。</p>
              <div className="mt">
                <button className="btn primary">{editingQna ? '保存修改' : '提交填报'}</button>
                {editingQna && <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={cancelEdit}>取消</button>}
              </div>
            </form>
          </div>}

          <div className="card">
            <h3>申报列表</h3>
            <div className="toolbar">
              <select value={qnaFilter.status} onChange={(e) => setQnaFilter({ ...qnaFilter, status: e.target.value })} style={{ width: 120 }}>
                <option value="">全部状态</option>
                <option value="pending">待审核</option>
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
                {qnaList.map((q) => (
                  <tr key={q.id}>
                    <td>{q.grade}</td><td>{q.subject}</td><td><span className={`period-tag period-${q.period_type}`}>{q.period_type}</span></td><td>{q.teacher_name || '-'}</td><td>{q.class_name || '-'}</td>
                    <td>{q.date ? `${q.date} ${q.period_count ? `×${q.period_count}节` : ''}` : (q.day_of_week ? `周${q.day_of_week} 第${q.period_no}节` : '-')}</td>
                    <td><span className={`badge ${STATUS_CLS[q.status]}`}>{STATUS[q.status]}</span></td>
                    <td>
                      <div className="toolbar" style={{ marginBottom: 0 }}>
                        {/* 编辑：仅管理员（年级组长只审不改） */}
                        {isAdmin && q.status !== 'withdrawn' && (
                          <button className="btn sm" onClick={() => startEditQna(q)}>编辑</button>
                        )}
                        {/* 审核：管理员 + 年级组长 对 pending 记录 */}
                        {canReview && q.status === 'pending' && (
                          <>
                            <button className="btn sm primary" onClick={() => reviewQna(q.id, true)}>通过</button>
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
                {qnaList.length === 0 && <tr><td colSpan={8} className="muted">暂无填报</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 课程申报 */}
      {tab === 'tasks' && isAdmin && (
        <>
          <div className="card">
            <h3>新建课程（自定义申报字段 + 计酬方式 + 分享填报）</h3>
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
                    <option value="折算">折算（节数 × 系数，不计钱）</option>
                  </select>
                </div>
                <div><label>{taskForm.pay_mode === '折算' ? '折算类型' : '按次计酬类型'}</label>
                  <select value={taskForm.period_type} onChange={(e) => setTaskForm({ ...taskForm, period_type: e.target.value })}>
                    <option value="">请选择</option>
                    {taskForm.pay_mode === '折算'
                      ? typeCoefs.map((t) => <option key={t.id} value={t.name}>{t.name}（系数 {t.coefficient}）</option>)
                      : typePays.map((t) => <option key={t.id} value={t.name}>{t.name}（{t.pay}元/节）</option>)}
                  </select>
                </div>
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

              <div className="mt"><button className="btn primary">创建课程并生成分享</button></div>
            </form>
          </div>

          <div className="card">
            <h3>课程列表</h3>
            <table>
              <thead><tr><th>标题</th><th>年级</th><th>学科</th><th>计酬</th><th>填报</th><th>截止</th><th>操作</th></tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td>{t.grade || '-'}</td>
                    <td>{t.subject || '-'}</td>
                    <td>{t.period_type ? (t.pay_mode === '折算' ? `${t.period_type}（折算）` : `${t.period_type}（${t.pay_rate ?? '按字典'}元/节）`) : '-'}</td>
                    <td><span className="badge">{t.apply_count ?? 0} 人</span></td>
                    <td>{t.deadline || '-'}</td>
                    <td>
                      <div className="toolbar" style={{ marginBottom: 0 }}>
                        <button className="btn sm" onClick={() => openApps(t)}>审核</button>
                        <button className="btn sm" onClick={() => openLinkModal(t)}>分享</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {tasks.length === 0 && <tr><td colSpan={7} className="muted">暂无课程</td></tr>}
              </tbody>
            </table>
          </div>

          {openTask && (
            <div className="card" style={{ borderColor: 'var(--primary)' }}>
              <div className="toolbar">
                <h3 style={{ margin: 0 }}>{openTask.title}</h3>
                <span className="badge">{openTask.pay_mode === '折算' ? '折算' : '按次计酬'}</span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => openLinkModal(openTask)}>分享</button>
                <button className="btn sm" onClick={() => setOpenTask(null)}>关闭</button>
              </div>
              <p className="muted">
                {openTask.grade ? `年级：${openTask.grade} · ` : ''}
                {openTask.subject ? `学科：${openTask.subject} · ` : ''}
                计酬：{openTask.period_type}（{openTask.pay_mode === '折算' ? '折算·不计钱' : '按次计酬'}）
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
                          {isAdmin && a.status === 'pending' && (
                            <>
                              <button className="btn sm primary" onClick={() => reviewApp(a.id, true)}>通过</button>
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
    </div>
  );
}
