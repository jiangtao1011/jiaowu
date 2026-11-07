import React, { useEffect, useMemo, useState } from 'react';
import { useToast } from './feedback.jsx';

// 统一导入预览确认弹窗。
// props:
//   title     弹窗标题
//   columns   表头数组（不含首列 checkbox 和末列「状态」）
//   rows      来自 preview 响应：[{ row_id, line, cells:[...], status, reason, update? }]
//   summary   来自 preview 响应：{ total, ok, duplicate, error, close_count? }
//   onConfirm async (row_ids) => Promise  确认入库
//   onClose   () => void
const STATUS_LABEL = { ok: '可导入', duplicate: '重复', error: '错误' };

export default function ImportPreview({ title, columns, rows, summary, onConfirm, onClose }) {
  const toast = useToast();
  const [selected, setSelected] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);

  // 默认勾选所有「可导入」行
  useEffect(() => {
    const ids = rows.filter((r) => r.status === 'ok').map((r) => r.row_id);
    setSelected(new Set(ids));
  }, [rows]);

  const okRows = useMemo(() => rows.filter((r) => r.status === 'ok'), [rows]);
  const toggle = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const toggleAll = () => {
    setSelected((s) => {
      const allOk = okRows.length > 0 && okRows.every((r) => s.has(r.row_id));
      if (allOk) return new Set();
      return new Set(okRows.map((r) => r.row_id));
    });
  };

  const confirm = async () => {
    if (!selected.size) return toast.error('请至少勾选一条可导入记录');
    setSubmitting(true);
    try {
      await onConfirm([...selected]);
      toast.success('导入完成');
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || '导入失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost" onClick={onClose}>关闭</button>
        </div>

        {/* 汇总条 */}
        <div className="import-summary">
          <span className="badge ok">可导入 {summary.ok}</span>
          <span className="badge warn">重复 {summary.duplicate}</span>
          <span className="badge danger">错误 {summary.error}</span>
          {summary.close_count != null && summary.close_count > 0 && (
            <span className="badge danger">将关闭旧课表 {summary.close_count} 条</span>
          )}
        </div>

        <div className="table-wrap" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          <table className="import-preview-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input type="checkbox" checked={okRows.length > 0 && okRows.every((r) => selected.has(r.row_id))} onChange={toggleAll} />
                </th>
                {columns.map((c, i) => <th key={i}>{c}</th>)}
                <th style={{ width: 160 }}>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isErr = r.status === 'error';
                const isDup = r.status === 'duplicate';
                const canSelect = r.status === 'ok';
                return (
                  <tr key={r.row_id} className={isErr ? 'ip-err' : isDup ? 'ip-dup' : ''}>
                    <td>
                      {canSelect ? (
                        <input type="checkbox" checked={selected.has(r.row_id)} onChange={() => toggle(r.row_id)} />
                      ) : null}
                    </td>
                    {r.cells.map((c, i) => <td key={i}>{c}</td>)}
                    <td>
                      <span className={`badge ${isErr ? 'danger' : isDup ? 'warn' : 'ok'}`}>
                        {STATUS_LABEL[r.status]}{r.update ? '·更新' : ''}
                      </span>
                      {r.reason && <div className="ip-reason">{r.reason}</div>}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={columns.length + 2} className="muted">文件为空</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 14, marginBottom: 0 }}>
          <span className="muted" style={{ marginRight: 'auto' }}>已选 {selected.size} 条</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={confirm} disabled={submitting || !selected.size}>
            {submitting ? '导入中…' : `确认导入（${selected.size} 条）`}
          </button>
        </div>
      </div>
    </div>
  );
}
