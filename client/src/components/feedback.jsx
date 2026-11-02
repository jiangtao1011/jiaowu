import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastCtx = createContext(null);

let toastSeq = 0;

// 全局反馈：toast（右上角堆叠、自动消失）+ confirm（居中确认框，返回 Promise<boolean>）。
// 用法：const toast = useToast(); toast.success('已保存'); if (!(await toast.confirm('确定删除？'))) return;
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null); // { message, title, danger, resolve }

  const dismiss = useCallback((id) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((type, text) => {
    const id = ++toastSeq;
    setToasts((ts) => [...ts, { id, type, text }]);
    setTimeout(() => dismiss(id), 3200);
  }, [dismiss]);

  const success = useCallback((text) => push('success', text), [push]);
  const error = useCallback((text) => push('error', text), [push]);
  const warn = useCallback((text) => push('warn', text), [push]);

  const confirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setConfirmState({ message, title: opts.title ?? null, danger: !!opts.danger, resolve });
    });
  }, []);

  const closeConfirm = useCallback((ok) => {
    setConfirmState((s) => {
      if (s) s.resolve(ok);
      return null;
    });
  }, []);

  const api = { success, error, warn, confirm };

  return (
    <ToastCtx.Provider value={api}>
      {children}

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <span className="toast-dot" />
            <span>{t.text}</span>
          </div>
        ))}
      </div>

      {confirmState && (
        <div className="modal-overlay" onClick={() => closeConfirm(false)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{confirmState.title || '确认操作'}</h3>
              <button className="btn ghost" onClick={() => closeConfirm(false)}>关闭</button>
            </div>
            <p className="confirm-text">{confirmState.message}</p>
            <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => closeConfirm(false)}>取消</button>
              <button className={`btn ${confirmState.danger ? 'danger' : 'primary'}`} onClick={() => closeConfirm(true)}>确定</button>
            </div>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
