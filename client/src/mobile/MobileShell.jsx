import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';

const ROLE_LABELS = {
  admin: '管理员', 教务员: '教务员', 教务处: '教务处', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};

const ICONS = { 首页: '⌂', 申报: '✎', 课时: '▦', 通知: '☰', 我的: '◉' };

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
