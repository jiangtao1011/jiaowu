import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import api, { errMsg } from '../api.js';

const REPLY_STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const REPLY_CLS = { pending: 'warn', approved: 'ok', rejected: '' };

export default function MobileNotices() {
  const { onUnreadChange } = useOutletContext();
  const [rows, setRows] = useState([]);
  const [myReplies, setMyReplies] = useState([]);
  const [unread, setUnread] = useState(0);
  const [tab, setTab] = useState('all'); // all | 各类型 | replies
  const [typeFilter, setTypeFilter] = useState('');
  const [open, setOpen] = useState(null); // 打开的通知
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      const [r, u, mr] = await Promise.all([
        api.get('/notices', { params: { publish_status: 'published' } }),
        api.get('/notices/unread-count'),
        api.get('/notices/my-replies'),
      ]);
      setRows(r.data.data);
      setUnread(u.data.data.unread);
      setMyReplies(mr.data.data);
      if (onUnreadChange) onUnreadChange(u.data.data.unread);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const openNotice = async (n) => {
    setOpen(n);
    try {
      await api.post(`/notices/${n.id}/read`);
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const submitReply = async () => {
    if (!reply.trim()) return setError('回复内容不能为空');
    setError(''); setMsg('');
    try {
      await api.post(`/notices/share/${open.share_token}/replies`, { content: reply });
      setMsg('回复已提交，待教务处审核');
      setReply('');
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const types = [...new Set(rows.map((n) => n.type))];
  const visibleRows = typeFilter ? rows.filter((n) => n.type === typeFilter) : rows;

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div>
          <div className="mt-title">通知</div>
          <div className="mt-sub">{unread > 0 ? `${unread} 条未读` : '全部已读'}</div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      {/* 顶部：类型筛选 + 我的回复 */}
      <div className="mcard" style={{ padding: 10 }}>
        <div className="toolbar" style={{ marginBottom: 0, gap: 8, flexWrap: 'wrap' }}>
          <button className={`btn sm ${tab === 'all' && !typeFilter ? 'primary' : ''}`} onClick={() => { setTab('all'); setTypeFilter(''); setOpen(null); }}>全部</button>
          {types.map((t) => (
            <button key={t} className={`btn sm ${typeFilter === t ? 'primary' : ''}`} onClick={() => { setTypeFilter(t); setTab('all'); setOpen(null); }}>{t}</button>
          ))}
          <button className={`btn sm ${tab === 'replies' ? 'primary' : ''}`} onClick={() => { setTab('replies'); setOpen(null); }}>我的回复</button>
        </div>
      </div>

      {tab === 'replies' ? (
        <div className="mcard">
          <div className="mcard-title">我的回复</div>
          {myReplies.map((r) => (
            <div key={r.id} className="mitem">
              <div className="mitem-main">
                <div className="mitem-title" style={{ fontSize: 13.5 }}>{r.content}</div>
                <div className="mitem-sub">回复于：{r.notice_title} · {r.created_at?.slice(0, 10)}</div>
              </div>
              <div className="mitem-side"><span className={`badge ${REPLY_CLS[r.status]}`}>{REPLY_STATUS[r.status]}</span></div>
            </div>
          ))}
          {myReplies.length === 0 && <div className="mempty">还没有回复过通知</div>}
        </div>
      ) : !open ? (
        <>
          {visibleRows.map((n) => {
            const isUnread = !n.my_read;
            return (
              <button key={n.id} className="mcard mlist-link" style={{ width: '100%', textAlign: 'left', cursor: 'pointer', border: 'none' }} onClick={() => openNotice(n)}>
                <div className="mitem" style={{ padding: 0, border: 'none' }}>
                  <div className="mitem-main">
                    <div className="mitem-title" style={{ fontWeight: isUnread ? 700 : 600 }}>{n.title}</div>
                    <div className="mitem-sub">{n.type}{n.published_at ? ` · ${n.published_at.slice(0, 10)}` : ''}</div>
                  </div>
                  <div className="mitem-side">
                    {isUnread && <span className="badge danger">未读</span>}
                  </div>
                </div>
              </button>
            );
          })}
          {visibleRows.length === 0 && <div className="mempty">暂无该类型的通知</div>}
        </>
      ) : (
        <div className="mcard">
          <button className="mbtn ghost" style={{ width: 'auto', padding: '8px 14px', fontSize: 14, marginBottom: 10 }} onClick={() => setOpen(null)}>‹ 返回</button>
          <div className="mcard-title">{open.title}</div>
          <div className="mitem-sub" style={{ marginBottom: 10 }}>{open.type} · {open.published_at?.slice(0, 10)}</div>
          {open.content && (
            <div className="mnotice-body" style={{ fontSize: 14.5, lineHeight: 1.7, marginBottom: 16 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                {open.content}
              </ReactMarkdown>
            </div>
          )}
          <div className="mfield">
            <label>回复</label>
            <textarea className="minput" rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="填写回复（提交后待审核）" />
          </div>
          <button className="mbtn" onClick={submitReply}>提交回复</button>
        </div>
      )}
    </div>
  );
}
