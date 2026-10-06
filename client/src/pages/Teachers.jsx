import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';

const PAY_KEYS = ['夏令营', '冬令营', '全员夏令营', '全员冬令营', '节假补课'];
const EMPTY = { name: '', phone: '', subject: '', pay_standard: {} };

export default function Teachers() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null); // null=新增，否则为编辑的教师 id
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [file, setFile] = useState(null);

  const load = async () => {
    try { setRows((await api.get('/teachers')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const setPay = (k, v) => setForm({ ...form, pay_standard: { ...form.pay_standard, [k]: v } });

  const parsePay = (s) => { try { return JSON.parse(s) || {}; } catch { return {}; } };

  const openAdd = () => { setEditingId(null); setForm(EMPTY); setError(''); setMsg(''); setShowForm(true); };

  const startEdit = (t) => {
    setEditingId(t.id);
    setForm({ name: t.name, phone: t.phone || '', subject: t.subject || '', pay_standard: parsePay(t.pay_standard) });
    setError(''); setMsg('');
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); setForm(EMPTY); };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const pay_standard = Object.fromEntries(Object.entries(form.pay_standard).filter(([, v]) => v !== ''));
      const body = { name: form.name, phone: form.phone, subject: form.subject, pay_standard };
      if (editingId) await api.patch(`/teachers/${editingId}`, body);
      else await api.post('/teachers', body);
      setMsg(editingId ? '教师信息已更新' : '教师已新增');
      closeForm();
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const toggleActive = async (t) => {
    try {
      await api.patch(`/teachers/${t.id}`, { active: !t.active });
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('edu_token');
      const r = await fetch('/api/teachers/template', { headers: { Authorization: `Bearer ${token}` } });
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '教师导入模板.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };

  const importFile = async () => {
    if (!file) return setError('请先选择教师文件（.xlsx / .csv）');
    setError(''); setMsg('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const { inserted, skipped, errors } = (await api.post('/teachers/import', fd)).data.data;
      setMsg(`导入成功 ${inserted} 条${skipped ? `，跳过已存在 ${skipped} 条` : ''}${errors.length ? `，${errors.length} 条未导入` : ''}`);
      setFile(null);
      setShowImport(false);
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const filtered = rows.filter((t) => {
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      const hay = [t.name, t.subject, t.phone, ...(t.classes || []).map((c) => c.class_name)]
        .join(' ').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    if (statusFilter === '在职' && !t.active) return false;
    if (statusFilter === '停用' && t.active) return false;
    return true;
  });

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">教师信息</h2>
        <p className="page-sub">教师基本信息、所带班级及课酬标准；点击「编辑」可修改</p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 14 }}>
          <input
            style={{ width: 220 }}
            placeholder="搜索姓名 / 学科 / 电话 / 班级"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select style={{ width: 120 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">全部状态</option>
            <option value="在职">在职</option>
            <option value="停用">停用</option>
          </select>
          <span className="spacer" />
          <button className="btn" onClick={() => { setError(''); setMsg(''); setFile(null); setShowImport(true); }}>批量导入</button>
          <button className="btn primary" onClick={openAdd}>新增教师</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead><tr><th>姓名</th><th>学科</th><th>电话</th><th>课酬标准</th><th>所带班级</th><th>状态</th><th style={{ width: 150 }}>操作</th></tr></thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td className="strong">{t.name}</td>
                  <td>{t.subject || '-'}</td>
                  <td>{t.phone || '-'}</td>
                  <td>
                    {Object.entries(parsePay(t.pay_standard)).map(([k, v]) => (
                      <span key={k} className="badge" style={{ marginRight: 4 }}>{k}:{v}</span>
                    ))}
                    {Object.keys(parsePay(t.pay_standard)).length === 0 && '-'}
                  </td>
                  <td>
                    {t.classes?.length
                      ? t.classes.map((c) => (
                          <span key={c.id} className="badge" style={{ marginRight: 4 }}>
                            {c.class_name}<span className="muted">·{c.class_type}</span>
                          </span>
                        ))
                      : '-'}
                  </td>
                  <td><span className={`badge ${t.active ? 'ok' : 'danger'}`}>{t.active ? '在职' : '停用'}</span></td>
                  <td>
                    <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
                      <button className="btn sm" onClick={() => startEdit(t)}>编辑</button>
                      <button className="btn sm" onClick={() => toggleActive(t)}>{t.active ? '停用' : '启用'}</button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="muted">
                  {rows.length === 0 ? '暂无教师，请新增或批量导入' : '无匹配结果'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: '10px 0 0' }}>共 {rows.length} 名教师{keyword || statusFilter ? `，筛选出 ${filtered.length} 名` : ''}</p>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{editingId ? `编辑教师（ID ${editingId}）` : '新增教师'}</h3>
              <button className="btn ghost" onClick={closeForm}>关闭</button>
            </div>
            <form onSubmit={submit}>
              <div className="form-grid">
                <div><label>姓名</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
                <div><label>电话</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                <div><label>任教学科</label><input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></div>
              </div>
              <div className="form-row" style={{ marginTop: 14 }}>
                <label>课酬标准（元/节，留空则不设）</label>
                <div className="form-grid">
                  {PAY_KEYS.map((k) => (
                    <div key={k}>
                      <label>{k}</label>
                      <input type="number" value={form.pay_standard[k] || ''} onChange={(e) => setPay(k, e.target.value)} />
                    </div>
                  ))}
                </div>
              </div>
              <div className="toolbar mt">
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
              <h3>批量导入教师</h3>
              <button className="btn ghost" onClick={() => setShowImport(false)}>关闭</button>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>上传 .xlsx / .csv 文件，按姓名匹配，已存在的自动跳过。可先下载模板。</p>
            <div className="toolbar">
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files[0])} style={{ width: 'auto' }} />
              <button className="btn primary" onClick={importFile} disabled={!file}>导入</button>
              <button className="btn" onClick={downloadTemplate}>下载导入模板</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
