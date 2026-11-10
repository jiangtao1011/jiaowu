import React from 'react';
import { Link } from 'react-router-dom';

// 移动端顶部栏，两种形态：
//  - 简洁形态：渐变背景 + 标题 + 快捷入口（待审申报/未读通知/待办工作），供各功能页使用
//  - hero 形态（传 hero 时）：参考工作台首页 hero 条——大日期数字 + 关键指标 + 快捷入口，供首页使用
export default function MobileTopBar({ title, sub, todo, unread, extra, hero }) {
  const pending = (todo?.qna ?? 0) + (todo?.applications ?? 0);
  const works = (todo?.overdue_uploads ?? 0) + (todo?.reminders?.length ?? 0);
  const unreadCount = unread ?? 0;

  // 快捷入口（两种形态共用）
  const actions = (
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
  );

  // ===== hero 形态（首页）=====
  if (hero) {
    return (
      <div className="mhero">
        {hero.name ? (
          <div className="mhero-greet">
            <span className="mhero-greet-text">{hero.greet || '你好'}</span>
            <span className="mhero-greet-name">{hero.name}</span>
          </div>
        ) : null}
        <div className="mhero-top">
          <div className="mhero-date">
            <div className="mhero-day">{hero.day}</div>
            <div className="mhero-ym">{hero.ym} · {hero.week}</div>
          </div>
          {actions}
        </div>
        <div className="mhero-stats">
          {hero.stats.map((s, i) => (
            <div key={i} className="mhero-stat">
              <b>{s.v}</b>
              <span>{s.l}</span>
            </div>
          ))}
        </div>
        {hero.tags?.length > 0 && (
          <div className="mhero-tags">
            {hero.tags.map((t, i) => (
              <span key={i} className={`mhero-tag ${t.tone || ''}`}>{t.text}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ===== 简洁形态（功能页）=====
  return (
    <div className="mtop">
      <div className="mtop-main">
        <div className="mtop-titles">
          <div className="mtop-title">{title}</div>
          {sub ? <div className="mtop-sub">{sub}</div> : null}
        </div>
        {actions}
      </div>
    </div>
  );
}
