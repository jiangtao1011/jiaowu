import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ADMIN_ROLES, RESULT_VIEW_ROLES, CLERK_ROLES, DIRECTOR_ROLES } from '../roles.js';

const ROLE_LABELS = {
  admin: '管理员', 分管领导: '分管领导', 教务主任: '教务主任', 教务员: '教务员', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
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
  const isAdmin = ADMIN_ROLES.includes(user?.role);
  const canViewDc = RESULT_VIEW_ROLES.includes(user?.role);
  const isGradeLeader = user?.role === '年级组长';
  const bound = !!user?.teacher_id; // 是否绑定教师档案

  // 「申报」tab：教师本人（绑定）可自主申报；教务员/教务主任/admin/年级组长可批量申报/审核
  const canApply = bound || CLERK_ROLES.includes(user?.role) || DIRECTOR_ROLES.includes(user?.role) || isGradeLeader;
  // 「课时」tab：教师本人看自己的课时；管理角色看全体课时
  const canStats = bound || canViewDc || isGradeLeader;

  // 底部导航（按能力显示，而非仅按是否绑定）
  const tabs = [
    { to: '/m', label: '首页', end: true },
    ...(canApply ? [{ to: '/m/apply', label: '申报' }] : []),
    ...(canStats ? [{ to: '/m/stats', label: '课时' }] : []),
    { to: '/m/notices', label: '通知', badge: unread > 0 ? unread : 0 },
    { to: '/m/me', label: '我的' },
  ];

  const logout = () => { onLogout(); navigate('/login'); };

  return (
    <div className="mobile-shell">
      <div className="mobile-body">
        <Outlet context={{ isAdmin, canViewDc, isGradeLeader, unread, onUnreadChange }} />
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
