import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api, { errMsg } from '../api.js';
import MobileTopBar from './MobileTopBar.jsx';

// 计酬方式的展示文案
const MODE_LABEL = { 按次计酬: '按次计酬', 固定折算: '固定折算', 正课折算: '正课折算' };
const MODE_COLOR = { 按次计酬: 'var(--primary)', 固定折算: 'var(--warn)', 正课折算: 'var(--info)' };

export default function MobileCourses() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setTasks((await api.get('/applications/my-tasks')).data.data || []);
      } catch (e) { setError(errMsg(e)); }
    })();
  }, []);

  const openCourse = (t) => {
    if (t.expired) return;
    if (!t.share_token) return;
    navigate(`/course/${t.share_token}`);
  };

  return (
    <div>
      <MobileTopBar title="课程填报" sub="点课程进入填报" />

      {error && <div className="alert error">{error}</div>}

      {tasks.length === 0 ? (
        <div className="mcard"><p className="mapply-empty">暂无可填报的课程</p></div>
      ) : (
        <div className="mcard">
          <div className="mcard-title">可选课程</div>
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`mitem mcourse-item${t.expired ? ' expired' : ''}`}
              onClick={() => openCourse(t)}
              role="button"
              tabIndex={0}
            >
              <div className="mcourse-icon" style={{ background: MODE_COLOR[t.pay_mode] || 'var(--primary)' }}>
                {t.title?.charAt(0) || '课'}
              </div>
              <div className="mitem-main">
                <div className="mitem-title">{t.title}</div>
                <div className="mitem-sub">
                  {t.subject ? `${t.subject} · ` : ''}{t.grade ? `${t.grade} · ` : ''}{MODE_LABEL[t.pay_mode] || t.pay_mode}{t.chargeable ? ' · 可收费' : ''}
                </div>
              </div>
              <div className="mitem-side">
                {t.expired
                  ? <span className="badge danger">已截止</span>
                  : t.deadline
                    ? <span className="mcourse-deadline">截止 {t.deadline}</span>
                    : <span className="mcourse-arrow">›</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
