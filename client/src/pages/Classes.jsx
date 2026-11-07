import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';
import ImportPreview from '../components/ImportPreview.jsx';

const TYPES = ['行政班', '分层', '走班'];
const EMPTY = { name: '', type: '行政班', student_count: '', grade: '', parent_id: '', subject: '' };

export default function Classes() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [memberIds, setMemberIds] = useState([]);
  const [editingId, setEditingId] = useState(null); // null=新增
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // { token, rows, summary }

  const load = async () => {
    try { setRows((await api.get('/classes')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const adminClasses = rows.filter((c) => c.type === '行政班');

  const openAdd = () => { setEditingId(null); setForm(EMPTY); setMemberIds([]); setError(''); setShowForm(true); };

  const startEdit = (c) => {
    setEditingId(c.id);
    setForm({
      name: c.name,
      type: c.type,
      student_count: c.student_count || '',
      grade: c.grade || '',
      parent_id: c.parent_id ? String(c.parent_id) : '',
      subject: c.subject || '',
    });
    setMemberIds((c.members || []).map((m) => m.id));
    setError('');
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); setForm(EMPTY); setMemberIds([]); };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const body = { ...form, student_count: Number(form.student_count) || 0 };
      if (form.type !== '走班') body.member_ids = [];
      else body.member_ids = memberIds;
      if (editingId) await api.patch(`/classes/${editingId}`, body);
      else await api.post('/classes', body);
      toast.success(editingId ? '班级信息已更新' : '班级已新增');
      closeForm();
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('edu_token');
      const r = await fetch('/api/classes/template', { headers: { Authorization: `Bearer ${token}` } });
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '班级导入模板.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };

  const importFile = async () => {
    if (!file) return toast.error('请先选择班级文件（.xlsx / .csv）');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const { token, rows, summary } = (await api.post('/classes/import/preview', fd)).data.data;
      setPreview({ token, rows, summary });
    } catch (e) { toast.error(errMsg(e)); }
  };

  const confirmImport = async (row_ids) => {
    await api.post('/classes/import/confirm', { token: preview.token, row_ids });
    setFile(null);
    setShowImport(false);
    setPreview(null);
    load();
  };

  const toggleMember = (id) => setMemberIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const removeClass = async (c) => {
    if (!(await toast.confirm(`确定删除班级「${c.name}」？`, { danger: true }))) return;
    try {
      await api.delete(`/classes/${c.id}`);
      toast.success('班级已删除');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const filtered = rows.filter((c) => {
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      const hay = [c.name, c.grade, c.subject].join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (typeFilter && c.type !== typeFilter) return false;
    return true;
  });

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">班级信息</h2>
        <p className="page-sub">行政班、行政班分层、走班（多班合班）及人数；点击「编辑」可修改</p>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <input
            style={{ width: 220 }}
            placeholder="搜索名称 / 年级 / 学科"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select style={{ width: 120 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">全部类型</option>
            {TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
          <span className="spacer" />
          <button className="btn" onClick={() => { setError(''); setFile(null); setShowImport(true); }}>批量导入</button>
          <button className="btn primary" onClick={openAdd}>新增班级</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead><tr><th>班级</th><th>类型</th><th className="num">人数</th><th className="num">统计班额</th><th>年级</th><th>学科</th><th>所属 / 合班</th><th style={{ width: 70 }}>操作</th></tr></thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="strong">{r.name}</td>
                  <td><span className={`badge ${r.type === '行政班' ? 'primary' : r.type === '分层' ? 'info' : 'warn'}`}>{r.type}</span></td>
                  <td className="num">{r.type === '走班' ? (r.student_count > 0 ? r.student_count : '-') : r.student_count}</td>
                  <td className="num">{r.effective_size}</td>
                  <td>{r.grade || '-'}</td>
                  <td>{r.subject || '-'}</td>
                  <td>
                    {r.type === '分层'
                      ? (rows.find((x) => x.id === r.parent_id)?.name || '-')
                      : r.type === '走班'
                        ? (r.members?.map((m) => m.name).join('、') || '-')
                        : (r.children?.length ? `分层：${r.children.map((c) => c.name).join('、')}` : '-')}
                  </td>
                  <td>
                    <div className="toolbar" style={{ marginBottom: 0 }}>
                      <button className="btn sm" onClick={() => startEdit(r)}>编辑</button>
                      <button className="btn sm danger" onClick={() => removeClass(r)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="muted">
                  {rows.length === 0 ? '暂无班级，请新增或批量导入' : '无匹配结果'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: '10px 0 0' }}>共 {rows.length} 个班级{keyword || typeFilter ? `，筛选出 ${filtered.length} 个` : ''}</p>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{editingId ? `编辑班级（ID ${editingId}）` : '新增班级'}</h3>
              <button className="btn ghost" onClick={closeForm}>关闭</button>
            </div>
            <form className="form-grid" onSubmit={submit}>
              <div>
                <label>班级名称</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 高一(1)班 / 高一(1)班数学A层 / 高一政治走班" required />
              </div>
              <div>
                <label>类型</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label>年级</label>
                <input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder="如 高一" />
              </div>
              <div>
                <label>人数（走班留空则按合班人数之和计）</label>
                <input type="number" value={form.student_count} onChange={(e) => setForm({ ...form, student_count: e.target.value })} />
              </div>
              {form.type === '分层' && (
                <div>
                  <label>所属班级 / 走班</label>
                  <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
                    <option value="">选择父级</option>
                    {rows.filter((c) => c.type !== '分层' && c.id !== editingId).map((c) => <option key={c.id} value={c.id}>{c.name}（{c.type}）</option>)}
                  </select>
                </div>
              )}
              <div>
                <label>学科</label>
                <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="如 数学 / 政治" />
              </div>
              {form.type === '走班' && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <label>合班的行政班（可多选；留空「人数」则统计班额 = 各合班人数之和，填了则用所填值）</label>
                  <div className="checkbox-list">
                    {adminClasses.map((c) => (
                      <label key={c.id} className="checkbox">
                        <input type="checkbox" checked={memberIds.includes(c.id)} onChange={() => toggleMember(c.id)} />
                        {c.name}（{c.student_count}人）
                      </label>
                    ))}
                    {adminClasses.length === 0 && <span className="muted">暂无行政班，请先创建行政班</span>}
                  </div>
                </div>
              )}
              <div style={{ gridColumn: '1 / -1' }} className="toolbar">
                <button className="btn primary">{editingId ? '保存修改' : '保存'}</button>
                <button type="button" className="btn" onClick={closeForm}>取消</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>批量导入班级</h3>
              <button className="btn ghost" onClick={() => setShowImport(false)}>关闭</button>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>表头：班级名称、类型（行政班/分层/走班）、人数、年级、所属班级、学科。分层在「所属班级」填父班级名；走班在「所属班级」用逗号列出合班的多个行政班。</p>
            <div className="toolbar">
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files[0])} style={{ width: 'auto' }} />
              <button className="btn primary" onClick={importFile} disabled={!file}>预览</button>
              <button className="btn" onClick={downloadTemplate}>下载导入模板</button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <ImportPreview
          title="批量导入班级"
          columns={['班级名称', '类型', '人数', '年级', '所属班级', '学科']}
          rows={preview.rows}
          summary={preview.summary}
          onConfirm={confirmImport}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
