import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import api from '../api.js';
import { useToast } from '../components/feedback.jsx';

const TYPE_STYLES = {
  课务调整: 'warn',
  考试: 'info',
  其他: 'default',
};

export default function NoticeView() {
  const { token } = useParams();
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState('');
  const [myRead, setMyRead] = useState(false);
  const [myLike, setMyLike] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [replyForm, setReplyForm] = useState({ name: '', content: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const isLoggedIn = !!localStorage.getItem('edu_token');

  useEffect(() => {
    api.get(`/notices/share/${token}`)
      .then((r) => {
        const d = r.data.data;
        setNotice(d);
        setMyRead(d.my_read);
        setMyLike(d.my_like);
        setLikeCount(d.like_count);
      })
      .catch(() => setError('通知不存在或已删除'));
  }, [token]);

  // 登录用户打开自动记已读
  useEffect(() => {
    if (notice && isLoggedIn && !myRead) {
      api.post(`/notices/share/${token}/read`, {}).then(() => setMyRead(true)).catch(() => {});
    }
  }, [notice, myRead, token, isLoggedIn]);

  const markRead = async () => {
    try {
      await api.post(`/notices/share/${token}/read`, { name: replyForm.name });
      setMyRead(true);
    } catch (e) { toast.error(e?.response?.data?.error || '操作失败'); }
  };

  const toggleLike = async () => {
    try {
      const r = await api.post(`/notices/share/${token}/like`, { name: replyForm.name });
      setMyLike(r.data.data.liked);
      setLikeCount((c) => (r.data.data.liked ? c + 1 : Math.max(0, c - 1)));
    } catch (e) { toast.error(e?.response?.data?.error || '操作失败'); }
  };

  const submitReply = async (e) => {
    e.preventDefault();
    if (!replyForm.content.trim()) return toast.error('回复内容不能为空');
    setBusy(true);
    try {
      await api.post(`/notices/share/${token}/replies`, replyForm);
      toast.success('回复已提交，审核通过后公开展示');
      setReplyForm({ ...replyForm, content: '' });
    } catch (e) { toast.error(e?.response?.data?.error || '操作失败'); }
    finally { setBusy(false); }
  };

  const download = (id, filename) => {
    fetch(`/api/notices/attachments/${id}/download`, {
      headers: isLoggedIn ? { Authorization: `Bearer ${localStorage.getItem('edu_token')}` } : {},
    }).then((r) => {
      if (!r.ok) throw new Error('下载失败');
      return r.blob();
    }).then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }).catch(() => setError('附件下载失败'));
  };

  const fmt = (d) => (d ? String(d).replace('T', ' ').slice(0, 16) : '');

  if (error && !notice) {
    return (
      <div className="n-share">
        <div className="n-card">
          <div className="n-empty">
            <div className="n-empty-mark">教</div>
            <p>{error}</p>
            <p className="n-empty-sub">链接可能已失效，请联系发布者</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="n-share">
      <div className="n-card">
        {error && <div className="alert error">{error}</div>}

        {notice && (
          <>
            <header className="n-head">
              <div className="n-brand">
                <span className="n-brand-mark">教</span>
                <span className="n-brand-name">课程中心 · 教务管理</span>
              </div>
              <div className="n-badges">
                <span className={`badge ${TYPE_STYLES[notice.type] || 'default'}`}>{notice.type}</span>
                {notice.publish_status === 'published'
                  ? <span className="badge ok">已发布</span>
                  : <span className="badge warn">草稿</span>}
              </div>
              <h1 className="n-title">{notice.title}</h1>
              <p className="n-meta">
                {notice.creator_name || '教务处'} 发布 · {fmt(notice.published_at || notice.created_at)}
              </p>
            </header>

            <div className="n-rule"><span /></div>

            <div className="n-body">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                {notice.content || '（无内容）'}
              </ReactMarkdown>
            </div>

            {notice.attachments?.length > 0 && (
              <div className="n-attach">
                <div className="n-sec-label">附件（{notice.attachments.length}）</div>
                {notice.attachments.map((a) => (
                  <button key={a.id} className="n-attach-item" onClick={() => download(a.id, a.filename)}>
                    <span className="n-attach-icon">📎</span>
                    <span className="n-attach-name">{a.filename}</span>
                    <span className="n-attach-size">{Math.max(1, Math.round(a.size / 1024))} KB</span>
                    <span className="n-attach-down">下载</span>
                  </button>
                ))}
              </div>
            )}

            <div className="n-seal">
              <div className="n-seal-inner">
                <span className="n-seal-top">课程中心</span>
                <span className="n-seal-bottom">教务管理</span>
              </div>
            </div>

            <div className="n-actions">
              {!myRead ? (
                <div className="n-read-row">
                  {!isLoggedIn && (
                    <input
                      className="n-input"
                      placeholder="你的姓名"
                      value={replyForm.name}
                      onChange={(e) => setReplyForm({ ...replyForm, name: e.target.value })}
                    />
                  )}
                  <button className="btn primary n-btn-block" onClick={markRead}>我已阅读</button>
                </div>
              ) : (
                <div className="n-read-done"><span className="n-check">✓</span> 已确认阅读</div>
              )}
              <button className={`btn n-like ${myLike ? 'primary' : ''}`} onClick={toggleLike}>
                <span className="n-like-icon">{myLike ? '♥' : '♡'}</span>
                <span>{likeCount}</span>
              </button>
            </div>

            <div className="n-replies">
              <div className="n-sec-label">回复（{notice.replies?.length || 0}）</div>
              {notice.replies?.length > 0 ? (
                <ul className="n-reply-list">
                  {notice.replies.map((r) => (
                    <li key={r.id} className="n-reply">
                      <div className="n-reply-head">
                        <span className="n-reply-author">{r.author || '匿名'}</span>
                        <span className="n-reply-time">{fmt(r.created_at)}</span>
                      </div>
                      <div className="n-reply-body">{r.content}</div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted n-reply-empty">暂无回复</p>
              )}
            </div>

            <form className="n-reply-form" onSubmit={submitReply}>
              {!isLoggedIn && (
                <input
                  className="n-input"
                  placeholder="你的姓名"
                  value={replyForm.name}
                  onChange={(e) => setReplyForm({ ...replyForm, name: e.target.value })}
                />
              )}
              <textarea
                className="n-textarea"
                rows={2}
                placeholder="写回复…（审核通过后展示）"
                value={replyForm.content}
                onChange={(e) => setReplyForm({ ...replyForm, content: e.target.value })}
              />
              <div className="n-reply-submit">
                <button className="btn primary" disabled={busy}>提交回复</button>
              </div>
            </form>
          </>
        )}
      </div>
      <p className="n-foot">本通知由 课程中心 · 教务管理 发布</p>
    </div>
  );
}
