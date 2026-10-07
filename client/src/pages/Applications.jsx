import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';

const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '', withdrawn: 'info' };

export default function Applications() {
  const [tab, setTab] = useState('qna');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

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
  const [taskForm, setTaskForm] = useState({ title: '', type: '私人定制课', course_type: '', time_desc: '', duration: '', content_desc: '', deadline: '', filler_role: '教师' });
  const [openTask, setOpenTask] = useState(null);
  const [apps, setApps] = useState([]);
  const [applyForm, setApplyForm] = useState({ teacher_id: '', course_name: '', course_content: '', schedule_time: '', duration: '', remark: '' });

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
    try { setTasks((await api.get('/applications/tasks')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (canReview) { loadQna(); loadTasks(); } }, []);

  const submitQna = async (e) => {
    e.preventDefault();
    setError(''); setMsg('');
    try {
      if (editingQna) {
        await api.patch(`/applications/${editingQna}`, { ...qnaForm, teacher_id: qnaForm.teacher_id || null, class_id: qnaForm.class_id || null, date: qnaForm.date || null });
        setMsg('申报已更新');
      } else {
        await api.post('/applications', { ...qnaForm, teacher_id: qnaForm.teacher_id || null, class_id: qnaForm.class_id || null, date: qnaForm.date || null });
        setMsg('申报已填报，待教务处审核');
      }
      setQnaForm({ grade: '', subject: '', teacher_id: '', class_id: '', day_of_week: '', period_no: '', content: '', date: '', period_count: '1', period_type: '答疑' });
      setEditingQna(null);
      loadQna();
    } catch (e) { setError(errMsg(e)); }
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
    try { await api.patch(`/applications/${id}/review`, { approved }); setMsg('已审核'); loadQna(); } catch (e) { setError(errMsg(e)); }
  };

  const deleteQna = async (id) => {
    if (!window.confirm('确定删除该申报记录？若已通过，其已生成的上课记录（计酬）将一并删除。')) return;
    try { await api.delete(`/applications/${id}`); setMsg('已删除'); loadQna(); } catch (e) { setError(errMsg(e)); }
  };

  const withdrawQna = async (id) => {
    if (!window.confirm('确定撤回该已通过的申报？其已生成的上课记录（计酬）将一并删除。')) return;
    try { await api.patch(`/applications/${id}/withdraw`); setMsg('已撤回'); loadQna(); } catch (e) { setError(errMsg(e)); }
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
    if (!importFile) return setError('请先选择申报文件（.xlsx / .csv）');
    setError(''); setMsg('');
    const fd = new FormData();
    fd.append('file', importFile);
    try {
      const res = await api.post('/applications/import', fd);
      const { inserted, errors } = res.data.data;
      if (inserted === 0 && errors.length) {
        setError(`未导入任何记录，${errors.length} 条失败：\n${errors.join('\n')}`);
        setMsg('');
      } else {
        setMsg(`导入成功 ${inserted} 条${errors.length ? `，${errors.length} 条未导入` : ''}`);
        if (errors.length) setError(errors.join('\n'));
      }
      setImportFile(null);
      loadQna();
    } catch (e) { setError(errMsg(e)); }
  };

  const submitTask = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/applications/tasks', taskForm);
      setTaskForm({ title: '', type: '私人定制课', course_type: '', time_desc: '', duration: '', content_desc: '', deadline: '', filler_role: '教师' });
      loadTasks();
    } catch (e) { setError(errMsg(e)); }
  };

  const openApps = async (task) => {
    setOpenTask(task);
    try { setApps((await api.get(`/applications/tasks/${task.id}/applications`)).data.data); } catch (e) { setError(errMsg(e)); }
  };

  const submitApply = async (e) => {
    e.preventDefault();
    setError(''); setMsg('');
    try {
      await api.post(`/applications/tasks/${openTask.id}/apply`, { ...applyForm, teacher_id: applyForm.teacher_id || null });
      setApplyForm({ teacher_id: '', course_name: '', course_content: '', schedule_time: '', duration: '', remark: '' });
      setMsg('申报已提交');
      openApps(openTask);
    } catch (e) { setError(errMsg(e)); }
  };

  const reviewApp = async (id, approved) => {
    try { await api.patch(`/applications/applications/${id}/review`, { approved }); setMsg('已审核'); openApps(openTask); } catch (e) { setError(errMsg(e)); }
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
      {msg && <div className="alert success">{msg}</div>}

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
          {isAdmin && (
            <div className="card">
              <h3>新建申报任务（教务员设置明细）</h3>
              <form onSubmit={submitTask}>
                <div className="form-grid">
                  <div><label>任务标题</label><input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} required /></div>
                  <div><label>类型</label>
                    <select value={taskForm.type} onChange={(e) => setTaskForm({ ...taskForm, type: e.target.value })}>
                      <option>私人定制课</option><option>竞赛课</option>
                    </select>
                  </div>
                  <div><label>课型</label><input value={taskForm.course_type} onChange={(e) => setTaskForm({ ...taskForm, course_type: e.target.value })} placeholder="如 一对一辅导" /></div>
                  <div><label>时长</label><input value={taskForm.duration} onChange={(e) => setTaskForm({ ...taskForm, duration: e.target.value })} placeholder="如 每节40分钟" /></div>
                  <div><label>上课时间</label><input value={taskForm.time_desc} onChange={(e) => setTaskForm({ ...taskForm, time_desc: e.target.value })} placeholder="如 周三第8节" /></div>
                  <div><label>截止时间</label><input type="datetime-local" value={taskForm.deadline} onChange={(e) => setTaskForm({ ...taskForm, deadline: e.target.value })} /></div>
                </div>
                <div className="form-row" style={{ marginTop: 14 }}><label>内容要求</label><input value={taskForm.content_desc} onChange={(e) => setTaskForm({ ...taskForm, content_desc: e.target.value })} /></div>
                <div className="mt"><button className="btn primary">创建任务</button></div>
              </form>
            </div>
          )}

          <div className="card">
            <h3>申报任务列表</h3>
            <table>
              <thead><tr><th>标题</th><th>类型</th><th>截止时间</th><th>操作</th></tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.title}</td>
                    <td><span className="badge">{t.type}</span></td>
                    <td>{t.deadline || '-'}</td>
                    <td><button className="btn sm" onClick={() => openApps(t)}>填报/查看</button></td>
                  </tr>
                ))}
                {tasks.length === 0 && <tr><td colSpan={4} className="muted">暂无申报任务</td></tr>}
              </tbody>
            </table>
          </div>

          {openTask && (
            <div className="card" style={{ borderColor: 'var(--primary)' }}>
              <div className="toolbar">
                <h3 style={{ margin: 0 }}>{openTask.title}</h3>
                <span className="badge">{openTask.type}</span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => setOpenTask(null)}>关闭</button>
              </div>
              <p className="muted">{openTask.course_type ? `课型：${openTask.course_type} · ` : ''}{openTask.duration ? `时长：${openTask.duration}` : ''}</p>
              {openTask.content_desc && <p className="muted">内容要求：{openTask.content_desc}</p>}

              <div className="card" style={{ border: '1px dashed var(--border)' }}>
                <h3>填报申报</h3>
                <form onSubmit={submitApply}>
                  <div className="form-grid">
                    <div><label>教师</label>
                      <select value={applyForm.teacher_id} onChange={(e) => setApplyForm({ ...applyForm, teacher_id: e.target.value })}>
                        <option value="">请选择</option>
                        {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                    <div><label>课程名称</label><input value={applyForm.course_name} onChange={(e) => setApplyForm({ ...applyForm, course_name: e.target.value })} required /></div>
                    <div><label>上课时间</label><input value={applyForm.schedule_time} onChange={(e) => setApplyForm({ ...applyForm, schedule_time: e.target.value })} /></div>
                    <div><label>时长</label><input value={applyForm.duration} onChange={(e) => setApplyForm({ ...applyForm, duration: e.target.value })} /></div>
                  </div>
                  <div className="form-row" style={{ marginTop: 14 }}><label>课程内容</label><textarea rows={3} value={applyForm.course_content} onChange={(e) => setApplyForm({ ...applyForm, course_content: e.target.value })} /></div>
                  <div className="mt"><button className="btn primary">提交申报</button></div>
                </form>
              </div>

              <table className="mt">
                <thead><tr><th>课程</th><th>教师</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id}>
                      <td>{a.course_name}</td>
                      <td>{a.teacher_name || '-'}</td>
                      <td>{a.schedule_time || '-'}</td>
                      <td><span className={`badge ${STATUS_CLS[a.status]}`}>{STATUS[a.status]}</span></td>
                      <td>
                        {isAdmin && a.status === 'pending' && (
                          <>
                            <button className="btn sm primary" onClick={() => reviewApp(a.id, true)}>通过</button>{' '}
                            <button className="btn sm danger" onClick={() => reviewApp(a.id, false)}>驳回</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {apps.length === 0 && <tr><td colSpan={5} className="muted">暂无申报</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
