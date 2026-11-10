import React from 'react';
import { Link } from 'react-router-dom';

// 移动端顶部栏：墨绿渐变背景 + 标题 + 快捷入口（待审申报/未读通知/待办工作）。
// 供各移动端页面统一使用，替代旧的朴素 mobile-topbar。
export default function MobileTopBar({ title, sub, todo, unread, extra }) {
  const pending = (todo?.qna ?? 0) + (todo?.applications ?? 0);
  const works = (todo?.overdue_uploads ?? 0) + (todo?.reminders?.length ?? 0);
  const unreadCount = unread ?? 0;

  return (
    <div className="mtop">
      <div className="mtop-main">
        <div className="mtop-titles">
          <div className="mtop-title">{title}</div>
          {sub ? <div className="mtop-sub">{sub}</div> : null}
        </div>
        <div className="mtop-actions">
          {pending > 0 && (
            <Link to="/m/apply" className="mtop-chip" title="待审申报">
              <span className="mtop-chip-ico">审</span>
              <span className="mtop-chip-badge">{pending > 99 ? '99+' : pending}</span>
            </Link>
          )}
          {unreadCount > 0 && (
            <Link to="/m/notices" className="mtop-chip" title="未读通知">
              <span className="mtop-chip-ico">铃</span>
              <span className="mtop-chip-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
            </Link>
          )}
          {works > 0 && (
            <Link to="/m" className="mtop-chip" title="待办工作">
              <span className="mtop-chip-ico">办</span>
              <span className="mtop-chip-badge">{works > 99 ? '99+' : works}</span>
            </Link>
          )}
          {extra}
        </div>
      </div>
    </div>
  );
}
