import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import api, { errMsg } from './api.js';
import Layout from './components/Layout.jsx';
import { ToastProvider } from './components/feedback.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Classes from './pages/Classes.jsx';
import Teachers from './pages/Teachers.jsx';
import Schedules from './pages/Schedules.jsx';
import Notices from './pages/Notices.jsx';
import UploadTasks from './pages/UploadTasks.jsx';
import Users from './pages/Users.jsx';
import NoticeView from './pages/NoticeView.jsx';
import Inspections from './pages/Inspections.jsx';
import Applications from './pages/Applications.jsx';
import Stats from './pages/Stats.jsx';
import Assessment from './pages/Assessment.jsx';
import Admin from './pages/Admin.jsx';
import MobileApply from './pages/MobileApply.jsx';
import CourseApply from './pages/CourseApply.jsx';
import MobileShell from './mobile/MobileShell.jsx';
import MobileHome from './mobile/MobileHome.jsx';
import MobileStats from './mobile/MobileStats.jsx';
import MobileNotices from './mobile/MobileNotices.jsx';
import MobileMe from './mobile/MobileMe.jsx';
import MobileTimetable from './mobile/MobileTimetable.jsx';
import MobileSubstitute from './mobile/MobileSubstitute.jsx';
import MobileInspection from './mobile/MobileInspection.jsx';
import MobileAssessment from './mobile/MobileAssessment.jsx';

function AuthGuard({ children }) {
  const token = localStorage.getItem('edu_token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

// 判断是否移动设备（窄屏 / 手机 UA）
function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  if (window.innerWidth < 768) return true;
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function MobileRedirect() {
  return isMobileDevice() ? <Navigate to="/m" replace /> : <Dashboard />;
}

function AppRoutes() {
  const navigate = useNavigate();
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('edu_user')); } catch { return null; }
  });
  const [unread, setUnread] = useState(0);

  // 登录后拉取未读通知数，供移动端底部「通知」tab 角标
  React.useEffect(() => {
    if (!user) return;
    (async () => {
      try { setUnread((await api.get('/notices/unread-count')).data.data.unread); } catch { /* 忽略 */ }
    })();
  }, [user]);

  const logout = () => {
    localStorage.removeItem('edu_token');
    localStorage.removeItem('edu_user');
    setUser(null);
    navigate('/login');
  };

  return (
    <Routes>
      <Route path="/login" element={<Login onLogin={setUser} />} />
      <Route path="/n/:token" element={<NoticeView />} />
      {/* 手机自主申报页：独立全屏（无侧边栏），教师手机直达 /apply */}
      <Route path="/apply" element={<AuthGuard><MobileApply /></AuthGuard>} />
      {/* 课程申报分享填报页：老师手机扫码/点链接打开 */}
      <Route path="/course/:token" element={<AuthGuard><CourseApply /></AuthGuard>} />

      {/* 移动端（统一壳 + 底部导航） */}
      <Route path="/m" element={<AuthGuard><MobileShell user={user} unread={unread} onUnreadChange={setUnread} onLogout={logout} /></AuthGuard>}>
        <Route index element={<MobileHome />} />
        <Route path="apply" element={<MobileApply />} />
        <Route path="stats" element={<MobileStats />} />
        <Route path="timetable" element={<MobileTimetable />} />
        <Route path="substitute" element={<MobileSubstitute />} />
        <Route path="inspection" element={<MobileInspection />} />
        <Route path="assessment" element={<MobileAssessment />} />
        <Route path="notices" element={<MobileNotices />} />
        <Route path="me" element={<MobileMe onLogout={logout} />} />
      </Route>

      <Route
        path="/"
        element={
          <AuthGuard>
            <Layout user={user} onLogout={logout} />
          </AuthGuard>
        }
      >
        <Route index element={<MobileRedirect />} />
        <Route path="classes" element={<Classes />} />
        <Route path="teachers" element={<Teachers />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="notices" element={<Notices />} />
        <Route path="uploads" element={<UploadTasks />} />
        <Route path="inspections" element={<Inspections />} />
        <Route path="applications" element={<Applications />} />
        <Route path="stats" element={<Stats />} />
        <Route path="assessment" element={<Assessment />} />
        <Route path="users" element={<Users />} />
        <Route path="admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ToastProvider>
  );
}
