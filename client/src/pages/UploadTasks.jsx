import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';

const ROLES = ['教务员', '教务处', '教研组长', '备课组长', '教师'];

export default function UploadTasks() {
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', description: '', target_role: '教师', requirement: '', deadline: '', allow_file_types: '' });
  const [openTask, setOpenTask] = useState(null);
  const [files, setFiles] = useState([]);
  const [file, setFile] = useState(null);

  const load = async () => {
    try {
      const [t, u] = await Promise.all([api.get('/upload-tasks'), api.get('/users')]);
      setTasks(t.data.data); setUsers(u.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/upload-tasks', { ...form, deadline: form.deadline || null });
      setForm({ title: '', description: '', target_role: '教师', requirement: '', deadline: '', allow_file_types: '' });
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const openFiles = async (task) => {
    setOpenTask(task);
    try { setFiles((await api.get(`/upload-tasks/${task.id}/files`)).data.data); } catch (e) { setError(errMsg(e)); }
  };

  const upload = async () => {
    if (!file) return;
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/upload-tasks/${openTask.id}/files`, fd);
      setFile(null);
      openFiles(openTask);
    } catch (e) { setError(errMsg(e)); }
  };

  const download = (fileId, filename) => {
    const token = localStorage.getItem('edu_token');
    const url = `/api/upload-tasks/files/${fileId}/download`;
    // 通过 fetch 携带 token 下载
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.blob())
      .then((b) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      });
  };

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">教学计划上传</h2>
        <p className="page-sub">自定义上传内容、指定人员、要求与截止时间，在线浏览</p>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <h3>新建上传任务</h3>
        <form onSubmit={submit}>
          <div className="form-grid">
            <div><label>任务标题</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></div>
            <div><label>指定人员范围</label>
              <select value={form.target_role} onChange={(e) => setForm({ ...form, target_role: e.target.value })}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row" style={{ marginTop: 14 }}><label>说明</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className="form-grid" style={{ marginTop: 14 }}>
            <div><label>上传要求</label><input value={form.requirement} onChange={(e) => setForm({ ...form, requirement: e.target.value })} placeholder="如：PDF，命名格式…" /></div>
            <div><label>截止时间</label><input type="datetime-local" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} /></div>
          </div>
          <div className="mt"><button className="btn primary">创建任务</button></div>
        </form>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>标题</th><th>指定范围</th><th>截止时间</th><th>操作</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td><span className="badge">{t.target_role}</span></td>
                <td>{t.deadline || '-'}</td>
                <td><button className="btn sm" onClick={() => openFiles(t)}>查看/上传文件</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openTask && (
        <div className="card" style={{ borderColor: 'var(--primary)' }}>
          <h3>文件：{openTask.title}</h3>
          <p className="muted">{openTask.requirement || '无额外要求'}</p>
          <div className="toolbar">
            <input type="file" onChange={(e) => setFile(e.target.files[0])} style={{ width: 'auto' }} />
            <button className="btn primary" onClick={upload} disabled={!file}>上传</button>
            <button className="btn" onClick={() => setOpenTask(null)}>关闭</button>
          </div>
          <table>
            <thead><tr><th>文件名</th><th>上传人</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td>{f.filename}</td>
                  <td>{f.uploader_name || '-'}</td>
                  <td>{f.uploaded_at}</td>
                  <td><button className="btn sm" onClick={() => download(f.id, f.filename)}>下载</button></td>
                </tr>
              ))}
              {files.length === 0 && <tr><td colSpan={4} className="muted">暂无文件</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
