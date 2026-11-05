import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api, { errMsg } from '../api.js';
import { isAdmin, RESULT_VIEW_ROLES, INSPECTION_SUBMIT_ROLES } from '../roles.js';

const ROLE_LABELS = {
  admin: '管理员', 分管领导: '分管领导', 教务主任: '教务主任', 教务员: '教务员', 教研组长: '教研组长', 备课组长: '备课组长', 年级组长: '年级组长', 教师: '教师',
};

export default function MobileMe({ onLogout }) {
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const [mine, setMine] = useState(null);
  const admin = isAdmin(user);
  const canSeeInspection = INSPECTION_SUBMIT_ROLES.includes(user.role) || RESULT_VIEW_ROLES.includes(user.role);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/dashboard/teacher');
        setMine(r.data.data);
      } catch (e) { /* 忽略 */ }
    })();
  }, []);

  const logout = () => { onLogout(); navigate('/login'); };
  const teacher = mine?.bound ? mine.teacher : null;
  const isBound = !!teacher;

  return (
    <div>
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div className="mt-title">我的</div>
      </div>

      <div className="mcard">
        <div className="mitem" style={{ border: 'none' }}>
          <div className="mitem-main">
            <div className="mitem-title" style={{ fontSize: 18 }}>{user?.name}</div>
            <div className="mitem-sub">{ROLE_LABELS[user?.role] || user?.role}{teacher ? ` · ${teacher.subject || '未设学科'}` : ''}</div>
          </div>
        </div>
        {teacher && (
          <div className="mstat-row">
            <div className="mstat"><div className="mstat-v">{teacher.subject || '-'}</div><div className="mstat-l">学科</div></div>
            <div className="mstat"><div className="mstat-v">{teacher.phone || '-'}</div><div className="mstat-l">电话</div></div>
            <div className="mstat"><div className="mstat-v">{mine.taught_classes?.length ?? 0}</div><div className="mstat-l">任教班级</div></div>
          </div>
        )}
      </div>

      {/* 任教班级 */}
      {teacher && mine.taught_classes?.length > 0 && (
        <div className="mcard">
          <div className="mcard-title">任教班级</div>
          {mine.taught_classes.map((c, i) => (
            <div key={i} className="mitem">
              <div className="mitem-main">
                <div className="mitem-title">{c.name}</div>
                <div className="mitem-sub">{c.subject || '未设学科'} · {c.lessons} 节/周 · {c.type}</div>
              </div>
              <div className="mitem-side"><span className="badge">{c.grade}</span></div>
            </div>
          ))}
        </div>
      )}

      {/* 快捷入口：个人功能（需绑定）+ 管理功能（按权限） */}
      <div className="mcard">
        <div className="mcard-title">快捷入口</div>
        {isBound && (
          <>
            <Link to="/m/timetable" className="mlist-link"><div className="mitem"><div className="mitem-main"><div className="mitem-title">我的课表</div><div className="mitem-sub">查看本周课表</div></div><span className="mitem-side">›</span></div></Link>
            <Link to="/m/stats" className="mlist-link"><div className="mitem"><div className="mitem-main"><div className="mitem-title">我的课时</div><div className="mitem-sub">查看课时与课酬</div></div><span className="mitem-side">›</span></div></Link>
            <Link to="/m/assessment" className="mlist-link"><div className="mitem"><div className="mitem-main"><div className="mitem-title">我的业绩</div><div className="mitem-sub">查看学期考核分档案</div></div><span className="mitem-side">›</span></div></Link>
            <Link to="/m/substitute" className="mlist-link"><div className="mitem"><div className="mitem-main"><div className="mitem-title">代课调课</div><div className="mitem-sub">发起代课/调课申请</div></div><span className="mitem-side">›</span></div></Link>
          </>
        )}
        {canSeeInspection && (
          <Link to="/m/inspection" className="mlist-link"><div className="mitem"><div className="mitem-main"><div className="mitem-title">常规检查</div><div className="mitem-sub">{admin ? '选课打分、拍照上传' : '查看检查记录与统计'}</div></div><span className="mitem-side">›</span></div></Link>
        )}
      </div>

      <button className="mbtn ghost" style={{ marginTop: 8 }} onClick={logout}>退出登录</button>
    </div>
  );
}
