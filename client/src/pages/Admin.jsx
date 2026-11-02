import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

function fmtSize(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'browse', label: '数据浏览' },
  { key: 'backup', label: '备份与恢复' },
  { key: 'maintain', label: '维护' },
];

export default function Admin() {
  const toast = useToast();
  const [tab, setTab] = useState('overview');

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">数据库管理</h2>
        <p className="page-sub">仅供管理员使用 · 备份、恢复与数据查看</p>
      </div>

      <div className="toolbar">
        {TABS.map((t) => (
          <button key={t.key} className={`btn ${tab === t.key ? 'primary' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'browse' && <Browse />}
      {tab === 'backup' && <Backup toast={toast} />}
      {tab === 'maintain' && <Maintain toast={toast} />}
    </div>
  );
}

// ===== 概览 =====
function Overview() {
  const [meta, setMeta] = useState(null);
  const [tables, setTables] = useState([]);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [m, t] = await Promise.all([api.get('/admin/meta'), api.get('/admin/tables')]);
      setMeta(m.data.data);
      setTables(t.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const integrityOk = meta?.integrity?.length === 1 && String(meta.integrity[0].quick_check) === 'ok';

  return (
    <div>
      {error && <div className="alert error">{error}</div>}

      {meta && (
        <div className="card">
          <div className="card-head"><h3>数据库状态</h3></div>
          <div className="stat-row">
            <div className="stat-card"><div className="v">{meta.tableCount}</div><div className="l">数据表</div></div>
            <div className="stat-card"><div className="v">{fmtSize(meta.sizeBytes)}</div><div className="l">数据库大小</div></div>
            <div className="stat-card"><div className="v">{meta.journalMode}</div><div className="l">日志模式</div></div>
            <div className="stat-card">
              <div className="v" style={{ color: integrityOk ? 'var(--ok)' : 'var(--danger)' }}>{integrityOk ? '正常' : '异常'}</div>
              <div className="l">完整性检查</div>
            </div>
          </div>
          <div className="hint">文件位置：{meta.dbPath}</div>
          {!integrityOk && meta.integrity?.length > 0 && (
            <div className="alert error" style={{ marginTop: 10 }}>
              {meta.integrity.map((r) => r.quick_check).join('；')}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h3>数据表清单</h3><span className="hint">共 {tables.length} 张表</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>表名</th><th className="num">记录数</th></tr></thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.name}>
                  <td><span className="badge info">{t.name}</span></td>
                  <td className="num">{t.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ===== 数据浏览 =====
function Browse() {
  const [tables, setTables] = useState([]);
  const [name, setName] = useState('');
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/admin/tables').then((r) => setTables(r.data.data)).catch((e) => setError(errMsg(e)));
  }, []);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    api.get(`/admin/tables/${name}`, { params: { page, pageSize } })
      .then((r) => { if (!cancelled) setData(r.data.data); })
      .catch((e) => { if (!cancelled) setError(errMsg(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [name, page, pageSize]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const cellValue = (v) => {
    if (v == null) return <span className="hint">NULL</span>;
    const s = String(v);
    if (s.length > 120) return <span title={s}>{s.slice(0, 120)}…</span>;
    return s;
  };

  return (
    <div>
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h3>浏览数据表</h3>
          <select value={name} onChange={(e) => { setName(e.target.value); setPage(1); }} style={{ minWidth: 220 }}>
            <option value="">选择数据表…</option>
            {tables.map((t) => <option key={t.name} value={t.name}>{t.name}（{t.count} 条）</option>)}
          </select>
        </div>

        {name && data && (
          <>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <span className="hint">共 {data.total} 条记录 · {data.columns.length} 列 · 第 {data.page}/{totalPages} 页</span>
              <span className="spacer" />
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <button className="btn sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
            </div>
            {loading ? (
              <div className="hint">加载中…</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>{data.columns.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row, i) => (
                      <tr key={row.id ?? i}>
                        {data.columns.map((c) => <td key={c.name}>{cellValue(row[c.name])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {name && !data && !loading && <div className="hint">暂无数据</div>}
      </div>
    </div>
  );
}

// ===== 备份与恢复 =====
function Backup({ toast }) {
  const [files, setFiles] = useState([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [b, p] = await Promise.all([api.get('/admin/backups'), api.get('/admin/restore-pending')]);
      setFiles(b.data.data);
      setPending(p.data.data.pending);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api.post('/admin/backup');
      toast.success('备份已创建');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const download = (filename) => {
    // 通过带 token 的请求下载，避免直接拼接 token 到 URL
    api.get(`/admin/backups/${filename}/download`, { responseType: 'blob' })
      .then((r) => {
        const url = URL.createObjectURL(r.data);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((e) => toast.error(errMsg(e)));
  };

  const remove = async (filename) => {
    if (!(await toast.confirm(`确定删除备份「${filename}」？此操作不可撤销。`, { danger: true }))) return;
    try {
      await api.delete(`/admin/backups/${filename}`);
      toast.success('已删除');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const restore = async (filename) => {
    if (!(await toast.confirm(
      `恢复备份「${filename}」将覆盖当前全部数据。恢复需重启后端服务后生效，期间请勿操作。确定继续？`,
      { danger: true }
    ))) return;
    try {
      await api.post(`/admin/backups/${filename}/restore`);
      toast.success('已标记恢复，重启后端后生效');
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(await toast.confirm(`上传并导入数据库文件「${file.name}」作为备份？`, {}))) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.post('/admin/backups/upload', fd);
      toast.success('上传成功');
      load();
    } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div>
      {error && <div className="alert error">{error}</div>}

      {pending && (
        <div className="alert warn" style={{ marginBottom: 12 }}>
          有未生效的恢复操作（edu.db.restore 已写入）。请重启后端服务使恢复生效。
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>备份列表</h3>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <label className="btn">
              上传导入
              <input type="file" accept=".db,.sqlite,.sqlite3" style={{ display: 'none' }} onChange={upload} />
            </label>
            <button className="btn primary" onClick={create}>立即备份</button>
          </div>
        </div>

        {files.length === 0 ? (
          <div className="hint">暂无备份，点击「立即备份」创建第一个数据库快照。</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>文件名</th><th className="num">大小</th><th>时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.filename}>
                    <td><span className="badge info">{f.filename}</span></td>
                    <td className="num">{fmtSize(f.size)}</td>
                    <td>{fmtTime(f.mtime)}</td>
                    <td>
                      <div className="toolbar" style={{ marginBottom: 0 }}>
                        <button className="btn sm" onClick={() => download(f.filename)}>下载</button>
                        <button className="btn sm danger" onClick={() => restore(f.filename)}>恢复</button>
                        <button className="btn sm" onClick={() => remove(f.filename)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ===== 维护 =====
function Maintain({ toast }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [vacuuming, setVacuuming] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const r = await api.post('/admin/integrity-check');
      setResult(r.data.data);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setChecking(false); }
  };

  const vacuum = async () => {
    if (!(await toast.confirm('压缩整理数据库（VACUUM）将回收空间，执行前会自动备份一次。确定继续？', {}))) return;
    setVacuuming(true);
    try {
      const r = await api.post('/admin/vacuum');
      toast.success(`整理完成，当前大小 ${fmtSize(r.data.data.sizeBytes)}`);
    } catch (e) { toast.error(errMsg(e)); }
    finally { setVacuuming(false); }
  };

  return (
    <div className="card">
      <div className="card-head"><h3>维护操作</h3></div>

      <div className="toolbar">
        <button className="btn" onClick={check} disabled={checking}>
          {checking ? '检查中…' : '完整性检查'}
        </button>
        <button className="btn danger" onClick={vacuum} disabled={vacuuming}>
          {vacuuming ? '整理中…' : '压缩整理（VACUUM）'}
        </button>
      </div>

      {result && (
        <div className={`alert ${result.ok ? 'success' : 'error'}`} style={{ marginTop: 8 }}>
          完整性检查结果：{result.ok ? '正常' : '异常'} — {result.detail?.map((r) => r.quick_check).join('；')}
        </div>
      )}

      <div className="hint" style={{ marginTop: 12 }}>
        完整性检查为只读操作，不锁写；压缩整理会短暂占用数据库，建议在业务空闲时执行。
      </div>
    </div>
  );
}
