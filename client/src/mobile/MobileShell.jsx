import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

const ROLE_LABELS = {
  admin: '管理员', 教务员: '教务员', 教务处: '教务处', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};

// 线性 SVG 图标（克制、统一描边风格）
const ICONS = {
  首页: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>,
  申报: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
  课时: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" rx="1" /><rect x="12" y="6" width="3" height="12" rx="1" /><rect x="17" y="13" width="3" height="5" rx="1" /></svg>,
  通知: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>,
  我的: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></svg>,
};

export default function MobileShell({ user, unread, onUnreadChange, onLogout }) {
  const navigate = useNavigate();
  const isAdmin = ['admin', '教务员', '教务处'].includes(user?.role);
  const isGradeLeader = user?.role === '年级组长';

  // 底部导航（按角色显示）
  const tabs = [
    { to: '/m', label: '首页', end: true },
    { to: '/m/apply', label: '申报' },
    { to: '/m/stats', label: '课时' },
    { to: '/m/notices', label: '通知', badge: unread > 0 ? unread : 0 },
    { to: '/m/me', label: '我的' },
  ];

  const logout = () => { onLogout(); navigate('/login'); };

  return (
    <div className="mobile-shell">
      <div className="mobile-body">
        <Outlet context={{ isAdmin, isGradeLeader, unread, onUnreadChange }} />
      </div>
      <nav className="mobile-tabbar">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `mobile-tab${isActive ? ' on' : ''}`}>
            <span className="mt-ico">{ICONS[t.label]}</span>
            <span>{t.label}</span>
            {t.badge > 0 && <span className="mt-badge">{t.badge > 99 ? '99+' : t.badge}</span>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
