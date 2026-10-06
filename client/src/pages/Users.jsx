import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';
import { canEditUser } from '../roles.js';

const ROLES = ['admin', '教务员', '教务处', '教研组长', '备课组长', '年级组长', '教师'];

export default function Users() {
  const [rows, setRows] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', name: '', role: '教师', phone: '', teacher_id: '', managed_grade: '' });
  const [editing, setEditing] = useState(null); // 正在编辑的用户 id；null 表示未编辑
  const [editForm, setEditForm] = useState({ name: '', role: '教师', phone: '', teacher_id: '', managed_grade: '', password: '' });

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const canManage = canEditUser(user); // admin + 教务员；教务处无账号管理权

  const load = async () => {
    try { setRows((await api.get('/users')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  const loadTeachers = async () => {
    try { setTeachers((await api.get('/teachers')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); loadTeachers(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/users', { ...form, teacher_id: form.teacher_id || null, managed_grade: form.managed_grade || null });
      setForm({ username: '', password: '', name: '', role: '教师', phone: '', teacher_id: '', managed_grade: '' });
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const toggleActive = async (u) => {
    try { await api.patch(`/users/${u.id}`, { active: u.active ? 0 : 1 }); load(); } catch (e) { setError(errMsg(e)); }
  };

  const startEdit = (u) => {
    setEditing(u.id);
    setEditForm({
      name: u.name || '', role: u.role || '教师', phone: u.phone || '',
      teacher_id: u.teacher_id ? String(u.teacher_id) : '', managed_grade: u.managed_grade || '', password: '',
    });
  };
  const cancelEdit = () => {
    setEditing(null);
    setEditForm({ name: '', role: '教师', phone: '', teacher_id: '', managed_grade: '', password: '' });
  };
  const submitEdit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const payload = {
        name: editForm.name, role: editForm.role,
        phone: editForm.phone || null,
        teacher_id: editForm.teacher_id || null, managed_grade: editForm.managed_grade || null,
      };
      if (editForm.password) payload.password = editForm.password;
      await api.patch(`/users/${editing}`, payload);
      cancelEdit();
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">账号管理</h2>
        <p className="page-sub">教务员统一创建和管理账号 · 账号可绑定教师档案，绑定后登录即自动识别身份（用于自主申报）</p>
      </div>

      {!canManage && <div className="alert error">无权限：仅管理员和教务员可管理账号。</div>}
      {error && <div className="alert error">{error}</div>}

      {canManage && <div className="card">
        <h3>新建账号</h3>
        <form onSubmit={submit}>
          <div className="form-grid">
            <div><label>用户名</label><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></div>
            <div><label>初始密码</label><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></div>
            <div><label>姓名</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
            <div><label>角色</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.filter((r) => user.role === 'admin' || r !== 'admin').map((r) => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div><label>电话</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div><label>绑定教师档案</label>
              <select value={form.teacher_id} onChange={(e) => setForm({ ...form, teacher_id: e.target.value })}>
                <option value="">不绑定</option>
                {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.subject || '未设学科'}）</option>)}
              </select>
            </div>
            {form.role === '年级组长' && (
              <div><label>负责年级</label><input value={form.managed_grade} onChange={(e) => setForm({ ...form, managed_grade: e.target.value })} placeholder="如 高一" /></div>
            )}
          </div>
          <div className="mt"><button className="btn primary">创建</button></div>
        </form>
      </div>}

      {canManage && editing && (
        <div className="card" style={{ borderColor: 'var(--primary)' }}>
          <h3>编辑账号</h3>
          <form onSubmit={submitEdit}>
            <div className="form-grid">
              <div><label>姓名</label><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} required /></div>
              <div><label>角色</label>
                <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} disabled={user.role !== 'admin'}>
                  {ROLES.map((r) => <option key={r}>{r}</option>)}
                </select>
                {user.role !== 'admin' && <div className="hint">仅管理员可修改角色</div>}
              </div>
              <div><label>电话</label><input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></div>
              <div><label>重置密码（留空不修改）</label><input type="password" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} placeholder="不填则不修改密码" /></div>
              <div><label>绑定教师档案</label>
                <select value={editForm.teacher_id} onChange={(e) => setEditForm({ ...editForm, teacher_id: e.target.value })}>
                  <option value="">不绑定</option>
                  {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.subject || '未设学科'}）</option>)}
                </select>
              </div>
              {editForm.role === '年级组长' && (
                <div><label>负责年级</label><input value={editForm.managed_grade} onChange={(e) => setEditForm({ ...editForm, managed_grade: e.target.value })} placeholder="如 高一" /></div>
              )}
            </div>
            <div className="mt">
              <button className="btn primary">保存修改</button>
              <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={cancelEdit}>取消</button>
            </div>
          </form>
        </div>
      )}

      {canManage && <div className="card">
        <table>
          <thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>教师档案</th><th>负责年级</th><th>电话</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.name}</td>
                <td><span className="badge">{u.role}</span></td>
                <td>{u.teacher_name ? <span className="badge ok">{u.teacher_name}</span> : '-'}</td>
                <td>{u.managed_grade || '-'}</td>
                <td>{u.phone || '-'}</td>
                <td>{u.active ? <span className="badge ok">启用</span> : <span className="badge warn">停用</span>}</td>
                <td>
                  <div className="toolbar" style={{ marginBottom: 0 }}>
                    <button className="btn sm" onClick={() => startEdit(u)} disabled={user.role !== 'admin' && u.role === 'admin'}>编辑</button>
                    <button className="btn sm" onClick={() => toggleActive(u)} disabled={user.role !== 'admin' && u.role === 'admin'}>{u.active ? '停用' : '启用'}</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </div>
  );
}
