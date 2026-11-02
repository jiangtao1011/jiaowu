import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

export default function Login({ onLogin }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { username, password, remember });
      localStorage.setItem('edu_token', data.data.token);
      localStorage.setItem('edu_user', JSON.stringify(data.data.user));
      onLogin(data.data.user);
      navigate('/');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  // 扫码登录：用二维码里的 code 兑换登录态
  const scanCode = searchParams.get('code');
  if (scanCode && !loading) {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.post('/auth/scan-login', { code: scanCode });
        localStorage.setItem('edu_token', data.data.token);
        localStorage.setItem('edu_user', JSON.stringify(data.data.user));
        onLogin(data.data.user);
        navigate('/');
      } catch (err) {
        toast.error(errMsg(err));
      } finally {
        setLoading(false);
      }
    })();
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-row">
          <div className="mark">教</div>
          <div>
            <h1>教务管理</h1>
            <div className="sub">课程中心 · 局域网教务管理平台</div>
          </div>
        </div>
        <div className="form-row">
          <label>用户名</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </div>
        <div className="form-row">
          <label>密码</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" id="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 'auto' }} />
          <label htmlFor="remember" style={{ margin: 0 }}>记住我（30 天内免登录）</label>
        </div>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
          {loading ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
