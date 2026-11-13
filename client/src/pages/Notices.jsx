import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import QRCode from 'qrcode';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';
import { downloadShareImage } from '../utils/shareImage.js';

const TYPE_STYLES = {
  课务调整: 'info',
  考试: 'warn',
  其他: 'default',
};

// Markdown 工具栏按钮定义
const MD_TOOLS = [
  { label: '加粗', hint: '**粗体**', insert: (s) => `**${s || '粗体文字'}**` },
  { label: '小标题', hint: '## 小标题', insert: (s) => `## ${s || '小标题'}` },
  { label: '列表', hint: '- 项目', insert: (s) => `- ${s || '项目一'}\n- ${s || '项目二'}` },
  { label: '编号', hint: '1. 项目', insert: (s) => `1. ${s || '项目一'}\n2. ${s || '项目二'}` },
  { label: '分隔线', hint: '---', insert: () => `\n---\n` },
  { label: '引用', hint: '> 引用', insert: (s) => `> ${s || '引用内容'}` },
  { label: '链接', hint: '[文字](网址)', insert: () => `[链接文字](https://)` },
];

export default function Notices() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', type: '课务调整', content: '' });
  const [files, setFiles] = useState([]);
  const [editingId, setEditingId] = useState(null); // null=新建，有值=编辑
  const [preview, setPreview] = useState(false); // 正文实时预览开关
  const [formOpen, setFormOpen] = useState(false); // 新建/编辑弹窗
  const [detail, setDetail] = useState(null); // { notice, reads, replies }
  const [linkModal, setLinkModal] = useState(null);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const taRef = React.useRef(null);
  const imgRef = React.useRef(null);

  const load = async () => {
    try { setRows((await api.get('/notices')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  // 上传正文图片，返回 URL 后插入 Markdown
  const uploadImage = async (file) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/notices/images', fd);
      const url = r.data.data.url;
      // 用相对路径，前端经 vite proxy 访问；分享落地页直接用绝对地址拼 origin
      const full = url.startsWith('http') ? url : `${window.location.origin}${url}`;
      insertMd({ label: '图片', insert: () => `\n![图片](${full})\n` });
      toast.success('图片已插入正文');
    } catch (e) { toast.error(errMsg(e)); }
  };

  // 在光标处插入 Markdown 片段（无选区时用整段/占位）
  const insertMd = (tool) => {
    const ta = taRef.current;
    const sel = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : { start: 0, end: 0 };
    const selected = form.content.slice(sel.start, sel.end);
    const inserted = tool.insert(selected);
    const next = form.content.slice(0, sel.start) + inserted + form.content.slice(sel.end);
    setForm({ ...form, content: next });
    // 恢复光标到插入内容之后
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        const pos = sel.start + inserted.length;
        ta.setSelectionRange(pos, pos);
      }
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        // 编辑：只改标题/类型/正文（附件另在详情里处理，本次不覆盖）
        await api.patch(`/notices/${editingId}`, { title: form.title, type: form.type, content: form.content || '' });
        toast.success('通知已更新');
      } else {
        const fd = new FormData();
        fd.append('title', form.title);
        fd.append('type', form.type);
        fd.append('content', form.content || '');
        for (const f of files) fd.append('files', f);
        await api.post('/notices', fd);
        toast.success('通知已创建');
      }
      resetForm();
      setFormOpen(false);
      load();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const resetForm = () => {
    setForm({ title: '', type: '课务调整', content: '' });
    setFiles([]);
    setEditingId(null);
    setPreview(false);
  };

  const startEdit = (n) => {
    setForm({ title: n.title, type: n.type, content: n.content || '' });
    setFiles([]);
    setEditingId(n.id);
    setPreview(false);
    setFormOpen(true);
  };

  const startCreate = () => {
    resetForm();
    setFormOpen(true);
  };

  const closeForm = () => {
    resetForm();
    setFormOpen(false);
  };

  const publish = async (id) => {
    try { await api.patch(`/notices/${id}/publish`, { publish_status: 'published' }); toast.success('已发布'); load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const unpublish = async (id) => {
    try { await api.patch(`/notices/${id}/publish`, { publish_status: 'draft' }); toast.success('已下线'); load(); } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (id) => {
    if (!(await toast.confirm('确认删除该通知？已读/回复/点赞记录会一并删除。', { danger: true }))) return;
    try { await api.delete(`/notices/${id}`); toast.success('已删除'); load(); } catch (e) { toast.error(errMsg(e)); }
  };

  // 复制到剪贴板：优先 Clipboard API（需 HTTPS/localhost），
  // 局域网 HTTP 访问时回退到隐藏 textarea + execCommand('copy')。
  const copyToClipboard = async (text) => {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* 回退 */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const copyLink = async (n) => {
    const url = n.share_url || `${window.location.origin}/n/${n.share_token}`;
    const ok = await copyToClipboard(url);
    setCopied(ok);
    if (ok) toast.success('分享链接已复制，可发到工作群'); else toast.error('复制失败，请手动复制链接');
    if (ok) setTimeout(() => setCopied(false), 1500);
  };

  // 生成「带标题的整段文案」，发群更有信息量
  const shareText = (n) => {
    const url = n.share_url || `${window.location.origin}/n/${n.share_token}`;
    const typeLabel = n.type === '其他' ? '通知' : n.type === '考试' ? '考试通知' : n.type;
    return `【${typeLabel}】${n.title}\n点击查看 → ${url}`;
  };

  const copyText = async (n) => {
    const text = shareText(n);
    const ok = await copyToClipboard(text);
    setCopied(ok);
    if (ok) toast.success('文案已复制，可直接粘贴到工作群'); else toast.error('复制失败，请手动复制文案');
    if (ok) setTimeout(() => setCopied(false), 1500);
  };

  // 打开分享弹层并生成二维码
  const openLinkModal = async (n) => {
    setLinkModal(n);
    setCopied(false);
    setQrDataUrl('');
    const url = n.share_url || `${window.location.origin}/n/${n.share_token}`;
    try {
      const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
      setQrDataUrl(dataUrl);
    } catch { /* 二维码生成失败则隐藏 */ }
  };

  // 下载二维码图片（发到工作群，老师扫码打开）
  const downloadQr = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `通知二维码_${linkModal?.title || '分享'}.png`;
    a.click();
  };

  // 下载分享图（复刻通知落地页公文版式）
  const downloadShare = () => {
    if (!qrDataUrl) return;
    const url = linkModal.share_url || `${window.location.origin}/n/${linkModal.share_token}`;
    const dateStr = (linkModal.published_at || linkModal.created_at || '').slice(0, 10);
    downloadShareImage({
      title: linkModal.title,
      sub: linkModal.type,
      content: linkModal.content || '',
      meta: `${linkModal.creator_name || '教务主任'} 发布 · ${dateStr}`,
      qrDataUrl,
      url,
      filename: `通知分享_${linkModal?.title || '分享'}.png`,
    });
  };

  const openDetail = async (id) => {
    setError('');
    try {
      const r = await api.get(`/notices/${id}/detail`);
      setDetail(r.data.data);
    } catch (e) { setError(errMsg(e)); }
  };

  const reviewReply = async (replyId, status) => {
    try { await api.patch(`/notices/replies/${replyId}/review`, { status }); toast.success('已审核'); openDetail(detail.notice.id); } catch (e) { toast.error(errMsg(e)); }
  };

  const fmt = (d) => (d ? String(d).replace('T', ' ').slice(0, 16) : '');

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">通知</h2>
        <p className="page-sub">课务调整、考试通知；正文支持 Markdown 排版，生成链接发到工作群</p>
      </div>

      {error && <div className="alert error">{error}</div>}

      {formOpen && (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{editingId ? '编辑通知' : '新建通知'}</h3>
              <button className="btn ghost" onClick={closeForm}>关闭</button>
            </div>
            <form onSubmit={submit}>
              <div className="form-grid">
                <div><label>标题</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></div>
                <div><label>类型</label>
                  <div className="type-pills">
                    {['课务调整', '考试', '其他'].map((t) => (
                      <button type="button" key={t} className={`type-pill ${form.type === t ? 'on' : ''}`} onClick={() => setForm({ ...form, type: t })}>{t}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="form-row" style={{ marginTop: 14 }}>
                <div className="md-label-row">
                  <label style={{ marginBottom: 0 }}>内容</label>
                  <div className="toolbar" style={{ marginBottom: 0, gap: 4 }}>
                    {MD_TOOLS.map((t) => (
                      <button type="button" key={t.label} className="btn sm md-tool" title={t.hint} onClick={() => insertMd(t)}>{t.label}</button>
                    ))}
                    <button type="button" className="btn sm md-tool" title="插入图片（上传后嵌入正文）" onClick={() => imgRef.current?.click()}>图片</button>
                    <input ref={imgRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { uploadImage(e.target.files[0]); e.target.value = ''; }} />
                    <button type="button" className={`btn sm ${preview ? 'primary' : ''}`} onClick={() => setPreview(!preview)}>{preview ? '关闭预览' : '预览'}</button>
                  </div>
                </div>
                {!preview ? (
                  <textarea ref={taRef} rows={8} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={'正文支持 Markdown：\n## 小标题\n- 列表项\n**加粗** 重点\n---\n直接换行即换行显示'} />
                ) : (
                  <div className="md-preview">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {form.content || '*（空）*'}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
              {!editingId && (
                <div className="form-row">
                  <label>附件（可选，多个）</label>
                  <input type="file" multiple onChange={(e) => setFiles([...e.target.files])} style={{ padding: 6 }} />
                  {files.length > 0 && <p className="muted" style={{ margin: '4px 0 0' }}>已选 {files.length} 个文件</p>}
                </div>
              )}
              <div className="toolbar" style={{ marginBottom: 0, marginTop: 14 }}>
                <button className="btn primary">{editingId ? '保存修改' : '保存'}</button>
                <button type="button" className="btn" onClick={closeForm}>取消</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>通知列表</h3>
          <button className="btn primary sm" onClick={startCreate}>新建通知</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>标题</th><th>类型</th><th>状态</th><th>已读</th><th>赞</th><th>回复</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td className="strong">{n.title}</td>
                  <td><span className={`badge ${TYPE_STYLES[n.type] || 'default'}`}>{n.type}</span></td>
                  <td>{n.publish_status === 'published' ? <span className="badge ok">已发布</span> : <span className="badge warn">草稿</span>}</td>
                  <td className="num">{n.read_count ?? 0}</td>
                  <td className="num">{n.like_count ?? 0}</td>
                  <td className="num">{n.reply_count ?? 0}</td>
                  <td>{fmt(n.created_at)}</td>
                  <td>
                    <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
                      <button className="btn sm" onClick={() => openDetail(n.id)}>详情</button>
                      <button className="btn sm" onClick={() => startEdit(n)}>编辑</button>
                      <button className="btn sm" onClick={() => openLinkModal(n)}>复制链接</button>
                      {n.publish_status === 'published'
                        ? <button className="btn sm" onClick={() => unpublish(n.id)}>下线</button>
                        : <button className="btn sm primary" onClick={() => publish(n.id)}>发布</button>}
                      <button className="btn sm danger" onClick={() => remove(n.id)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="muted">暂无通知</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {linkModal && (
        <div className="modal-overlay" onClick={() => setLinkModal(null)}>
          <div className="modal link-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>分享通知</h3>
              <button className="btn ghost" onClick={() => setLinkModal(null)}>关闭</button>
            </div>
            <p className="muted" style={{ margin: '0 0 16px' }}>
              「{linkModal.title}」的免登录访问方式，可扫码或复制链接发到工作群。
            </p>

            <div className="share-body">
              <div className="share-qr">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="通知二维码" className="share-qr-img" />
                ) : (
                  <div className="share-qr-placeholder">二维码生成中…</div>
                )}
                <div className="share-qr-label">手机扫码打开</div>
              </div>

              <div className="share-link-col">
                <label className="share-label">复制整段文案（发群更有信息量）</label>
                <div className="link-box share-text-preview">
                  {shareText(linkModal)}
                </div>
                <label className="share-label" style={{ marginTop: 12 }}>仅分享链接</label>
                <div className="link-box">
                  <span className="link-url">{linkModal.share_url || `${window.location.origin}/n/${linkModal.share_token}`}</span>
                </div>
                <div className="link-tip">链信/企业微信内请复制链接到浏览器打开，或直接发二维码图给老师扫码（需与系统同一局域网）。</div>

                <div className="toolbar" style={{ marginTop: 14, marginBottom: 0 }}>
                  <button className="btn primary" onClick={() => copyText(linkModal)}>{copied ? '已复制 ✓' : '复制整段文案'}</button>
                  <button className="btn" onClick={() => copyLink(linkModal)}>复制链接</button>
                  <button className="btn" onClick={downloadQr} disabled={!qrDataUrl}>下载二维码</button>
                  <button className="btn" onClick={downloadShare} disabled={!qrDataUrl}>下载分享图</button>
                </div>
                {linkModal.publish_status !== 'published' && (
                  <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
                    <button className="btn sm" onClick={() => { publish(linkModal.id); setLinkModal(null); }}>先发布再分享</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <div className="modal-head">
              <h3>{detail.notice.title}</h3>
              <button className="btn ghost" onClick={() => setDetail(null)}>关闭</button>
            </div>

            {detail.notice.content && (
              <div className="md-preview" style={{ marginBottom: 16, maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                  {detail.notice.content}
                </ReactMarkdown>
              </div>
            )}

            <h4 className="notice-section-title">已读名单（{detail.read_count}）</h4>
            {detail.reads.length > 0 ? (
              <div className="notice-tags">
                {detail.reads.map((r) => (
                  <span key={r.id} className="notice-tag">{r.author || '匿名'}<span className="tag-time">{fmt(r.read_at)}</span></span>
                ))}
              </div>
            ) : <p className="muted">暂无已读记录</p>}

            <h4 className="notice-section-title mt-lg">回复（{detail.replies.length}）</h4>
            {detail.replies.length > 0 ? (
              <ul className="reply-list">
                {detail.replies.map((r) => (
                  <li key={r.id} className="reply-item">
                    <div className="reply-head">
                      <span className="reply-author">{r.author || '匿名'}</span>
                      <span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'pending' ? 'warn' : 'danger'}`}>
                        {r.status === 'approved' ? '已通过' : r.status === 'pending' ? '待审核' : '已拒绝'}
                      </span>
                      <span className="reply-time">{fmt(r.created_at)}</span>
                    </div>
                    <div className="reply-content">{r.content}</div>
                    {r.status === 'pending' && (
                      <div className="toolbar" style={{ marginBottom: 0, marginTop: 6, gap: 6 }}>
                        <button className="btn sm primary" onClick={() => reviewReply(r.id, 'approved')}>通过</button>
                        <button className="btn sm danger" onClick={() => reviewReply(r.id, 'rejected')}>拒绝</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="muted">暂无回复</p>}
          </div>
        </div>
      )}
    </div>
  );
}
