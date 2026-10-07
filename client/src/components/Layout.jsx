import React, { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import QRCode from 'qrcode';
import api from '../api.js';
import { canEditUser } from '../roles.js';

const GROUPS = [
  {
    label: '日常事务',
    items: [
      { to: '/', label: '工作台', end: true },
      { to: '/schedules', label: '课表与调课' },
      { to: '/inspections', label: '常规检查' },
      { to: '/applications', label: '课务申报', adminOnly: true },
    ],
  },
  {
    label: '统计与资料',
    items: [
      { to: '/stats', label: '统计中心' },
      { to: '/assessment', label: '教学业绩' },
      { to: '/notices', label: '通知' },
      { to: '/uploads', label: '教学计划上传' },
    ],
  },
  {
    label: '基础信息',
    items: [
      { to: '/teachers', label: '教师信息' },
      { to: '/classes', label: '班级信息' },
      { to: '/users', label: '账号管理', editOnly: true },
    ],
  },
];

const ROLE_LABELS = {
  admin: '管理员',
  教务员: '教务员',
  教务处: '教务处',
  教研组长: '教研组长',
  备课组长: '备课组长',
  年级组长: '年级组长',
  教师: '教师',
};

export default function Layout({ user, onLogout }) {
  const initial = (user?.name || user?.username || '?').charAt(0);
  const isAdmin = ['admin', '教务员', '教务处'].includes(user?.role);
  const showUsers = canEditUser(user);
  const [scanQr, setScanQr] = useState(null);
  const [scanUrl, setScanUrl] = useState('');

  // 生成扫码登录二维码：当前登录用户生成一次性 code，手机扫码直达登录
  const openScan = async () => {
    try {
      const r = await api.post('/auth/scan-code');
      const code = r.data.data.code;
      const url = `${window.location.origin}/login?code=${code}`;
      setScanUrl(url);
      setScanQr(await QRCode.toDataURL(url, { width: 220, margin: 1 }));
    } catch (e) { /* 忽略 */ }
  };
  const closeScan = () => { setScanQr(null); setScanUrl(''); };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">教</div>
          <div>
            <div className="name">教务管理</div>
            <div className="sub">课程中心</div>
          </div>
        </div>
        <nav>
          {GROUPS.map((g) => (
            <React.Fragment key={g.label}>
              <div className="group">{g.label}</div>
              {g.items.filter((n) => (!n.adminOnly || isAdmin) && (!n.editOnly || showUsers)).map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                  <span className="dot" />
                  {n.label}
                </NavLink>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="user-box">
          <div className="who">
            <span className="avatar">{initial}</span>
            <span>{user?.name} · {ROLE_LABELS[user?.role] || user?.role}</span>
          </div>
          <button className="logout" onClick={openScan}>扫码登录</button>
          <button className="logout" onClick={onLogout}>退出</button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>

      {scanQr && (
        <div className="modal-overlay" onClick={closeScan}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>扫码登录</h3>
              <button className="btn ghost" onClick={closeScan}>关闭</button>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>用手机扫下方二维码，即可免密码登录（3 分钟内有效，一次性）。</p>
            <div style={{ textAlign: 'center' }}><img src={scanQr} alt="扫码登录二维码" style={{ width: 220, height: 220 }} /></div>
            <p className="muted" style={{ marginTop: 12, wordBreak: 'break-all', fontSize: 12 }}>{scanUrl}</p>
          </div>
        </div>
      )}
    </div>
  );
}
